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

function isTextEntry(el: HTMLElement): boolean {
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].includes(el.type);
}

export type PressResult =
  | { done: true; what: string }
  | { done: false; why: string };

export function pressAt(x: number, y: number): PressResult {
  const el = document.elementFromPoint(x, y);
  if (!el) return { done: false, why: "" };
  if (isBlocked(el)) {
    return { done: false, why: "このボタンは手では押せません（取り消せない操作のため）。マウスか指で押してください。" };
  }
  const target = ((el.closest(CLICKABLE) as HTMLElement | null) ?? (el as HTMLElement));
  if ((target as HTMLButtonElement).disabled || target.getAttribute("aria-disabled") === "true") {
    return { done: false, why: "いまは押せません。" };
  }
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
