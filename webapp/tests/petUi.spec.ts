/**
 * ペット（components/Pet.tsx）。画面の上での振る舞い。
 *
 * ペットは見た目だけの物。だから見張るのは2つ:
 *   ・様子が正しく出る（待機・困った）。押すと「動いていること」が出る
 *   ・会話の邪魔をしない（列を高くしない・入力欄や切り替えに重ならない・
 *     Esc で外の画面まで閉じない・動きを減らす設定では止まる）
 *
 * 作業中・確認待ち・できた は、バックエンドが要るので
 * tests/linked/pets.spec.ts で見る。
 */

import { test, expect, type Page } from "@playwright/test";
import { enterApp } from "./cameraHelpers";
import { plusButton } from "./nav";

const pet = (page: Page) => page.locator("[data-pet]").first();
const petButton = (page: Page) => page.getByRole("button", { name: /^ペットの/ }).first();

async function say(page: Page, text: string) {
  const box = page.getByPlaceholder(/メッセージ…$/);
  await box.fill(text);
  await box.press("Enter");
}

test("最初から会話の右下にいて、待機中は何も言わない", async ({ page }) => {
  await enterApp(page);
  await expect(pet(page)).toHaveAttribute("data-pet", "mochi");
  await expect(pet(page)).toHaveAttribute("data-pet-mood", "idle");
  await expect(page.locator("[data-pet-says]")).toHaveCount(0);

  // 入力欄の右上（会話の切り替えと同じ列の右端）にいる
  const p = (await petButton(page).boundingBox())!;
  const composer = (await page.getByPlaceholder(/メッセージ…$/).boundingBox())!;
  const toggle = (await page.getByRole("button", { name: /^💬 会話$/ }).boundingBox())!;
  expect(p.y + p.height, "入力欄の上にいない").toBeLessThanOrEqual(composer.y + 1);
  expect(p.x, "右端にいない").toBeGreaterThan(toggle.x + toggle.width);
});

test("押すと「動いていること」が出て、Esc ではそれだけ閉じる", async ({ page }) => {
  await enterApp(page);
  await petButton(page).click();
  const box = page.getByRole("dialog", { name: "モチのようす" });
  await expect(box).toBeVisible();
  await expect(box.locator('[data-activity="chat"]')).toContainText("会話: 待機中");
  await expect(box).toContainText("ほかに動いているものはありません");

  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);

  // 画面の上でも、Esc は一覧だけ閉じる（外の画面まで閉じない）
  await say(page, "タスク見せて");
  const panel = page.locator('[data-panel="tasks"]');
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^ペットの/ }).click();
  await expect(page.getByRole("dialog", { name: "モチのようす" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "モチのようす" })).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(panel, "ペットの一覧と一緒に、画面まで閉じた").toBeVisible();
});

test("画面を開いている間も上の列にいて、「会話を見る」で会話へ戻れる", async ({ page }) => {
  await enterApp(page);
  await say(page, "タスク見せて");
  const panel = page.locator('[data-panel="tasks"]');
  await expect(panel).toBeVisible();
  // 会話の側のペットは出さない（同じ物が2つ並ばない）
  await expect(page.locator("[data-pet]")).toHaveCount(1);
  await panel.getByRole("button", { name: /^ペットの/ }).click();
  await page.getByRole("button", { name: "会話を見る" }).click();
  await expect(panel).toHaveCount(0);
  await expect(pet(page)).toBeVisible();
});

test("「＋」の「ペット」で選べて、再読込しても残る", async ({ page }) => {
  await enterApp(page);
  await plusButton(page).click();
  await page.locator('[data-action="pet"]').click();
  const picker = page.getByRole("dialog", { name: "ペットを選ぶ" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("radio", { name: /^モチ/ })).toHaveAttribute("aria-checked", "true");

  await picker.getByRole("radio", { name: /^ピヨ/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(pet(page)).toHaveAttribute("data-pet", "piyo");

  await enterApp(page);
  await expect(pet(page)).toHaveAttribute("data-pet", "piyo");
});

test("「/pet」でも選ぶ窓が開く（ChatGPT と同じ呼び方）", async ({ page }) => {
  await enterApp(page);
  const box = page.getByPlaceholder(/メッセージ…$/);
  await box.fill("/pet");
  const menu = page.getByRole("listbox", { name: "できること" });
  await expect(menu.getByRole("option").first()).toHaveAttribute("data-action", "pet");
  await box.press("Enter");
  await expect(page.getByRole("dialog", { name: "ペットを選ぶ" })).toBeVisible();
  await expect(box, "選んだあとに「/pet」が残っている").toHaveValue("");
});

test("会話で「ペット変えて」なら選ぶ窓、「ペット隠して」なら消える。カードから戻せる", async ({ page }) => {
  await enterApp(page);
  await say(page, "ペット変えて");
  const picker = page.getByRole("dialog", { name: "ペットを選ぶ" });
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  await say(page, "ペット隠して");
  await expect(page.locator("[data-pet]")).toHaveCount(0);
  await expect(page.getByText(/ペットを隠しました/)).toBeVisible();

  // 会話に残ったカードから、また選べる
  await page.locator('[data-action-card="pet"]').last().getByRole("button", { name: /選ぶ/ }).click();
  await expect(picker).toBeVisible();
  await picker.getByRole("radio", { name: /^コロ/ }).click();
  await expect(pet(page)).toHaveAttribute("data-pet", "koro");
});

test("ペットの「隠す」でも消え、再読込しても出てこない", async ({ page }) => {
  await enterApp(page);
  await petButton(page).click();
  await page.getByRole("button", { name: "隠す", exact: true }).click();
  await expect(page.locator("[data-pet]")).toHaveCount(0);
  await enterApp(page);
  await expect(page.locator("[data-pet]")).toHaveCount(0);
});

test("失敗すると、困った顔になる", async ({ page }) => {
  // バックエンドが無いので、送ると失敗する
  await enterApp(page);
  await say(page, "こんにちは");
  await expect(pet(page)).toHaveAttribute("data-pet-mood", "blocked", { timeout: 10_000 });
  await petButton(page).click();
  await expect(page.getByRole("dialog", { name: /のようす$/ })).toContainText("会話: うまくいかなかった");
});

test("動きを減らす設定では、止まった絵になる", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enterApp(page);
  const art = pet(page).locator("svg.pet-art");
  await expect(art).toHaveClass(/pet-still/);
  const moving = await art.evaluate((svg) =>
    [...svg.querySelectorAll("*")].filter((el) => getComputedStyle(el).animationName !== "none").length);
  expect(moving, "止まっていない部品がある").toBe(0);
});

test("動きを減らしていなければ、待機中も息をしている", async ({ page }) => {
  // 上の確認が空振りしていない（そもそも動いていない）ことを確かめる
  await enterApp(page);
  const name = await pet(page).locator("svg.pet-art .pet-body").evaluate((g) => getComputedStyle(g).animationName);
  expect(name).toBe("pet-breathe");
});

test.describe("スマホ", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("入力欄の上の列に収まり、列を高くしない・切り替えに重ならない", async ({ page }) => {
    await enterApp(page);
    const row = page.getByRole("button", { name: /^💬 会話$/ }).locator("xpath=../..");
    const withPet = (await row.boundingBox())!;
    const p = (await petButton(page).boundingBox())!;
    const run = (await page.getByRole("button", { name: /実行（司令塔）/ }).boundingBox())!;
    const composer = (await page.getByPlaceholder(/メッセージ…$/).boundingBox())!;

    expect(p.x + p.width, "画面の右へはみ出している").toBeLessThanOrEqual(375);
    expect(p.x, "切り替えに重なっている").toBeGreaterThanOrEqual(run.x + run.width);
    expect(p.y + p.height, "入力欄に重なっている").toBeLessThanOrEqual(composer.y + 1);
    expect(p.width).toBeGreaterThanOrEqual(44);
    expect(p.height).toBeGreaterThanOrEqual(44);

    // 隠したときと、列の高さが変わらない
    await petButton(page).click();
    await page.getByRole("button", { name: "隠す", exact: true }).click();
    const without = (await row.boundingBox())!;
    expect(Math.abs(withPet.height - without.height), `列の高さ ${without.height} → ${withPet.height}`)
      .toBeLessThanOrEqual(1);
  });

  test("「動いていること」が画面からはみ出さない", async ({ page }) => {
    await enterApp(page);
    await petButton(page).click();
    const box = (await page.getByRole("dialog", { name: /のようす$/ }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y).toBeGreaterThanOrEqual(0);
  });
});
