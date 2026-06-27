"use client";

/**
 * Chat — THE FORGE OS conversation surface.
 *
 * - Glassy message bubbles (user right, assistant left).
 * - Streams assistant replies token-by-token over SSE (lib/api.streamChat).
 * - Speaks replies via browser TTS (lib/voice.speak), with an API /tts fallback.
 * - Hands-free mic via Web Speech API; 📷 image attach routes to /vision.
 * - Drives a CoreState the parent uses to animate the CoreOrb.
 */

import { AnimatePresence, motion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import type { CoreState } from "./CoreOrb";
import { streamChat, tts, vision, type ChatTurn } from "@/lib/api";
import {
  isSpeechSynthesisSupported,
  playBase64Audio,
  speak,
  stopSpeaking,
  useSpeechRecognition,
} from "@/lib/voice";

export interface ChatSettings {
  name: string;
  persona: string;
  /** edge-tts voice name for the API fallback (e.g. "ja-JP-NanamiNeural"). */
  voice?: string;
  /** Speech rate multiplier (1.0 = normal). Browser TTS uses it directly;
      the API fallback converts it to a "+NN%" rate string. */
  rate?: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Optional preview for an attached image (data URL). */
  image?: string;
  pending?: boolean;
  error?: boolean;
}

export interface ChatProps {
  settings: ChatSettings;
  /** Lets the parent reflect listening/speaking/thinking on the CoreOrb. */
  onStateChange?: (state: CoreState) => void;
  /** Whether spoken replies are enabled (TTS). */
  voiceReplies?: boolean;
}

const HISTORY_LIMIT = 12;

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function Chat({ settings, onStateChange, voiceReplies = true }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingImage, setPendingImage] = useState<{ dataUrl: string; base64: string; mime: string } | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const cancelRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ttsSupported = useMemo(() => isSpeechSynthesisSupported(), []);

  const { supported: micSupported, listening, transcript, start: startMic, stop: stopMic, reset: resetMic } =
    useSpeechRecognition("ja-JP");

  // Mirror live transcript into the input while listening.
  useEffect(() => {
    if (listening && transcript) setInput(transcript);
  }, [listening, transcript]);

  // Derive + broadcast the orb state.
  const coreState: CoreState = listening
    ? "listening"
    : speaking
      ? "speaking"
      : streaming
        ? "thinking"
        : "idle";

  useEffect(() => {
    onStateChange?.(coreState);
  }, [coreState, onStateChange]);

  // Auto-scroll to the newest content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Cleanup any in-flight stream / speech on unmount.
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      stopSpeaking();
    };
  }, []);

  const buildHistory = useCallback((): ChatTurn[] => {
    return messages
      .filter((m) => !m.pending && !m.error && m.content.trim())
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));
  }, [messages]);

  /** Speak a completed assistant reply (browser TTS → API /tts fallback). */
  const speakReply = useCallback(
    async (text: string) => {
      if (!voiceReplies || !text.trim()) return;
      setSpeaking(true);
      const rate = settings.rate ?? 1.0;
      if (ttsSupported) {
        speak(text, { lang: "ja-JP", rate, onEnd: () => setSpeaking(false) });
        return;
      }
      // Fallback: ask the backend to synthesize (with chosen voice + rate).
      try {
        const pct = Math.round((rate - 1) * 100);
        const rateStr = `${pct >= 0 ? "+" : ""}${pct}%`;
        const audio = await tts({ text, voice: settings.voice, rate: rateStr });
        await playBase64Audio(audio);
      } catch {
        /* silent fallback */
      } finally {
        setSpeaking(false);
      }
    },
    [voiceReplies, ttsSupported, settings.voice, settings.rate],
  );

  /** Send a text turn (optionally with an attached image → /vision). */
  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !pendingImage) || streaming) return;

    if (listening) stopMic();
    resetMic();
    stopSpeaking();

    const image = pendingImage;
    const userMsg: Message = {
      id: uid(),
      role: "user",
      content: text || (image ? "(image)" : ""),
      image: image?.dataUrl,
    };
    const assistantMsg: Message = { id: uid(), role: "assistant", content: "", pending: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setPendingImage(null);
    setStreaming(true);

    // Image path → one-shot /vision (non-streaming) for multimodal understanding.
    if (image) {
      try {
        const reply = await vision({
          prompt: text || "この画像について説明してください。",
          imageBase64: image.base64,
          mime: image.mime,
        });
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: reply, pending: false } : m)),
        );
        void speakReply(reply);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Vision request failed.";
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: msg, pending: false, error: true } : m)),
        );
      } finally {
        setStreaming(false);
      }
      return;
    }

    // Text path → SSE streaming.
    const history = buildHistory();
    let acc = "";
    const handlers = streamChat(
      { message: text, history, persona: settings.persona || undefined, name: settings.name || undefined },
      (token) => {
        acc += token;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: acc, pending: false } : m)),
        );
      },
      (error) => {
        setStreaming(false);
        cancelRef.current = null;
        if (error && !acc) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id ? { ...m, content: `⚠ ${error}`, pending: false, error: true } : m,
            ),
          );
          return;
        }
        // Mark complete and speak the final reply.
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, pending: false } : m)));
        if (acc.trim()) void speakReply(acc);
      },
    );
    cancelRef.current = handlers.cancel;
  }, [input, pendingImage, streaming, listening, stopMic, resetMic, buildHistory, settings, speakReply]);

  const stopStreaming = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(false);
    stopSpeaking();
    setSpeaking(false);
  }, []);

  const toggleMic = useCallback(() => {
    if (!micSupported) return;
    if (listening) {
      stopMic();
    } else {
      stopSpeaking();
      startMic();
    }
  }, [micSupported, listening, startMic, stopMic]);

  const onPickImage = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
      setPendingImage({ dataUrl, base64, mime: file.type || "image/jpeg" });
    };
    reader.readAsDataURL(file);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter to send, Shift+Enter for newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const canSend = (input.trim().length > 0 || !!pendingImage) && !streaming;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Message list */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-2"
        aria-live="polite"
      >
        {messages.length === 0 && <EmptyState name={settings.name} />}

        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </AnimatePresence>
      </div>

      {/* Composer */}
      <div className="mt-2 shrink-0">
        {pendingImage && (
          <div className="mb-2 flex items-center gap-3 rounded-forge border border-panel bg-[var(--panel)] p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pendingImage.dataUrl}
              alt="attachment preview"
              className="h-12 w-12 rounded-md object-cover"
            />
            <span className="flex-1 truncate text-xs text-muted">Image attached — describe it or ask a question.</span>
            <button
              type="button"
              onClick={() => setPendingImage(null)}
              className="rounded-md px-2 py-1 text-xs text-muted transition hover:text-fg-strong"
              aria-label="Remove attachment"
            >
              ✕
            </button>
          </div>
        )}

        <div className="panel flex items-end gap-1.5 p-2">
          {/* Image attach */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg text-muted transition hover:bg-white/5 hover:text-fg-strong"
            aria-label="Attach image"
            title="Attach image"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2l1-1.6A1.5 1.5 0 0 1 9 3.7h6a1.5 1.5 0 0 1 1.3.7l1 1.6h1.2A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickImage}
          />

          {/* Text input */}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={listening ? "聞き取り中…" : "THE FORGE OS にメッセージ…"}
            className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
            style={{ scrollbarWidth: "none" }}
          />

          {/* Mic (hands-free) */}
          {micSupported && (
            <button
              type="button"
              onClick={toggleMic}
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg transition ${
                listening
                  ? "bg-[rgba(0,243,255,0.12)] text-[var(--accent)] shadow-cyan"
                  : "text-muted hover:bg-white/5 hover:text-fg-strong"
              }`}
              aria-label={listening ? "Stop listening" : "Start voice input"}
              title={listening ? "Stop listening" : "Voice input"}
            >
              {listening ? (
                <motion.span
                  animate={{ scale: [1, 1.18, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                >
                  <MicIcon />
                </motion.span>
              ) : (
                <MicIcon />
              )}
            </button>
          )}

          {/* Send / Stop */}
          {streaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-panel-strong text-fg-strong transition hover:shadow-glow"
              aria-label="Stop generating"
              title="Stop"
            >
              <span className="block h-3 w-3 rounded-[2px] bg-[var(--accent)]" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canSend}
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg transition ${
                canSend
                  ? "border border-[var(--line)] text-fg-strong shadow-glow hover:shadow-glow-strong"
                  : "border border-panel text-muted/50"
              }`}
              aria-label="Send message"
              title="Send"
            >
              ➤
            </button>
          )}
        </div>

        {/* Footer hint / speaking indicator */}
        <div className="mt-1.5 flex h-4 items-center justify-center gap-2 px-1">
          {speaking ? (
            <span className="text-[10px] tracking-[0.2em] text-[var(--accent)] label-mono">SPEAKING…</span>
          ) : listening ? (
            <span className="text-[10px] tracking-[0.2em] text-[var(--accent)] label-mono">LISTENING…</span>
          ) : (
            <span className="text-[10px] tracking-[0.18em] text-muted/50 label-mono">
              {micSupported ? "ENTERで送信 · ハンズフリー対応" : "ENTERで送信"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={[
          "max-w-[85%] rounded-forge border px-3.5 py-2.5 text-sm leading-relaxed sm:max-w-[78%]",
          "backdrop-blur-md",
          isUser
            ? "border-panel-strong bg-[rgba(255,255,255,0.07)] text-fg-strong"
            : "border-panel bg-[rgba(150,200,255,0.06)] text-fg shadow-glow",
          message.error ? "border-[rgba(255,120,120,0.45)] text-[#ffb4b4]" : "",
        ].join(" ")}
      >
        {message.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={message.image}
            alt="user attachment"
            className="mb-2 max-h-56 w-full rounded-lg object-cover"
          />
        )}
        {message.pending && !message.content ? (
          <TypingDots />
        ) : (
          <span className={message.role === "assistant" && message.pending ? "caret" : ""}>
            {message.content}
          </span>
        )}
      </div>
    </motion.div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="Assistant is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 rounded-full bg-[rgba(150,200,255,0.9)]"
          style={{ animation: `dot-bounce 1.2s ease-in-out ${i * 0.18}s infinite` }}
        />
      ))}
    </span>
  );
}

function EmptyState({ name }: { name: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.2 }}
      className="flex h-full flex-col items-center justify-center px-6 text-center"
    >
      <p className="label-mono text-glow text-sm text-fg-strong">{`${name} ONLINE`}</p>
      <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted">
        話しかけるか入力して始めてください。画像を添付すればコアが解析します。マイクでハンズフリー会話もできます。
      </p>
    </motion.div>
  );
}
