/**
 * pointerDom.ts — 手のカーソルが、画面の物を押す・スクロールする。
 *
 * マウスで押したときと同じ順に合図を出す（pointerdown → mousedown →
 * pointerup → mouseup → click）。押したときに反応する物（ボードの付箋
 * など）も、離したときに反応する物も、同じように動く。
 *
 * 手では押させない物
 * ------------------
 * `data-gesture-block` の付いた物の中は押さない。承認（「実行する」
 * 「いつも許可」）がそれで、手の認識の揺れで**取り消せない操作を
 * 通してしまう**ことがあってはいけないため。そこだけは、マウスか指で。
 * 削除の確認（window.confirm）も、ブラウザが出す窓なので手では押せない。
 * これも同じ理由で、そのままにしてある。
 */

const CLICKABLE = [
  "button", "a[href]", "input", "textarea", "select", "label", "summary",
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="switch"]',
  '[role="checkbox"]', '[role="radio"]', '[role="menuitem"]', '[role="option"]',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(",");

export const GESTURE_BLOCK_ATTR = "data-gesture-block";

/** カーソル自身は pointer-events:none なので、その下の物が返る。 */
export function clickableAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  return (el?.closest(CLICKABLE) as HTMLElement | null) ?? null;
}

export function isBlocked(el: Element | null): boolean {
  return Boolean(el?.closest(`[${GESTURE_BLOCK_ATTR}]`));
}

function isDisabled(el: HTMLElement): boolean {
  return Boolean((el as HTMLButtonElement).disabled) || el.getAttribute("aria-disabled") === "true";
}

const keys = new WeakMap<Element, number>();
let nextKey = 1;
/** 要素ごとに変わらない印（「同じボタンの上に止まっている」を数えるため）。 */
function keyOf(el: Element): number {
  let k = keys.get(el);
  if (!k) { k = nextKey++; keys.set(el, k); }
  return k;
}

export interface Target {
  el: HTMLElement;
  /** 押す位置（画面の px）。 */
  x: number;
  y: number;
  key: number;
  blocked: boolean;
  /** カーソルの真下ではなく、近くの物に吸い付いたか。 */
  snapped: boolean;
}

/**
 * カーソルの下、または近く（radius px 以内）の押せる物。
 *
 * 手のカーソルはマウスほど細かく止められない。小さなボタン（✕ など）の
 * すぐ脇で止まって押せない、が一番の困りごとなので、近くにあれば吸い付く。
 * 押すのは、その物の中でカーソルにいちばん近い点。
 */
export function findTarget(x: number, y: number, radius = 28): Target | null {
  const at = (el: Element | null, px: number, py: number, snapped: boolean): Target | null => {
    const c = el?.closest(CLICKABLE) as HTMLElement | null;
    if (!c || isDisabled(c)) return null;
    const r = c.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const inset = Math.min(4, r.width / 2, r.height / 2);
    const cx = Math.min(Math.max(px, r.left + inset), r.right - inset);
    const cy = Math.min(Math.max(py, r.top + inset), r.bottom - inset);
    return { el: c, x: cx, y: cy, key: keyOf(c), blocked: isBlocked(c), snapped };
  };
  const direct = at(document.elementFromPoint(x, y), x, y, false);
  if (direct) return direct;

  let best: Target | null = null;
  let bestD = Infinity;
  for (const rr of [radius / 2, radius]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      const t = at(document.elementFromPoint(px, py), x, y, true);
      if (!t) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bestD) { best = t; bestD = d; }
    }
    if (best) return best;
  }
  return null;
}

function isTextEntry(el: HTMLElement): boolean {
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].includes(el.type);
}

export type PressResult =
  | { done: true; what: string }
  | { done: false; why: string };

export const BLOCKED_REASON = "このボタンは手では押せません（取り消せない操作のため）。マウスか指で押してください。";

/** 物を押す（マウスで押したときと同じ順に合図を出す）。 */
export function pressElement(target: HTMLElement, x: number, y: number): PressResult {
  if (isBlocked(target)) return { done: false, why: BLOCKED_REASON };
  if (isDisabled(target)) return { done: false, why: "いまは押せません。" };
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
  const ptr = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  target.dispatchEvent(new PointerEvent("pointerdown", { ...ptr, buttons: 1 }));
  target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
  if (isTextEntry(target)) target.focus();
  target.dispatchEvent(new PointerEvent("pointerup", { ...ptr, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  const what = (target.getAttribute("aria-label") || target.textContent || "").trim().slice(0, 24);
  return { done: true, what };
}

/** カーソルの位置（または近く）の物を押す。 */
export function pressAt(x: number, y: number): PressResult {
  const t = findTarget(x, y);
  if (t) return pressElement(t.el, t.x, t.y);
  // 押せる物が無い所: 下の物にそのまま合図だけ出す（ボードなど、
  // 押せる印の無い所で反応する画面のため）。承認の印の中なら押さない。
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return { done: false, why: "" };
  if (isBlocked(el)) return { done: false, why: BLOCKED_REASON };
  return pressElement(el, x, y);
}

/** カーソルの下で、いちばん内側のスクロールできる箱を動かす。 */
export function scrollAt(x: number, y: number, px: number): void {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el && el !== document.body && el !== document.documentElement) {
    const oy = getComputedStyle(el).overflowY;
    if (/(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 1) {
      el.scrollBy({ top: px });
      return;
    }
    el = el.parentElement;
  }
  (document.scrollingElement || document.documentElement).scrollBy({ top: px });
}

/** Esc を押したことにする（開いている窓を閉じる）。 */
export function pressEscape(): void {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}
