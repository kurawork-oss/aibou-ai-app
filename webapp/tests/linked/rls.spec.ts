/**
 * 守り（RLS）が入っていないことを、隠さない（仕様§14）。
 *
 * なぜ要るか
 * ----------
 * ログインに Supabase Auth を使う構成では、**anon キーがブラウザのJSに
 * 入る**。そういう鍵なので正しいが、Supabase はその鍵で表を直接叩ける。
 * 止めるのは RLS だけ。
 *
 * ここで見るのは2つ。
 *
 *   ① 守りが入っていない表があるとき、そう言うか
 *   ② 表が揃ったあとも、**流し直せるか**
 *
 * ②が肝心。揃ったら流すボタンを隠していたので、**あとから足した安全設定が、
 * 先に設定を済ませた人には一生届かない**状態だった。直した本人以外には
 * 何も起きない直しになる。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, type Backend } from "./backend";

const TABLES = ["tasks", "events", "api_keys", "conversations"];

function withDb(be: Backend, over: Record<string, unknown> = {}) {
  be.set("/admin/db/status", () => ({ json: {
    connected: true, db_url_set: true,
    present: TABLES, missing: [], ...over,
  } }));
}

async function openConnect(page: Page) {
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "つなぐ", exact: true }).click();
  await expect(page.getByText(/DB 永続化/)).toBeVisible({ timeout: 10_000 });
}

test("守りの無い表があれば、そう言う", async ({ page }) => {
  const be = await mockBackend(page);
  withDb(be, { unguarded: ["api_keys", "conversations"] });
  await enterApp(page);
  await openConnect(page);

  await expect(page.getByText(/守り（RLS）が入っていません/)).toBeVisible();
  await expect(page.getByText(/2件/)).toBeVisible();
  // 何が困るのかまで書く（「RLSが無い」だけでは伝わらない）
  await expect(page.getByText(/URLを知っている人が/)).toBeVisible();
});

test("全部守られていれば、無用に脅さない", async ({ page }) => {
  const be = await mockBackend(page);
  withDb(be, { unguarded: [] });
  await enterApp(page);
  await openConnect(page);

  await expect(page.getByText(/必要なテーブルが揃っています/)).toBeVisible();
  await expect(page.getByText(/守り（RLS）が入っていません/)).toHaveCount(0);
});

test("数えられないときは、どちらとも言わない", async ({ page }) => {
  /* 接続文字列が無いと守りの状態は数えられない。分からないことを
     「安全」とも「危ない」とも言わない。 */
  const be = await mockBackend(page);
  withDb(be, {});          // unguarded を返さない
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText(/守り（RLS）が入っていません/)).toHaveCount(0);
});

test("揃ったあとでも、流し直せる", async ({ page }) => {
  const be = await mockBackend(page);
  withDb(be, { unguarded: [] });
  let ran = 0;
  be.set("/admin/migrate", () => { ran++; return { json: { ok: true } }; });
  await enterApp(page);
  await openConnect(page);

  const again = page.getByRole("button", { name: /もう一度流す/ });
  await expect(again).toBeVisible();
  await again.click();
  await expect(page.getByText(/流しました/)).toBeVisible({ timeout: 10_000 });
  expect(ran, "流していない").toBe(1);
});
