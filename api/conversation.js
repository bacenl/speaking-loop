const SHISA_API = "https://api.shisa.ai";
const SHISA_OPENAI = "https://api.shisa.ai/openai/v1";
const LLM_MODEL = "shisa-ai/shisa-v2.1-llama3.3-70b";
const DEFAULT_VOICE = "15354123-f0be-4795-8101-eab7b2843b4c";

function getApiKey() {
  return process.env.SHISA_API_KEY || process.env.SHISA_KEY || "";
}

function bearerKey() {
  const key = getApiKey();
  if (!key) return "";
  return key.startsWith("shsk:") ? key : `shsk:${key}`;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  if (typeof req.body === "string") {
    return JSON.parse(req.body || "{}");
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function shisaFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.text();
    console.error("Shisa API request failed", {
      url,
      status: response.status,
      detail,
    });
    throw new Error(`Shisa API ${response.status}: ${detail}`);
  }
  return response;
}

async function transcribe({ audio, targets }) {
  const hotwords = [...(targets?.words || []), ...(targets?.grammar || [])];
  const response = await shisaFetch(`${SHISA_API}/asr/srt/audio_llm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio,
      language: "ja",
      hotwords,
      temperature: 0,
    }),
  });
  const data = await response.json();
  return data.text || "";
}

async function translate(text, sourceLang = "ja", targetLang = "en") {
  if (!text) return "";
  const form = new FormData();
  form.append("text", text);
  form.append("source_lang", sourceLang);
  form.append("target_lang", targetLang);
  form.append("stream", "false");
  const response = await shisaFetch(`${SHISA_API}/translate/`, {
    method: "POST",
    headers: { Authorization: bearerKey() },
    body: form,
  });
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

const GRAMMAR_PATTERNS = [
  {
    target: "〜てしまった",
    variants: ["てしまった", "でしまった", "ちゃった", "じゃった"],
    cue: "最近、思ったより大変で少し後悔した出来事があった。",
  },
  {
    target: "〜ばよかった",
    variants: ["ばよかった", "たらよかった", "ればよかった"],
    cue: "最近、あとから考えて、もっと早く別の行動をしておけばよかったと思った出来事があった。",
  },
  {
    target: "〜んじゃないかと思う",
    variants: ["んじゃないかと思う", "のではないかと思う", "じゃないかと思う"],
    cue: "最近、はっきり断言できないけれど、たぶんそうだと思っている話がある。",
  },
];

function allTargets(targets = {}) {
  return [...(targets.words || []), ...(targets.grammar || [])];
}

function normalizeJapanese(text = "") {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[。、！？!?.,]/g, "");
}

function variantsFor(target) {
  const grammar = GRAMMAR_PATTERNS.find((item) => item.target === target);
  if (grammar) return grammar.variants;
  const withoutMarker = target.replace(/^〜/, "");
  return [target, withoutMarker];
}

function textHasTarget(text, target) {
  const normalized = normalizeJapanese(text);
  return variantsFor(target).some((variant) =>
    normalized.includes(normalizeJapanese(variant)),
  );
}

function applyTrackingUpdate(tracking = {}, update = {}) {
  const next = { ...tracking };
  for (const status of ["modelled", "used_incorrectly", "used_correctly"]) {
    for (const target of update[status] || []) {
      if (!next[target]) continue;
      if (
        next[target].status === "used_correctly" &&
        status !== "used_correctly"
      ) {
        continue;
      }
      next[target] = { ...next[target], status };
    }
  }
  return next;
}

function analyzeUserTargets(transcript, targets = {}, tracking = {}) {
  const usedCorrectly = [];
  for (const target of allTargets(targets)) {
    if (tracking[target]?.status === "used_correctly") continue;
    if (textHasTarget(transcript, target)) usedCorrectly.push(target);
  }
  return { used_correctly: usedCorrectly, used_incorrectly: [] };
}

function analyzeAssistantTargets(text, targets = {}, tracking = {}) {
  const modelled = [];
  for (const target of allTargets(targets)) {
    if (tracking[target]?.status === "used_correctly") continue;
    if (textHasTarget(text, target)) modelled.push(target);
  }
  return { modelled };
}

function combineUpdates(...updates) {
  const combined = {
    used_correctly: [],
    used_incorrectly: [],
    modelled: [],
  };
  for (const update of updates) {
    for (const status of Object.keys(combined)) {
      for (const target of update?.[status] || []) {
        if (!combined[status].includes(target)) combined[status].push(target);
      }
    }
  }
  combined.modelled = combined.modelled.filter(
    (target) => !combined.used_correctly.includes(target),
  );
  return combined;
}

function chooseFocusTarget(targets = {}, tracking = {}) {
  const ordered = allTargets(targets);
  return (
    ordered.find((target) => tracking[target]?.status === "pending") ||
    ordered.find((target) => tracking[target]?.status === "modelled") ||
    ordered.find((target) => tracking[target]?.status === "used_incorrectly") ||
    null
  );
}

function allTargetsUsed(targets = {}, tracking = {}) {
  const ordered = allTargets(targets);
  return (
    ordered.length > 0 &&
    ordered.every((target) => tracking[target]?.status === "used_correctly")
  );
}

function buildConversationCue(focusTarget) {
  if (!focusTarget) return "相手の近況を聞きながら、自然な雑談を続ける。";
  const grammar = GRAMMAR_PATTERNS.find((item) => item.target === focusTarget);
  if (grammar) return grammar.cue;
  return `最近、「${focusTarget}」という言葉が自然に出そうな出来事や気持ちについて話す。`;
}

/*
English translation of the Japanese-only conversation prompt below:

You are a Japanese conversation partner. The other person is an intermediate
Japanese learner, but do not use English. Reply only with natural Japanese
conversation text.

Setting: {scenario}
Natural backstory for this turn: {conversationCue}
Conversation turn count: {turnCount}

Guidelines:
- Write exactly one assistant turn addressed to the learner.
- Do not write both sides of a conversation or any script/dialogue transcript.
- Reply as ordinary conversation.
- Do not interrogate the learner.
- If the learner's Japanese is short or unnatural, reply with shorter, simpler
  Japanese.
- Keep the reply to 2-3 sentences.
- Do not write parenthetical notes, explanations, plans, JSON, Markdown, labels,
  or anything outside the conversation.
- If it is time to close, finish warmly and append [END] on a new line.
*/
function buildPrompt({ targets, tracking, scenario, turnCount, focusTarget }) {
  const shouldClose = allTargetsUsed(targets, tracking) || turnCount >= 15;
  const conversationCue = buildConversationCue(focusTarget);
  return `あなたは日本語で会話する相手です。
相手は中級の日本語学習者ですが、英語は使いません。
返事は自然な日本語の会話文だけにしてください。

状況: ${scenario}
背景: ${conversationCue}
回数: ${turnCount}

会話ルール:
- 返事はあなたの1ターン分だけを書く。
- 複数人の台本、会話例、引用だけの返事は書かない。
- 「私:」「相手:」「ユーザー:」のような話者ラベルは書かない。
- 普通の会話として、相手に直接話しかける。
- 質問攻めにしない。
- 相手の日本語が短い、または不自然な場合は、より短く簡単な日本語で返す。
- 返事は2〜3文まで。
- 括弧書き、注釈、説明、作戦メモ、JSON、Markdown、見出し、ラベルは書かない。
- 会話以外の文章は書かない。
- ${
    shouldClose
      ? "自然に会話を締めくくる。最後の返事の後に、改行して [END] を付ける。"
      : "まだ会話を終わらせない。"
  }
`;
}

function extractReplyFromJsonLike(raw) {
  const trimmed = raw.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!unfenced.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(unfenced);
    const reply =
      parsed.reply ||
      parsed.response ||
      parsed.message ||
      parsed.content ||
      parsed.text;
    return typeof reply === "string" ? reply : null;
  } catch {
    return null;
  }
}

function parseAssistant(raw) {
  let text = extractReplyFromJsonLike(raw) || raw;
  text = text
    .replace(/\[TRACK\][\s\S]*?\[\/TRACK\]/g, "")
    .replace(/```(?:json)?[\s\S]*?```/gi, "")
    .replace(/^\s*\{[\s\S]*\}\s*$/g, "")
    .replace(/（※[\s\S]*?）/g, "")
    .replace(/\(※[\s\S]*?\)/g, "")
    .replace(/[（(]\s*(?:focus|target|strategy|goal|hint|teaching target|private teaching target|自然に|ユーザー|話題|文法|練習|狙い|目的|意図|方針)\s*[:：]?[・\s\S]*?[）)]/gi, "")
    .replace(/（[^）]*(?:自然に|ユーザー|話題|きっかけ|使える場面|文法|練習|狙い|目的|意図|方針|注釈|説明|促す|返答|日本語レベル|開放的な質問|短くて)[^）]*）/g, "")
    .replace(/\([^)]*(?:自然に|ユーザー|話題|きっかけ|使える場面|文法|練習|狙い|目的|意図|方針|注釈|説明|促す|返答|日本語レベル|開放的な質問|短くて)[^)]*\)/g, "")
    .replace(/(?:Focus|Target|Strategy|Goal|Hint|Teaching target)\s*[:：].*$/gim, "")
    .replace(/\[END\]/g, "")
    .trim();
  text = collapseSelfDialogue(text);
  const terminated = /\[END\]/.test(raw);
  return { text, terminated };
}

function collapseSelfDialogue(text) {
  const cleaned = text
    .replace(/^\s*(?:私|相手|ユーザー|AI|先生|友達)\s*[:：]\s*/gm, "")
    .trim();
  const quotedTurns = [...cleaned.matchAll(/[「『]([^」』]+)[」』]/g)].map(
    (match) => match[1].trim(),
  );
  if (quotedTurns.length >= 2) {
    const question = quotedTurns.find((turn) => /[？?]/.test(turn));
    return question || quotedTurns[0];
  }
  return cleaned;
}

function hasPlanningLeak(text) {
  return /(?:Focus|Target|Strategy|Goal|Hint|Teaching target)|(?:（※|\(※|自然に|ユーザーに|話題に近づける|会話のきっかけ|使える場面|文法を|練習|狙い|目的|意図|方針|注釈|説明|促す|返答を促す|日本語レベル|開放的な質問|ターゲット|フォーカス)|(?:[「『][^」』]+[」』]\s*){2,}|(?:私|相手|ユーザー|AI|先生|友達)\s*[:：]/i.test(
    text,
  );
}

async function chat({
  history = [],
  targets,
  tracking,
  scenario,
  turnCount,
  focusTarget,
  start,
}) {
  const messages = [
    {
      role: "system",
      content: buildPrompt({
        targets,
        tracking,
        scenario,
        turnCount,
        focusTarget,
      }),
    },
    ...history.map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
  ];
  if (start) {
    messages.push({
      role: "user",
      content:
        "会話を自然に始めてください。相手は日本語学習者ですが、日本語だけで話してください。",
    });
  }
  const requestBody = {
    model: LLM_MODEL,
    messages,
    temperature: 0.65,
    max_tokens: 420,
  };
  const response = await shisaFetch(`${SHISA_OPENAI}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const data = await response.json();
  const parsed = parseAssistant(data?.choices?.[0]?.message?.content || "");
  if (!hasPlanningLeak(parsed.text)) return parsed;

  const retryResponse = await shisaFetch(`${SHISA_OPENAI}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...requestBody,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: parsed.text,
        },
        {
          role: "user",
          content:
            "今の返答には説明や作戦メモが入っています。メモや括弧書きを全部消して、自然な日本語の会話文だけをもう一度書いてください。",
        },
      ],
      temperature: 0.4,
    }),
  });
  const retryData = await retryResponse.json();
  return parseAssistant(retryData?.choices?.[0]?.message?.content || parsed.text);
}

async function pickVoice(requestedVoice) {
  if (requestedVoice?.id) return requestedVoice;
  try {
    const response = await shisaFetch(`${SHISA_API}/tts/voices`, {
      headers: { Authorization: `Bearer ${bearerKey()}` },
    });
    const voices = await response.json();
    const voice =
      voices.find(
        (item) =>
          item.streaming &&
          item.formats?.includes("mp3") &&
          /japanese|ja|jp/i.test(`${item.language} ${item.description}`),
      ) ||
      voices.find((item) => item.streaming && item.formats?.includes("mp3")) ||
      voices[0];
    if (voice?.id) return { id: voice.id, format: "mp3" };
  } catch {
    return { id: DEFAULT_VOICE, format: "mp3" };
  }
  return { id: DEFAULT_VOICE, format: "mp3" };
}

async function synthesize(text, voice) {
  if (!text) return { audioBase64: "", audioMimeType: "audio/mp3", voice };
  const selected = await pickVoice(voice);
  const format = selected.format || "mp3";
  const response = await shisaFetch(`${SHISA_API}/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      voice_id: selected.id,
      format,
      stream: true,
      text,
    }),
  });
  const arrayBuffer = await response.arrayBuffer();
  return {
    audioBase64: Buffer.from(arrayBuffer).toString("base64"),
    audioMimeType: response.headers.get("content-type") || `audio/${format}`,
    voice: selected,
  };
}

async function handleStart(body) {
  const focusTarget = chooseFocusTarget(body.targets, body.tracking);
  const assistant = await chat({
    history: [],
    targets: body.targets,
    tracking: body.tracking,
    scenario: body.scenario,
    turnCount: 0,
    focusTarget,
    start: true,
  });
  const trackingUpdate = analyzeAssistantTargets(
    assistant.text,
    body.targets,
    body.tracking,
  );
  const [aiTranslation, audio] = await Promise.all([
    translate(assistant.text, "ja", "en"),
    synthesize(assistant.text, body.voice),
  ]);
  return {
    aiResponse: assistant.text,
    aiTranslation,
    trackingUpdate,
    focusTarget,
    terminated: assistant.terminated,
    ...audio,
  };
}

async function handleTurn(body) {
  const userTranscript = await transcribe(body);
  const userTrackingUpdate = analyzeUserTargets(
    userTranscript,
    body.targets,
    body.tracking,
  );
  const trackingAfterUser = applyTrackingUpdate(
    body.tracking,
    userTrackingUpdate,
  );
  const focusTarget = chooseFocusTarget(body.targets, trackingAfterUser);
  const nextHistory = [
    ...(body.history || []),
    { role: "user", content: userTranscript },
  ];
  const [userTranslation, assistant] = await Promise.all([
    translate(userTranscript, "ja", "en"),
    chat({
      history: nextHistory,
      targets: body.targets,
      tracking: trackingAfterUser,
      scenario: body.scenario,
      turnCount: body.turnCount,
      focusTarget,
    }),
  ]);
  const assistantTrackingUpdate = analyzeAssistantTargets(
    assistant.text,
    body.targets,
    trackingAfterUser,
  );
  const trackingUpdate = combineUpdates(
    userTrackingUpdate,
    assistantTrackingUpdate,
  );
  const [aiTranslation, audio] = await Promise.all([
    translate(assistant.text, "ja", "en"),
    synthesize(assistant.text, body.voice),
  ]);
  return {
    userTranscript,
    userTranslation,
    aiResponse: assistant.text,
    aiTranslation,
    trackingUpdate,
    focusTarget,
    terminated: assistant.terminated,
    ...audio,
  };
}

async function handleReview(body) {
  const targets = [
    ...(body.targets?.words || []),
    ...(body.targets?.grammar || []),
  ];
  const prompt = `The following is a Japanese conversation between an AI tutor and a language learner.
The learner's target items were: ${targets.join(", ")}
Tracking result: ${JSON.stringify(body.tracking || {})}
Conversation: ${JSON.stringify(body.history || [])}

Return JSON with this shape:
{"summary":"3-5 sentence English paragraph","targetNotes":{"target":"one-line English note"}}
Be warm and specific. Do not be generic.`;

  const response = await shisaFetch(`${SHISA_OPENAI}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 700,
    }),
  });
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content.replace(/^```json|```$/g, "").trim());
  } catch {
    return { summary: content, targetNotes: {} };
  }
}

export default async function handler(req, res) {
  console.info("conversation api request", {
    method: req.method,
    url: req.url,
  });
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }
  if (!getApiKey()) {
    return json(res, 500, {
      error: "Missing SHISA_API_KEY environment variable.",
    });
  }

  try {
    const body = await readBody(req);
    console.info("conversation api action", {
      action: body.action,
      hasAudio: Boolean(body.audio),
      targetCount:
        (body.targets?.words?.length || 0) + (body.targets?.grammar?.length || 0),
    });
    if (body.action === "start") return json(res, 200, await handleStart(body));
    if (body.action === "turn") return json(res, 200, await handleTurn(body));
    if (body.action === "review") return json(res, 200, await handleReview(body));
    return json(res, 400, { error: "Unknown action." });
  } catch (error) {
    console.error("conversation api failed", {
      message: error.message,
      stack: error.stack,
    });
    return json(res, 500, { error: error.message || "Unexpected error." });
  }
}
