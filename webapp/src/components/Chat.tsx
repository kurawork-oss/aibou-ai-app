"use client";

/**
 * Chat — THE FORGE OS conversation surface.
 *
 * - Glassy message bubbles (user right, assistant left).
 * - Streams assistant replies token-by-token over SSE (lib/api.streamChat).
 * - 返答は lib/coreVoice で読み上げる。受信しながら文単位で喋るので、長い
 *   返答でも最初の文からすぐ声が出る。記号・絵文字は読み上げない。
 * - Hands-free mic via Web Speech API; 📷 image attach routes to /vision.
 * - Drives a CoreState the parent uses to animate the CoreOrb.
 */

import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import type { CoreState } from "./CoreOrb";
import AgentTrace, { type AgentStep as TraceStep } from "@/components/AgentTrace";
import Markdown from "@/components/Markdown";
import {
  API_URL,
  streamChat, vision, agentActStream, agentExecute,
  conversationsList, conversationGet, conversationSave, conversationDelete,
  capabilities, runCommand, setupPending, setupResume,
  type ChatTurn, type AgentEvent, type CommandItem, type CommandResult,
  type MadeItem,
} from "@/lib/api";
import CommandPalette, { readHashInput } from "@/components/CommandPalette";
import Canvas, { pushItem } from "@/components/Canvas";
import { PACKS_CHANGED } from "@/lib/shell";
import { useSpeechRecognition } from "@/lib/voice";
import { speakCore, stopCoreVoice, type CoreVoiceSettings, type VoiceEngine } from "@/lib/coreVoice";
import { takeCompleteSentences } from "@/lib/speech";
import * as memory from "@/lib/memory";
import { trimHistory } from "@/lib/history";

export interface ChatSettings {
  name: string;
  persona: string;
  /** サーバー音声（edge-tts）の声。例 "ja-JP-NanamiNeural"。 */
  voice?: string;
  /** 端末に入っている音声の名前（SpeechSynthesisVoice.name）。 */
  browserVoice?: string;
  /** 声の出どころ。browser=端末の音声（すぐ鳴る） / server=edge-tts（なめらか）。 */
  voiceEngine?: VoiceEngine;
  /** 話す速さ（1.0 が等倍）。 */
  rate?: number;
  /** 声の高さ（1.0 が標準）。 */
  pitch?: number;
}

/** エージェントの実行過程（考えた→道具を使った→結果を見た）。 */
/** 経過表示の型と見た目は AgentTrace に集約した（HOMEと揃えるため）。
 *  他のファイルが Chat から import しているので、ここから出し直す。 */
export type AgentStep = TraceStep;

/** 承認待ちの操作（メール送信など、取り消せないもの）。 */
interface PendingAct {
  tool: string;
  params: Record<string, unknown>;
  note?: string;
  /** 危なさ（0 読むだけ / 1 中が変わる / 2 外に残る / 3 取り返せない）。 */
  level?: number;
  levelLabel?: string;
  /** 何が起きるのか（「送ったメールは取り消せません」など）。 */
  why?: string;
  /** 承認モードを切っていても必ず聞く操作か。 */
  alwaysConfirm?: boolean;
  /** 危なさではなく、外のページを読んだ後の連鎖で聞いている。 */
  chained?: boolean;
}

/**
 * 連携が足りなくて止まったときの案内。
 *
 * ここで会話を終わらせないのが肝。用事はサーバー側で預かってあるので、
 * 繋いで戻れば続きから進む。
 */
interface NeedSetup {
  provider: string;
  label: string;
  connectPath: string;
  canConnect: boolean;
  needsOwner: boolean;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Optional preview for an attached image (data URL). */
  image?: string;
  /** 連携が足りなくて止まったとき、その案内。 */
  need?: NeedSetup;
  pending?: boolean;
  error?: boolean;
  /** エージェントとして動いたターンの実行記録（会話ターンでは undefined）。 */
  steps?: AgentStep[];
  /** そのターン全体でかかった時間（ミリ秒）。遅さの原因を後から辿れるように残す。 */
  totalMs?: number;
  /** このターンで承認を待っている操作。 */
  await?: PendingAct;
}

export interface ChatProps {
  settings: ChatSettings;
  /** Lets the parent reflect listening/speaking/thinking on the CoreOrb. */
  onStateChange?: (state: CoreState) => void;
  /** Whether spoken replies are enabled (TTS). */
  voiceReplies?: boolean;
  /**
   * `#ボード` のように「画面を開く」近道を押されたときの行き先。
   *
   * これが無いと、`#` は画面ものには使えず「管理タブから探してください」と
   * 返すだけになる。案内を出すために近道を作ったわけではないので、
   * ここは実際に開く。
   */
  onOpenView?: (view: string) => void;
}

const HISTORY_LIMIT = 12;
const LS_CONVOS = "forge_chat_convos";
const CONVO_LIMIT = 40;

interface Convo {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadConvos(): Convo[] {
  try {
    const raw = localStorage.getItem(LS_CONVOS);
    return raw ? (JSON.parse(raw) as Convo[]) : [];
  } catch {
    return [];
  }
}

function saveConvos(convos: Convo[]): void {
  // localStorage(≈5MB)を枯渇させない: 溢れたら古い会話の画像→古い会話ごと退避。
  let list = convos.slice(0, CONVO_LIMIT);
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      localStorage.setItem(LS_CONVOS, JSON.stringify(list));
      return;
    } catch {
      const withImages = [...list].reverse().find((c) => c.messages.some((m) => m.image));
      if (withImages) {
        list = list.map((c) =>
          c.id === withImages.id
            ? { ...c, messages: c.messages.map((m) => ({ ...m, image: undefined })) }
            : c,
        );
      } else if (list.length > 1) {
        list = list.slice(0, -1); // 最古を落とす
      } else {
        return; // これ以上は諦める（クラッシュはしない）
      }
    }
  }
}

export default function Chat({ settings, onStateChange, voiceReplies = true, onOpenView }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // # の候補と、直行したときの一言
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [note, setNote] = useState("");
  // 司令塔モード：会話ではなく、道具を使って実際に動く（HOMEのエージェントと同じ）
  const [agentMode, setAgentMode] = useState(false);
  const [approval, setApproval] = useState(true);   // 取り消せない操作は実行前に確認
  const actedRef = useRef(false);

  /* ── 作った物（会話の隣に出す） ───────────────────────────────
     画像・資料・スライド・検索結果は、吹き出しに入れると見られない。
     出来た物はここに積んで、キャンバスに出す。            */
  const [madeItems, setMadeItems] = useState<MadeItem[]>([]);
  const [canvasOpen, setCanvasOpen] = useState(false);

  /** 出来た物を受け取る。**出たら開く**（作った物を隠さない）。 */
  const made = useCallback((item: MadeItem) => {
    setMadeItems((prev) => pushItem(prev, item));
    setCanvasOpen(true);
  }, []);

  /* キャンバスは会話にかぶせるが、**入力欄は残す**。
     見た直後にやりたいのはたいてい「直して」「もっと」なので、
     いちいち閉じさせない。入力欄の高さは中身（画像を貼った・
     用事を預かった等）で変わるので、その都度測る。 */
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [composerH, setComposerH] = useState(0);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // 画面の下端から入力欄の上端までの高さ（下のナビも含まれる）
      setComposerH(Math.max(0, Math.round(window.innerHeight - r.top)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  // モードは覚えておく（毎回切り替えるのは面倒）
  useEffect(() => {
    try {
      setAgentMode(localStorage.getItem("forge_chat_agent") === "1");
      setApproval(localStorage.getItem("forge_chat_approval") !== "0");
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("forge_chat_agent", agentMode ? "1" : "0");
      localStorage.setItem("forge_chat_approval", approval ? "1" : "0");
    } catch { /* ignore */ }
  }, [agentMode, approval]);
  const [pendingImage, setPendingImage] = useState<{ dataUrl: string; base64: string; mime: string } | null>(null);
  const [speaking, setSpeaking] = useState(false);

  /* ── 読み上げの状態 ────────────────────────────────────────────────
     受信しながら文単位で喋るので、「いま鳴っている音」と「順番待ち」の
     両方を持つ。止めるときは必ず両方消すこと（順番待ちが残っていると、
     止めたはずの返答が後から喋り出す）。                                */
  const cancelSpeechRef = useRef<(() => void) | null>(null);
  const spokenUpTo = useRef(0);
  const speakQueue = useRef<string[]>([]);
  const speakBusy = useRef(false);

  /** 読み上げを完全に止める（鳴っている音・順番待ち・読んだ位置を全部消す）。 */
  const stopReply = useCallback(() => {
    cancelSpeechRef.current?.();
    cancelSpeechRef.current = null;
    stopCoreVoice();
    speakQueue.current = [];
    speakBusy.current = false;
    spokenUpTo.current = 0;
    setSpeaking(false);
  }, []);

  // Conversation history (Gemini-style left sidebar).
  const [convos, setConvos] = useState<Convo[]>([]);
  const [currentId, setCurrentId] = useState<string>(() => uid());
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => { setConvos(loadConvos()); }, []);

  // 履歴はこれまで端末の中（localStorage）にしか無かったので、
  // 端末を変えると全部消えていた。自分のDBにも残し、開いたときに取り込む。
  // 手元の控えは残す（オフラインでも読めるし、保存先が無くても会話はできる）。
  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    conversationsList()
      .then((remote) => {
        if (!alive || remote.length === 0) return;
        setConvos((prev) => {
          const known = new Set(prev.map((c) => c.id));
          const extra: Convo[] = remote
            .filter((r) => !known.has(r.id))
            .map((r) => ({
              id: r.id,
              title: r.title || "新しいチャット",
              messages: [],                       // 本文は開いたときに取りに行く
              updatedAt: Date.parse(r.updated_at || "") || 0,
            }));
          if (extra.length === 0) return prev;
          const next = [...prev, ...extra].sort((a, b) => b.updatedAt - a.updatedAt);
          saveConvos(next);
          return next;
        });
      })
      .catch(() => { /* 取れなくても手元の控えで動く */ });
    return () => { alive = false; };
  }, []);

  // Persist the current conversation once it has settled (not mid-stream).
  useEffect(() => {
    if (streaming) return;
    const meaningful = messages.filter((m) => !m.pending && m.content.trim());
    if (meaningful.length === 0) return;
    setConvos((prev) => {
      const title = (meaningful.find((m) => m.role === "user")?.content || "新しいチャット").slice(0, 30);
      const entry: Convo = { id: currentId, title, messages, updatedAt: Date.now() };
      const next = prev.some((c) => c.id === currentId)
        ? prev.map((c) => (c.id === currentId ? entry : c))
        : [entry, ...prev];
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      saveConvos(next);
      return next;
    });

    // 自分のDBにも残す。失敗しても会話は続けられるよう、ここでは黙って諦める
    // （保存先が無い場合は、他の画面が理由つきで教えてくれる）。
    if (API_URL) {
      const title = (meaningful.find((m) => m.role === "user")?.content || "").slice(0, 60);
      void conversationSave(
        currentId,
        meaningful.map((m) => ({ role: m.role, content: m.content })),
        title,
      ).catch(() => {});
    }
  }, [messages, streaming, currentId]);

  const newChat = useCallback(() => {
    cancelRef.current?.();
    speechCancelledRef.current = true;
    stopReply();
    setMessages([]);
    setInput("");
    setPendingImage(null);
    setCurrentId(uid());
    setHistoryOpen(false);
  }, [stopReply]);

  const loadConvo = useCallback((id: string) => {
    const c = loadConvos().find((x) => x.id === id);
    cancelRef.current?.();
    speechCancelledRef.current = true;
    stopReply();
    setCurrentId(id);
    setHistoryOpen(false);

    if (c && c.messages.length > 0) {
      setMessages(c.messages.map((m) => ({ ...m, pending: false })));
      return;
    }
    // 他の端末で作った会話は、手元には見出ししかない。本文を取りに行く。
    if (!API_URL) { setMessages([]); return; }
    setMessages([]);
    void conversationGet(id)
      .then((body) => {
        if (!body) return;
        // サーバー側は role/content だけを持つ（画像や実行記録は端末の控えのみ）。
        // 画面が使う形に足りない項目を補う。
        setMessages(body.messages.map((m, i) => ({
          id: `${id}-${i}`, role: m.role, content: m.content, pending: false,
        })));
      })
      .catch(() => {});
  }, [stopReply]);

  const deleteConvo = useCallback((id: string) => {
    if (!window.confirm("この履歴を削除しますか？（元に戻せません）")) return;
    setConvos((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConvos(next);
      return next;
    });
    if (API_URL) void conversationDelete(id).catch(() => {});
    if (id === currentId) {
      setMessages([]);
      setCurrentId(uid());
    }
  }, [currentId]);

  const cancelRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  // Auto-scroll to the newest content — but only when the user is already
  // near the bottom, so scrolling up to re-read isn't yanked back per token.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Cleanup any in-flight stream / speech on unmount.
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      stopReply();
    };
  }, [stopReply]);

  const buildHistory = useCallback((): ChatTurn[] => {
    // 長さの上限で刈る。返事が出始めるまでの時間は送った文章の長さで伸びる
    // ので、長い生成物が混じったときだけ古いほうを落とす（普通の会話は素通り）。
    return trimHistory(
      messages
        .filter((m) => !m.pending && !m.error && m.content.trim())
        .slice(-HISTORY_LIMIT)
        .map((m) => ({ role: m.role, content: m.content })),
    ) as ChatTurn[];
  }, [messages]);

  // Set when the user stops generation / switches conversations — a reply
  // that finishes after that must not be spoken into the new context.
  const speechCancelledRef = useRef(false);

  // ── リアルタイム会話モード（話す→自動送信→返答を読み上げ→再びマイク） ──
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(false);
  useEffect(() => { voiceModeRef.current = voiceMode; }, [voiceMode]);

  /** 設定を読み上げ側の形にまとめる。 */
  const voiceSettings = useMemo<CoreVoiceSettings>(() => ({
    engine: settings.voiceEngine ?? "browser",
    browserVoice: settings.browserVoice,
    serverVoice: settings.voice,
    rate: settings.rate ?? 1.0,
    pitch: settings.pitch ?? 1.0,
  }), [settings.voiceEngine, settings.browserVoice, settings.voice, settings.rate, settings.pitch]);

  /** 読み上げてよい状態か。会話モード中は設定に関わらず読む（会話が成立しないため）。 */
  const maySpeak = useCallback(
    () => !speechCancelledRef.current && (voiceReplies || voiceModeRef.current),
    [voiceReplies],
  );

  /** 返答（またはその一部）を読み上げる。 */
  const speakReply = useCallback(
    (text: string) => {
      if (!maySpeak() || !text.trim()) return;
      setSpeaking(true);
      cancelSpeechRef.current = speakCore(
        text,
        voiceSettings,
        { onEnd: () => setSpeaking(false) },
        Boolean(API_URL),
      );
    },
    [maySpeak, voiceSettings],
  );

  /* ── 受信しながら読み上げる ────────────────────────────────────────
     全部受け取ってから読み始めると、長い返答ほど黙っている時間が長くなる。
     言い切った文が出るたびに順番待ちへ積んで、1文めからすぐ喋り始める。   */

  /** 順番待ちを1つずつ流す。読み終わるたびに次を鳴らす。 */
  const drainSpeech = useCallback(() => {
    if (speakBusy.current || !speakQueue.current.length) return;
    if (!maySpeak()) { speakQueue.current = []; return; }
    speakBusy.current = true;
    setSpeaking(true);
    const next = speakQueue.current.shift() as string;
    cancelSpeechRef.current = speakCore(
      next,
      voiceSettings,
      {
        onEnd: () => {
          speakBusy.current = false;
          if (speakQueue.current.length) drainSpeech();
          else setSpeaking(false);
        },
      },
      Boolean(API_URL),
    );
  }, [maySpeak, voiceSettings]);

  /** 受信済みの全文を渡す。まだ読んでいない「言い切った文」だけを喋る。 */
  const feedSpeech = useCallback((acc: string) => {
    if (!maySpeak()) return;
    const { chunks, consumed } = takeCompleteSentences(acc.slice(spokenUpTo.current));
    if (!consumed) return;
    spokenUpTo.current += consumed;
    if (chunks.length) { speakQueue.current.push(...chunks); drainSpeech(); }
  }, [maySpeak, drainSpeech]);

  /** 受信し終わったとき、句点で終わっていない残りを読む。 */
  const flushSpeech = useCallback((acc: string) => {
    if (!maySpeak()) return;
    const rest = acc.slice(spokenUpTo.current);
    spokenUpTo.current = acc.length;
    // 末尾に改行を足して「言い切った」扱いにする
    const { chunks } = takeCompleteSentences(`${rest}\n`);
    if (chunks.length) { speakQueue.current.push(...chunks); drainSpeech(); }
  }, [maySpeak, drainSpeech]);

  /** Execute one assistant turn (vision or SSE stream) into the given bubble.
      Shared by send() and regenerate(). */
  const runTurn = useCallback(
    async (
      text: string,
      image: { base64: string; mime: string } | null,
      assistantId: string,
      history: ChatTurn[],
    ) => {
      // Image path → one-shot /vision (non-streaming) for multimodal understanding.
      if (image) {
        try {
          const reply = await vision({
            prompt: text || "この画像について説明してください。",
            imageBase64: image.base64,
            mime: image.mime,
          });
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: reply, pending: false } : m)),
          );
          void speakReply(reply);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Vision request failed.";
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: msg, pending: false, error: true } : m)),
          );
        } finally {
          setStreaming(false);
        }
        return;
      }

      // 司令塔モード → 道具を使って実際に動く（会話ではなく実行）。
      // 実行過程を同じ吹き出しの中に出すので、会話の流れが途切れない。
      if (agentMode) {
        actedRef.current = false;
        const setSteps = (fn: (prev: AgentStep[]) => AgentStep[]) =>
          setMessages((prev) => prev.map((m) => (
            m.id === assistantId ? { ...m, steps: fn(m.steps ?? []), pending: false } : m)));
        cancelRef.current = agentActStream(
          text, history, settings.name || undefined, approval,
          (ev: AgentEvent) => {
            switch (ev.phase) {
              case "prepare":
                // 返事が始まる前の工程。ここが重いとそのまま待ち時間になるので出す。
                setSteps((s) => [...s.filter((x) => x.kind !== "thinking"),
                  { kind: "prepare", what: ev.what || "準備", detail: ev.detail, ms: ev.ms }]);
                break;
              case "thinking":
                setSteps((s) => [...s.filter((x) => x.kind !== "thinking"), { kind: "thinking" }]);
                break;
              case "tool":
                actedRef.current = true;
                setSteps((s) => [...s.filter((x) => x.kind !== "thinking"),
                  { kind: "tool", tool: ev.tool || "", note: ev.note, ms: ev.ms }]);
                break;
              case "observation":
                setSteps((s) => [...s, { kind: "observation", result: ev.result || "", ms: ev.ms }]);
                break;
              case "show":
                // その手で出来た物を、隣のキャンバスに出す。
                // 文章で「作りました。HOMEの生成物から見てください」と
                // 案内していた所。作った物は、ここで受け取れるようにする。
                if (ev.item) made(ev.item);
                break;
              case "approval":
                setSteps((s) => s.filter((x) => x.kind !== "thinking"));
                setMessages((prev) => prev.map((m) => (m.id === assistantId
                  ? { ...m, pending: false, await: {
                      tool: ev.tool || "", params: ev.params || {}, note: ev.note,
                      level: ev.level, levelLabel: ev.level_label, why: ev.why,
                      alwaysConfirm: ev.always_confirm,
                      chained: ev.chained,
                    } }
                  : m)));
                break;
              case "setup_required":
                // 「設定してきてください」で終わらせない。繋ぐボタンを出す。
                // 用事はサーバーが預かっているので、戻れば続きから進む。
                setSteps((s) => s.filter((x) => x.kind !== "thinking"));
                setMessages((prev) => prev.map((m) => (m.id === assistantId
                  ? { ...m, pending: false, need: {
                      provider: ev.provider || "", label: ev.label || "",
                      connectPath: ev.connect_path || "",
                      canConnect: Boolean(ev.can_connect),
                      needsOwner: Boolean(ev.needs_owner),
                    } }
                  : m)));
                break;
              case "error":
                setSteps((s) => [...s.filter((x) => x.kind !== "thinking"),
                  { kind: "error", detail: ev.detail || "エラー" }]);
                break;
              case "final":
                setSteps((s) => s.filter((x) => x.kind !== "thinking"));
                setMessages((prev) => prev.map((m) => (
                  m.id === assistantId ? { ...m, content: ev.text || "", pending: false } : m)));
                break;
              case "done":
                setMessages((prev) => prev.map((m) => (
                  m.id === assistantId ? { ...m, totalMs: ev.total_ms } : m)));
                break;
            }
          },
          (error) => {
            setStreaming(false);
            cancelRef.current = null;
            if (error) {
              setMessages((prev) => prev.map((m) => (m.id === assistantId
                ? { ...m, content: m.content || `⚠ ${error}`, pending: false, error: !m.content }
                : m)));
              return;
            }
            setMessages((prev) => {
              const done = prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m));
              const me = done.find((m) => m.id === assistantId);
              // 音声モードでも結果を読み上げる（会話ターンと同じ扱い）
              if (me?.content?.trim()) void speakReply(me.content);
              return done;
            });
          },
        ).cancel;
        return;
      }

      /* 端末の中の記憶から、この話に関係する物を引く。
         サーバー側にも記憶はあるが、そちらは Supabase が要る。繋いでいない
         人・圏外の人にとっては、これが唯一の記憶になる。
         引けなくても会話は止めない（記憶は「あれば効く」物）。 */
      let localMemory = "";
      try {
        localMemory = (await memory.search(text, 6)).block;
      } catch {
        localMemory = "";
      }
      /* この発言自体も覚えておく。本人が言ったことは、あとで効く度合いが
         いちばん高い（好み・予定・体質など）。返答のほうは長くて要約でも
         あるので、いまは取らない。 */
      void memory.add(text, { source: "me", kind: "note" }).catch(() => null);

      // Text path → SSE streaming.
      let acc = "";
      spokenUpTo.current = 0;          // このターンの読み上げ位置を初期化
      const handlers = streamChat(
        { message: text, history, persona: settings.persona || undefined,
          name: settings.name || undefined, memory: localMemory },
        (token) => {
          acc += token;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: acc, pending: false } : m)),
          );
          // 言い切った文から順に喋る（受信し終わるまで黙らない）
          feedSpeech(acc);
        },
        (error) => {
          setStreaming(false);
          cancelRef.current = null;
          if (error && !acc) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: `⚠ ${error}`, pending: false, error: true } : m,
              ),
            );
            return;
          }
          // Mark complete and speak whatever is still unspoken.
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
          if (acc.trim()) flushSpeech(acc);
        },
      );
      cancelRef.current = handlers.cancel;
    },
    [settings, speakReply, feedSpeech, flushSpeech, agentMode, approval, made],
  );

  /** 承認待ちの操作を実行する（メール送信など、取り消せないもの）。 */
  const approveAct = useCallback(async (msgId: string) => {
    let act: PendingAct | undefined;
    setMessages((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      act = m.await;
      return { ...m, await: undefined,
        steps: [...(m.steps ?? []), { kind: "tool" as const, tool: act?.tool ?? "", note: act?.note }] };
    }));
    if (!act) return;
    try {
      const { result, show } = await agentExecute(act.tool, act.params);
      setMessages((prev) => prev.map((m) => (m.id === msgId
        ? { ...m, steps: [...(m.steps ?? []), { kind: "observation" as const, result }] } : m)));
      for (const it of show) made(it);
      actedRef.current = true;
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === msgId
        ? { ...m, steps: [...(m.steps ?? []), { kind: "error" as const, detail: "実行に失敗しました" }] } : m)));
    }
  }, [made]);

  /** 承認待ちの操作をやめる（実行しない）。 */
  const rejectAct = useCallback((msgId: string) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId
      ? { ...m, await: undefined,
          steps: [...(m.steps ?? []), { kind: "observation" as const, result: "（実行しませんでした）" }] }
      : m)));
  }, []);

  /** Send a text turn (optionally with an attached image → /vision). */
  /* ── # の近道 ──────────────────────────────────────────────
     ふつうに「猫の絵を描いて」と書くとAIが道具を選ぶ。融通は利くが一手待つ。
     `#画像 猫の絵` はその一手を飛ばして直行する。速くて結果が読める。
     ただし # は近道であって必須ではない。知らないコマンドや、1つの文から
     機械的に割れない物（#予定 明日15時に歯医者）は、ふつうの頼みごととして
     AIへ回す。ここが崩れると「呪文を覚えないと使えないアプリ」になる。 */
  const hash = readHashInput(input);

  const runShortcut = useCallback(async (text: string): Promise<boolean> => {
    let res: CommandResult;
    try {
      res = await runCommand(text);
    } catch {
      return false;                      // 通信が駄目ならAIに回す
    }
    if (res.unknown || res.kind === "delegate") return false;

    if (res.kind === "needs_arg") {
      setInput(`${text.replace(/[\s　]+$/, "")} `);
      setNote(res.message ?? "");
      return true;
    }
    if (res.kind === "view") {
      // 画面ものは、その場で開く。開けないときだけ在り処を言う
      // （近道が「探してください」で終わるなら、近道ではない）。
      if (res.view && onOpenView) {
        setInput("");
        setNote("");
        onOpenView(res.view);
      } else {
        setNote(`「${res.label}」は管理タブから開けます。`);
      }
      return true;
    }
    // 直行できた。会話にも残す（あとから何をしたか読み返せるように）
    setMessages((prev) => [...prev,
      { id: uid(), role: "user", content: text },
      { id: uid(), role: "assistant", content: res.result ?? "" }]);
    // 近道で出来た物も、AI経由と同じようにキャンバスへ
    for (const it of res.show ?? []) made(it);
    setInput("");
    return true;
  }, [onOpenView, made]);

  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    const load = () => {
      capabilities()
        .then((d) => { if (alive) setCommands(d.commands); })
        .catch(() => { /* # が出ないだけ。会話はふつうに動く */ });
    };
    load();
    // 設定で「使う機能」を変えたら入れ替える。1回だけ取っていたので、
    // 「開発」を切ったあとも `#コード` が候補に残っていた。
    window.addEventListener(PACKS_CHANGED, load);
    return () => { alive = false; window.removeEventListener(PACKS_CHANGED, load); };
  }, []);

  /* ── 連携から戻ってきたとき ──────────────────────────────────
     別のタブで許可して戻ってくると、サーバーには用事が預かってある。
     ここで拾って「続きをやりますか」を出す。拾わないと、利用者は
     さきほどの頼みごとをもう一度言うことになる。それが設定でいちばん
     いらない手間だった。

     勝手に実行はしない。送信のような取り返せない操作が、繋いだ瞬間に
     黙って走るのがいちばん怖いので、押してもらう。 */
  const [held, setHeld] = useState<{ instruction: string } | null>(null);

  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    const check = () => {
      setupPending()
        .then((d) => { if (alive) setHeld(d.waiting && d.instruction ? { instruction: d.instruction } : null); })
        .catch(() => { /* 拾えなくても会話は動く */ });
    };
    check();
    // 別のタブで許可して戻ってきた瞬間に気づけるように
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !pendingImage) || streaming) return;

    // # で始まるなら、まず直行を試す。駄目ならそのままAIへ。
    if (!pendingImage && (text.startsWith("#") || text.startsWith("＃"))) {
      if (await runShortcut(text)) return;
    }

    if (listening) stopMic();
    resetMic();
    stopReply();

    speechCancelledRef.current = false;
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

    const history = buildHistory();
    await runTurn(text, image ? { base64: image.base64, mime: image.mime } : null, assistantMsg.id, history);
  }, [input, pendingImage, streaming, listening, stopMic, resetMic, buildHistory,
      runTurn, stopReply, runShortcut]);

  /** 会話モード開始：マイクを開き、以後は 無音→自動送信→読み上げ→再びマイク のループ。 */
  const enterVoiceMode = useCallback(() => {
    if (!micSupported) return;
    speechCancelledRef.current = false;
    setVoiceMode(true);
    setInput("");
    resetMic();
    startMic();
  }, [micSupported, resetMic, startMic]);

  const exitVoiceMode = useCallback(() => {
    setVoiceMode(false);
    stopMic();
    resetMic();
    stopReply();
    setSpeaking(false);
    setInput("");
  }, [stopMic, resetMic, stopReply]);

  // 割り込み（バージイン）：AIの発話/生成を止めて、すぐ自分が話せる状態に戻す。
  const interruptVoice = useCallback(() => {
    cancelRef.current?.();               // 生成中なら中断
    speechCancelledRef.current = true;   // 遅れて来る応答を読み上げさせない
    stopReply();
    setSpeaking(false);
    setStreaming(false);
    setTimeout(() => { if (voiceModeRef.current) { resetMic(); startMic(); } }, 150);
  }, [resetMic, startMic, stopReply]);

  // 会話モード：発話が止まって約1.4秒たったら自動送信（テンポよくラリー）。
  useEffect(() => {
    if (!voiceMode || !listening || streaming) return;
    const text = transcript.trim();
    if (text.length < 1) return;
    const t = setTimeout(() => { void send(); }, 1400);
    return () => clearTimeout(t);
  }, [voiceMode, listening, streaming, transcript, send]);

  // 会話モード：読み上げが終わったら次のターンのためにマイクを再開。
  // （streaming→speaking は同一レンダーで切り替わるので、TTSを拾う隙間はない）
  useEffect(() => {
    if (!voiceMode || speaking || streaming || listening) return;
    const t = setTimeout(() => {
      if (voiceModeRef.current) { resetMic(); startMic(); }
    }, 500);
    return () => clearTimeout(t);
  }, [voiceMode, speaking, streaming, listening, resetMic, startMic]);

  /** ChatGPT-style 再生成 — re-run the latest user turn into a fresh bubble. */
  const regenerate = useCallback(async () => {
    if (streaming) return;
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx < 0) return;
    const userMsg = messages[lastUserIdx];
    stopReply();
    setSpeaking(false);
    speechCancelledRef.current = false;

    const kept = messages.slice(0, lastUserIdx + 1);
    const assistantMsg: Message = { id: uid(), role: "assistant", content: "", pending: true };
    setMessages([...kept, assistantMsg]);
    setStreaming(true);

    // History = clean turns BEFORE the regenerated user message.
    const history: ChatTurn[] = kept
      .slice(0, -1)
      .filter((m) => !m.pending && !m.error && m.content.trim())
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));

    // Rebuild the vision payload from the stored data-URL if the turn had an image.
    let image: { base64: string; mime: string } | null = null;
    if (userMsg.image) {
      const comma = userMsg.image.indexOf(",");
      const semi = userMsg.image.indexOf(";");
      image = {
        base64: comma >= 0 ? userMsg.image.slice(comma + 1) : "",
        mime: semi > 5 ? userMsg.image.slice(5, semi) : "image/jpeg",
      };
    }
    const text = userMsg.content === "(image)" ? "" : userMsg.content;
    await runTurn(text, image, assistantMsg.id, history);
  }, [messages, streaming, runTurn, stopReply]);

  const stopStreaming = useCallback(() => {
    speechCancelledRef.current = true;
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(false);
    stopReply();
    setSpeaking(false);
  }, [stopReply]);

  const toggleMic = useCallback(() => {
    if (!micSupported) return;
    if (listening) {
      stopMic();
    } else {
      stopReply();
      startMic();
    }
  }, [micSupported, listening, startMic, stopMic, stopReply]);

  // Shared: turn a File/Blob (from the picker OR a pasted screenshot) into a
  // downscaled data-URL attachment for /vision + preview.
  const processImageFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || "");
      // 縮小してから保持（表示・vision・localStorage 全部この小さい版を使う）。
      // 生の写真(数MB)を data URL のまま履歴に入れると localStorage が即枯渇する。
      const img = new Image();
      img.onload = () => {
        const MAX = 640;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        let dataUrl = src;
        let mime = file.type || "image/jpeg";
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL("image/jpeg", 0.72);
          mime = "image/jpeg";
        }
        const comma = dataUrl.indexOf(",");
        setPendingImage({ dataUrl, base64: comma >= 0 ? dataUrl.slice(comma + 1) : "", mime });
      };
      img.onerror = () => {
        const comma = src.indexOf(",");
        setPendingImage({ dataUrl: src, base64: comma >= 0 ? src.slice(comma + 1) : "", mime: file.type || "image/jpeg" });
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }, []);

  const onPickImage = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (file) processImageFile(file);
  }, [processImageFile]);

  // Paste a screenshot (Ctrl/Cmd+V) directly into the composer.
  const onPasteImage = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) { e.preventDefault(); processImageFile(file); break; }
      }
    }
  }, [processImageFile]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Never submit mid-IME composition (Japanese conversion Enter).
      if (e.nativeEvent.isComposing) return;
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
    <div
      /* PCではキャンバスが右半分に出る。会話がその下に潜ると読めなくなる
         ので、開いているあいだは残りの幅で中央に寄せ直す（実測で入力欄の
         右端がキャンバスの左端を91px越えていた）。
         スマホはかぶせる形なので、ここは効かせない。 */
      className={`relative flex h-full min-h-0 w-full justify-center transition-[margin] duration-200 ${
        canvasOpen ? "lg:mr-[42vw] lg:max-w-[calc(100%-42vw)]" : ""
      }`}
    >
      {/* Full-height left history panel + bottom-left toggle (chat only). */}
      <ChatHistory
        convos={convos}
        currentId={currentId}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onNew={newChat}
        onPick={loadConvo}
        onDelete={deleteConvo}
      />

      {/* Conversation column — screen-centred */}
      <div className="flex h-full min-h-0 w-full max-w-2xl flex-col">
      {/* Message list */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-2"
        aria-live="polite"
      >
        {messages.length === 0 && <EmptyState name={settings.name} />}

        <AnimatePresence initial={false}>
          {messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              onRegenerate={
                !streaming && m.role === "assistant" && !m.pending && i === messages.length - 1
                  ? regenerate
                  : undefined
              }
              onApprove={m.await ? () => void approveAct(m.id) : undefined}
              onReject={m.await ? () => rejectAct(m.id) : undefined}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Composer */}
      <div className="mt-2 shrink-0" ref={composerRef}>
        {/* 会話 / 司令塔（実行）の切替。何ができるモードなのかを明示する。 */}
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {/* 狭い画面では、履歴の取っ手をここに並べる。
              浮かせたままだと、この切り替えの上に重なって隠してしまう。 */}
          {!historyOpen && (
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-label="Chat history"
              className="flex min-[860px]:hidden items-center gap-1.5 rounded-forge border border-panel px-2.5 py-1 text-[10px] tracking-[0.12em] text-muted label-mono"
            >
              <HistoryIcon /> 履歴
            </button>
          )}
          <div className="flex overflow-hidden rounded-forge border border-panel">
            {([[false, "💬 会話"], [true, "⚙ 実行（司令塔）"]] as const).map(([on, label]) => (
              <button key={label} type="button" onClick={() => setAgentMode(on)}
                aria-pressed={agentMode === on}
                className="px-3 py-1 text-[10px] tracking-[0.12em] label-mono"
                style={{
                  background: agentMode === on ? "var(--btn-bg)" : "transparent",
                  color: agentMode === on ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {label}
              </button>
            ))}
          </div>
          {agentMode && (
            <>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)}
                  className="accent-[var(--accent)]" />
                <span className="text-[10px] text-muted label-mono">取り消せない操作は確認する</span>
              </label>
              <span className="text-[11px] text-muted">
                タスク・予定・資料作成・メール・検索など30種の道具を使って実際に動きます
              </span>
            </>
          )}
        </div>

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

        {/* 連携待ちで預かった用事。押すと、言い直さずに続きから進む。 */}
        {held && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-forge border p-2"
               style={{ borderColor: "var(--accent)", background: "var(--tint)" }}>
            <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-fg">
              預かっていた用事があります:「{held.instruction}」
            </span>
            <button
              type="button"
              onClick={async () => {
                const got = await setupResume().catch(() => null);
                setHeld(null);
                if (got?.ok && got.instruction) {
                  setInput(got.instruction);
                  // 入力欄に戻すだけ。送信は本人に押してもらう。
                  setNote("続きを入れました。送信すると進めます。");
                }
              }}
              className="shrink-0 rounded-forge border px-3 py-2 text-[11px] label-mono"
              style={{ borderColor: "var(--accent)", color: "var(--fg-strong)",
                       background: "var(--btn-bg)" }}
            >
              続きを出す
            </button>
            <button
              type="button"
              onClick={() => { void setupResume().catch(() => null); setHeld(null); }}
              className="shrink-0 rounded-forge border border-panel px-3 py-2 text-[11px] text-muted label-mono"
            >
              やめる
            </button>
          </div>
        )}

        {note && (
          <p role="status" aria-live="polite"
             className="mb-1 text-[11px] leading-relaxed text-muted">{note}</p>
        )}

        <div className="panel relative flex items-end gap-1.5 p-2">
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

          {/* # の候補。打ちながら絞る（一覧メニューにしない）。 */}
          {hash.active && commands.length > 0 && (
            <CommandPalette
              items={commands}
              query={hash.query}
              onPick={(c) => {
                // 引数が要る物は、名前まで入れて続きを打たせる。
                // 要らない物はそのまま送る。
                const next = `#${c.cmd}${c.arg ? " " : ""}`;
                setInput(next);
                if (!c.arg) void runShortcut(next.trim());
              }}
              onClose={() => setInput("")}
            />
          )}

          {/* Text input */}
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Auto-grow up to max-h-32 (ChatGPT-style composer).
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
            }}
            onKeyDown={onKeyDown}
            onPaste={onPasteImage}
            rows={1}
            placeholder={listening ? "聞き取り中…"
              : agentMode ? "やってほしいことを指示…（例：明日15時に歯医者の予定を入れて）"
              : "AIbou にメッセージ…"}
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

          {/* Realtime voice conversation (hands-free loop) — accent so it stands out */}
          {micSupported && (
            <button
              type="button"
              onClick={enterVoiceMode}
              disabled={streaming}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] text-[var(--accent)] shadow-glow transition hover:shadow-glow-strong disabled:opacity-40"
              aria-label="会話モード"
              title="ハンズフリー会話モード（ボタンを押さずに話し続けられます）"
            >
              <WaveIcon />
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
              {micSupported ? "ENTERで送信 · 画像はCtrl+V · ハンズフリー対応" : "ENTERで送信 · 画像はCtrl+V"}
            </span>
          )}
        </div>
      </div>
      </div>

      {/* ── 作った物のキャンバス（会話の隣） ──
          スマホは会話にかぶせ、PCは右半分に並ぶ。閉じても生成物は残る。 */}
      <Canvas
        items={madeItems}
        open={canvasOpen}
        bottomOffset={composerH}
        onClose={() => setCanvasOpen(false)}
        onOpenFiles={onOpenView ? () => onOpenView("archive") : undefined}
      />

      {/* 閉じたあとに、出した物へ戻る口。無いと「消えた」ように見える。 */}
      {!canvasOpen && madeItems.length > 0 && (
        <button
          type="button"
          onClick={() => setCanvasOpen(true)}
          className="fixed bottom-[74px] right-3 z-20 flex min-h-[44px] items-center gap-1.5 rounded-forge border border-[var(--line)] px-3 text-[11px] text-fg-strong shadow-glow transition sm:bottom-4"
          style={{ background: "var(--chrome)" }}
        >
          <span>🗂</span>
          <span>作った物 {madeItems.length}</span>
        </button>
      )}

      {/* ── リアルタイム会話モードの全画面オーバーレイ ── */}
      <AnimatePresence>
        {voiceMode && (
          <VoiceOverlay
            state={coreState}
            transcript={listening ? input : ""}
            lastReply={[...messages].reverse().find((m) => m.role === "assistant" && !m.pending && !m.error)?.content || ""}
            onExit={exitVoiceMode}
            onInterrupt={interruptVoice}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Fullscreen realtime-voice overlay (ChatGPT voice-mode style) ──── */
function VoiceOverlay({
  state, transcript, lastReply, onExit, onInterrupt,
}: {
  state: CoreState;
  transcript: string;
  lastReply: string;
  onExit: () => void;
  onInterrupt: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const label =
    state === "listening" ? "聞いています…"
      : state === "thinking" ? "考えています…"
        : state === "speaking" ? "話しています…（タップで割り込み）"
          : "接続中…";
  const color =
    state === "listening" ? "var(--accent)"
      : state === "speaking" ? "#60d394"
        : state === "thinking" ? "#ffd060"
          : "var(--muted)";

  // Live audio-reactive orb: a dedicated analyser mic drives a --vlevel CSS var
  // (0..1) every frame — no React re-renders. echoCancellation off so the orb
  // also reacts while the AI speaks (TTS bleed), for a lively ChatGPT-like feel.
  useEffect(() => {
    let ctx: AudioContext | null = null;
    let raf = 0;
    let stream: MediaStream | null = null;
    let cancelled = false;
    let level = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new Ctor();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / data.length);
          level = level * 0.75 + Math.min(1, rms * 3.5) * 0.25; // smooth
          rootRef.current?.style.setProperty("--vlevel", level.toFixed(3));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* analyser is optional */ }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      try { void ctx?.close(); } catch { /* ignore */ }
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const canInterrupt = state === "speaking" || state === "thinking";

  return createPortal(
    <motion.div
      ref={rootRef}
      role="dialog"
      aria-label="会話モード"
      className="fixed inset-0 z-[80] flex flex-col items-center justify-between bg-black/92 px-6 py-8 backdrop-blur-md"
      style={{ ["--vlevel" as string]: 0 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="text-[10px] tracking-[0.3em] text-muted label-mono">VOICE MODE · 会話モード</div>

      {/* Audio-reactive orb (tap to interrupt while the AI is talking/thinking) */}
      <button
        type="button"
        onClick={() => canInterrupt && onInterrupt()}
        aria-label={canInterrupt ? "割り込んで話す" : "会話中"}
        className="relative grid flex-1 place-items-center focus:outline-none"
        style={{ cursor: canInterrupt ? "pointer" : "default" }}
      >
        {/* concentric ripples (ambient, state-driven) */}
        {[0, 1].map((i) => (
          <motion.span
            key={i}
            className="absolute rounded-full"
            style={{ width: 200, height: 200, border: `1px solid ${color}` }}
            animate={{ scale: [1, 1.7], opacity: [0.4, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut", delay: i * 1.2 }}
          />
        ))}
        {/* the orb — scales & glows with --vlevel (voice level) */}
        <span
          className="grid h-40 w-40 place-items-center rounded-full transition-[background] duration-500"
          style={{
            background: `radial-gradient(circle at 38% 32%, ${color}44, rgba(10,14,22,0.92) 70%)`,
            border: `1px solid ${color}77`,
            transform: "scale(calc(1 + var(--vlevel, 0) * 0.5))",
            boxShadow: `0 0 calc(30px + var(--vlevel, 0) * 110px) ${color}66`,
          }}
        >
          <motion.span
            className="text-3xl"
            aria-hidden
            animate={state === "thinking" ? { opacity: [0.4, 1, 0.4] } : state === "speaking" ? { scale: [1, 1.12, 1] } : { opacity: 1 }}
            transition={{ duration: state === "speaking" ? 0.5 : 1.2, repeat: Infinity }}
          >
            {state === "listening" ? "🎙" : state === "thinking" ? "◈" : state === "speaking" ? "🔊" : "…"}
          </motion.span>
        </span>
      </button>

      <div className="flex w-full max-w-md flex-col items-center gap-4">
        <div className="text-[12px] tracking-[0.22em] label-mono" style={{ color }}>{label}</div>
        <div className="max-h-32 w-full overflow-y-auto text-center">
          {transcript ? (
            <p className="text-[16px] leading-relaxed text-fg-strong">{transcript}</p>
          ) : lastReply ? (
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted">{lastReply.slice(0, 240)}</p>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted/70">
              話しかけてください。話し終えて少し待つと自動で送信し、返答を読み上げます。<br />そのまま続けて話せます（ボタン操作は不要）。
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onExit}
          className="rounded-full border border-[#ff6b6b55] bg-[rgba(255,107,107,0.08)] px-8 py-2.5 text-[11px] tracking-[0.22em] text-[#ff8888] transition hover:bg-[rgba(255,107,107,0.16)] label-mono"
        >
          ■ 会話を終了
        </button>
      </div>
    </motion.div>,
    document.body,
  );
}

function WaveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M3 12v0M7 9v6M11 5v14M15 8v8M19 11v2" />
    </svg>
  );
}

/* ── Chat history — full-height left panel + bottom-left toggle ────── */
function ChatHistory({
  convos, currentId, open, onOpenChange, onNew, onPick, onDelete,
}: {
  convos: Convo[];
  currentId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNew: () => void;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const list = (
    <div className="flex h-full flex-col gap-2">
      <button
        type="button"
        onClick={onNew}
        className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
      >
        ＋ 新しいチャット
      </button>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {convos.length === 0 ? (
          <p className="px-1 py-2 text-[10px] leading-relaxed text-muted/70">
            履歴はまだありません。話しかけると、この一覧に会話が残ります。
          </p>
        ) : (
          convos.map((c) => {
            const active = c.id === currentId;
            return (
              <div
                key={c.id}
                className="group flex items-center gap-1 rounded-forge border px-2 py-1.5 transition"
                style={{
                  borderColor: active ? "var(--accent)" : "transparent",
                  background: active ? "var(--btn-bg)" : "transparent",
                }}
              >
                <button
                  type="button"
                  onClick={() => onPick(c.id)}
                  className="min-w-0 flex-1 truncate text-left text-[11px] text-fg"
                  title={c.title}
                >
                  {c.title || "（無題）"}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(c.id)}
                  className="shrink-0 text-[10px] text-muted opacity-60 transition hover:text-[#ff8888] sm:opacity-0 sm:group-hover:opacity-100"
                  aria-label="Delete conversation"
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* 左下に浮かせる取っ手。開いている間は出さない。

          **広い画面でだけ浮かせる。** 会話の列は max-w-2xl（672px）で
          中央に置いてあるので、画面が 840px より狭いと、この取っ手が
          列の上に重なる——スマホでは「会話／実行」の切り替えを覆って
          いた（押せない側が見えない、という形で出る）。
          狭いときは、下の入力まわりに同じボタンを並べて出す。 */}
      {!open && (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          aria-label="Chat history"
          className="fixed bottom-24 left-3 z-40 hidden min-[860px]:flex items-center gap-1.5 rounded-full border border-[var(--panel-bd)] bg-[var(--chrome)] px-3 py-2 text-[10px] tracking-[0.16em] text-fg-strong shadow-glow backdrop-blur transition hover:shadow-glow-strong label-mono"
        >
          <HistoryIcon /> 履歴
        </button>
      )}

      {/* Full-height left panel (spans top→bottom, past the core). */}
      <AnimatePresence>
        {open && (
          <>
            <motion.button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => onOpenChange(false)}
              className="fixed inset-0 z-40 bg-black/50"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.aside
              className="fixed left-0 top-0 z-50 h-full w-72 max-w-[82vw] p-2"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              <div className="glass-silver flex h-full flex-col p-2">
                <div className="mb-1 flex items-center justify-between px-1">
                  <span className="text-[9px] tracking-[0.22em] text-muted label-mono">HISTORY</span>
                  <button
                    type="button"
                    onClick={() => onOpenChange(false)}
                    aria-label="Close history"
                    className="text-muted transition hover:text-fg-strong"
                  >
                    ✕
                  </button>
                </div>
                <div className="min-h-0 flex-1">{list}</div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" />
    </svg>
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

function MessageBubble({ message, onRegenerate, onApprove, onReject }: {
  message: Message;
  onRegenerate?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const isUser = message.role === "user";
  const settled = !isUser && !message.pending && (message.content.trim().length > 0 || message.error);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div className={`flex max-w-[85%] flex-col sm:max-w-[78%] ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={[
          "rounded-forge border px-3.5 py-2.5 text-sm leading-relaxed",
          "backdrop-blur-md",
          isUser
            ? "border-panel-strong bg-[rgba(255,255,255,0.07)] text-fg-strong"
            : "border-panel bg-[var(--tint)] text-fg shadow-glow",
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
        {/* エージェントとして動いたターンは、何をしたかを本文の前に出す。
            結果だけ見せると「勝手に何かした」ように見えるので、必ず経過を残す。 */}
        {message.steps && message.steps.length > 0 && (
          <div className="mb-2 border-b border-panel pb-2">
            <AgentTrace steps={message.steps} animate={false} totalMs={message.totalMs} />
          </div>
        )}

        {/* 連携が足りなくて止まった — ここで会話を終わらせない。
            用事はサーバーが預かっているので、繋いで戻れば続きから進む。 */}
        {message.need && (
          <div className="mb-2 rounded-forge border p-2.5"
               style={{ borderColor: "var(--accent)", background: "var(--tint)" }}>
            <div className="text-[10px] text-[var(--accent)] label-mono">
              {message.need.label}との連携が必要
            </div>
            {message.need.canConnect ? (
              <>
                <a
                  href={`${API_URL}${message.need.connectPath}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 inline-flex min-h-[44px] items-center rounded-forge border px-3.5 text-[12px] label-mono"
                  style={{ borderColor: "var(--accent)", color: "var(--fg-strong)",
                           background: "var(--btn-bg)" }}
                >
                  {message.need.label}と連携する
                </a>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                  許可して戻ってくると、さきほどの用事から続けます。
                  言い直す必要はありません。
                </p>
              </>
            ) : message.need.needsOwner ? (
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                このアプリの持ち主が{message.need.label}へのアプリ登録を
                まだ済ませていないため、いまは繋げません。
              </p>
            ) : null}
          </div>
        )}

        {/* 承認待ち — 取り消せない操作は必ず確認してから実行する */}
        {message.await && (
          <div className="mb-2 rounded-forge border border-[#ffd06055] bg-[rgba(255,208,96,0.06)] p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-[#ffd060] label-mono">確認が必要な操作</span>
              {message.await.levelLabel && (
                <span className="rounded-full border border-[#ffd06055] px-2 py-0.5 text-[10px] text-[#ffd060]">
                  {message.await.levelLabel}
                </span>
              )}
              {/* 承認モードを切っていても聞く操作は、そう言っておく。
                  「設定を切ったのに確認が出る」を不具合と思われないため。 */}
              {message.await.alwaysConfirm && (
                <span className="text-[10px] text-muted">設定に関わらず必ず確認します</span>
              )}
              {/* 「読むだけ」なのに確認が出る理由を、札で先に出す。
                  これが無いと、危なくない操作で止まったように見える。 */}
              {message.await.chained && (
                <span className="rounded-full border border-[#c07aff55] px-2 py-0.5 text-[10px] text-[#c07aff]">
                  ページ由来の可能性
                </span>
              )}
            </div>
            {message.await.why && (
              <div className="mt-1 text-[11px] leading-relaxed text-[#ffd060]">
                {message.await.why}
              </div>
            )}
            <div className="mt-0.5 text-[11px] text-fg-strong">
              {message.await.tool}{message.await.note ? ` — ${message.await.note}` : ""}
            </div>
            {message.await.chained && (
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                下のURLをよく見てください。会話の内容がURLに書き込まれていたら、
                外へ持ち出そうとしています。心当たりが無ければ「やめる」を押してください。
              </p>
            )}
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted">
              {JSON.stringify(message.await.params, null, 1)}
            </pre>
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" onClick={onApprove}
                className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1 text-[10px] text-fg-strong label-mono">
                実行する
              </button>
              <button type="button" onClick={onReject}
                className="rounded-forge border border-panel px-3 py-1 text-[10px] text-muted transition hover:text-fg-strong label-mono">
                やめる
              </button>
            </div>
          </div>
        )}

        {message.pending && !message.content ? (
          <TypingDots />
        ) : isUser || message.error ? (
          <span className="whitespace-pre-wrap">{message.content}</span>
        ) : (
          <div className={message.pending ? "caret" : ""}>
            <Markdown text={message.content} />
          </div>
        )}
      </div>

      {/* Assistant message actions — copy (ChatGPT parity) + regenerate on the last turn. */}
      {settled && (
        <div className="mt-1 flex items-center gap-3 px-1">
          {!message.error && <CopyButton text={message.content} />}
          {onRegenerate && (
            <button
              type="button"
              onClick={() => void onRegenerate()}
              className="text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong label-mono"
              aria-label="Regenerate reply"
              title="もう一度生成"
            >
              ↻ 再生成
            </button>
          )}
        </div>
      )}
      </div>
    </motion.div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch { /* clipboard unavailable */ }
      }}
      className="text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong label-mono"
      aria-label="Copy reply"
      title="コピー"
    >
      {copied ? "✓ コピー済み" : "⧉ コピー"}
    </button>
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
