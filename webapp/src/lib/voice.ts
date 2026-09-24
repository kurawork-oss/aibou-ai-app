/**
 * THE FORGE OS — Web Speech API helpers (free, in-browser).
 *
 * - `useSpeechRecognition()`  → hands-free transcription (ja-JP), continuous-ish.
 * - `speak(text)`             → browser TTS via window.speechSynthesis (ja-JP voice).
 *
 * Everything degrades gracefully: on unsupported browsers (notably non-Chromium),
 * `supported` is false and start/stop/speak become safe no-ops. Browser TTS is the
 * preferred hands-free path; the API /tts route is a fallback handled in the UI.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * Minimal Web Speech typings (the DOM lib ships these only partially) *
 * ------------------------------------------------------------------ */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((ev: Event) => void) | null;
  onstart: ((ev: Event) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export interface UseSpeechRecognitionResult {
  /** Whether the browser supports speech recognition at all. */
  supported: boolean;
  /** True while the mic is actively listening. */
  listening: boolean;
  /** Best-effort live transcript (final + interim). */
  transcript: string;
  /** Last recognition error code, if any. */
  error: string | null;
  /** Begin listening. Clears the previous transcript. */
  start: () => void;
  /** Stop listening (keeps the transcript). */
  stop: () => void;
  /** Clear the transcript buffer. */
  reset: () => void;
}

/**
 * Hands-free speech recognition hook (default ja-JP).
 * Continuous-ish: keeps a session open and accumulates final results, with the
 * current interim chunk appended live so the UI can show what's being heard.
 */
export function useSpeechRecognition(lang: string = "ja-JP"): UseSpeechRecognitionResult {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef<string>("");
  // When true, auto-restart on `onend` (some browsers stop after a pause).
  const wantListeningRef = useRef<boolean>(false);

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    setSupported(true);

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (ev: SpeechRecognitionEventLike) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalRef.current += text;
        } else {
          interim += text;
        }
      }
      setTranscript((finalRef.current + interim).trim());
    };

    recognition.onerror = (ev: SpeechRecognitionErrorEventLike) => {
      // "no-speech" / "aborted" are benign; surface the rest.
      if (ev.error !== "no-speech" && ev.error !== "aborted") {
        setError(ev.error);
      }
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        wantListeningRef.current = false;
        setListening(false);
      }
    };

    recognition.onend = () => {
      // Auto-restart while the user still wants to listen (continuous-ish).
      if (wantListeningRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          /* fallthrough to stopped state */
        }
      }
      setListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      wantListeningRef.current = false;
      try {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.abort();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    };
  }, [lang]);

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    finalRef.current = "";
    setTranscript("");
    setError(null);
    wantListeningRef.current = true;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // start() throws if already started — treat as listening.
      setListening(true);
    }
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    wantListeningRef.current = false;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
  }, []);

  const reset = useCallback(() => {
    finalRef.current = "";
    setTranscript("");
  }, []);

  return { supported, listening, transcript, error, start, stop, reset };
}

/* ------------------------------------------------------------------ *
 * Browser text-to-speech                                              *
 * ------------------------------------------------------------------ */

let cachedVoices: SpeechSynthesisVoice[] = [];

/** Lazily load/refresh the available voices (they populate asynchronously). */
function loadVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) cachedVoices = voices;
  return cachedVoices;
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  // Warm the voice list; some browsers only fill it after this event.
  loadVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
}

/**
 * True when the browser exposes the speech synthesis API.
 *
 * 注意: これが true でも「声が1つも入っていない」端末がある（一部のAndroid
 * WebView、音声パッケージ未導入のLinux/Windows、法人管理端末など）。その場合
 * speak() は無音のまま終わり、onend も来ないことがある。「喋らないのに
 * サーバー音声へも切り替わらない」という詰み方をするので、実際に使えるか
 * どうかは hasUsableVoice() で見ること。
 */
export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** その言語で実際に使える声の一覧（設定画面で選ばせるために使う）。 */
export function listVoices(lang = "ja-JP"): SpeechSynthesisVoice[] {
  const voices = cachedVoices.length ? cachedVoices : loadVoices();
  const base = lang.split("-")[0].toLowerCase();
  return voices.filter((v) => v.lang?.toLowerCase().startsWith(base));
}

/** その言語を実際に喋れるか。API があるかどうかとは別物。 */
export function hasUsableVoice(lang = "ja-JP"): boolean {
  return listVoices(lang).length > 0;
}

/**
 * 声を選ぶ。名前の指定があればそれを最優先する。
 *
 * 以前はここで常に「最初に見つかった日本語の声」を返していたため、設定で
 * 声を変えても何も変わらなかった（設定はサーバー音声側にしか渡っていな
 * かった）。名前で引けるようにして、選択が実際に効くようにしている。
 */
function pickVoice(lang: string, name?: string): SpeechSynthesisVoice | undefined {
  const voices = cachedVoices.length ? cachedVoices : loadVoices();
  if (!voices.length) return undefined;
  if (name) {
    const exact = voices.find((v) => v.name === name);
    if (exact) return exact;
  }
  const base = lang.split("-")[0].toLowerCase();
  return (
    voices.find((v) => v.lang?.toLowerCase() === lang.toLowerCase()) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith(base)) ||
    voices[0]
  );
}

export interface SpeakOptions {
  lang?: string;
  /** 端末に入っている声の名前（SpeechSynthesisVoice.name）。 */
  voiceName?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
}

/**
 * Speak `text` using the browser's speech synthesis (default ja-JP).
 * No-op (and calls onEnd) when unsupported or text is empty. Cancels any
 * in-flight utterance first so replies don't overlap.
 */
export function speak(text: string, opts: SpeakOptions = {}): void {
  const clean = (text || "").trim();
  if (!isSpeechSynthesisSupported() || !clean) {
    opts.onEnd?.();
    return;
  }
  const lang = opts.lang ?? "ja-JP";
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = lang;
    utter.rate = opts.rate ?? 1.02;
    utter.pitch = opts.pitch ?? 1.0;
    utter.volume = opts.volume ?? 1.0;
    const voice = pickVoice(lang, opts.voiceName);
    if (voice) utter.voice = voice;
    if (opts.onStart) utter.onstart = () => opts.onStart?.();
    utter.onend = () => opts.onEnd?.();
    utter.onerror = () => opts.onEnd?.();
    window.speechSynthesis.speak(utter);
  } catch {
    opts.onEnd?.();
  }
}

/**
 * 文の配列を順番に喋る。
 *
 * 1つの長い文字列を渡すより、文ごとに分けて続けて流したほうが自然に
 * 聞こえる。長文を一度に渡すと途中で切れるブラウザがあるのも避けられる。
 * 戻り値を呼ぶと途中で止められる。
 */
export function speakSequence(
  chunks: string[],
  opts: SpeakOptions = {},
): () => void {
  let cancelled = false;
  let i = 0;

  const next = () => {
    if (cancelled) return;
    if (i >= chunks.length) { opts.onEnd?.(); return; }
    const part = chunks[i++];
    speakOne(part, {
      ...opts,
      onStart: i === 1 ? opts.onStart : undefined,
      onEnd: next,
    });
  };
  next();
  return () => { cancelled = true; stopSpeaking(); };
}

/** speak() と同じだが、直前の発話を打ち切らない（連続再生用）。 */
function speakOne(text: string, opts: SpeakOptions): void {
  const clean = (text || "").trim();
  if (!isSpeechSynthesisSupported() || !clean) { opts.onEnd?.(); return; }
  const lang = opts.lang ?? "ja-JP";
  try {
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = lang;
    utter.rate = opts.rate ?? 1.02;
    utter.pitch = opts.pitch ?? 1.0;
    utter.volume = opts.volume ?? 1.0;
    const voice = pickVoice(lang, opts.voiceName);
    if (voice) utter.voice = voice;
    if (opts.onStart) utter.onstart = () => opts.onStart?.();
    // 声が入っていない端末では onend が来ないことがあるため、
    // 呼び出し側が待ち続けないよう保険をかける。
    let done = false;
    const finish = () => { if (!done) { done = true; opts.onEnd?.(); } };
    utter.onend = finish;
    utter.onerror = finish;
    window.speechSynthesis.speak(utter);
    if (!hasUsableVoice(lang)) setTimeout(finish, 50);
  } catch {
    opts.onEnd?.();
  }
}

/** Immediately stop any browser speech. */
export function stopSpeaking(): void {
  if (!isSpeechSynthesisSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

/**
 * 上と同じだが、途中で止められる。
 * 割り込み（利用者が喋りかける・別の返答が来る）で前の音声を確実に切るために要る。
 */
export function playBase64AudioControllable(
  audioBase64: string,
  mime = "audio/mpeg",
): { done: Promise<void>; stop: () => void } {
  let stop = () => {};
  const done = new Promise<void>((resolve) => {
    if (!audioBase64 || typeof window === "undefined") { resolve(); return; }
    try {
      const audio = new Audio(`data:${mime};base64,${audioBase64}`);
      const finish = () => resolve();
      audio.onended = finish;
      audio.onerror = finish;
      stop = () => {
        try { audio.pause(); audio.src = ""; } catch { /* ignore */ }
        finish();
      };
      void audio.play().catch(finish);
    } catch {
      resolve();
    }
  });
  return { done, stop: () => stop() };
}
