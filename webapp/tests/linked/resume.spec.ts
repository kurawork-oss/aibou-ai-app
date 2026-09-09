/**
 * 連携から戻ってきたときに、頼みごとが消えていないことの検証。
 *
 * 「Notionに議事録をメモして」→ 繋いでいない → 別のタブで許可 → 戻る。
 * ここで会話が振り出しに戻ると、利用者はさきほどの頼みごとをもう一度
 * 言うことになる。設定まわりでいちばん要らない手間だった。
 *
 * ただし**勝手に実行はしない**。送信のような取り返せない操作が、
 * 繋いだ瞬間に黙って走るのがいちばん怖い。押してもらう。
 */

import { test, expect } from "@playwright/test";
import { enterApp, mockBackend } from "./backend";

test("預かった用事が、戻ってきたときに出ている", async ({ page }) => {
  const be = await mockBackend(page);
  be.state.pending = {
    waiting: true, provider: "notion",
    instruction: "Notionに議事録をメモして", auto_resume: true,
  };
  await enterApp(page);

  await expect(page.getByText(/預かっていた用事/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Notionに議事録をメモして")).toBeVisible();
});

test("勝手には実行しない（押してもらう）", async ({ page }) => {
  const be = await mockBackend(page);
  be.state.pending = {
    waiting: true, provider: "notion",
    instruction: "Notionに議事録をメモして", auto_resume: true,
  };
  await enterApp(page);
  await expect(page.getByText(/預かっていた用事/)).toBeVisible({ timeout: 10_000 });

  // 出しただけの段階で、実行の口を叩いていないこと
  expect(be.count("/setup/resume")).toBe(0);
  expect(be.count("/agent/act")).toBe(0);
  expect(be.count("/chat")).toBe(0);
});

test("預かっていないときは、何も出さない", async ({ page }) => {
  // 何も無いのに「続きをやりますか」と出ると、身に覚えのない確認になる。
  await mockBackend(page);
  await enterApp(page);
  await page.waitForTimeout(1200);
  await expect(page.getByText(/預かっていた用事/)).toHaveCount(0);
});
