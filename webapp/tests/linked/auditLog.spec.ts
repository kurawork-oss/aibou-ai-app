/**
 * 操作の記録（AIbou があなたの代わりに外でしたこと）。
 *
 * 身に覚えのない送信があったときに見る所。ここで守りたいのは、
 * **確認して押した物と、確認なしで動いた物が見分けられる**こと。
 * 同じ見た目で並ぶと、どれが勝手に動いたのかを拾えない。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp } from "./backend";

async function openCheck(page: Page) {
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "しらべる", exact: true }).click();
  await expect(page.getByRole("region", { name: "操作の記録" })).toBeVisible({ timeout: 10_000 });
}

const NOW = Date.now() / 1000;

test("確認して押した物と、確認なしで動いた物を分けて出す", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/audit", () => ({ json: { items: [
    { id: "a1", at: NOW, source: "approve", source_label: "承認ボタン", tool: "send_email",
      target: "boss@example.com", where: "", level: 3, approved: true, ok: true,
      summary: "送信しました", instruction: "" },
    { id: "a2", at: NOW - 60, source: "schedule", source_label: "定期実行", tool: "calendar_add",
      target: "朝会", where: "", level: 2, approved: false, ok: true,
      summary: "追加しました", instruction: "毎朝の朝会を入れて" },
    { id: "a3", at: NOW - 120, source: "approve", source_label: "承認ボタン", tool: "recipe_run",
      target: "朝のケース確認", where: "ノート / 専用ブラウザ（Playwright）", level: 3,
      approved: true, ok: false, summary: "手順「朝のケース確認」は流しきれませんでした",
      instruction: "" },
  ] } }));
  await enterApp(page);
  await openCheck(page);

  const log = page.getByRole("region", { name: "操作の記録" });
  await expect(log.getByText("メールを送信")).toBeVisible();
  await expect(log.getByText("boss@example.com")).toBeVisible();
  await expect(log.getByText("確認して実行", { exact: true })).toHaveCount(2);
  await expect(log.getByText("確認なし", { exact: true })).toHaveCount(1);
  await expect(log.getByText("定期実行")).toBeVisible();
  await expect(log.getByText(/毎朝の朝会を入れて/)).toBeVisible();
  // どの台・どのブラウザで動いたか
  await expect(log.getByText("ノート / 専用ブラウザ（Playwright）")).toBeVisible();
  // できなかった物は、できなかったと出す
  await expect(log.getByLabel("できなかった")).toHaveCount(1);
  await expect(log.getByText(/流しきれませんでした/)).toBeVisible();
});

test("まだ何もしていなければ、そう言う", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/audit", () => ({ json: { items: [] } }));
  await enterApp(page);
  await openCheck(page);
  await expect(page.getByRole("region", { name: "操作の記録" }).getByText("まだありません。"))
    .toBeVisible();
});

test("取れなかったときに「何もしていない」と言わない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/audit", () => ({ status: 503, json: { detail: "down" } }));
  await enterApp(page);
  await openCheck(page);
  const log = page.getByRole("region", { name: "操作の記録" });
  await expect(log.getByText("記録を取得できませんでした")).toBeVisible();
  await expect(log.getByText("まだありません。")).toHaveCount(0);
});
