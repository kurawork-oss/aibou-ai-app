/**
 * 声の設定の検証。
 *
 * ここが壊れると「設定を変えても声が変わらない」に逆戻りする。実際に確かめ
 * たいのは、選んだ内容がちゃんと保存されて読み上げ側へ渡ることと、鳴らない
 * 状況（端末に音声が入っていない／バックエンド未接続）を隠さないこと。
 *
 * 音そのものはヘッドレスでは鳴らせない（この環境の Chromium は音声が0件）。
 * 音が出るかどうかは実機で耳で確かめるしかないので、ここでは「設定が正しく
 * 保たれて渡るか」までを見る。
 */

import { test, expect, type Page } from "@playwright/test";

async function enterApp(page: Page) {
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hud = page.getByLabel("Modes", { exact: true });
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()).catch(() => {}),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await hud.waitFor({ timeout: 10_000 });
}

test("何も保存していない人は、等倍の速さ・標準の高さで始まる", async ({ page }) => {
  // Number(null) が 0 になるため、素直に範囲へ押し込むと未設定の人が
  // いきなり最低速（0.5倍）になる。実際に踏んだので、既定値を固定で見張る。
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  // 声の設定は「声」タブへ移した（前は物置の CORE の中）
  await page.getByRole("button", { name: "声", exact: true }).click();
  await expect(page.getByLabel("Talk speed")).toHaveValue("1", { timeout: 5_000 });
  await expect(page.getByLabel("Voice pitch")).toHaveValue("1");
});

test("声の設定に、出どころ・声・速さ・高さ・試聴がそろっている", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  // 声の設定は「声」タブへ移した（前は物置の CORE の中）
  await page.getByRole("button", { name: "声", exact: true }).click();

  await expect(page.getByText("VOICE SOURCE")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /端末の声/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /サーバーの声/ })).toBeVisible();
  await expect(page.getByText("CORE VOICE")).toBeVisible();
  await expect(page.getByText("TALK SPEED")).toBeVisible();
  await expect(page.getByText("VOICE PITCH")).toBeVisible();
  await expect(page.getByRole("button", { name: /この声で試聴/ })).toBeVisible();
});

test("音声が入っていない端末では、鳴らないことをはっきり伝える", async ({ page }) => {
  // このテスト環境の Chromium は音声を1つも持たない＝実際に起きる状況
  await page.goto("/");
  await enterApp(page);
  const voices = await page.evaluate(() => window.speechSynthesis?.getVoices().length ?? 0);
  test.skip(voices > 0, "この環境には音声が入っているため、この確認は不要");

  await page.getByLabel("Settings").click();
  // 声の設定は「声」タブへ移した（前は物置の CORE の中）
  await page.getByRole("button", { name: "声", exact: true }).click();
  await expect(page.getByText(/この端末には音声が入っていない/)).toBeVisible({ timeout: 5_000 });
});

test("バックエンド未接続なら、サーバーの声は選べない", async ({ page }) => {
  // テストは NEXT_PUBLIC_API_URL 空（未接続）で動く
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  // 声の設定は「声」タブへ移した（前は物置の CORE の中）
  await page.getByRole("button", { name: "声", exact: true }).click();
  await expect(page.getByRole("button", { name: /サーバーの声/ })).toBeDisabled();
});

test("試聴ボタンを押しても画面が壊れない（音声が無い端末でも固まらない）", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  // 声の設定は「声」タブへ移した（前は物置の CORE の中）
  await page.getByRole("button", { name: "声", exact: true }).click();
  await page.getByRole("button", { name: /この声で試聴/ }).click();
  await page.waitForTimeout(1200);
  // 「再生中…」のまま固まらず、押せる状態に戻ること
  await expect(page.getByRole("button", { name: /この声で試聴/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("速さと高さを変えて保存すると、次に開いたときも残っている", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  // 声の設定は「声」タブへ移した（前は物置の CORE の中）
  await page.getByRole("button", { name: "声", exact: true }).click();

  await page.getByLabel("Talk speed").fill("1.35");
  await page.getByLabel("Voice pitch").fill("1.2");
  await page.getByRole("button", { name: /SAVE|保存/ }).first().click();

  // 保存先に入っていること（読み上げ側はここから読む）
  const saved = await page.evaluate(() => ({
    rate: localStorage.getItem("forge_tts_rate"),
    pitch: localStorage.getItem("forge_tts_pitch"),
    engine: localStorage.getItem("forge_voice_engine"),
  }));
  expect(Number(saved.rate)).toBeCloseTo(1.35, 2);
  expect(Number(saved.pitch)).toBeCloseTo(1.2, 2);
  expect(saved.engine).toBeTruthy();

  // 開き直しても残っている
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await page.getByLabel("Settings").click();
  // 声の設定は「声」タブへ移した（前は物置の CORE の中）
  await page.getByRole("button", { name: "声", exact: true }).click();
  await expect(page.getByLabel("Talk speed")).toHaveValue("1.35");
  await expect(page.getByLabel("Voice pitch")).toHaveValue("1.2");
});
