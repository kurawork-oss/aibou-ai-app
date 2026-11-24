/**
 * ペットが、作業の様子をそのまま映すか（バックエンドあり）。
 *
 * いちばん大事なのは「確認待ち」。承認を待って止まっているのに、ペットが
 * のんびりしていたら、画面から目を離していた人は終わったと思う
 * （agentState.spec.ts のコアと同じ話）。
 *
 * 止まったままの状態は、差し替えバックエンドでは作れない（本文をまとめて
 * 返す）ので、本物のSSEサーバーを立てて間を空けて流す。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, sseServer } from "./backend";

const pet = (page: Page) => page.locator("[data-pet]").first();

async function agentSay(page: Page, text: string) {
  await page.getByRole("button", { name: /実行（司令塔）/ }).click();
  const ta = page.locator("textarea").first();
  await ta.fill(text);
  await page.keyboard.press("Enter");
}

test("承認を待っているあいだは「確認してね」と知らせる", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/agent/act", () => ({ passthrough: true }));
  const server = await sseServer([
    { after: 100, data: { phase: "start" } },
    { after: 100, data: { phase: "thinking" } },
    { after: 300, data: {
      phase: "approval", tool: "send_email", params: { to: "a@example.com" },
      note: "メールを送ります", level: 3, level_label: "取り消せない",
      why: "送ったメールは取り消せません",
    } },
    // ここで止まる（押されるまで done は来ない）
  ]);
  try {
    await enterApp(page);
    await agentSay(page, "上司にメールを送っておいて");
    await expect(pet(page)).toHaveAttribute("data-pet-mood", "needs_input", { timeout: 10_000 });
    await expect(page.locator("[data-pet-says]")).toHaveText("確認してね");

    await page.getByRole("button", { name: /^ペットの/ }).click();
    const box = page.getByRole("dialog", { name: /のようす$/ });
    await expect(box.locator('[data-activity="chat"]')).toContainText("確認を待っています");
  } finally {
    await server.close();
  }
});

test("連携が足りなくて止まっているときも、確認待ちにする", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/agent/act", () => ({ passthrough: true }));
  const server = await sseServer([
    { after: 100, data: { phase: "start" } },
    { after: 300, data: {
      phase: "setup_required", provider: "notion", label: "Notion",
      connect_path: "/connect/notion", can_connect: true,
    } },
    { after: 50, data: { phase: "final", text: "Notionと繋ぐと、続きから進められます。" } },
    { after: 50, data: { phase: "done", steps: 1, awaiting_setup: true } },
  ]);
  try {
    await enterApp(page);
    await agentSay(page, "Notionから議事録を探して");
    await expect(pet(page)).toHaveAttribute("data-pet-mood", "needs_input", { timeout: 10_000 });
    await expect(page.locator("[data-pet-says]")).toHaveText("つなぐのが必要");
  } finally {
    await server.close();
  }
});

test("作業中は弾み、終わると「できたよ」を少し出して待機へ戻る", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/agent/act", () => ({ passthrough: true }));
  const server = await sseServer([
    { after: 100, data: { phase: "start" } },
    { after: 100, data: { phase: "thinking" } },
    { after: 200, data: { phase: "tool", tool: "web_search", note: "調べています" } },
    { after: 1500, data: { phase: "observation", result: "見つかりました" } },
    { after: 100, data: { phase: "final", text: "調べました。" } },
    { after: 50, data: { phase: "done", steps: 1 } },
  ]);
  try {
    await enterApp(page);
    await agentSay(page, "明日の天気を調べて");
    await expect(pet(page)).toHaveAttribute("data-pet-mood", "running", { timeout: 10_000 });
    await expect(page.locator("[data-pet-says]")).toHaveText(/作業中|考え中/);
    await expect(pet(page)).toHaveAttribute("data-pet-mood", "ready", { timeout: 10_000 });
    await expect(page.locator("[data-pet-says]")).toHaveText("できたよ");
    // 出しっぱなしにしない（待機と区別が付かなくなる）
    await expect(pet(page)).toHaveAttribute("data-pet-mood", "idle", { timeout: 5_000 });
    await expect(page.locator("[data-pet-says]")).toHaveCount(0);
  } finally {
    await server.close();
  }
});

test("サーバーの承認待ちとゴールも「動いていること」に出て、そこから開ける", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/approvals", { json: { items: [{ id: "a1", tool: "send_email", params: {} }] } });
  be.set("/autopilot/missions", { json: { items: [
    { id: "m1", goal: "提案資料を仕上げる", status: "active", current: 1,
      steps: [{ n: 1, title: "骨子", status: "done" }, { n: 2, title: "図", status: "pending" }] },
    { id: "m2", goal: "終わったゴール", status: "completed", current: 2, steps: [] },
  ] } });
  await enterApp(page);
  await page.getByRole("button", { name: /^ペットの/ }).click();
  const box = page.getByRole("dialog", { name: /のようす$/ });
  await expect(box.locator('[data-activity="approvals"]')).toContainText("承認待ち: 1件");
  const goal = box.locator('[data-activity="mission-m1"]');
  await expect(goal).toContainText("提案資料を仕上げる");
  await expect(goal).toContainText("1/2");
  // 終わったゴールは「動いていること」ではない
  await expect(box.locator('[data-activity="mission-m2"]')).toHaveCount(0);

  await goal.getByRole("button", { name: "見る" }).click();
  await expect(page.locator('[data-panel="autopilot"]')).toBeVisible();
});

test("サーバーが何も返さなくても、一覧は壊れない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/approvals", { status: 500, json: { error: "boom" } });
  be.set("/autopilot/missions", { status: 500, json: { error: "boom" } });
  await enterApp(page);
  await page.getByRole("button", { name: /^ペットの/ }).click();
  const box = page.getByRole("dialog", { name: /のようす$/ });
  await expect(box).toContainText("ほかに動いているものはありません", { timeout: 5_000 });
});
