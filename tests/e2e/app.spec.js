import { expect, test } from "@playwright/test";

async function installAudioMock(page) {
  await page.addInitScript(() => {
    window.__speakingLoopAudio = {
      current: null,
      finish() {
        this.current?.onended?.();
      },
      fail() {
        this.current?.onerror?.();
      },
    };

    window.Audio = class {
      constructor(src) {
        this.src = src;
        this.onended = null;
        this.onerror = null;
        this.currentTime = 0;
        window.__speakingLoopAudio.current = this;
      }

      play() {
        return Promise.resolve();
      }

      pause() {}
    };
  });
}

async function mockConversationApi(page) {
  let turnCount = 0;
  await page.route("**/api/conversation", async (route) => {
    const body = route.request().postDataJSON();
    const base = {
      aiTranslation: "Translation",
      audioBase64: "AQID",
      audioMimeType: "audio/mp3",
      voice: { id: "test-voice", format: "mp3" },
    };

    if (body.action === "start") {
      await route.fulfill({
        json: {
          ...base,
          aiResponse: "久しぶり！最近どうだった？",
          trackingUpdate: {},
          terminated: false,
        },
      });
      return;
    }

    if (body.action === "turn") {
      turnCount += 1;
      await route.fulfill({
        json: {
          ...base,
          userTranscript: "最近、諦めそうだった。",
          userTranslation: "Recently, I almost gave up.",
          aiResponse:
            turnCount > 1
              ? "今日は話せてよかった。またね！"
              : "そうなんだ。最後まで頑張ったんだね。",
          trackingUpdate: { used_correctly: ["諦める"] },
          terminated: turnCount > 1,
        },
      });
      return;
    }

    if (body.action === "review") {
      await route.fulfill({
        json: {
          summary: "You used 諦める naturally while talking about a hard moment.",
          targetNotes: {
            諦める: "Used naturally in a sentence about almost giving up.",
          },
        },
      });
      return;
    }

    await route.fulfill({ status: 400, json: { error: "Unknown action." } });
  });
}

async function mockDebugApi(page) {
  await page.route("**/api/debug/summary", async (route) => {
    const token = route.request().headers()["x-debug-token"];
    if (token !== "test-token") {
      await route.fulfill({ status: 401, json: { error: "Unauthorized." } });
      return;
    }
    await route.fulfill({
      json: {
        sessions: 1,
        messages: 2,
        api_calls: 4,
        audio_files: 1,
      },
    });
  });
  await page.route("**/api/debug/messages?**", async (route) => {
    const token = route.request().headers()["x-debug-token"];
    if (token !== "test-token") {
      await route.fulfill({ status: 401, json: { error: "Unauthorized." } });
      return;
    }
    await route.fulfill({
      json: {
        messages: [
          {
            created_at: new Date("2026-06-03T00:00:00Z").toISOString(),
            message_id: "message-1",
            message_number: 7,
            session_number: 3,
            turn_index: 1,
            role: "user",
            content: "最近、諦めそうだった。",
            translation: "Recently, I almost gave up.",
            app_version: "test-version",
            client_props: { os: "Linux", browser: "Chrome" },
            vad_enabled: true,
            api_calls: [
              {
                id: "call-1",
                callType: "asr",
                status: "success",
                latencyMs: 123,
                model: null,
                error: null,
              },
            ],
            audio: [
              {
                id: "audio-1",
                kind: "user_input",
                key: "debug/session/audio.wav",
                mimeType: "audio/wav",
                sizeBytes: 32000,
              },
            ],
          },
        ],
      },
    });
  });
}

async function finishTutorAudio(page) {
  await page.evaluate(() => window.__speakingLoopAudio.finish());
}

async function emitSpeech(page) {
  await page.evaluate(() => {
    window.__speakingLoopVad.startSpeech();
    window.__speakingLoopVad.endSpeech();
  });
}

function status(page, value) {
  return page.locator("footer").getByText(value, { exact: true });
}

test.beforeEach(async ({ page }) => {
  await installAudioMock(page);
  await mockConversationApi(page);
  await mockDebugApi(page);
});

test("Omakase starts the chat and completes a voice turn", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("久しぶり！最近どうだった？")).toBeVisible();
  await expect(status(page, "speaking")).toBeVisible();

  await finishTutorAudio(page);
  await expect(status(page, "recording")).toBeVisible();

  await emitSpeech(page);
  await expect(page.getByText("最近、諦めそうだった。")).toBeVisible();
  await expect(page.getByText("そうなんだ。最後まで頑張ったんだね。")).toBeVisible();
  await expect(status(page, "speaking")).toBeVisible();

  await finishTutorAudio(page);
  await expect(status(page, "recording")).toBeVisible();
});

test("interrupt stops tutor audio and resumes recording", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(status(page, "speaking")).toBeVisible();

  await page.getByRole("button", { name: "Tap to interrupt" }).click();

  await expect(status(page, "recording")).toBeVisible();
});

test("custom onboarding accepts targets and starts a scenario", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Custom" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("諦める").fill("懐かしい");
  await page.keyboard.press("Enter");
  await expect(page.getByText("懐かしい")).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("〜てしまった").fill("〜ばよかった");
  await page.keyboard.press("Enter");
  await expect(page.getByText("〜ばよかった")).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "カフェでのんびり話す" }).click();
  await page.getByRole("button", { name: "Start" }).click();

  await expect(page.getByText("カフェでのんびり話す")).toBeVisible();
  await expect(page.getByText("久しぶり！最近どうだった？")).toBeVisible();
});

test("terminated conversation opens the review screen", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(status(page, "speaking")).toBeVisible();
  await finishTutorAudio(page);
  await expect(status(page, "recording")).toBeVisible();
  await emitSpeech(page);
  await expect(status(page, "speaking")).toBeVisible();
  await finishTutorAudio(page);
  await expect(status(page, "recording")).toBeVisible();
  await emitSpeech(page);

  await expect(page.getByText("Review", { exact: true })).toBeVisible();
  await expect(
    page.getByText("You used 諦める naturally while talking about a hard moment."),
  ).toBeVisible();
});

test("debug dashboard is token protected and shows log rows", async ({ page }) => {
  await page.goto("/debug");

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Enter DEBUG_ADMIN_TOKEN")).toBeVisible();

  await page.getByLabel("Admin token").fill("test-token");
  await page.getByRole("button", { name: "Refresh" }).click();

  await expect(page.getByText("Messages")).toBeVisible();
  await expect(page.locator("p").filter({ hasText: /^2$/ }).first()).toBeVisible();
  await expect(page.getByText("最近、諦めそうだった。")).toBeVisible();
  await expect(page.getByText("asr:success 123ms")).toBeVisible();
  await expect(page.getByText("Linux / Chrome / VAD on")).toBeVisible();
});
