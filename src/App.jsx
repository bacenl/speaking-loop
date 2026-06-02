import React, { useEffect, useRef, useState } from "react";
import { useMicVAD } from "@ricky0123/vad-react";
import {
  Check,
  Circle,
  Loader2,
  Mic,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";

const OMAKASE = {
  scenario:
    "久しぶりに友達と話している - catching up with a friend after a long time",
  words: ["諦める", "恥ずかしい", "懐かしい", "うまくいく", "気にしない"],
  grammar: ["〜てしまった", "〜ばよかった", "〜んじゃないかと思う"],
};

const SCENARIOS = [
  "久しぶりに友達と話す",
  "カフェでのんびり話す",
  "週末の出来事を話す",
  "自由",
];

const STATUS_LABELS = {
  pending: "Pending",
  modelled: "Modelled",
  used_correctly: "Used",
  used_incorrectly: "Needs work",
};

const STATUS_STYLES = {
  pending: "border-slate-300 bg-white text-slate-600",
  modelled: "border-amber-300 bg-amber-50 text-amber-800",
  used_correctly: "border-emerald-300 bg-emerald-50 text-emerald-800",
  used_incorrectly: "border-rose-300 bg-rose-50 text-rose-800",
};

const WAVEFORM_BARS = 40;
const EMPTY_LEVELS = Array.from({ length: WAVEFORM_BARS }, () => 0);
const SILENCE_STOP_MS = 4000;
const VAD_SAMPLE_RATE = 16000;
const VAD_ASSET_PATH =
  "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/";
const ONNX_WASM_PATH =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";

function makeTracking(targets) {
  return [...targets.words, ...targets.grammar].reduce((acc, target) => {
    acc[target] = { status: "pending", note: "" };
    return acc;
  }, {});
}

function capHistory(history) {
  return history.slice(-8);
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function float32ToWavBlob(samples, sampleRate = VAD_SAMPLE_RATE) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function frameLevel(frame) {
  if (!frame?.length) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / frame.length) * 6);
}

async function conversationRequest(payload) {
  console.info("Sending /api/conversation payload", payload);
  const response = await fetch("/api/conversation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function cleanConversationText(text = "") {
  const trimmed = String(text).trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (unfenced.startsWith("{")) {
    try {
      const parsed = JSON.parse(unfenced);
      const reply =
        parsed.reply ||
        parsed.response ||
        parsed.message ||
        parsed.content ||
        parsed.text;
      if (typeof reply === "string") return cleanConversationText(reply);
    } catch {
      // Fall through to regex cleanup below.
    }
  }
  const cleaned = trimmed
    .replace(/\[TRACK\][\s\S]*?\[\/TRACK\]/g, "")
    .replace(/```(?:json)?[\s\S]*?```/gi, "")
    .replace(/（※[\s\S]*?）/g, "")
    .replace(/\(※[\s\S]*?\)/g, "")
    .replace(/[（(]\s*(?:focus|target|strategy|goal|hint|teaching target|private teaching target|自然に|ユーザー|話題|文法|練習|狙い|目的|意図|方針)\s*[:：]?[・\s\S]*?[）)]/gi, "")
    .replace(/（[^）]*(?:自然に|ユーザー|話題|きっかけ|使える場面|文法|練習|狙い|目的|意図|方針|注釈|説明|促す|返答|日本語レベル|開放的な質問|短くて)[^）]*）/g, "")
    .replace(/\([^)]*(?:自然に|ユーザー|話題|きっかけ|使える場面|文法|練習|狙い|目的|意図|方針|注釈|説明|促す|返答|日本語レベル|開放的な質問|短くて)[^)]*\)/g, "")
    .replace(/(?:Focus|Target|Strategy|Goal|Hint|Teaching target)\s*[:：].*$/gim, "")
    .replace(/\[END\]/g, "")
    .trim();
  return collapseSelfDialogue(cleaned);
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

function mergeTracking(previous, update = {}) {
  const next = { ...previous };
  if (!update || typeof update !== "object") return next;
  const allowedStatuses = ["modelled", "used_incorrectly", "used_correctly"];
  for (const status of allowedStatuses) {
    const targets = update[status];
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
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

function ChipInput({ label, placeholder, values, setValues, canSkip, onSkip }) {
  const [draft, setDraft] = useState("");

  const addDraft = () => {
    const value = draft.trim();
    if (!value || values.includes(value)) return;
    setValues([...values, value]);
    setDraft("");
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-950">{label}</h2>
        <p className="mt-1 text-sm text-slate-600">
          Add each target, then press Enter.
        </p>
      </div>
      <div className="flex min-h-14 flex-wrap gap-2 rounded-md border border-slate-300 bg-white p-2 focus-within:border-teal-600">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-2 rounded-md border border-teal-200 bg-teal-50 px-2.5 py-1 text-sm text-teal-900"
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => setValues(values.filter((item) => item !== value))}
              className="rounded p-0.5 text-teal-700 hover:bg-teal-100"
            >
              <X size={14} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addDraft();
            }
          }}
          placeholder={placeholder}
          className="min-w-40 flex-1 border-0 bg-transparent px-2 py-1 outline-none"
        />
      </div>
      <div className="flex justify-between gap-3">
        {canSkip ? (
          <button
            type="button"
            onClick={onSkip}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Skip
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={addDraft}
          className="rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Onboarding({ onStart, initialTargets }) {
  const initial = initialTargets?.targets || initialTargets;
  const [step, setStep] = useState(initial ? 4 : 1);
  const [mode, setMode] = useState("omakase");
  const [words, setWords] = useState(initial?.words || []);
  const [grammar, setGrammar] = useState(initial?.grammar || []);
  const [scenario, setScenario] = useState(
    initialTargets?.scenario || SCENARIOS[0],
  );
  const [customScenario, setCustomScenario] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const begin = async () => {
    setStarting(true);
    setError("");
    try {
      await onStart({
        words,
        grammar,
        scenario: customScenario.trim() || scenario,
      });
    } catch (caught) {
      console.error("Conversation startup failed", caught);
      setError(caught.message || "Could not start the conversation.");
    } finally {
      setStarting(false);
    }
  };

  const beginOmakase = async () => {
    setStarting(true);
    setError("");
    try {
      await onStart({
        words: OMAKASE.words,
        grammar: OMAKASE.grammar,
        scenario: OMAKASE.scenario,
      });
    } catch (caught) {
      console.error("Omakase startup failed", caught);
      setError(caught.message || "Could not start the Omakase conversation.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-lg bg-stone-50 p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between border-b border-slate-200 pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
              Speaking Loop
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-950">
              Japanese conversation practice
            </h1>
          </div>
          <span className="rounded-md bg-white px-3 py-1 text-sm text-slate-600">
            {step} / 4
          </span>
        </div>

        {step === 1 && (
          <div className="space-y-5">
            <p className="text-slate-700">
              Practise your own vocabulary and grammar in a natural spoken
              conversation, then review exactly what came up.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setMode("omakase")}
                disabled={starting}
                className={`rounded-lg border p-5 text-left ${
                  mode === "omakase"
                    ? "border-teal-600 bg-teal-50"
                    : "border-slate-300 bg-white hover:border-slate-600"
                }`}
              >
                <span className="block text-lg font-semibold text-teal-950">
                  Omakase
                </span>
                <span className="mt-2 block text-sm text-teal-800">
                  Use a curated intermediate set.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMode("custom")}
                disabled={starting}
                className={`rounded-lg border p-5 text-left ${
                  mode === "custom"
                    ? "border-teal-600 bg-teal-50"
                    : "border-slate-300 bg-white hover:border-slate-600"
                }`}
              >
                <span className="block text-lg font-semibold text-slate-950">
                  Custom
                </span>
                <span className="mt-2 block text-sm text-slate-600">
                  Add the words and grammar you want to practise.
                </span>
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <ChipInput
            label="Vocabulary targets"
            placeholder="諦める"
            values={words}
            setValues={setWords}
            canSkip
            onSkip={() => setStep(3)}
          />
        )}

        {step === 3 && (
          <ChipInput
            label="Grammar targets"
            placeholder="〜てしまった"
            values={grammar}
            setValues={setGrammar}
            canSkip
            onSkip={() => setStep(4)}
          />
        )}

        {step === 4 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                Conversation scenario
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Pick a setting or describe your own.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {SCENARIOS.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setScenario(item)}
                  className={`rounded-md border px-3 py-3 text-left text-sm ${
                    scenario === item
                      ? "border-teal-600 bg-teal-50 text-teal-950"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
            <input
              value={customScenario}
              onChange={(event) => setCustomScenario(event.target.value)}
              placeholder="Custom scenario"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-3 outline-none focus:border-teal-600"
            />
          </div>
        )}

        {error && (
          <div className="mt-5 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-between border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={() => setStep(Math.max(1, step - 1))}
            disabled={step === 1 || starting}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Back
          </button>
          {step < 4 ? (
            <button
              type="button"
              onClick={() => {
                if (step === 1 && mode === "omakase") {
                  beginOmakase();
                  return;
                }
                setStep(step + 1);
              }}
              disabled={starting}
              className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting && <Loader2 className="animate-spin" size={16} />}
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={begin}
              disabled={starting || words.length + grammar.length === 0}
              className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? <Loader2 className="animate-spin" size={16} /> : <Mic size={16} />}
              Start
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TargetTracker({ tracking }) {
  return (
    <aside className="flex h-full flex-col border-t border-slate-200 bg-white p-4 lg:w-80 lg:border-l lg:border-t-0">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Targets
      </h2>
      <div className="mt-3 flex flex-wrap gap-2 lg:block lg:space-y-2">
        {Object.entries(tracking).map(([target, value]) => (
          <div
            key={target}
            className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm lg:flex ${STATUS_STYLES[value.status]}`}
          >
            {value.status === "used_correctly" ? (
              <Check size={15} />
            ) : value.status === "pending" ? (
              <Circle size={15} />
            ) : (
              <span className="text-base leading-none">
                {value.status === "modelled" ? "〇" : "△"}
              </span>
            )}
            <span className="font-medium">{target}</span>
            <span className="ml-auto hidden text-xs lg:inline">
              {STATUS_LABELS[value.status]}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Waveform({ active, status, levels }) {
  const visibleLevels = levels?.length ? levels : EMPTY_LEVELS;

  return (
    <div
      className={`flex h-10 w-48 items-center gap-0.5 rounded-md border px-2 py-1 ${
        active
          ? "border-teal-300 bg-teal-50"
          : status === "recording"
            ? "border-slate-300 bg-white"
            : "border-slate-200 bg-slate-50 opacity-60"
      }`}
      aria-label="Live microphone waveform"
    >
      {visibleLevels.map((level, index) => (
        <span
          key={index}
          className={`block flex-1 rounded-full transition-[height,background-color] duration-75 ${
            active ? "bg-teal-700" : "bg-slate-400"
          }`}
          style={{
            height: `${Math.max(3, Math.round(4 + level * 30))}px`,
          }}
        />
      ))}
    </div>
  );
}

function Conversation({
  session,
  status,
  userSpeaking,
  levels,
  vadError,
  onEnd,
  onStopRecording,
  onInterrupt,
}) {
  const transcriptRef = useRef(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [session.history]);

  return (
    <main className="flex min-h-screen flex-col bg-stone-100 lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-stone-50 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-950">
              {session.scenario}
            </h1>
            <p className="text-sm text-slate-500">
              Turn {session.turnCount} / 15
            </p>
          </div>
          <button
            type="button"
            onClick={() => onEnd()}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Square size={15} />
            End session
          </button>
        </header>

        <div
          ref={transcriptRef}
          className="transcript-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
        >
          {session.history.length === 0 ? (
            <div className="mx-auto mt-20 max-w-md rounded-lg border border-slate-200 bg-white p-5 text-center text-slate-600">
              The first Japanese prompt will appear after the tutor starts.
            </div>
          ) : (
            session.history.map((turn, index) => (
              <article
                key={`${turn.role}-${index}`}
                className={`max-w-3xl rounded-lg border p-4 ${
                  turn.role === "assistant"
                    ? "border-teal-200 bg-white"
                    : "ml-auto border-slate-200 bg-slate-50"
                }`}
              >
                <p className="text-lg leading-8 text-slate-950">
                  {turn.content}
                </p>
                {turn.translation && (
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    ({turn.translation})
                  </p>
                )}
              </article>
            ))
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-stone-50 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700">
              {status}
            </span>
            <Waveform
              active={userSpeaking}
              status={status}
              levels={levels}
            />
          </div>
          {status === "speaking" ? (
            <button
              type="button"
              onClick={onInterrupt}
              className="inline-flex items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800"
            >
              <Square size={15} />
              Tap to interrupt
            </button>
          ) : status === "recording" ? (
            <button
              type="button"
              onClick={onStopRecording}
              className="inline-flex items-center gap-2 rounded-md border border-teal-300 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-900"
            >
              <Square size={15} />
              Stop recording
            </button>
          ) : (
            <span className="inline-flex items-center gap-2 text-sm text-slate-500">
              <Mic size={15} />
              {vadError ||
                `Auto-stops after ${Math.round(SILENCE_STOP_MS / 1000)}s silence`}
            </span>
          )}
        </footer>
      </section>
      <TargetTracker tracking={session.tracking} />
    </main>
  );
}

function Review({ session, review, onSameWords, onChangeTargets }) {
  const targets = Object.entries(session.tracking);
  const used = targets.filter(([, value]) => value.status === "used_correctly");

  return (
    <main className="min-h-screen bg-stone-100 p-4">
      <section className="mx-auto max-w-4xl space-y-5">
        <header className="rounded-lg border border-slate-200 bg-white p-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-teal-700">
            Review
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-950">
            {used.length} / {targets.length} targets used naturally
          </h1>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          {targets.map(([target, value]) => (
            <div
              key={target}
              className={`rounded-lg border p-4 ${STATUS_STYLES[value.status]}`}
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">{target}</h2>
                <span className="text-sm">{STATUS_LABELS[value.status]}</span>
              </div>
              <p className="mt-2 text-sm">
                {review?.targetNotes?.[target] ||
                  value.note ||
                  "No detailed note was generated for this target."}
              </p>
            </div>
          ))}
        </div>

        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">
            Overall feedback
          </h2>
          <p className="mt-2 leading-7 text-slate-700">
            {review?.summary || "Review generation is pending."}
          </p>
        </section>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onSameWords}
            className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white"
          >
            <Play size={16} />
            Same words, new conversation
          </button>
          <button
            type="button"
            onClick={onChangeTargets}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
          >
            <Trash2 size={16} />
            Change vocab / grammar
          </button>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [status, setStatus] = useState("idle");
  const [review, setReview] = useState(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [levels, setLevels] = useState(EMPTY_LEVELS);
  const [vadError, setVadError] = useState("");
  const audioPlayerRef = useRef(null);
  const statusRef = useRef(status);
  const submitAudioRef = useRef(null);
  const manualStopPendingRef = useRef(false);

  const stopTutorAudio = () => {
    const player = audioPlayerRef.current;
    if (!player) return;
    player.onended = null;
    player.onerror = null;
    player.pause();
    player.currentTime = 0;
    audioPlayerRef.current = null;
  };

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const vad = useMicVAD({
    startOnLoad: false,
    model: "v5",
    baseAssetPath: VAD_ASSET_PATH,
    onnxWASMBasePath: ONNX_WASM_PATH,
    redemptionMs: SILENCE_STOP_MS,
    minSpeechMs: 400,
    preSpeechPadMs: 800,
    submitUserSpeechOnPause: true,
    onSpeechStart: () => {
      if (statusRef.current !== "recording") return;
      setLevels(EMPTY_LEVELS);
    },
    onSpeechEnd: (audio) => {
      if (statusRef.current !== "recording") return;
      manualStopPendingRef.current = false;
      setLevels(EMPTY_LEVELS);
      submitAudioRef.current?.(float32ToWavBlob(audio));
    },
    onVADMisfire: () => {
      if (statusRef.current !== "recording") return;
      manualStopPendingRef.current = false;
      setLevels(EMPTY_LEVELS);
    },
    onFrameProcessed: (probabilities, frame) => {
      if (statusRef.current !== "recording") return;
      const level = Math.max(frameLevel(frame), probabilities.isSpeech);
      setLevels((current) => [...current.slice(1), level]);
    },
  });

  useEffect(() => {
    setVadError(vad.errored || "");
  }, [vad.errored]);

  useEffect(() => {
    if (status === "recording") {
      void vad.start();
    } else {
      void vad.pause();
    }
  }, [status, vad.start, vad.pause]);

  const fetchFirstTurn = async (baseSession) => {
    return conversationRequest({
        action: "start",
        targets: baseSession.targets,
        tracking: baseSession.tracking,
        turnCount: 0,
        scenario: baseSession.scenario,
        voice: baseSession.voice,
    });
  };

  const playTutorAudio = async (data, fallbackStatus = "recording") => {
    if (data.audioBase64) {
      stopTutorAudio();
      setStatus("speaking");
      const player = new Audio(
        `data:${data.audioMimeType || "audio/mp3"};base64,${data.audioBase64}`,
      );
      audioPlayerRef.current = player;
      player.onended = () => {
        audioPlayerRef.current = null;
        setStatus(fallbackStatus);
      };
      player.onerror = () => {
        audioPlayerRef.current = null;
        setStatus(fallbackStatus);
      };
      await player.play();
    } else {
      setStatus(fallbackStatus);
    }
  };

  const submitAudio = async (audioBlob) => {
    if (!session) return;
    if (audioBlob.size < 1200) {
      setStatus("recording");
      return;
    }
    setStatus("thinking");
    try {
      const audio = await blobToBase64(audioBlob);
      const data = await conversationRequest({
        action: "turn",
        audio,
        mimeType: audioBlob.type,
        history: capHistory(session.history),
        targets: session.targets,
        tracking: session.tracking,
        turnCount: session.turnCount,
        scenario: session.scenario,
        voice: session.voice,
      });
      const nextHistory = capHistory([
        ...session.history,
        {
          role: "user",
          content: cleanConversationText(data.userTranscript),
          translation: data.userTranslation,
        },
        {
          role: "assistant",
          content: cleanConversationText(data.aiResponse),
          translation: data.aiTranslation,
        },
      ]);
      const tracking = mergeTracking(session.tracking, data.trackingUpdate);
      const nextSession = {
        ...session,
        history: nextHistory,
        tracking,
        turnCount: session.turnCount + 1,
        terminated: data.terminated,
      };
      setSession(nextSession);
      if (data.terminated) {
        await playTutorAudio(data, "idle");
        endSession(nextSession);
        return;
      }
      await playTutorAudio(data, "recording");
    } catch (error) {
      console.error(error);
      setStatus("recording");
      setSession((current) => ({
        ...current,
        error:
          error.message ||
          "Something went wrong while processing the conversation turn.",
      }));
    }
  };

  useEffect(() => {
    submitAudioRef.current = submitAudio;
  });

  const handleInterrupt = () => {
    stopTutorAudio();
    setStatus("recording");
  };

  const handleStopRecording = () => {
    manualStopPendingRef.current = true;
    void vad.pause().then(() => {
      if (!manualStopPendingRef.current || statusRef.current !== "recording") {
        return;
      }
      manualStopPendingRef.current = false;
      void vad.start();
    });
  };

  const requestFirstTurn = async (baseSession) => {
    setStatus("thinking");
    const data = await fetchFirstTurn(baseSession);
    setSession((current) => ({
      ...current,
      history: [
        {
          role: "assistant",
          content: cleanConversationText(data.aiResponse),
          translation: data.aiTranslation,
        },
      ],
      tracking: mergeTracking(current.tracking, data.trackingUpdate),
      voice: data.voice || current.voice,
    }));
    await playTutorAudio(data);
  };

  const startSession = async ({ words, grammar, scenario }) => {
    const targets = { words, grammar };
    const baseSession = {
      targets,
      tracking: makeTracking(targets),
      history: [],
      turnCount: 0,
      scenario,
      terminated: false,
      voice: null,
      error: "",
    };
    try {
      setStatus("thinking");
      if (vad.loading) {
        throw new Error("Voice detector is still loading. Please try again in a moment.");
      }
      if (vad.errored) {
        throw new Error(`Voice detector failed to load: ${vad.errored}`);
      }
      await vad.start();
      await vad.pause();
      const data = await fetchFirstTurn(baseSession);
      const hydratedSession = {
        ...baseSession,
        history: [
          {
            role: "assistant",
            content: cleanConversationText(data.aiResponse),
            translation: data.aiTranslation,
          },
        ],
        tracking: mergeTracking(baseSession.tracking, data.trackingUpdate),
        voice: data.voice || null,
        terminated: data.terminated,
      };
      setSession(hydratedSession);
      setReview(null);
      setReviewMode(false);
      setShowOnboarding(false);
      await playTutorAudio(data, data.terminated ? "idle" : "recording");
    } catch (caught) {
      await vad.pause();
      setStatus("idle");
      throw caught;
    }
  };

  const endSession = async (sessionOverride) => {
    const reviewSession = sessionOverride || session;
    stopTutorAudio();
    await vad.pause();
    setStatus("idle");
    setReviewMode(true);
    try {
      const data = await conversationRequest({
          action: "review",
          history: reviewSession?.history || [],
          targets: reviewSession?.targets,
          tracking: reviewSession?.tracking,
      });
      setReview(data);
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => () => {
    void vad.pause();
  }, [vad.pause]);

  if (reviewMode && session) {
    return (
      <Review
        session={session}
        review={review}
        onSameWords={() => {
          setReviewMode(false);
          setShowOnboarding(true);
        }}
        onChangeTargets={() => {
          setSession(null);
          setReviewMode(false);
          setShowOnboarding(true);
        }}
      />
    );
  }

  return (
    <>
      {session && (
        <Conversation
          session={session}
          status={status}
          userSpeaking={vad.userSpeaking}
          levels={levels}
          vadError={vadError}
          onStopRecording={handleStopRecording}
          onEnd={endSession}
          onInterrupt={handleInterrupt}
        />
      )}
      {showOnboarding && (
        <Onboarding
          initialTargets={session}
          onStart={startSession}
        />
      )}
    </>
  );
}
