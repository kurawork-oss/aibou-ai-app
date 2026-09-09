/**
 * `#` の窓を、繋がっている画面で見る。
 *
 * ここは長いあいだ手作業でしか確かめられていなかった（候補はサーバーから
 * 来るので、オフラインのビルドでは1つも出ない）。そして実際、そこに
 * バグが残っていた——`#ボード` が画面を開かず「管理タブから探して
 * ください」と返すだけで、近道になっていなかった。
 *
 * だから見るのは「出るか」ではなく **「押したら着くか」**。
 */

import { test, expect } from "@playwright/test";
import { enterApp, mockBackend } from "./backend";

test("# を打つと候補が出て、打つほど絞れる", async ({ page }) => {
  await mockBackend(page);
  await enterApp(page);

  const ta = page.locator("textarea").first();
  await ta.fill("#");
  await expect(page.getByText("タスクを追加")).toBeVisible();
  await expect(page.getByText("画像をつくる")).toBeVisible();
  // 引数が要る物は、何を書けばいいか先に見せる
  await expect(page.getByText("#タスク やること")).toBeVisible();

  // 日本語入力は必ずかなを通る。変換前に絞れること。
  await ta.fill("#がぞう");
  await expect(page.getByText("画像をつくる")).toBeVisible();
  await expect(page.getByText("タスクを追加")).toHaveCount(0);
});

test("知らない名前でも行き止まりにしない", async ({ page }) => {
  await mockBackend(page);
  await enterApp(page);
  await page.locator("textarea").first().fill("#ぜんぜんちがう");
  await expect(page.getByText(/そのまま送れば/)).toBeVisible();
});

test("文の途中の # では候補を出さない", async ({ page }) => {
  // ハッシュタグや見出しを書けなくなるため。
  await mockBackend(page);
  await enterApp(page);
  await page.locator("textarea").first().fill("これは #tag です");
  await expect(page.getByText("タスクを追加")).toHaveCount(0);
});

test("引数のいる近道は、選ぶと続きを書く形になる", async ({ page }) => {
  await mockBackend(page);
  await enterApp(page);
  const ta = page.locator("textarea").first();
  await ta.fill("#がぞう");
  await page.getByText("画像をつくる").click();
  // 名前が入って、続きを書ける状態になる（勝手に実行しない）
  await expect(ta).toHaveValue("#画像 ");
  await expect(page.getByText("タスクを追加")).toHaveCount(0);   // 窓は閉じる
});

test("画面ものは、その場で開く", async ({ page }) => {
  // 「管理タブから探してください」で終わっていた所。近道の意味が無い。
  const be = await mockBackend(page);
  await enterApp(page);
  const ta = page.locator("textarea").first();
  await ta.fill("#ボード");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "＋ 付箋" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/管理タブから開けます/)).toHaveCount(0);
  expect(be.calls.some((c) => c.path === "/command")).toBeTruthy();
});

test("引数つきの近道は、AIに考えさせず直行する", async ({ page }) => {
  const be = await mockBackend(page);
  await enterApp(page);
  const ta = page.locator("textarea").first();
  await ta.fill("#画像 猫の絵");
  await page.keyboard.press("Enter");

  // 会話にも残る（あとから何をしたか読み返せる）
  await expect(page.getByText("画像をつくる：やりました")).toBeVisible({ timeout: 10_000 });
  // /command で済み、会話（/chat）へは回っていない
  expect(be.count("/command")).toBe(1);
  expect(be.count("/chat")).toBe(0);
});

test("引数を書き忘れたら、勝手に決めずに聞く", async ({ page }) => {
  await mockBackend(page);
  await enterApp(page);
  const ta = page.locator("textarea").first();
  await ta.fill("#画像");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/どんな絵かを書いてください/)).toBeVisible({ timeout: 10_000 });
  await expect(ta).toHaveValue("#画像 ");
});

test("切ってある機能の近道は、はじめから出さない", async ({ page }) => {
  const be = await mockBackend(page);
  be.state.packs = be.state.packs.map((p) =>
    p.key === "dev" ? { ...p, enabled: false } : p);
  await enterApp(page);
  await page.locator("textarea").first().fill("#");
  await expect(page.getByText("ホワイトボードを開く")).toBeVisible();
  await expect(page.getByText("コードの作業場を開く")).toHaveCount(0);
});
