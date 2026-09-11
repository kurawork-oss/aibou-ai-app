/**
 * 色の計算。
 *
 * なぜ要るのか
 * ------------
 * 「カスタム」のテーマでは、文字の色と枠の色を人が選ぶ。選べるという
 * ことは、**読めない組み合わせも選べる**ということで、白地に白文字を
 * 選んだ人は設定画面ごと読めなくなって戻せなくなる。
 *
 * だから選んだ瞬間にコントラスト比を出して、足りなければその場で警告し、
 * 押すだけで直せるようにする。そのための計算をここに置く。
 *
 * 比の基準は WCAG 2.1。本文は 4.5:1、大きい文字は 3:1 が目安。
 * （目安であって規格の全部ではない。ここで見ているのは明るさの差だけ）
 *
 * CSS の color-mix() でも混色はできるが、
 *   ・比の計算には結局 JS が要る（混ぜた結果を読み戻せない）
 *   ・古いブラウザで黙って効かない
 * ので、混ぜる側も JS に寄せて1か所にまとめる。
 */

export interface Rgb { r: number; g: number; b: number }

/** `#rgb` `#rrggbb` を読む。読めなければ null（例外にしない）。 */
export function parseHex(hex: string): Rgb | null {
  const s = hex.trim().replace(/^#/, "");
  if (s.length === 3) {
    const [r, g, b] = s.split("").map((c) => parseInt(c + c, 16));
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  return null;
}

const clamp255 = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

export function toHex({ r, g, b }: Rgb): string {
  const h = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** a と b を t（0〜1）で混ぜる。t=0 で a、t=1 で b。 */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
  };
}

/** `rgba(r,g,b,a)` の文字列。canvas と CSS のどちらでも使える形。 */
export function rgba({ r, g, b }: Rgb, a: number): string {
  return `rgba(${clamp255(r)},${clamp255(g)},${clamp255(b)},${a})`;
}

/** 相対輝度（WCAG の定義）。 */
export function luminance({ r, g, b }: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** コントラスト比（1〜21）。順番はどちらでもよい。 */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 背景に対して**確実に読める**文字色（白か黒）を返す。
 *
 * 「直す」ボタンの中身。人が選んだ色相を保ったまま直そうとすると、
 * 直した結果がまた足りない、ということが起きる。白か黒に振れば、
 * どんな背景でも必ず 4.5 を超える側がある。
 */
export function readableInk(bg: Rgb): Rgb {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  return contrast(white, bg) >= contrast(black, bg) ? white : black;
}

/** 明るい地か（パネルの膜を白と黒のどちらにするかの判断）。 */
export function isLight(bg: Rgb): boolean {
  return luminance(bg) > 0.35;
}
