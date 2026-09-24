/**
 * 「押すだけ」の連携が、ログインを求める構成でも入口で断られないこと。
 *
 * 以前のボタンは <a href=".../connect/notion/start" target="_blank"> だった。
 * 新しいタブへのただの移動には、ログイン情報（ヘッダー）が載らない。
 * サーバーがログインを求める構成では、押した先がいきなり 401 になっていた
 * ——画面では押せるのに、押すと必ず断られる。
 *
 * いまは、押したら先に**1回きりの札**（ticket）をもらい、それを付けて開く。
 * 札は短い時間で切れ、1回使うと二度と通らない（api/test_connect_ticket.py）。
 */

import { test, expect, type Page } from "@playwright/test";
import { enterApp, mockBackend } from "./backend";

const NOTION = { key: "notion", label: "Notion", configured: true, connected: false, unlocks: [] };

async function openExtend(page: Page) {
  await page.getByLabel("Mobile navigation").getByText("管理", { exact: true }).click();
  await page.getByRole("button", { name: /もっと/ }).click();
  await page.getByRole("button", { name: /^連携/ }).click();
  await page.getByRole("button", { name: /Notion/ }).first().click();
}

test("連携するボタンは、札をもらってから同意の入口を開く", async ({ page, context }) => {
  const be = await mockBackend(page, {
    "/connect": { json: { providers: [NOTION], no_oauth: {} } },
    "/connect/notion/ticket": { json: { ok: true, ticket: "T-once" } },
  });
  // 新しいタブは page.route の外。入口だけ受けて、何を持って来たかを見る
  await context.route("**/127.0.0.1:8099/connect/notion/start**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>consent</p>" }));

  await enterApp(page);
  await openExtend(page);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Notionと連携する" }).click(),
  ]);
  await tab.waitForURL(/\/connect\/notion\/start\?ticket=T-once$/, { timeout: 10_000 });

  // 札は POST で1回だけもらう（開くたびに何枚も作らない）
  const asked = be.calls.filter((c) => c.path === "/connect/notion/ticket");
  expect(asked.map((c) => c.method)).toEqual(["POST"]);
  // 元の画面はそのまま（押した人が、戻る場所を失わない）
  await expect(page.getByRole("button", { name: "Notionと連携する" })).toBeVisible();
});

test("札がもらえなくても、入口は開く（ログインの要らない構成では、それで通る）", async ({ page, context }) => {
  await mockBackend(page, {
    "/connect": { json: { providers: [NOTION], no_oauth: {} } },
    "/connect/notion/ticket": { status: 503, json: { detail: "down" } },
  });
  await context.route("**/127.0.0.1:8099/connect/notion/start**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>consent</p>" }));

  await enterApp(page);
  await openExtend(page);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Notionと連携する" }).click(),
  ]);
  await tab.waitForURL(/\/connect\/notion\/start$/, { timeout: 10_000 });
});
