/**
 * 背景の選択。テーマ（色）とは別の設定。
 *
 * なぜ分けたのか
 * --------------
 * 前は「紺のテーマ＝水たまり」「宇宙のテーマ＝星空」と固定だった。
 * 白い画面で星を見たい人も、レトロの色で水を見たい人も選べない。
 * 色と背景は別の好みなので、別の設定にする。
 *
 * 既定は `auto`＝テーマに合った背景。今まで通りの見え方になるので、
 * 何も触っていない人の画面は変わらない。
 *
 * 落とす物と落とさない物
 * ----------------------
 * ほとんどの背景は**コードで描いている**ので、通信は 0 byte。
 * 通信が要るのは写真を敷く背景だけ。だから一覧では「ダウンロード」を
 * 出すのはその2つだけで、残りは押した瞬間に変わる。
 *
 * 「重い背景が増えると開くのが遅くなる」を避けるため、素材は
 * **選ぶまで取りに行かない**（lib/assetCache.ts）。
 */

import type { Skin } from "@/lib/skin";

export type BackgroundKey =
  | "water-chrome"
  | "water-grid"
  | "stars"
  | "retro"
  | "emerald"
  | "plain"
  | "user-flat"
  | "user-water";

/** canvas の描き分け。`none` は canvas を止める（CSS だけで見せる）。 */
export type BackgroundRender = "water" | "stars" | "retro" | "none";

export interface BackgroundAsset {
  /** 本体（選んだときだけ落とす）。 */
  url: string;
  /** 目安の大きさ（人に見せる用）。 */
  bytes: number;
  /** 一覧に出す見本。本体よりずっと小さい物を用意する。 */
  thumb: string;
}

export interface BackgroundDef {
  key: BackgroundKey;
  label: string;
  hint: string;
  render: BackgroundRender;
  /** 水の底に何を敷くか。 */
  floor?: "grid" | "asset" | "user";
  asset?: BackgroundAsset;
  /** 自分の画像が要る（無いときは選べない）。 */
  needsUserImage?: boolean;
}

export const BACKGROUNDS: BackgroundDef[] = [
  {
    key: "water-chrome",
    label: "水たまり・銀",
    hint: "触ると波が立つ。底に銀の流れの絵を敷く",
    render: "water",
    floor: "asset",
    asset: { url: "/skin-cyber-floor.webp", bytes: 118062, thumb: "/skin-cyber-floor-thumb.webp" },
  },
  {
    key: "water-grid",
    label: "水たまり・線",
    hint: "触ると波が立つ。底は細い格子（ダウンロード不要）",
    render: "water",
    floor: "grid",
  },
  { key: "stars", label: "星空", hint: "星と流れ星と星座。奥へ伸びる格子の床", render: "stars" },
  { key: "retro", label: "ドットの夜", hint: "昔のゲームの夜空。粗い画素でそのまま描く", render: "retro" },
  { key: "emerald", label: "金の綾", hint: "エメラルドの地に金の斜線（CSSだけ）", render: "none" },
  { key: "plain", label: "無地", hint: "何も描かない。いちばん軽い", render: "none" },
  {
    key: "user-flat",
    label: "自分の画像",
    hint: "保存した画像をそのまま敷く",
    render: "none",
    needsUserImage: true,
  },
  {
    key: "user-water",
    label: "自分の画像＋水",
    hint: "保存した画像を水の底に敷く。触ると歪む",
    render: "water",
    floor: "user",
    needsUserImage: true,
  },
];

const BY_KEY = new Map(BACKGROUNDS.map((b) => [b.key, b]));

export function backgroundDef(key: BackgroundKey): BackgroundDef {
  return BY_KEY.get(key) ?? BACKGROUNDS[BACKGROUNDS.length - 3]; // plain
}

/** テーマごとの既定。`auto` のときに使う。 */
export const DEFAULT_BACKGROUND: Record<Skin, BackgroundKey> = {
  cyber: "water-chrome",
  emerald: "emerald",
  forge: "stars",
  aibou: "plain",
  retro: "retro",
  custom: "plain",
};

/** 保存される値。`auto` はテーマに合わせる、の意味。 */
export type BackgroundChoice = BackgroundKey | "auto";

export const BACKGROUND_KEY = "forge_bg";
/** 切り替えを、開いている画面（Backdrop3D）へ伝えるイベント名。 */
export const BACKGROUND_EVENT = "forge:background";

const VALID = new Set<string>([...BY_KEY.keys(), "auto"]);

export function normalizeBackground(value: unknown): BackgroundChoice {
  return typeof value === "string" && VALID.has(value) ? (value as BackgroundChoice) : "auto";
}

export function readBackground(): BackgroundChoice {
  try {
    return normalizeBackground(localStorage.getItem(BACKGROUND_KEY));
  } catch {
    return "auto";
  }
}

/**
 * 実際に描く背景を決める。
 *
 * 自分の画像が要る背景を選んだまま画像を消した場合は、無地へ逃がす。
 * ここで逃がさないと、真っ黒な画面になって設定へ戻る道が分からなくなる。
 */
export function resolveBackground(
  skin: Skin, choice: BackgroundChoice, hasUserImage: boolean,
): BackgroundKey {
  // 「自分で決める」テーマで画像を保存した人は、おまかせのままその画像を出す。
  // ここで出さないと、画像を保存したのに無地のままで「保存できていない」
  // ように見える。
  const auto = skin === "custom" && hasUserImage ? "user-flat" : DEFAULT_BACKGROUND[skin] ?? "plain";
  const key = choice === "auto" ? auto : choice;
  const def = BY_KEY.get(key);
  if (!def) return "plain";
  if (def.needsUserImage && !hasUserImage) return "plain";
  return key;
}

/** <html data-bg> に立てる。CSS 側の背景（金の綾・自分の画像）はこれを見る。 */
export function applyBackground(key: BackgroundKey): void {
  try {
    document.documentElement.dataset.bg = key;
  } catch {
    /* SSR では何もしない */
  }
}

/**
 * 最初の描画より前に <html data-bg> を立てる素のJS。
 *
 * これが無いと、CSS が持っている背景（金の綾・自分の画像）と
 * 「canvas を出すか」の判断が、Reactのマウントまで決まらない。
 * つまり**開いた一瞬だけ違う背景**が見える。設定を増やしたぶん、
 * ちらつきも増えるので、ここで先に決めてしまう。
 *
 * 自分の画像があるかだけは、ここでは分からない（IndexedDB は同期で
 * 読めない）。選んでいる人はある前提で置き、無ければ Backdrop3D が
 * 1コマ内に無地へ直す。無い人に一瞬だけ地の色が見えるだけで済む。
 *
 * data-skin は skin.ts の起動スクリプトが先に立てている前提。
 * layout.tsx でその順に並べてある。
 */
export const BACKGROUND_BOOT_SCRIPT =
  `(function(){try{` +
  `var D=${JSON.stringify(DEFAULT_BACKGROUND)},K=${JSON.stringify([...BY_KEY.keys()])};` +
  `var d=document.documentElement,s=d.getAttribute("data-skin")||"cyber";` +
  `var c=localStorage.getItem("${BACKGROUND_KEY}");` +
  `if(K.indexOf(c)<0)c=D[s]||"plain";` +
  `d.setAttribute("data-bg",c);` +
  `}catch(e){}})();`;

export function setBackground(choice: BackgroundChoice): BackgroundChoice {
  const v = normalizeBackground(choice);
  try {
    localStorage.setItem(BACKGROUND_KEY, v);
  } catch {
    /* 保存できなくても表示だけは切り替える */
  }
  try {
    window.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: v }));
  } catch {
    /* SSR では何もしない */
  }
  return v;
}
