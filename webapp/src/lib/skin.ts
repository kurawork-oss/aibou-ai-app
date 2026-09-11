/**
 * 見た目（スキン）の切り替え。
 *
 *   cyber   … 既定。紺の水面（触ると波が立つ）。コアと枠と影はシルバー
 *   emerald … エメラルド×金×黒。枠と影は金、コアは白く光る
 *   forge   … 宇宙。黒＋シルバーのHUD（THE FORGE OS）
 *   aibou   … 白＋薄紫のライト。AIbouブランドの明るい画面
 *
 * 仕組みは <html data-skin="..."> の1属性だけ。色・面・角丸・ラベルの体裁は
 * すべて globals.css の `html[data-skin="..."]` ブロックで上書きするので、
 * 各コンポーネントを書き換えずに全画面の見た目が変わる。
 *
 * コアの光だけは canvas に直接描くので CSS が効かない。そこは
 * `CORE_PALETTE` を見て描く（lib/coreSkin.ts）。
 *
 * ここは副作用の無い関数と、DOMに1回だけ触る関数に分けてある（テストしやすさ）。
 */

export type Skin = "cyber" | "emerald" | "forge" | "aibou";

/** 並び順は設定画面の並び順。既定を先頭に置く。 */
export const SKINS: { key: Skin; label: string; hint: string }[] = [
  { key: "cyber", label: "CYBER（紺）", hint: "紺の水面。触ると波が立つ。コアはシルバー。既定" },
  { key: "emerald", label: "EMERALD（緑金）", hint: "エメラルド×金×黒。白く光るコア" },
  { key: "forge", label: "FORGE（宇宙）", hint: "黒×シルバーのHUD。星空とグリッド" },
  { key: "aibou", label: "AIbou（ライト）", hint: "白×淡い紫の明るい画面" },
];

export const SKIN_KEYS: Skin[] = SKINS.map((s) => s.key);

export const DEFAULT_SKIN: Skin = "cyber";

/** localStorage のキー。他の設定と同じ forge_ 接頭辞に揃える。 */
export const SKIN_KEY = "forge_skin";

/** ブラウザのUI色（アドレスバー等）。切り替え時に meta も合わせる。 */
export const SKIN_THEME_COLOR: Record<Skin, string> = {
  cyber: "#080e20",
  emerald: "#03201a",
  forge: "#0a0b0f",
  aibou: "#f4f5fd",
};

/** 未知の値・null を既定に丸める（保存値が壊れていても落ちないように）。 */
export function normalizeSkin(value: unknown): Skin {
  return typeof value === "string" && (SKIN_KEYS as string[]).includes(value)
    ? (value as Skin)
    : DEFAULT_SKIN;
}

/** 保存済みのスキンを読む。localStorage が使えない環境でも例外を投げない。 */
export function readSkin(): Skin {
  try {
    return normalizeSkin(localStorage.getItem(SKIN_KEY));
  } catch {
    return DEFAULT_SKIN;
  }
}

/** DOM に反映する（<html data-skin> と theme-color）。 */
export function applySkin(skin: Skin): void {
  const s = normalizeSkin(skin);
  try {
    document.documentElement.dataset.skin = s;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", SKIN_THEME_COLOR[s]);
  } catch {
    /* SSR や属性が触れない環境では何もしない */
  }
}

/** 保存して反映する。 */
export function setSkin(skin: Skin): Skin {
  const s = normalizeSkin(skin);
  try {
    localStorage.setItem(SKIN_KEY, s);
  } catch {
    /* 保存できなくても見た目だけは変える */
  }
  applySkin(s);
  return s;
}

/**
 * 最初の描画より前に <html data-skin> を立てるための素のJS。
 * layout.tsx から <script> として差し込む（Reactのマウントを待つと、
 * 別のスキンで一瞬描かれてから切り替わる「ちらつき」が出る）。
 *
 * スキンの一覧と色は上の定義から差し込む。ここに名前を直書きすると、
 * スキンを足したときに**この行だけ古いまま**になり、初回だけ既定の色で
 * 描かれる（前にスキンが2つだったころ、実際そう書いてあった）。
 */
export const SKIN_BOOT_SCRIPT =
  `(function(){try{` +
  `var K=${JSON.stringify(SKIN_KEYS)},C=${JSON.stringify(SKIN_THEME_COLOR)};` +
  `var s=localStorage.getItem("${SKIN_KEY}");` +
  `if(K.indexOf(s)<0)s="${DEFAULT_SKIN}";` +
  `document.documentElement.setAttribute("data-skin",s);` +
  `var m=document.querySelector('meta[name="theme-color"]');` +
  `if(m)m.setAttribute("content",C[s]);` +
  `}catch(e){}})();`;
