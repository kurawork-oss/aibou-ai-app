/**
 * 見た目（テーマ）の切り替え。
 *
 *   cyber   … 既定。紺。コアと枠と影はシルバー
 *   emerald … エメラルド×金×黒。枠と影は金、コアは白く光る
 *   forge   … 宇宙。黒＋シルバーのHUD（THE FORGE OS）
 *   aibou   … 白＋薄紫のライト。AIbouブランドの明るい画面
 *   retro   … 昔のRPG。角を落とさず、白い二重枠のメッセージウィンドウ
 *   custom  … 文字色・枠色・下地・背景画像を自分で決める
 *
 * 仕組みは <html data-skin="..."> の1属性だけ。色・面・角丸・ラベルの体裁は
 * すべて globals.css の `html[data-skin="..."]` ブロックで上書きするので、
 * 各コンポーネントを書き換えずに全画面の見た目が変わる。
 *
 * custom だけは色が人の手で決まるので CSS に書けない。こちらで
 * **同じトークン名**に値を流し込む（`--fg-strong` などを inline で立てる）。
 * 入口が同じなので、各コンポーネントから見れば他のテーマと区別がない。
 *
 * コアの光だけは canvas に直接描くので CSS が効かない。そこは
 * `CORE_PALETTE` を見て描く（lib/coreSkin.ts）。
 *
 * 背景（水たまり／星空／自分の画像…）は**別の設定**になった。
 * テーマを変えても背景は変わらない（lib/background.ts）。
 */

import { isLight, mix, parseHex, rgba, toHex, type Rgb } from "@/lib/color";

export type Skin = "cyber" | "emerald" | "forge" | "aibou" | "retro" | "custom";

/** 並び順は設定画面の並び順。既定を先頭に置く。 */
export const SKINS: { key: Skin; label: string; hint: string }[] = [
  { key: "cyber", label: "CYBER（紺）", hint: "紺にシルバーの枠と影。既定" },
  { key: "emerald", label: "EMERALD（緑金）", hint: "エメラルド×金×黒。白く光るコア" },
  { key: "forge", label: "FORGE（宇宙）", hint: "黒×シルバーのHUD" },
  { key: "aibou", label: "AIbou（ライト）", hint: "白×淡い紫の明るい画面" },
  { key: "retro", label: "RETRO（ドット）", hint: "昔のRPG。白い二重枠と角のない窓" },
  { key: "custom", label: "CUSTOM（自分で）", hint: "文字色・枠色・背景画像を自分で決める" },
];

export const SKIN_KEYS: Skin[] = SKINS.map((s) => s.key);

export const DEFAULT_SKIN: Skin = "cyber";

/** localStorage のキー。他の設定と同じ forge_ 接頭辞に揃える。 */
export const SKIN_KEY = "forge_skin";
/** カスタムの色。JSON 1本で持つ。 */
export const CUSTOM_THEME_KEY = "forge_custom_theme";
/**
 * カスタムの色が変わったことを、開いている画面へ知らせるイベント名。
 *
 * CSS のトークンは属性を書き換えれば勝手に届くが、**canvas には届かない**
 * （コアの光はCSS変数を読めない）。色を変えた瞬間にコアが追従しないと、
 * 設定画面で色を選んでも何が変わったのか分からない。
 */
export const CUSTOM_THEME_EVENT = "forge:customtheme";

/** ブラウザのUI色（アドレスバー等）。切り替え時に meta も合わせる。 */
export const SKIN_THEME_COLOR: Record<Skin, string> = {
  cyber: "#080e20",
  emerald: "#03201a",
  forge: "#0a0b0f",
  aibou: "#f4f5fd",
  retro: "#0d0d20",
  // custom は人が決めた下地の色を使う（下の customThemeColor で差し替える）
  custom: "#101018",
};

/* ── カスタムの色 ────────────────────────────────────────────────── */

export interface CustomTheme {
  /** 文字の色。 */
  ink: string;
  /** 枠・線・影の色。 */
  frame: string;
  /** 下地の色（背景画像が載るまでの地、かつ面の色の元）。 */
  bg: string;
  /**
   * 背景画像の上にかける膜の濃さ（0〜0.85）。
   *
   * 写真をそのまま敷くと、明るい所に載った文字が読めなくなる
   * （送ってもらった銀の画像で実際に起きた）。ここを上げると
   * 絵は残したまま、文字と張り合わなくなる。
   */
  veil: number;
}

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  ink: "#ffffff",
  frame: "#8fb6ff",
  bg: "#101018",
  veil: 0.35,
};

/** 壊れた保存値・欠けた項目を既定で埋める。 */
export function normalizeCustomTheme(value: unknown): CustomTheme {
  const v = (value ?? {}) as Partial<CustomTheme>;
  const hex = (s: unknown, fb: string) =>
    typeof s === "string" && parseHex(s) ? toHex(parseHex(s)!) : fb;
  const veil = typeof v.veil === "number" && Number.isFinite(v.veil)
    ? Math.max(0, Math.min(0.85, v.veil))
    : DEFAULT_CUSTOM_THEME.veil;
  return {
    ink: hex(v.ink, DEFAULT_CUSTOM_THEME.ink),
    frame: hex(v.frame, DEFAULT_CUSTOM_THEME.frame),
    bg: hex(v.bg, DEFAULT_CUSTOM_THEME.bg),
    veil,
  };
}

export function readCustomTheme(): CustomTheme {
  try {
    return normalizeCustomTheme(JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) || "{}"));
  } catch {
    return DEFAULT_CUSTOM_THEME;
  }
}

/**
 * カスタムの色を、いつもの CSS トークンに変換する。
 *
 * 人が決めるのは3色だけ。本文・補助・面・入力欄まで全部決めてもらうと
 * 設定が終わらないので、**3色から残りを作る**。
 *   本文   … 文字色を下地へ少し寄せる（見出しとの差を出す）
 *   補助   … さらに寄せる
 *   面     … 下地の色を半透明で。背景が写真でも、面の上の文字の
 *            明るさが読める（＝コントラストが計算できる）ようにする
 *
 * 純粋な関数にしてあるので、DOM 無しで検算できる。
 */
export function customThemeVars(theme: CustomTheme): Record<string, string> {
  const ink = parseHex(theme.ink) ?? ({ r: 255, g: 255, b: 255 } as Rgb);
  const frame = parseHex(theme.frame) ?? ({ r: 143, g: 182, b: 255 } as Rgb);
  const bg = parseHex(theme.bg) ?? ({ r: 16, g: 16, b: 24 } as Rgb);

  const fg = mix(ink, bg, 0.16);
  const muted = mix(ink, bg, 0.44);
  const bg2 = mix(bg, ink, 0.06);
  const light = isLight(bg);

  return {
    "--bg": toHex(bg),
    "--bg2": toHex(bg2),
    "--panel": rgba(bg, 0.58),
    "--panel-bd": rgba(frame, 0.42),
    "--fg": toHex(fg),
    "--fg-strong": toHex(ink),
    "--muted": toHex(muted),
    "--muted-rgb": `${Math.round(muted.r)} ${Math.round(muted.g)} ${Math.round(muted.b)}`,
    "--line": toHex(frame),
    "--glow": rgba(frame, 0.26),
    "--glow-strong": rgba(frame, 0.4),
    "--accent": toHex(frame),
    "--input-bg": rgba(bg, 0.55),
    "--input-bd": rgba(frame, 0.46),
    "--btn-bg": rgba(frame, 0.12),
    "--btn-bd": rgba(frame, 0.55),
    "--shadow": light ? "rgba(20,24,40,0.16)" : "rgba(0,0,0,0.6)",
    "--chrome": rgba(bg, 0.86),
    "--chrome-2": rgba(bg, 0.92),
    "--tint": rgba(frame, 0.1),
    // 背景画像にかける膜（globals.css の custom ブロックが読む）
    "--veil": String(theme.veil),
    "--veil-color": light ? "255,255,255" : "0,0,0",
  };
}

export function saveCustomTheme(theme: CustomTheme): CustomTheme {
  const t = normalizeCustomTheme(theme);
  try {
    localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(t));
  } catch {
    /* 保存できなくても、見た目だけは変える */
  }
  if (readSkin() === "custom") applyCustomVars(t);
  try {
    window.dispatchEvent(new CustomEvent(CUSTOM_THEME_EVENT, { detail: t }));
  } catch {
    /* SSR では何もしない */
  }
  return t;
}

/**
 * 膜の濃さは、色ではなく**背景の設定**に属する。
 *
 * 自分の画像は他のテーマの色でも使えるので、テーマを離れたときに
 * これまで消していた（＝カスタム以外で開くと、せっかく上げた濃さが
 * 既定に戻っていた）。片付ける対象から外す。
 */
const VEIL_VARS = new Set(["--veil", "--veil-color"]);

/** カスタムの色を <html> に流し込む。他のテーマでは後片付けする。 */
export function applyCustomVars(theme: CustomTheme | null): void {
  try {
    const el = document.documentElement;
    const vars = customThemeVars(DEFAULT_CUSTOM_THEME);
    if (!theme) {
      // 残しておくと、別のテーマに切り替えても色が居座る
      for (const k of Object.keys(vars)) {
        if (!VEIL_VARS.has(k)) el.style.removeProperty(k);
      }
      return;
    }
    const next = customThemeVars(theme);
    for (const [k, v] of Object.entries(next)) el.style.setProperty(k, v);
  } catch {
    /* SSR では何もしない */
  }
}

/* ── テーマの読み書き ────────────────────────────────────────────── */

/** 未知の値・null を既定に丸める（保存値が壊れていても落ちないように）。 */
export function normalizeSkin(value: unknown): Skin {
  return typeof value === "string" && (SKIN_KEYS as string[]).includes(value)
    ? (value as Skin)
    : DEFAULT_SKIN;
}

/** 保存済みのテーマを読む。localStorage が使えない環境でも例外を投げない。 */
export function readSkin(): Skin {
  try {
    return normalizeSkin(localStorage.getItem(SKIN_KEY));
  } catch {
    return DEFAULT_SKIN;
  }
}

/** アドレスバーの色。custom のときは人が決めた下地を返す。 */
export function skinThemeColor(skin: Skin, custom?: CustomTheme): string {
  if (skin === "custom") return (custom ?? DEFAULT_CUSTOM_THEME).bg;
  return SKIN_THEME_COLOR[skin];
}

/** DOM に反映する（<html data-skin> と theme-color とカスタムの色）。 */
export function applySkin(skin: Skin): void {
  const s = normalizeSkin(skin);
  try {
    document.documentElement.dataset.skin = s;
    const custom = s === "custom" ? readCustomTheme() : null;
    applyCustomVars(custom);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", skinThemeColor(s, custom ?? undefined));
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
 * 別のテーマで一瞬描かれてから切り替わる「ちらつき」が出る）。
 *
 * テーマの一覧と色は上の定義から差し込む。ここに名前を直書きすると、
 * テーマを足したときに**この行だけ古いまま**になり、初回だけ既定の色で
 * 描かれる（前にテーマが2つだったころ、実際そう書いてあった）。
 *
 * カスタムの色もここで流し込む。Reactを待つと、一瞬だけ既定の紺が
 * 出てから自分の色に変わる——それが「重い」と感じる正体になる。
 * 計算は customThemeVars と同じものを、素のJSで最小限に写している。
 * （関数をそのまま埋め込めないため。ズレるとカスタムの初回だけ色が
 *  違うので、tests/appearance.spec.ts で両者の一致を見ている）
 */
export const SKIN_BOOT_SCRIPT =
  `(function(){try{` +
  `var K=${JSON.stringify(SKIN_KEYS)},C=${JSON.stringify(SKIN_THEME_COLOR)};` +
  `var s=localStorage.getItem("${SKIN_KEY}");` +
  `if(K.indexOf(s)<0)s="${DEFAULT_SKIN}";` +
  `var d=document.documentElement;d.setAttribute("data-skin",s);` +
  `var tc=C[s];` +
  `if(s==="custom"){` +
    `var D=${JSON.stringify(DEFAULT_CUSTOM_THEME)},t=D;` +
    `try{t=Object.assign({},D,JSON.parse(localStorage.getItem("${CUSTOM_THEME_KEY}")||"{}"))}catch(e){}` +
    `var hx=function(h,f){h=String(h||"").replace("#","");` +
      `if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];` +
      `var n=parseInt(h,16);return h.length===6&&!isNaN(n)?[n>>16&255,n>>8&255,n&255]:f};` +
    `var ink=hx(t.ink,[255,255,255]),fr=hx(t.frame,[143,182,255]),bg=hx(t.bg,[16,16,24]);` +
    `var mixc=function(a,b,k){return[a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k,a[2]+(b[2]-a[2])*k]};` +
    `var hex=function(c){return"#"+c.map(function(v){return("0"+Math.round(v).toString(16)).slice(-2)}).join("")};` +
    `var rg=function(c,a){return"rgba("+Math.round(c[0])+","+Math.round(c[1])+","+Math.round(c[2])+","+a+")"};` +
    `var lum=function(c){var f=function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};` +
      `return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2])};` +
    `var li=lum(bg)>0.35,mu=mixc(ink,bg,0.44);` +
    `var V={"--bg":hex(bg),"--bg2":hex(mixc(bg,ink,0.06)),"--panel":rg(bg,0.58),` +
      `"--panel-bd":rg(fr,0.42),"--fg":hex(mixc(ink,bg,0.16)),"--fg-strong":hex(ink),` +
      `"--muted":hex(mu),"--muted-rgb":Math.round(mu[0])+" "+Math.round(mu[1])+" "+Math.round(mu[2]),` +
      `"--line":hex(fr),"--glow":rg(fr,0.26),"--glow-strong":rg(fr,0.4),"--accent":hex(fr),` +
      `"--input-bg":rg(bg,0.55),"--input-bd":rg(fr,0.46),"--btn-bg":rg(fr,0.12),"--btn-bd":rg(fr,0.55),` +
      `"--shadow":li?"rgba(20,24,40,0.16)":"rgba(0,0,0,0.6)","--chrome":rg(bg,0.86),` +
      `"--chrome-2":rg(bg,0.92),"--tint":rg(fr,0.1),"--veil":String(t.veil),` +
      `"--veil-color":li?"255,255,255":"0,0,0"};` +
    `for(var k in V)d.style.setProperty(k,V[k]);` +
    `tc=hex(bg);` +
  `}` +
  `var m=document.querySelector('meta[name="theme-color"]');` +
  `if(m)m.setAttribute("content",tc);` +
  `}catch(e){}})();`;
