/**
 * つくる系（画像・SNS・録音）を、繋がっている状態で見る。
 *
 * この3つに共通するのは「時間もお金もかかる操作」だということ。
 * だから、いちばん困るのは失敗そのものではなく
 *
 *   ・失敗したのに成功と言う  → 出来ていない物を待ち続ける
 *   ・何が起きているか不明    → もう一度押していいのか分からない
 *
 * の2つ。ここではその2つを見る。
 */

import { test, expect, type Page } from "@playwright/test";
import { enterApp, mockBackend, type Backend } from "./backend";

/** 管理タブの「もっと」から、その画面を開く。 */
async function openMore(page: Page, label: string | RegExp, mark: string | RegExp) {
  await page.getByLabel("Mobile navigation").getByText("管理", { exact: true }).click();
  await page.getByRole("button", { name: /もっと/ }).click();
  await page.getByRole("button", { name: label }).click();
  await expect(page.getByText(mark)).toBeVisible({ timeout: 10_000 });
}

/* ── 画像をつくる ───────────────────────────────────────────────── */
async function openImage(page: Page) {
  await openMore(page, /つくる/, /WEBアプリ|何を作りますか/);
  await page.getByRole("button", { name: /素材/ }).click();
  await expect(page.getByText(/指示|プロンプト|どんな/).first()).toBeVisible({ timeout: 10_000 });
}

function withImage(be: Backend) {
  be.set("/image/aspects", { json: { items: [{ key: "1:1", label: "正方形" }] } });
  be.set("/image/engines", { json: { items: [{ key: "auto", label: "おまかせ" }] } });
}

test("画像が作れなかったら、その理由を出す", async ({ page }) => {
  const be = await mockBackend(page);
  withImage(be);
  be.set("/image/generate", { status: 400, json: { error: "画像の生成に対応した鍵がありません" } });
  await enterApp(page);
  await openImage(page);

  const box = page.locator("textarea, input[type=text]").filter({ hasNot: page.locator("[disabled]") }).first();
  await box.fill("夕焼けの富士山");
  await page.getByRole("button", { name: /生成|つくる|作る/ }).first().click();

  await expect(page.getByText(/対応した鍵がありません/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/✓/)).toHaveCount(0);
});

test("一部だけ失敗したときは、出来た数と失敗を両方言う", async ({ page }) => {
  // 「2案できました」とだけ言うと、頼んだ4案のうち2つ落ちたことが伝わらない。
  const be = await mockBackend(page);
  withImage(be);
  be.set("/image/generate", { json: {
    images: [{ url: "data:image/png;base64,iVBORw0KGgo=", seed: 1 }],
    width: 1024, height: 1024, engine: "auto",
    partial_error: "1件は混雑のため作れませんでした",
  } });
  await enterApp(page);
  await openImage(page);
  const box = page.locator("textarea, input[type=text]").first();
  await box.fill("夕焼けの富士山");
  await page.getByRole("button", { name: /生成|つくる|作る/ }).first().click();

  await expect(page.getByText(/1案/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/一部失敗/)).toBeVisible();
});

/* ── SNSの文案 ──────────────────────────────────────────────────── */
test("SNSの文案が作れなかったら、そう言う", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/x/status", { json: { connected: false } });
  be.set("/sns/generate", { status: 503, json: { detail: "AIの利用券が設定されていません" } });
  await enterApp(page);
  await openMore(page, /SNS/, /SNS投稿サポート/);

  const box = page.locator("textarea").first();
  await box.fill("新商品を出しました");
  await page.getByRole("button", { name: /作る|生成|文案/ }).first().click();

  await expect(page.getByText(/利用券が設定されていません/)).toBeVisible({ timeout: 10_000 });
});

test("Xに繋いでいないときは、投稿ボタンを出さずに次の手を書く", async ({ page }) => {
  // 押せるボタンを出しておいて、押したら「繋いでいません」が
  // いちばん困る。出さずに、どうすれば送れるかを書く。
  const be = await mockBackend(page);
  be.set("/x/status", { json: { configured: false, missing: ["X_API_KEY"], autopost_allowed: false, limit: 280 } });
  be.set("/sns/generate", { json: { ok: true, platform: "x", limit: 280, posts: [
    { text: "新商品を出しました。", hashtags: ["#新商品"], length: 10, over_limit: false },
  ] } });
  await enterApp(page);
  await openMore(page, /SNS/, /SNS投稿サポート/);

  await page.locator("textarea").first().fill("新商品を出しました");
  await page.getByRole("button", { name: /作る|生成|文案/ }).first().click();
  await expect(page.getByText("新商品を出しました。")).toBeVisible({ timeout: 10_000 });

  await expect(page.getByRole("button", { name: /に投稿/ })).toHaveCount(0);
  await expect(page.getByText(/設定するまではコピーして投稿します/)).toBeVisible();
});

test("Xに繋いであれば、押したときだけ送ると明記する", async ({ page }) => {
  // 勝手に投稿されないことを、投稿ボタンの隣で言う。
  const be = await mockBackend(page);
  be.set("/x/status", { json: { configured: true, missing: [], autopost_allowed: false, limit: 280 } });
  be.set("/sns/generate", { json: { ok: true, platform: "x", limit: 280, posts: [
    { text: "新商品を出しました。", hashtags: ["#新商品"], length: 10, over_limit: false },
  ] } });
  await enterApp(page);
  await openMore(page, /SNS/, /SNS投稿サポート/);
  await page.locator("textarea").first().fill("新商品を出しました");
  await page.getByRole("button", { name: /作る|生成|文案/ }).first().click();
  await expect(page.getByRole("button", { name: /に投稿/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/自動実行からは投稿しません/)).toBeVisible();
});

/* ── 録音・文字起こし ───────────────────────────────────────────── */
test("録音は端末の中で処理すると、先に書いてある", async ({ page }) => {
  // 画面や音声を扱う機能なので、どこへ行くのかを触る前に言う。
  await mockBackend(page);
  await enterApp(page);
  await openMore(page, /録音/, /画面録画・録音/);
  await expect(page.getByText(/端末内で処理|サーバーには送/)).toBeVisible();
});

test("録る前は、文字起こしの欄そのものを出さない", async ({ page }) => {
  // 対象が無いのにボタンだけあると、押して初めて「何もありません」に
  // なる。出来ないことは、出さないほうが早い。
  const be = await mockBackend(page);
  be.set("/capture/status", { json: { ffmpeg: false, transcribe: false, voiceover: false, engines: {} } });
  await enterApp(page);
  await openMore(page, /録音/, /画面録画・録音/);
  await expect(page.getByText(/AI — 文字起こし/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /文字起こし/ })).toHaveCount(0);
});
