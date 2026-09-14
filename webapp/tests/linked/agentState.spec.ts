/**
 * 「止まっていること」が、画面から分かるか。
 *
 * なぜここを見るか
 * ----------------
 * いちばん困るのは**待たれていることに気づけない**形。
 *
 *   ・取り消せない操作の前で、承認を待って止まっている
 *   ・連携が足りなくて、繋がれるのを待って止まっている
 *
 * どちらも、こちらが答えるまで一歩も進まない。それなのにコアは待機の顔で
 * ゆっくり回っていた。画面から目を離していた人には、終わったように見える。
 * 「やっておいて」と頼んで、何もされていない——いちばん静かな失敗。
 *
 * ここは本物のSSEサーバーを立てて、**止まったまま**にする。
 * 差し替えバックエンドは本文をまとめて返すので、止まっている状態そのものが
 * 作れない。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, sseServer } from "./backend";

async function agentSay(page: Page, text: string) {
  // 実行（司令塔）モードへ。会話モードは /chat、実行は /agent/act を叩く。
  await page.getByRole("button", { name: /実行（司令塔）/ }).click();
  const ta = page.locator("textarea").first();
  await ta.fill(text);
  await page.keyboard.press("Enter");
}

test("承認を待っているあいだ、コアは待機の顔をしない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/agent/act", () => ({ passthrough: true }));
  const server = await sseServer([
    { after: 100, data: { phase: "start" } },
    { after: 100, data: { phase: "prepare", what: "記憶を読み込み", ms: 120 } },
    { after: 200, data: { phase: "thinking" } },
    { after: 300, data: {
      phase: "approval", tool: "send_email", params: { to: "a@example.com" },
      note: "メールを送ります", level: 3, level_label: "取り消せない",
      why: "送ったメールは取り消せません",
    } },
    // ここで止まる。done は送らない（実物も、押されるまで来ない）
  ]);
  try {
    await enterApp(page);
    await agentSay(page, "上司にメールを送っておいて");

    await expect(page.getByText(/WAITING/)).toBeVisible({ timeout: 10_000 });
    // 何を待っているかも出ている
    await expect(page.getByText(/メールを送ります|取り消せません/).first()).toBeVisible();
  } finally {
    await server.close();
  }
});

test("繋がないと進めないときも、待機の顔をしない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/agent/act", () => ({ passthrough: true }));
  const server = await sseServer([
    { after: 100, data: { phase: "start" } },
    { after: 100, data: { phase: "thinking" } },
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

    await expect(page.getByText(/SETUP/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Notionとの連携が必要/)).toBeVisible();
  } finally {
    await server.close();
  }
});

test("段取り中と、考え中を分けて出す", async ({ page }) => {
  /* 準備（記憶やルールの読み込み）は返事が始まる前に終わらせる必要があり、
     重くなるとそのまま待ち時間になる。どちらで待たされているのかが
     見えないと、どこを直せばいいのか分からない。 */
  const be = await mockBackend(page);
  be.set("/agent/act", () => ({ passthrough: true }));
  const server = await sseServer([
    { after: 100, data: { phase: "start" } },
    { after: 100, data: { phase: "prepare", what: "記憶を読み込み", ms: 900 } },
    { after: 1200, data: { phase: "thinking" } },
    { after: 600, data: { phase: "final", text: "できました。" } },
    { after: 50, data: { phase: "done", steps: 0 } },
  ]);
  try {
    await enterApp(page);
    await agentSay(page, "今日の予定は？");
    await expect(page.getByText(/PLANNING/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/THINKING/)).toBeVisible({ timeout: 10_000 });
  } finally {
    await server.close();
  }
});

test("終わったら、終わったと出してから待機へ戻る", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/agent/act", () => ({ passthrough: true }));
  const server = await sseServer([
    { after: 100, data: { phase: "start" } },
    { after: 100, data: { phase: "final", text: "できました。" } },
    { after: 50, data: { phase: "done", steps: 1 } },
  ]);
  try {
    await enterApp(page);
    await agentSay(page, "タスクに牛乳を追加して");
    await expect(page.getByText(/COMPLETED/)).toBeVisible({ timeout: 10_000 });
    // 出しっぱなしにしない（待機と区別が付かなくなる）
    await expect(page.getByText(/COMPLETED/)).toHaveCount(0, { timeout: 6_000 });
  } finally {
    await server.close();
  }
});
