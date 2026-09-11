/**
 * コアの種類（見た目の形）の切り替え。
 *
 * skin.ts と同じ作りで、保存は localStorage の1キーだけ。切り替えたときに
 * 開いている画面へ即反映するため、CustomEvent を投げる（CoreOrb が拾う）。
 */

import type { ShapeKey } from "@/lib/coreShapes";

/** orb は従来のコア（既定）。それ以外は coreShapes.ts の形。 */
export type CoreType = "orb" | ShapeKey;

export const CORE_TYPES: { key: CoreType; label: string; hint: string }[] = [
  { key: "orb", label: "コア", hint: "既定。粒子の殻と発光する芯" },
  { key: "pyramid", label: "ピラミッド", hint: "青い結晶の四角錐。頂点がきらめく" },
  { key: "icosa", label: "多面体", hint: "すりガラスの二十面体。稜線が光る" },
  { key: "hex", label: "ヘックス球", hint: "六角の鱗。光の帯がゆっくり流れる" },
  { key: "crystal", label: "クリスタル", hint: "放射状に爆ぜた結晶" },
  { key: "portal", label: "リング", hint: "光の輪。正面と真横を行き来する" },
  { key: "pixel", label: "ドット", hint: "昔のゲームの球。色数を減らし、カクカク動く" },
];

export const DEFAULT_CORE_TYPE: CoreType = "orb";
export const CORE_TYPE_KEY = "forge_core_type";
/** 切り替えを開いている画面へ伝えるイベント名。 */
export const CORE_TYPE_EVENT = "forge:coretype";

const VALID = new Set<string>(CORE_TYPES.map((c) => c.key));

/** 未知の値・null を既定に丸める。 */
export function normalizeCoreType(value: unknown): CoreType {
  return typeof value === "string" && VALID.has(value) ? (value as CoreType) : DEFAULT_CORE_TYPE;
}

/** 保存済みの種類を読む（localStorage が使えなくても例外を投げない）。 */
export function readCoreType(): CoreType {
  try {
    return normalizeCoreType(localStorage.getItem(CORE_TYPE_KEY));
  } catch {
    return DEFAULT_CORE_TYPE;
  }
}

/** 保存して、開いている画面へ知らせる。 */
export function setCoreType(next: CoreType): CoreType {
  const v = normalizeCoreType(next);
  try {
    localStorage.setItem(CORE_TYPE_KEY, v);
  } catch {
    /* 保存できなくても表示だけは切り替える */
  }
  try {
    window.dispatchEvent(new CustomEvent(CORE_TYPE_EVENT, { detail: v }));
  } catch {
    /* SSR では何もしない */
  }
  return v;
}
