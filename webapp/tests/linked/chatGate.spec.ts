/**
 * ふだんの会話でも、確認の要る操作は確認してから動く。
 *
 * なぜ足したか
 * ------------
 * 確認の門（段階3は設定に関わらず必ず聞く）は、実行（司令塔）モードに
 * しか付いていなかった。既定の会話モードでも道具は動く——「上司にメールを
 * 送って」で、**メールが実際に1通飛んだ**（サーバーを直に叩いて確かめた）。
 *
 * サーバーは会話でも止めるようになった（api/test_gate.py）。ここで見るのは
 * 画面の側: 止まったことが見え、押すまで何も起きず、押したら実行モードと
 * 同じ口で動くこと。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, type Backend } from "./backend";

/** 会話の返事が「確認してから」で止まる。 */
function chatAsks(be: Backend, over: Record<string, unknown> = {}) {
  be.set("/chat", () => ({ sse: [
    { approval: {
      tool: "send_email",
      params: { to: "boss@example.com", subject: "報告", body: "終わりました" },
      note: "上司にメールを送ります", level: 3, level_label: "取り返せない",
      why: "送ったメールは取り消せません。", chained: false,
      may_always: false, always_confirm: true, ...over } },
    { done: true },
  ] }));
}

async function say(page: Page, text: string) {
  await page.locator("textarea").first().fill(text);
  await page.keyboard.press("Enter");
}

test("会話で頼んだメールは、確認カードで止まる", async ({ page }) => {
  const be = await mockBackend(page);
  chatAsks(be);
  await enterApp(page);
  await say(page, "上司にメールを送って");

  await expect(page.getByText("確認が必要な操作")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("送ったメールは取り消せません。")).toBeVisible();
  await expect(page.getByText("設定に関わらず必ず確認します")).toBeVisible();
  // 何を送るのかが見える（宛先を見ずに押させない）
  await expect(page.getByText(/boss@example\.com/)).toBeVisible();
  // 取り返せない操作に「いつも許可」は出さない
  await expect(page.getByRole("button", { name: "いつも許可" })).toHaveCount(0);
  // 押すまでは、何も実行していない
  expect(be.count("/agent/execute")).toBe(0);
});

test("押したら、見せた段階と一緒に実行を頼む", async ({ page }) => {
  /* 段階を一緒に送る。押されるまでの間に実行の場所が変わって重くなって
     いたら、サーバーが断る（api/test_gate.py）。 */
  const be = await mockBackend(page);
  chatAsks(be);
  be.set("/agent/execute", () => ({ json: { result: "送りました", show: [] } }));
  await enterApp(page);
  await say(page, "上司にメールを送って");
  await page.getByRole("button", { name: "実行する" }).click({ timeout: 15_000 });

  await expect.poll(() => be.count("/agent/execute"), { timeout: 10_000 }).toBe(1);
  const sent = be.calls.find((c) => c.path === "/agent/execute")?.body as
    { tool?: string; params?: { to?: string }; level?: number };
  expect(sent?.tool).toBe("send_email");
  expect(sent?.params?.to).toBe("boss@example.com");
  expect(sent?.level).toBe(3);
  await expect(page.getByText("送りました")).toBeVisible();
});

test("二度押しても、1回しか実行しない", async ({ page }) => {
  /* 取り返せない操作で2回走ると、メールが2通飛ぶ。 */
  const be = await mockBackend(page);
  chatAsks(be);
  be.set("/agent/execute", () => ({ json: { result: "送りました", show: [] } }));
  await enterApp(page);
  await say(page, "上司にメールを送って");
  const run = page.getByRole("button", { name: "実行する" });
  await run.waitFor({ timeout: 15_000 });
  be.latency = 400;               // 1回目の返事を待っている間に、もう一度押す
  // 同じ一瞬に2回押す（画面が描き直される前に、2回目が届く形）
  await run.evaluate((el) => { (el as HTMLElement).click(); (el as HTMLElement).click(); });
  await expect(page.getByText("送りました")).toBeVisible({ timeout: 10_000 });
  expect(be.count("/agent/execute")).toBe(1);
});

test("実行モードでも、押したら実行を頼む", async ({ page }) => {
  /* 承認の処理は会話と実行モードで同じ物。以前は、押しても依頼が飛ばない
     ことがあった（押された物を、画面の更新が済む前に探していた）。 */
  const be = await mockBackend(page);
  be.set("/agent/act", () => ({ sse: [
    { phase: "start" },
    { phase: "approval", step: 1, tool: "calendar_add",
      params: { title: "歯医者", date: "2026-10-01" }, note: "予定を入れます",
      level: 2, level_label: "外のサービスに残る", why: "", chained: false,
      always_confirm: false, may_always: true },
    { phase: "done", steps: 0, awaiting_approval: true },
  ] }));
  be.set("/agent/execute", () => ({ json: { result: "入れました", show: [] } }));
  await enterApp(page);
  await page.getByRole("button", { name: /実行（司令塔）/ }).click();
  await say(page, "1日に歯医者を入れて");
  await page.getByRole("button", { name: "実行する" }).click({ timeout: 15_000 });

  await expect.poll(() => be.count("/agent/execute"), { timeout: 10_000 }).toBe(1);
  const sent = be.calls.find((c) => c.path === "/agent/execute")?.body as
    { tool?: string; level?: number };
  expect(sent?.tool).toBe("calendar_add");
  expect(sent?.level).toBe(2);
  await expect(page.getByText("入れました")).toBeVisible();
});

test("やめたら、何も実行しない", async ({ page }) => {
  const be = await mockBackend(page);
  chatAsks(be);
  await enterApp(page);
  await say(page, "上司にメールを送って");
  await page.getByRole("button", { name: "やめる" }).click({ timeout: 15_000 });

  await expect(page.getByText("（実行しませんでした）")).toBeVisible();
  await expect(page.getByText("確認が必要な操作")).toHaveCount(0);
  expect(be.count("/agent/execute")).toBe(0);
});

test("会話も、確認の設定と「いつも許可」をサーバーへ渡す", async ({ page }) => {
  /* 渡さないと、会話だけ設定が効かない（サーバーは「聞く」側に倒すので
     安全ではあるが、切った人にも毎回聞くことになる）。 */
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [{ token: "はい。" }, { done: true }] }));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("forge_always_allow",
        JSON.stringify([{ tool: "calendar_add", label: "外のサービスに残る", at: 1 }]));
    } catch { /* 保存できない環境では、渡す物が無いだけ */ }
  });
  await enterApp(page);
  await say(page, "明日の予定を入れて");

  await expect.poll(() => be.count("/chat"), { timeout: 10_000 }).toBeGreaterThan(0);
  const body = be.calls.find((c) => c.path === "/chat")?.body as
    { approval?: boolean; allow?: string[] };
  expect(typeof body?.approval).toBe("boolean");
  expect(body?.allow).toContain("calendar_add");
});
