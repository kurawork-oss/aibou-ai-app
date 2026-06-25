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

/** True when the browser can synthesize speech. */
export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Pick a Japanese voice if available, else the first voice. */
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = cachedVoices.length ? cachedVoices : loadVoices();
  if (!voices.length) return undefined;
  const base = lang.split("-")[0].toLowerCase();
  return (
    voices.find((v) => v.lang?.toLowerCase() === lang.toLowerCase()) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith(base)) ||
    voices[0]
  );
}

export interface SpeakOptions {
  lang?: string;
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
    const voice = pickVoice(lang);
    if (voice) utter.voice = voice;
    if (opts.onStart) utter.onstart = () => opts.onStart?.();
    utter.onend = () => opts.onEnd?.();
    utter.onerror = () => opts.onEnd?.();
    window.speechSynthesis.speak(utter);
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

/** Play a base64-encoded mp3 (the API /tts fallback). Resolves when done. */
export function playBase64Audio(audioBase64: string, mime = "audio/mpeg"): Promise<void> {
  return new Promise((resolve) => {
    if (!audioBase64 || typeof window === "undefined") {
      resolve();
      return;
    }
    try {
      const audio = new Audio(`data:${mime};base64,${audioBase64}`);
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      void audio.play().catch(() => resolve());
    } catch {
      resolve();
    }
  });
}
