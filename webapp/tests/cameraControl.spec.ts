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
import { MODEL_BASE } from "../src/lib/vision";

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

const MODELS_DIR = path.join(__dirname, "../node_modules/@vladmandic/human/models");

async function serveModels(page: Page) {
  await page.route(`${MODEL_BASE}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const file = path.join(MODELS_DIR, name);
    if (!name || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    await route.fulfill({
      status: 200,
      body: fs.readFileSync(file),
      contentType: name.endsWith(".json") ? "application/json" : "application/octet-stream",
    });
  });
}

/** 開いたカメラを覚えておく（止めたあと、本当に消えたかを見るため）。テストの中だけの仕掛け。 */
async function trackStreams(page: Page) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const orig = md.getUserMedia.bind(md);
    (window as unknown as { __streams: MediaStream[] }).__streams = [];
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await orig(c);
      (window as unknown as { __streams: MediaStream[] }).__streams.push(s);
      return s;
    };
  });
}

const liveTracks = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __streams?: MediaStream[] }).__streams ?? [])
    .flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);

async function enterApp(page: Page) {
  await page.goto("/");
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hud = page.locator('nav[aria-label="Mobile navigation"], nav[aria-label="画面の切り替え"]')
    .getByRole("button", { name: "管理", exact: true }).first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()).catch(() => {}),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await hud.waitFor({ timeout: 10_000 });
}

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
