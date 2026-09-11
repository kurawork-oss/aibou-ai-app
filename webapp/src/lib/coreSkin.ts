/**
 * コアの光の色を、スキンごとに持つ。
 *
 * なぜ CSS ではないのか
 * --------------------
 * コアは canvas に直接描いているので、`--accent` のような CSS 変数が届かない。
 * かといって毎フレーム `getComputedStyle` を呼ぶと、描画のたびに版組みを
 * 走らせることになる（60fps で回る所なので、ここは触らない）。
 *
 * だから色だけをこちらに持ち、`data-skin` を見て1回選ぶ。
 *
 * 決めごと
 * --------
 *   emerald … 緑の地に**白く**光る。だから中心は白のまま、縁だけ緑を差す
 *   cyber   … 紺の地に**シルバー**で光る。青みを抜いて、灰白へ寄せる
 * どちらも「地の色でコアを塗らない」。地に近い色で光らせると、光って
 * いるのか背景なのか分からなくなる。
 */

import { mix, parseHex, toHex, type Rgb } from "@/lib/color";
import { readCustomTheme, type CustomTheme, type Skin } from "@/lib/skin";

export interface CorePalette {
  /** 外側のにじみ（中心→外）。 */
  bloomIn: string;
  bloomMid: string;
  bloomOut: string;
  /** 状態のリング（listening/speaking のときに強く出る色）。 */
  ping: string;
  /** 玉の本体。中心の白から、縁の暗さまで6段。 */
  body: [string, string, string, string, string, string];
  /** 粒（球殻）の色。手前と奥で濃さを変える。 */
  shell: string;
  /** 強調中の粒（cyan 相当）。 */
  shellHot: string;
  /** 輪郭と軌道リング。 */
  ring: string;
  /** リングを走る光。 */
  ringLight: string;
}

const FORGE: CorePalette = {
  bloomIn: "150,200,255",
  bloomMid: "120,180,255",
  bloomOut: "120,180,255",
  ping: "0,243,255",
  body: [
    "rgba(255,255,255,0.98)",
    "rgba(214,234,255,0.95)",
    "rgba(158,198,245,0.72)",
    "rgba(70,118,190,0.60)",
    "rgba(22,44,86,0.78)",
    "rgba(6,12,30,0.95)",
  ],
  shell: "225,240,255",
  shellHot: "120,240,255",
  ring: "197,198,199",
  ringLight: "200,222,255",
};

/** 緑の地に、白く光る。縁にだけ緑を差して、地となじませる。 */
const EMERALD: CorePalette = {
  bloomIn: "255,255,255",
  bloomMid: "196,255,232",
  bloomOut: "120,240,200",
  ping: "120,255,214",
  body: [
    "rgba(255,255,255,1)",
    "rgba(240,255,250,0.96)",
    "rgba(196,244,226,0.74)",
    "rgba(96,190,160,0.60)",
    "rgba(18,86,70,0.80)",
    "rgba(3,32,26,0.96)",
  ],
  shell: "245,255,251",
  shellHot: "150,255,220",
  ring: "220,240,232",
  ringLight: "255,255,255",
};

/** 紺の地に、シルバーで光る。青みを抜いて灰白へ寄せる。 */
const CYBER: CorePalette = {
  bloomIn: "255,255,255",
  bloomMid: "214,222,236",
  bloomOut: "170,182,205",
  ping: "206,216,234",
  body: [
    "rgba(255,255,255,1)",
    "rgba(232,237,246,0.96)",
    "rgba(186,196,214,0.74)",
    "rgba(104,118,146,0.62)",
    "rgba(28,40,72,0.82)",
    "rgba(4,10,26,0.96)",
  ],
  shell: "236,241,250",
  shellHot: "255,255,255",
  ring: "198,207,224",
  ringLight: "232,238,248",
};

/**
 * レトロ。**色数を減らす**のがこのテーマの肝。
 *
 * 昔の機械は同時に出せる色が十数色しかなく、その制約が「ドットらしさ」
 * そのものになっている。なめらかな階調を並べると、粗いだけの絵になる。
 * だから中間色を作らず、白・水色・青・紺の4段でぶつ切りにする。
 */
const RETRO: CorePalette = {
  bloomIn: "255,255,255",
  bloomMid: "92,220,255",
  bloomOut: "48,96,220",
  ping: "255,210,63",
  body: [
    "rgba(255,255,255,1)",
    "rgba(255,255,255,1)",     // 同じ色を続けて「段」を作る（中間色を作らない）
    "rgba(92,220,255,1)",
    "rgba(92,220,255,1)",
    "rgba(48,96,220,1)",
    "rgba(16,16,48,1)",
  ],
  shell: "255,255,255",
  shellHot: "255,210,63",
  ring: "255,255,255",
  ringLight: "92,220,255",
};

const BY_SKIN: Record<Exclude<Skin, "custom">, CorePalette> = {
  cyber: CYBER,
  emerald: EMERALD,
  forge: FORGE,
  // 白い画面では、黒っぽい玉のままだと浮くので FORGE をそのまま使う
  // （元からそうしていた。ここで変えると今の見た目が変わってしまう）。
  aibou: FORGE,
  retro: RETRO,
};

/**
 * カスタムの配色を、選ばれた枠の色から作る。
 *
 * コアの色まで人に決めさせると設定が終わらないので、枠の色（＝その人が
 * 「この画面の色」と決めた色）から光を作る。中心は白のまま——地の色で
 * 光らせると、光っているのか背景なのか分からなくなる。
 */
export function customCorePalette(theme: CustomTheme): CorePalette {
  const frame = parseHex(theme.frame) ?? ({ r: 143, g: 182, b: 255 } as Rgb);
  const bg = parseHex(theme.bg) ?? ({ r: 16, g: 16, b: 24 } as Rgb);
  const ch = (c: Rgb) => `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`;
  const white = { r: 255, g: 255, b: 255 } as Rgb;
  return {
    bloomIn: "255,255,255",
    bloomMid: ch(mix(frame, white, 0.35)),
    bloomOut: ch(frame),
    ping: ch(mix(frame, white, 0.2)),
    body: [
      "rgba(255,255,255,1)",
      `${toHex(mix(white, frame, 0.12))}`,
      `${toHex(mix(white, frame, 0.45))}`,
      `${toHex(mix(frame, bg, 0.35))}`,
      `${toHex(mix(frame, bg, 0.78))}`,
      `${toHex(mix(bg, { r: 0, g: 0, b: 0 } as Rgb, 0.4))}`,
    ],
    shell: ch(mix(frame, white, 0.5)),
    shellHot: "255,255,255",
    ring: ch(mix(frame, white, 0.3)),
    ringLight: ch(mix(frame, white, 0.55)),
  };
}

/**
 * いまのスキンの配色。
 *
 * `data-skin` が読めない場所（SSR・テストのjsdom等）では既定を返す。
 * ここで例外を投げると、コアが描けずに画面の真ん中が空く。
 */
export function corePalette(skin?: Skin, custom?: CustomTheme): CorePalette {
  let s = skin;
  if (!s) {
    try {
      s = document.documentElement.dataset.skin as Skin | undefined;
    } catch {
      s = undefined;
    }
  }
  if (s === "custom") {
    try {
      return customCorePalette(custom ?? readCustomTheme());
    } catch {
      return CYBER;
    }
  }
  return (s && BY_SKIN[s as Exclude<Skin, "custom">]) || CYBER;
}

export { CYBER, EMERALD, FORGE, RETRO };
