/**
 * カメラ操作モードを、本物のブラウザで通す。
 *
 * カメラは Chromium の偽物（--use-fake-device-for-media-stream）を使う。
 * 映るのは動く模様だけで、手も顔も映らない。だからここで確かめるのは
 * 「カメラが開く・認識の部品が読み込まれて回り始める・止めたらカメラが
 * 消える・映っていない物を映っていないと言う」まで。手の形の見分け方は
 * tests/handGesture.spec.ts、顔の照合は tests/faceMatch.spec.ts が見ている。
 * 実際の手と顔での使い心地は、実機のカメラで確かめるしかない。
 *
 * モデルは jsDelivr から取る作りだが、テストでは外へ出ない。
 * 入っている npm の中身（node_modules/@vladmandic/human/models）を返す。
 */

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { enterApp, liveTracks, serveModels, trackStreams } from "./cameraHelpers";

const FAKE_CAMERA = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  // 画面の無い所でも WebGL を使う（TensorFlow.js が使う）
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
];

test.use({
  launchOptions: [async ({ launchOptions }, use) => {
    await use({ ...launchOptions, args: [...(launchOptions.args ?? []), ...FAKE_CAMERA] });
  }, { scope: "worker" }],
  permissions: ["camera"],
});

const panel = (page: Page) => page.getByRole("complementary", { name: "カメラ操作" });

test("広い画面: 上のボタンで始めると、カメラが開いて認識が回り始め、止めるとカメラが消える", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveModels(page);
  await trackStreams(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await enterApp(page);

  await page.getByRole("button", { name: "カメラで操作（顔と手）" }).click();
  await expect(panel(page)).toBeVisible();
  // 偽のカメラには手が映らないので、ここまで来れば「読み込み → 回っている」
  await expect(panel(page).locator("[data-camera-status]"))
    .toHaveText("手を映してください", { timeout: 90_000 });
  // 次にすることを言う
  await expect(panel(page).locator("[data-camera-hint]"))
    .toHaveText("手のひらをカメラに向けて、顔の横くらいまで上げてください。");
  expect(await liveTracks(page)).toBe(1);

  // 映像が実際に流れている（止まった絵ではない）
  const playing = await panel(page).locator("video").evaluate((v: HTMLVideoElement) =>
    v.readyState >= 2 && v.videoWidth > 0 && !v.paused);
  expect(playing).toBe(true);

  // 回っている間に落ちていない
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);

  await panel(page).getByRole("button", { name: "カメラ操作を止める" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => liveTracks(page)).toBe(0);
});

test("設定から始めると、設定は閉じて操作モードになる", async ({ page }) => {
  test.setTimeout(120_000);
  await serveModels(page);
  await trackStreams(page);
  await enterApp(page);
  await page.getByLabel("Settings").click();
  const section = page.getByRole("region", { name: "カメラで操作" });
  await section.scrollIntoViewIfNeeded();
  await expect(section).toContainText("登録した人が映っている間だけ");
  // 約束を画面に書いてある（映像を送らない・顔はこの端末だけ・ログインの代わりではない）
  await expect(section).toContainText("保存も送信もしません");
  await expect(section).toContainText("この端末にだけ保存");
  await expect(section).toContainText("ログインの代わりではありません");

  await section.getByRole("button", { name: "▶ カメラ操作を始める" }).click();
  await expect(page.getByText("CORE SETTINGS")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator("[data-camera-status]"))
    .toHaveText("手を映してください", { timeout: 90_000 });
  await panel(page).getByRole("button", { name: "カメラ操作を止める" }).click();
  await expect.poll(() => liveTracks(page)).toBe(0);
});

test("顔の登録: 顔が映っていなければ、そう言う。やめるとカメラが消える", async ({ page }) => {
  test.setTimeout(120_000);
  await serveModels(page);
  await trackStreams(page);
  await enterApp(page);
  await page.getByLabel("Settings").click();
  const section = page.getByRole("region", { name: "カメラで操作" });
  await section.getByRole("button", { name: "顔を登録する" }).scrollIntoViewIfNeeded();
  await section.getByRole("button", { name: "顔を登録する" }).click();
  await expect(section.locator("[data-face-hint]"))
    .toHaveText("顔が見えません。カメラの正面に顔を入れてください。", { timeout: 90_000 });
  expect(await liveTracks(page)).toBe(1);
  await section.getByRole("button", { name: "やめる" }).click();
  await expect.poll(() => liveTracks(page)).toBe(0);
  // 撮れていないので、登録されていない
  await expect(section.locator("[data-face-registered]")).toHaveAttribute("data-face-registered", "0");
});

test("顔の登録を設定を閉じて打ち切っても、カメラが点きっぱなしにならない", async ({ page }) => {
  test.setTimeout(120_000);
  await serveModels(page);
  await trackStreams(page);
  await enterApp(page);
  await page.getByLabel("Settings").click();
  const section = page.getByRole("region", { name: "カメラで操作" });
  await section.getByRole("button", { name: "顔を登録する" }).scrollIntoViewIfNeeded();
  await section.getByRole("button", { name: "顔を登録する" }).click();
  await expect.poll(() => liveTracks(page), { timeout: 30_000 }).toBe(1);
  await page.keyboard.press("Escape"); // 設定は Esc で閉じる
  await expect(page.getByText("CORE SETTINGS")).toHaveCount(0);
  await expect.poll(() => liveTracks(page)).toBe(0);
});

test("カメラを断られたら、どうすれば使えるかを言う", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  await enterApp(page);
  await page.getByRole("button", { name: "カメラで操作（顔と手）" }).click();
  await expect(panel(page).locator("[data-camera-status]")).toContainText("許可");
  await expect(panel(page).getByRole("button", { name: "もう一度" })).toBeVisible();
});

test("登録した顔があれば、本人を確かめるまで手では動かない", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveModels(page);
  await page.addInitScript(() => {
    // 1024個の特徴を5枚（中身は何でもよい。偽のカメラには顔が映らない）
    const one = btoa(String.fromCharCode(...new Uint8Array(new Float32Array(1024).fill(0.03).buffer)));
    localStorage.setItem("forge_camera_face", JSON.stringify({ v: 1, at: Date.now(), samples: [one, one, one, one, one] }));
  });
  await enterApp(page);
  await page.getByRole("button", { name: "カメラで操作（顔と手）" }).click();
  // 顔が映っていないので、手の操作には進まない
  await expect(panel(page).locator("[data-camera-status]"))
    .toHaveText("登録した顔が見えないので止めています", { timeout: 90_000 });
  await panel(page).getByRole("button", { name: "カメラ操作を止める" }).click();
});

test("スマホの1列にはボタンを足さない（設定からは始められる）", async ({ page }) => {
  await enterApp(page);
  await expect(page.getByRole("button", { name: "カメラで操作（顔と手）" })).toHaveCount(0);
  await page.getByLabel("Settings").click();
  await expect(page.getByRole("region", { name: "カメラで操作" })
    .getByRole("button", { name: "▶ カメラ操作を始める" })).toBeVisible();
});

test("承認のボタンには、手で押させない印が付いている", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, "../src/components", f), "utf8");
  // 押すと取り消せない操作が通るボタン。印（data-gesture-block）が無いと、手の認識の揺れで通りうる
  const cases: [string, RegExp][] = [
    ["Chat.tsx", /onClick=\{onApprove\}[^>]*data-gesture-block/],
    ["Chat.tsx", /onClick=\{onAlways\}[^>]*data-gesture-block/],
    ["PendingApprovals.tsx", /data-gesture-block\s*\n\s*onClick=\{\(\) => void answer\(a\.id, "approve"\)\}/],
    ["Home.tsx", /onClick=\{\(\) => void approve\(\)\}[^>]*data-gesture-block/],
    ["Income.tsx", /data-gesture-block\s*\n\s*onClick=\{\(\) => onAct\(job\.id!, "approve"\)\}/],
  ];
  for (const [file, re] of cases) expect(read(file), file).toMatch(re);
});

/* ── 2巡目: はじめての練習・押し方と速さ ───────────────────────── */

const practice = (page: Page) => page.getByRole("dialog", { name: "カメラ操作の練習" });

test("はじめて始めると練習が出る。スキップすれば次からは出ない", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveModels(page);
  await enterApp(page);
  await page.getByRole("button", { name: "カメラで操作（顔と手）" }).click();
  await expect(practice(page)).toBeVisible({ timeout: 90_000 });
  await expect(practice(page).locator("[data-practice-step]")).toHaveAttribute("data-practice-step", "hand");
  await expect(practice(page)).toContainText("手のひらをカメラに向けて");
  await practice(page).getByRole("button", { name: "スキップ" }).click();
  await expect(practice(page)).toHaveCount(0);

  // 止めて、もう一度始める → 練習は出ない
  await panel(page).getByRole("button", { name: "カメラ操作を止める" }).click();
  await page.getByRole("button", { name: "カメラで操作（顔と手）" }).click();
  await expect(panel(page).locator("[data-camera-status]")).toHaveText("手を映してください", { timeout: 90_000 });
  await expect(practice(page)).toHaveCount(0);

  // 「？」から、練習をもう一度
  await panel(page).getByRole("button", { name: "手の形の一覧" }).click();
  await expect(panel(page).getByRole("list", { name: "手の形と動き" })).toContainText("1秒止める");
  await panel(page).getByRole("button", { name: "練習をもう一度" }).click();
  await expect(practice(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "カメラ操作を止める" }).click();
});

test("設定: 押し方と速さを選べて、覚えている", async ({ page }) => {
  await enterApp(page);
  await page.getByLabel("Settings").click();
  const section = page.getByRole("region", { name: "カメラで操作" });
  const how = section.getByRole("radiogroup", { name: "押し方" });
  const speed = section.getByRole("radiogroup", { name: "カーソルの速さ" });
  await expect(how.getByRole("radio", { name: "両方" })).toHaveAttribute("aria-checked", "true");
  await how.getByRole("radio", { name: "止めるだけ" }).click();
  await speed.getByRole("radio", { name: "はやい" }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("forge_camera_prefs") || "{}"));
  expect(saved.clickMode).toBe("dwell");
  expect(saved.speed).toBe("fast");
  await page.reload();
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByRole("region", { name: "カメラで操作" }).getByRole("radiogroup", { name: "押し方" })
    .getByRole("radio", { name: "止めるだけ" })).toHaveAttribute("aria-checked", "true");
});

/* ── カーソルが押す物を決める所（lib/pointerDom.ts）を、本物のブラウザで ── */

/** pointerDom.ts を、そのままページに読み込める形にする（import の無い1ファイル）。 */
function pointerDomScript(): string {
  const src = fs.readFileSync(path.join(__dirname, "../src/lib/pointerDom.ts"), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
  return `(() => { ${js.replace(/^export /gm, "")}
    window.__pd = { findTarget, pressAt, pressElement }; })();`;
}

async function pointerPage(page: Page) {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <style>body{margin:0} button{position:absolute;padding:0;border:0}</style>
    <button id="small" style="left:100px;top:100px;width:20px;height:20px">✕</button>
    <button id="big" style="left:300px;top:300px;width:200px;height:80px">大きい</button>
    <button id="approve" data-gesture-block style="left:600px;top:100px;width:80px;height:30px">実行する</button>
    <button id="off" disabled style="left:100px;top:400px;width:40px;height:40px">off</button>
    <input id="text" style="position:absolute;left:600px;top:400px;width:120px;height:30px" />
  `);
  await page.addScriptTag({ content: pointerDomScript() });
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[] };
    w.__log = [];
    for (const id of ["small", "big", "approve", "text"]) {
      for (const ev of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        document.getElementById(id)!.addEventListener(ev, () => w.__log.push(`${id}:${ev}`));
      }
    }
  });
}

type PD = { findTarget: (x: number, y: number) => null | { el: HTMLElement; x: number; y: number; snapped: boolean; blocked: boolean } };

test("小さなボタンのすぐ脇で止まっても、吸い付いて押せる", async ({ page }) => {
  await pointerPage(page);
  const r = await page.evaluate(() => {
    const pd = (window as unknown as { __pd: PD }).__pd;
    const near = pd.findTarget(140, 110); // ✕ の右端から20px
    const on = pd.findTarget(110, 110);
    const far = pd.findTarget(200, 200);
    return {
      near: near && { id: near.el.id, snapped: near.snapped, x: near.x, y: near.y },
      on: on && { id: on.el.id, snapped: on.snapped },
      far,
    };
  });
  expect(r.near?.id).toBe("small");
  expect(r.near?.snapped).toBe(true);
  // 押すのはボタンの中
  expect(r.near!.x).toBeLessThanOrEqual(120);
  expect(r.near!.x).toBeGreaterThanOrEqual(100);
  expect(r.on).toEqual({ id: "small", snapped: false });
  expect(r.far).toBeNull();
});

test("大きなボタンは、カーソルの位置で押す（真ん中へ飛ばない）", async ({ page }) => {
  await pointerPage(page);
  const t = await page.evaluate(() => {
    const x = (window as unknown as { __pd: PD }).__pd.findTarget(320, 310);
    return x && { id: x.el.id, x: x.x, y: x.y };
  });
  expect(t).toEqual({ id: "big", x: 320, y: 310 });
});

test("押すときはマウスと同じ順に合図を出す。文字の欄なら入力できる状態にする", async ({ page }) => {
  await pointerPage(page);
  const log = await page.evaluate(() => {
    const pd = (window as unknown as { __pd: { pressAt: (x: number, y: number) => unknown } }).__pd;
    pd.pressAt(140, 110);
    pd.pressAt(650, 415);
    return { log: (window as unknown as { __log: string[] }).__log, focused: document.activeElement?.id };
  });
  expect(log.log.slice(0, 5)).toEqual(["small:pointerdown", "small:mousedown", "small:pointerup", "small:mouseup", "small:click"]);
  expect(log.focused).toBe("text");
});

test("承認のボタンは、真上でも・吸い付きでも押さない。押せないボタンには吸い付かない", async ({ page }) => {
  await pointerPage(page);
  const r = await page.evaluate(() => {
    const w = window as unknown as { __pd: PD & { pressAt: (x: number, y: number) => { done: boolean; why?: string } }; __log: string[] };
    const direct = w.__pd.pressAt(640, 115);
    const snapped = w.__pd.pressAt(700, 115);
    const t = w.__pd.findTarget(640, 115);
    const off = w.__pd.findTarget(120, 420);
    return { direct, snapped, blocked: t?.blocked, off: off?.el.id ?? null, log: w.__log };
  });
  expect(r.direct.done).toBe(false);
  expect(r.direct.why).toContain("手では押せません");
  expect(r.snapped.done).toBe(false);
  expect(r.blocked).toBe(true);
  expect(r.log.filter((l) => l.startsWith("approve:"))).toEqual([]);
  expect(r.off).toBeNull();
});

/* ── 3巡目: 手を2回たたいて始める・止める ────────────────────────── */

test("パンパンを入れるとマイクで聞き始め、偽マイクのピッという音では動かない。切るとマイクが消える", async ({ page }) => {
  test.setTimeout(60_000);
  await serveModels(page);
  await trackStreams(page);
  await enterApp(page);
  await page.getByLabel("Settings").click();
  const section = page.getByRole("region", { name: "カメラで操作" });
  const box = section.getByRole("checkbox", { name: /手を2回たたいて/ });
  await box.scrollIntoViewIfNeeded();
  await box.check();
  await expect(section.locator("[data-clap-status]")).toHaveAttribute("data-clap-status", "listening", { timeout: 15_000 });
  expect(await liveTracks(page)).toBe(1);
  // Chrome の偽マイクは1秒ごとにピッと鳴る。4秒聞いても、カメラ操作は始まらない
  await page.waitForTimeout(4000);
  await expect(panel(page)).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("forge_camera_prefs") || "{}"));
  expect(saved.clapToggle).toBe(true);

  await box.uncheck();
  await expect.poll(() => liveTracks(page)).toBe(0);
  await expect(section.locator("[data-clap-status]")).toHaveCount(0);
});

test("パンパンは既定では切ってある（勝手にマイクを開かない）", async ({ page }) => {
  await trackStreams(page);
  await enterApp(page);
  await page.waitForTimeout(1500);
  expect(await liveTracks(page)).toBe(0);
  await page.getByLabel("Settings").click();
  await expect(page.getByRole("region", { name: "カメラで操作" })
    .getByRole("checkbox", { name: /手を2回たたいて/ })).not.toBeChecked();
});
