/**
 * pets.ts — ペット（相棒の姿）。作業の様子を、動きで見せる。
 *
 * ChatGPT のペットと同じ考え方にしてある: **ペットは見た目だけ**で、
 * 仕事のやり方は変えない。いま何をしているかを、遠目でも分かるように
 * 動きと一言で見せる（画面から目を離していても気づける）。
 *
 *   作業中（考え中・段取り中・作業中・話している）… 弾む
 *   確認待ち（承認・連携が必要）……………………… 跳ねて「！」
 *   できた ……………………………………………… 喜ぶ「✓」
 *   困った（失敗）……………………………………… しょんぼり「？」
 *   待機 ………………………………………………… ゆっくり息をする
 *
 * 状態は lib/coreState.ts の CoreState をそのまま使う（コアの球と同じ表を
 * 見る。別の決め方を持つと、片方だけずれる）。
 *
 * 姿は、このアプリのために描いたオリジナル（どこかのキャラクターではない）。
 * どれを選んでいるかは、この端末にだけ覚える。
 */

import { useSyncExternalStore } from "react";
import type { CoreState } from "@/lib/coreState";

export type PetMood = "idle" | "listening" | "running" | "needs_input" | "ready" | "blocked";

/** コアの状態 → ペットの様子。 */
export function moodOf(state: CoreState): PetMood {
  switch (state) {
    case "waiting_user":
    case "setup_required":
      return "needs_input";
    case "error":
      return "blocked";
    case "completed":
      return "ready";
    case "listening":
      return "listening";
    case "thinking":
    case "planning":
    case "working":
    case "speaking":
      return "running";
    default:
      return "idle";
  }
}

/** ふきだしの一言。待機中は何も言わない（静かにしている）。 */
export function petSays(state: CoreState): string {
  switch (state) {
    case "listening": return "聞いてるよ";
    case "thinking": return "考え中…";
    case "planning": return "段取り中…";
    case "working": return "作業中…";
    case "speaking": return "話してるよ";
    case "waiting_user": return "確認してね";
    case "setup_required": return "つなぐのが必要";
    case "completed": return "できたよ";
    case "error": return "うまくいかなかった";
    default: return "";
  }
}

export interface PetKind {
  id: string;
  name: string;
  /** どんな子か（選ぶ画面に出す一言）。 */
  about: string;
  /** 体の色・影の色・頬の色。 */
  body: string;
  shade: string;
  cheek: string;
  /** 形（components/Pet.tsx が描き分ける）。 */
  shape: "mochi" | "dog" | "cat" | "chick" | "bot";
}

export const PETS: PetKind[] = [
  { id: "mochi", name: "モチ", about: "まるくて、のんびり", body: "#f4f1ea", shade: "#d9d3c4", cheek: "#f3a6a0", shape: "mochi" },
  { id: "koro", name: "コロ", about: "たれ耳の子犬", body: "#e9c58f", shade: "#c99a5b", cheek: "#f0a07a", shape: "dog" },
  { id: "mii", name: "ミィ", about: "気まぐれな子猫", body: "#b9bcc6", shade: "#8e929e", cheek: "#f2a3b3", shape: "cat" },
  { id: "piyo", name: "ピヨ", about: "元気なひよこ", body: "#ffd85a", shade: "#e6b62c", cheek: "#ff9f6b", shape: "chick" },
  { id: "bit", name: "ビット", about: "小さなロボット", body: "#9fe8ef", shade: "#5fc1cb", cheek: "#7ff3ff", shape: "bot" },
];

export const DEFAULT_PET = "mochi";
export const PET_OFF = "off";

const LS_PET = "forge_pet";

export function petById(id: string): PetKind | undefined {
  return PETS.find((p) => p.id === id);
}

/** 選んでいるペット（"off" なら出さない）。保存されていなければ既定の子。 */
export function readPet(): string {
  try {
    const v = localStorage.getItem(LS_PET);
    if (v === PET_OFF || (v && petById(v))) return v;
  } catch { /* 読めない端末では既定の子 */ }
  return DEFAULT_PET;
}

const listeners = new Set<() => void>();
let picker = false;

export function writePet(id: string): void {
  try { localStorage.setItem(LS_PET, id); } catch { /* その場だけ効く */ }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** 選んでいるペット（画面の描き直しつき）。 */
export function usePet(): string {
  return useSyncExternalStore(subscribe, readPet, () => DEFAULT_PET);
}

/* ── 選ぶ窓（会話の「＋」・「ペットを変えて」・ペットの吹き出しから開く） ── */

export function openPetPicker(): void { picker = true; listeners.forEach((l) => l()); }
export function closePetPicker(): void { picker = false; listeners.forEach((l) => l()); }
export function usePetPickerOpen(): boolean {
  return useSyncExternalStore(subscribe, () => picker, () => false);
}
