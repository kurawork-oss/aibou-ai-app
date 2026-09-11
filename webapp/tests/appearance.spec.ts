/**
 * 見た目の設定まわりの、**数で決まる性質**。
 *
 * ここで押さえていないと、それぞれ次の形で表に出る：
 *
 *   読めない配色を止められない → 設定画面ごと読めなくなって、戻せない
 *   背景の逃がし先が無い       → 画像を消した瞬間に真っ黒な画面になる
 *   起動スクリプトがずれる     → カスタムの初回だけ違う色で描かれる
 *
 * ブラウザが要らない部分はここで、要る部分は tests/lookUi.spec.ts で見る。
 */

import { test, expect } from "@playwright/test";
import {
  contrast, isLight, luminance, mix, parseHex, readableInk, toHex,
} from "../src/lib/color";
import {
  DEFAULT_CUSTOM_THEME, SKINS, SKIN_BOOT_SCRIPT, SKIN_KEYS, SKIN_THEME_COLOR,
  customThemeVars, normalizeCustomTheme, normalizeSkin,
} from "../src/lib/skin";
import {
  BACKGROUNDS, DEFAULT_BACKGROUND, backgroundDef, normalizeBackground, resolveBackground,
} from "../src/lib/background";
import { veilFor } from "../src/lib/imageStore";

/* ── 色 ────────────────────────────────────────────────────────── */

test("色の読み取りは、壊れた値で落ちない", async () => {
  expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
  expect(parseHex("00ff88")).toEqual({ r: 0, g: 255, b: 136 });
  for (const bad of ["", "#", "#12", "#12345", "rgb(1,2,3)", "とても青い"]) {
    expect(parseHex(bad), bad).toBeNull();
  }
});

test("コントラスト比は WCAG の目安と合う", async () => {
  const white = parseHex("#ffffff")!;
  const black = parseHex("#000000")!;
  // 白と黒は 21:1（定義上の最大）
  expect(contrast(white, black)).toBeCloseTo(21, 1);
  // 同じ色どうしは 1:1
  expect(contrast(white, white)).toBeCloseTo(1, 5);
  // 順番を変えても同じ
  expect(contrast(white, black)).toBeCloseTo(contrast(black, white), 6);
});

test("「直す」は、どんな地の色でも必ず読める文字色を返す", async () => {
  // ここが肝。人が選んだ色相を保ったまま直そうとすると、直した結果が
  // また足りない、が起きる。白か黒に振れば必ず 4.5 を超える側がある。
  const samples = [
    "#000000", "#ffffff", "#808080", "#7f7f7f", "#767676",
    "#03201a", "#f4f5fd", "#ffd23f", "#8fb6ff", "#e0455f",
  ];
  for (const hex of samples) {
    const bg = parseHex(hex)!;
    const ink = readableInk(bg);
    expect(contrast(ink, bg), `${hex} → ${toHex(ink)}`).toBeGreaterThanOrEqual(4.5);
  }
});

test("明るい地・暗い地の判定が、膜の色と噛み合う", async () => {
  expect(isLight(parseHex("#ffffff")!)).toBe(true);
  expect(isLight(parseHex("#f4f5fd")!)).toBe(true);
  expect(isLight(parseHex("#080e20")!)).toBe(false);
  expect(isLight(parseHex("#0d0d20")!)).toBe(false);
  // 輝度そのものも単調（明るいほど大きい）
  expect(luminance(parseHex("#ffffff")!)).toBeGreaterThan(luminance(parseHex("#808080")!));
  expect(luminance(parseHex("#808080")!)).toBeGreaterThan(luminance(parseHex("#000000")!));
});

test("混色は端で元の色に戻る", async () => {
  const a = parseHex("#000000")!;
  const b = parseHex("#ffffff")!;
  expect(toHex(mix(a, b, 0))).toBe("#000000");
  expect(toHex(mix(a, b, 1))).toBe("#ffffff");
  // 範囲の外を渡しても飛び出さない
  expect(toHex(mix(a, b, -5))).toBe("#000000");
  expect(toHex(mix(a, b, 9))).toBe("#ffffff");
});

/* ── カスタムの設定 ──────────────────────────────────────────────── */

test("壊れた保存値でも、必ず使える設定になる", async () => {
  const bad = normalizeCustomTheme({ ink: "青", frame: null, bg: "#12345", veil: 99 });
  expect(bad.ink).toBe(DEFAULT_CUSTOM_THEME.ink);
  expect(bad.frame).toBe(DEFAULT_CUSTOM_THEME.frame);
  expect(bad.bg).toBe(DEFAULT_CUSTOM_THEME.bg);
  expect(bad.veil).toBeLessThanOrEqual(0.85);   // 真っ暗にはならない
  expect(normalizeCustomTheme({ veil: -3 }).veil).toBeGreaterThanOrEqual(0);
  expect(normalizeCustomTheme(null).ink).toBe(DEFAULT_CUSTOM_THEME.ink);
  expect(normalizeCustomTheme("こわれた").ink).toBe(DEFAULT_CUSTOM_THEME.ink);
});

test("3色から、画面で使うトークンが全部そろう", async () => {
  const vars = customThemeVars({ ink: "#ffffff", frame: "#8fb6ff", bg: "#101018", veil: 0.35 });
  // 各画面が読んでいるトークンが欠けていると、そこだけ前のテーマの色が残る
  for (const k of [
    "--bg", "--bg2", "--panel", "--panel-bd", "--fg", "--fg-strong", "--muted",
    "--muted-rgb", "--line", "--glow", "--glow-strong", "--accent",
    "--input-bg", "--input-bd", "--btn-bg", "--btn-bd", "--shadow",
    "--chrome", "--chrome-2", "--tint",
  ]) {
    expect(vars[k], k).toBeTruthy();
  }
  expect(vars["--fg-strong"]).toBe("#ffffff");
  expect(vars["--accent"]).toBe("#8fb6ff");
});

test("本文と補助は、見出しより地に寄っている（差が出ている）", async () => {
  // 3色しか選ばないので、本文・補助はこちらで作る。ここが同じ色だと
  // 見出しと本文の区別が消えて、のっぺりした画面になる。
  const theme = { ink: "#ffffff", frame: "#8fb6ff", bg: "#101018", veil: 0.35 };
  const v = customThemeVars(theme);
  const bg = parseHex(theme.bg)!;
  const strong = contrast(parseHex(v["--fg-strong"])!, bg);
  const body = contrast(parseHex(v["--fg"])!, bg);
  const muted = contrast(parseHex(v["--muted"])!, bg);
  expect(strong).toBeGreaterThan(body);
  expect(body).toBeGreaterThan(muted);
  // 補助でも、読めなくなるほどは落とさない
  expect(muted).toBeGreaterThan(3);
});

/* ── テーマの一覧 ────────────────────────────────────────────────── */

test("テーマの一覧・色・起動スクリプトが、そろって同じ物を指す", async () => {
  // ここがずれると「設定には出るが、開いた瞬間だけ既定の色」になる。
  // 前にスキンが2つだったころ、起動スクリプトに名前が直書きしてあった。
  for (const s of SKINS) {
    expect(SKIN_KEYS, s.key).toContain(s.key);
    expect(SKIN_THEME_COLOR[s.key], s.key).toMatch(/^#[0-9a-f]{6}$/i);
    expect(SKIN_BOOT_SCRIPT, s.key).toContain(`"${s.key}"`);
  }
  expect(SKIN_KEYS.length).toBe(SKINS.length);
});

test("知らないテーマ名は既定に丸まる", async () => {
  expect(normalizeSkin("nonsense")).toBe("cyber");
  expect(normalizeSkin(null)).toBe("cyber");
  expect(normalizeSkin(42)).toBe("cyber");
  expect(normalizeSkin("retro")).toBe("retro");
});

/* ── 背景 ────────────────────────────────────────────────────────── */

test("どのテーマにも、既定の背景が決まっている", async () => {
  for (const s of SKINS) {
    const key = DEFAULT_BACKGROUND[s.key];
    expect(key, s.key).toBeTruthy();
    expect(BACKGROUNDS.map((b) => b.key), s.key).toContain(key);
  }
});

test("自分の画像が無いまま選ばれていたら、無地へ逃がす", async () => {
  // 逃がさないと真っ黒な画面になって、設定へ戻る道が分からなくなる。
  expect(resolveBackground("cyber", "user-flat", false)).toBe("plain");
  expect(resolveBackground("cyber", "user-water", false)).toBe("plain");
  expect(resolveBackground("cyber", "user-flat", true)).toBe("user-flat");
});

test("おまかせは、テーマに合った背景になる", async () => {
  expect(resolveBackground("cyber", "auto", false)).toBe("water-chrome");
  expect(resolveBackground("forge", "auto", false)).toBe("stars");
  expect(resolveBackground("aibou", "auto", false)).toBe("plain");
  expect(resolveBackground("retro", "auto", false)).toBe("retro");
  // 自分で決めるテーマで画像を保存した人は、おまかせのままその画像が出る
  expect(resolveBackground("custom", "auto", false)).toBe("plain");
  expect(resolveBackground("custom", "auto", true)).toBe("user-flat");
});

test("知らない背景名は、おまかせに丸まる", async () => {
  expect(normalizeBackground("nonsense")).toBe("auto");
  expect(normalizeBackground(null)).toBe("auto");
  expect(normalizeBackground("water-grid")).toBe("water-grid");
  // 丸めた後も必ず解決できる
  expect(backgroundDef(resolveBackground("cyber", normalizeBackground("???"), false))).toBeTruthy();
});

test("通信が要る背景は、見本と本体が別々に用意されている", async () => {
  // 一覧を開いただけで本体が落ちたら、ダウンロード式にした意味が無い。
  const withAsset = BACKGROUNDS.filter((b) => b.asset);
  expect(withAsset.length, "落とす素材のある背景が1つも無い").toBeGreaterThan(0);
  for (const b of withAsset) {
    expect(b.asset!.thumb, b.key).not.toBe(b.asset!.url);
    expect(b.asset!.bytes, b.key).toBeGreaterThan(0);
  }
  // 大半は通信 0 のまま（増やしすぎていないことの歯止め）
  expect(withAsset.length).toBeLessThan(BACKGROUNDS.length / 2);
});

test("水を使う背景には、底の指定がある", async () => {
  for (const b of BACKGROUNDS) {
    if (b.render !== "water") continue;
    expect(b.floor, b.key).toBeTruthy();
    // 画像を敷く指定なら、その画像がある
    if (b.floor === "asset") expect(b.asset, b.key).toBeTruthy();
  }
});

test("膜の濃さは、色のトークンと一緒に持ち歩く", async () => {
  /* 膜は「色」ではなく「背景」の設定だが、保存場所はカスタムの設定と
     同じ1本にしてある（つまみが2か所に散らないように）。
     実際に消えないかどうかは、DOM が要るので lookUi.spec.ts で見る。 */
  const vars = customThemeVars({ ink: "#ffffff", frame: "#8fb6ff", bg: "#101018", veil: 0.62 });
  expect(vars["--veil"]).toBe("0.62");
  expect(vars["--veil-color"]).toBe("0,0,0");            // 暗い地 → 黒い膜
  const light = customThemeVars({ ink: "#000000", frame: "#3b5bfd", bg: "#ffffff", veil: 0.2 });
  expect(light["--veil-color"]).toBe("255,255,255");     // 明るい地 → 白い膜
});

/* ── 背景画像の膜 ───────────────────────────────────────────────── */

test("膜の濃さは、画像の明るさから式で決まる", async () => {
  /* 決め打ちの35%で明るい写真を敷いたら、上の文字が飛んだ。逆に暗い
     写真へ同じ35%をかけると、ただ真っ暗になる。感覚ではなく、
     コントラスト比 4.5 の式から逆算する。 */

  // 明るい画像ほど、濃い膜が要る（単調であること）
  const bright = veilFor(0.75, true);
  const mid = veilFor(0.40, true);
  const dark = veilFor(0.05, true);
  expect(bright).toBeGreaterThan(mid);
  expect(mid).toBeGreaterThan(dark);

  // 出した濃さで、白い文字が実際に読めるようになっていること
  for (const L of [0.05, 0.2, 0.4, 0.6, 0.75, 0.95]) {
    const a = veilFor(L, true);
    const after = L * (1 - a);                       // 黒い膜を重ねた後の明るさ
    const ratio = (1 + 0.05) / (after + 0.05);       // 白い文字との比
    // 上限 0.85 で頭打ちにしているので、極端に明るい画像だけは届かない。
    // そこは「つまみで下げる」ではなく「これ以上暗くしない」を選んでいる。
    if (a < 0.85) expect(ratio, `明るさ${L} → 膜${a.toFixed(2)}`).toBeGreaterThanOrEqual(4.4);
  }

  // 明るいテーマ（黒い文字）では、白い膜で地を明るくする向きになる
  for (const L of [0.05, 0.3, 0.6]) {
    const a = veilFor(L, false);
    const after = L * (1 - a) + a;
    const ratio = (after + 0.05) / (0 + 0.05);
    expect(ratio, `明るさ${L} → 白い膜${a.toFixed(2)}`).toBeGreaterThanOrEqual(4.4);
  }
});

test("膜は行き過ぎない（真っ暗にも、無効にもならない）", async () => {
  for (const L of [0, 0.001, 0.5, 1, Number.NaN, Infinity, -5]) {
    const a = veilFor(L, true);
    expect(a, `明るさ${L}`).toBeGreaterThanOrEqual(0.15);
    expect(a, `明るさ${L}`).toBeLessThanOrEqual(0.85);
  }
});
