/**
 * usePhone — スマホの幅で開いているか（Tailwind の sm 未満）。
 *
 * 見た目の切り替えは、できるだけ CSS（sm:）でやる。ここを使うのは、
 * **並べる物そのものを変える**とき（上の飾りを1列にまとめる、入力欄の
 * 横のボタンを減らす）だけ。CSS で隠すと、同じ物が2つ並んで、
 * 読み上げ・テスト・キーボード操作のどれもが隠れた方を拾う。
 *
 * 描く前に決める（useLayoutEffect）。描いてから切り替えると、開いた瞬間に
 * 大きいコアが一瞬出てから縮む。
 */

import { useEffect, useLayoutEffect, useState } from "react";

export const PHONE_QUERY = "(max-width: 639px)";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 指で打っている端末か（画面のキーボード）。幅ではなく、指かどうかで見る。
 * 幅の狭いPCの窓は Enter で送りたいし、横にしたタブレットは幅が広くても指で打つ。
 */
export function isTouchTyping(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useIsoLayoutEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return phone;
}
