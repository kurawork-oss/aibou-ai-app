/**
 * cameraControl.ts — カメラ操作モードの「入り切り」と、端末に置く設定。
 *
 * ここは軽く保つ。認識の部品（約2MBの JavaScript と約14MBのモデル）は
 * lib/vision.ts が、モードを始めたときに初めて取りに行く。使わない人の
 * 最初の読み込みは1バイトも増やさない。
 *
 * 顔のデータの置き場
 * ------------------
 * 登録した顔の特徴は**この端末の localStorage にだけ**置く。サーバーにも
 * 記憶の合流（lib/memorySync.ts）にも乗せない。顔は取り替えのきかない
 * 情報なので、預かる場所を増やさない。消すのは設定のボタン1つ。
 *
 * カメラの映像そのものは、どこにも保存しない・送らない。
 */

import { useSyncExternalStore } from "react";
import {
  decodeDescriptor, encodeDescriptor, isStrictness, type Strictness,
} from "@/lib/faceMatch";

const LS_PREFS = "forge_camera_prefs";
const LS_FACE = "forge_camera_face";

export interface CameraPrefs {
  /** 顔を登録してあるとき、本人が映っている間だけ手で操作できる。 */
  requireFace: boolean;
  strictness: Strictness;
  /** 写真・画面に映した顔を弾く（試験的。本人が弾かれることがある）。 */
  antiSpoof: boolean;
  /** 右の小窓にカメラの映像を出す。 */
  preview: boolean;
}

export const DEFAULT_CAMERA_PREFS: CameraPrefs = {
  requireFace: true,
  strictness: "normal",
  antiSpoof: false,
  preview: true,
};

export function readCameraPrefs(): CameraPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PREFS) || "{}") as Partial<CameraPrefs>;
    return {
      requireFace: typeof raw.requireFace === "boolean" ? raw.requireFace : DEFAULT_CAMERA_PREFS.requireFace,
      strictness: isStrictness(raw.strictness) ? raw.strictness : DEFAULT_CAMERA_PREFS.strictness,
      antiSpoof: typeof raw.antiSpoof === "boolean" ? raw.antiSpoof : DEFAULT_CAMERA_PREFS.antiSpoof,
      preview: typeof raw.preview === "boolean" ? raw.preview : DEFAULT_CAMERA_PREFS.preview,
    };
  } catch {
    return { ...DEFAULT_CAMERA_PREFS };
  }
}

export function writeCameraPrefs(p: CameraPrefs): void {
  try { localStorage.setItem(LS_PREFS, JSON.stringify(p)); } catch { /* 保存できない端末では、その場だけ効く */ }
  emit();
}

interface StoredFace { v: 1; at: number; samples: string[] }

/** 登録した顔の特徴（何枚か）。無ければ null。 */
export function readFaceProfile(): { at: number; samples: number[][] } | null {
  try {
    const raw = localStorage.getItem(LS_FACE);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredFace;
    if (s?.v !== 1 || !Array.isArray(s.samples) || s.samples.length === 0) return null;
    const samples = s.samples.map(decodeDescriptor).filter((d) => d.length >= 64);
    return samples.length ? { at: s.at, samples } : null;
  } catch {
    return null;
  }
}

/** 保存できたかを返す（容量がいっぱいの端末で「登録しました」と言わないため）。 */
export function writeFaceProfile(samples: number[][]): boolean {
  try {
    const s: StoredFace = { v: 1, at: Date.now(), samples: samples.map(encodeDescriptor) };
    localStorage.setItem(LS_FACE, JSON.stringify(s));
    emit();
    return true;
  } catch {
    return false;
  }
}

export function clearFaceProfile(): void {
  try { localStorage.removeItem(LS_FACE); } catch { /* ignore */ }
  emit();
}

/* ── 入り切り（どの画面からでも同じ1つを見る） ─────────────────── */

let running = false;
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function isCameraControlRunning(): boolean { return running; }
export function startCameraControl(): void { if (!running) { running = true; emit(); } }
export function stopCameraControl(): void { if (running) { running = false; emit(); } }

/** いまカメラ操作モードが動いているか（画面の再描画つき）。 */
export function useCameraControlRunning(): boolean {
  return useSyncExternalStore(subscribe, isCameraControlRunning, () => false);
}

/** 設定や登録が変わったら描き直したい所が使う。 */
export function subscribeCameraStore(l: () => void): () => void { return subscribe(l); }

/* ── 使えるかどうかを、押す前に言う ──────────────────────────────── */

export function cameraAvailability(): { ok: true } | { ok: false; reason: string } {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { ok: false, reason: "ブラウザの中でだけ使えます。" };
  }
  if (!window.isSecureContext) {
    return { ok: false, reason: "カメラは https か localhost で開いたときだけ使えます。" };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: "このブラウザはカメラに対応していません。Chrome・Edge・Safari の新しい版で開いてください。" };
  }
  return { ok: true };
}

/** カメラを開けなかった理由を、次に何をすればいいかの形で返す。 */
export function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "カメラの使用が許可されていません。アドレス欄の左の印からカメラを「許可」にして、もう一度始めてください。";
    case "NotFoundError":
    case "OverconstrainedError":
      return "カメラが見つかりません。パソコンにカメラが付いているか・つないであるかを確かめてください。";
    case "NotReadableError":
    case "AbortError":
      return "カメラを開けませんでした。ほかのアプリ（会議アプリなど）がカメラを使っていないか確かめてください。";
    default:
      return `カメラを開けませんでした（${name || "原因不明"}）。`;
  }
}
