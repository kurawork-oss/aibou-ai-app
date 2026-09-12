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
  | "chrome-flat"
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
  /** 縦長の画面で使う絵。 */
  asset?: BackgroundAsset;
  /**
   * 横長の画面で使う絵（無ければ `asset` を使う）。
   *
   * 同じ絵で両方まかなうと、どちらかが必ず大きく切られる。縦 1200×2133 の
   * 絵を 1440×900 の画面に cover で敷くと、**高さの35%しか映らない**
   * ——絵の大半が画面の外にあり、残りが 1.2 倍に引き伸ばされる。
   * 形の違う絵を2枚持つほうが、1枚を伸ばすより軽くて綺麗。
   */
  wideAsset?: BackgroundAsset;
  /** CSS が `--asset-bg` として敷く（canvas を使わない＝いちばん鮮明）。 */
  flatAsset?: boolean;
  /** 自分の画像が要る（無いときは選べない）。 */
  needsUserImage?: boolean;
}

/**
 * 縦長の画面用（スマホ）。
 *
 * 元の絵そのままの 1200×2133。前は 900×1600 に縮めて配っていたが、
 * iPhone は横に 1170 画素あるので**わずかに足りず**、水を通さない
 * 「銀の流れ」でだけ引き伸ばしが見えていた。
 *
 * 名前を変えてあるのは、前の絵が端末に取ってある人がいるため。
 * 同じ名前で中身だけ差し替えると、その人には**古い小さい絵が出続ける**
 * （Cache Storage は名前で引くので、中身が変わったことに気づけない）。
 */
const CHROME_TALL: BackgroundAsset = {
  url: "/skin-chrome-tall.webp", bytes: 189938, thumb: "/skin-chrome-tall-thumb.webp",
};
/** 横長の画面用（PC・タブレット横）。 */
const CHROME_WIDE: BackgroundAsset = {
  url: "/skin-chrome-wide.webp", bytes: 129052, thumb: "/skin-chrome-wide-thumb.webp",
};

export const BACKGROUNDS: BackgroundDef[] = [
  {
    key: "water-chrome",
    label: "水たまり・銀",
    hint: "触ると波が立つ。底に銀の流れの絵を敷く",
    render: "water",
    floor: "asset",
    asset: CHROME_TALL,
    wideAsset: CHROME_WIDE,
  },
  {
    /**
     * 水を張らない版。
     *
     * なぜ要るか——**水を通すと、絵はどうやってもぼやける**から。
     * 水は画面を格子に割って1点ずつ計算するので、絵もその格子の細かさ
     * までしか持てない。1440×900 の画面なら底は 763×477 で焼かれ、
     * Retina の実画素（2880）へは 3.8 倍に拡大して出る。元の絵を何ピクセル
     * で渡しても、ここは変わらない。
     *
     * こちらは CSS が画像をそのまま敷くので、画面の実解像度で出る
     * （Retina なら 2倍で出る）。canvas も requestAnimationFrame も
     * 使わないので、いちばん軽くもある。波が要らない人はこちら。
     */
    key: "chrome-flat",
    label: "銀の流れ",
    hint: "水を張らずに絵をそのまま敷く。いちばん鮮明で、いちばん軽い",
    render: "none",
    flatAsset: true,
    asset: CHROME_TALL,
    wideAsset: CHROME_WIDE,
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

/* 逃げ先は名前で引く。ここが「後ろから3番目」だった頃、背景を1つ足した
   だけで逃げ先が「自分の画像」に変わっていた——並べ替えただけで壊れる
   書き方はしない。 */
const PLAIN = BACKGROUNDS.find((b) => b.key === "plain") as BackgroundDef;

export function backgroundDef(key: BackgroundKey): BackgroundDef {
  return BY_KEY.get(key) ?? PLAIN;
}

/**
 * いまの画面が横長か。
 *
 * 機種ではなく**窓の形**で見る。スマホを横に倒せば横長だし、PCの窓を
 * 縦に細くすれば縦長。敷く絵を決めるのは形のほうなので、
 * 「スマホかPCか」で分けない。
 */
export function isWideScreen(): boolean {
  try {
    return window.innerWidth >= window.innerHeight;
  } catch {
    return true;          // SSR では横長（PC）を既定に
  }
}

/** この画面の形に合う絵。横長の絵を持たない背景は、そのまま1枚を使う。 */
export function assetFor(def: BackgroundDef, wide = isWideScreen()): BackgroundAsset | undefined {
  return (wide && def.wideAsset) || def.asset;
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
