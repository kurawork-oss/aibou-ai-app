/**
 * 「この操作はいつも許可」（webapp/src/lib/alwaysAllow.ts）。
 *
 * なぜ足したか
 * ------------
 * 同じ確認が何度も出ると、**読まずに押す癖**がつく。そうなると本当に
 * 読んでほしい確認（メールを送る・お金が動く）も一緒に素通りする。
 * 減らしてよい所を減らすことが、残った確認を読ませることになる。
 *
 * ここで見るのは、その逆側
 * ------------------------
 * 出してはいけない所に「いつも許可」が出ていないか。出た時点で、押した
 * 覚えのないメールが飛ぶ道ができる。サーバー側でも縛ってあるが
 * （api/test_always_allow.py）、**そもそもボタンを出さない**ことも要る
 * ——押せるボタンがあれば人は押すので。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, type Backend } from "./backend";

/** 承認待ちを1件返す /agent/act。 */
function withApproval(be: Backend, over: Record<string, unknown> = {}) {
  be.set("/agent/act", () => ({ sse: [
    { phase: "start" },
    { phase: "approval", step: 1, tool: "calendar_add",
      params: { title: "歯医者", when: "2026-09-20 10:00" },
      note: "予定を入れます", level: 2, level_label: "外のサービスに残る",
      why: "", chained: false, always_confirm: false, may_always: true, ...over },
    { phase: "done", steps: 0, awaiting_approval: true },
  ] }));
}

/** 司令塔モードに入れて、1回頼む。 */
async function ask(page: Page, text: string) {
  await page.getByRole("button", { name: /司令塔|実行/ }).first().click().catch(() => {});
  await page.locator("textarea").first().fill(text);
  await page.keyboard.press("Enter");
}

test("外に残る操作には「いつも許可」が出る", async ({ page }) => {
  const be = await mockBackend(page);
  withApproval(be);
  await enterApp(page);
  await ask(page, "20日の10時に歯医者を入れて");
  await expect(page.getByRole("button", { name: "いつも許可" }))
    .toBeVisible({ timeout: 15_000 });
});

test("取り返せない操作には「いつも許可」を出さない", async ({ page }) => {
  /* ここが出た時点で、押した覚えのないメールが飛ぶ道ができる。 */
  const be = await mockBackend(page);
  withApproval(be, { tool: "send_email", level: 3, level_label: "取り返せない",
    why: "送ったメールは取り消せません。", always_confirm: true, may_always: false });
  await enterApp(page);
  await ask(page, "田中さんにメールして");
  await expect(page.getByRole("button", { name: "実行する" }))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "いつも許可" })).toHaveCount(0);
  await expect(page.getByText("設定に関わらず必ず確認します")).toBeVisible();
});

test("外のページを読んだ後の確認にも出さない", async ({ page }) => {
  /* 聞いている理由が「危なさ」ではなく「誰が決めたか」。道具ごとに
     一度許してよい性質の物ではない。 */
  const be = await mockBackend(page);
  withApproval(be, { tool: "web_read", level: 0, level_label: "読むだけ",
    chained: true, may_always: false,
    params: { url: "https://example.com/?data=..." } });
  await enterApp(page);
  await ask(page, "そのページも読んで");
  await expect(page.getByText("ページ由来の可能性")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "いつも許可" })).toHaveCount(0);
});

test("押すと、次からはサーバーへ「許可済み」として届く", async ({ page }) => {
  const be = await mockBackend(page);
  withApproval(be);
  be.set("/agent/execute", () => ({ json: { ok: true, result: "入れました", show: [] } }));
  await enterApp(page);
  await ask(page, "20日の10時に歯医者を入れて");
  await page.getByRole("button", { name: "いつも許可" }).click({ timeout: 15_000 });

  // 2回目。送っている中身を見る
  be.reset();
  await ask(page, "21日の10時にも入れて");
  await expect.poll(() => be.count("/agent/act"), { timeout: 15_000 }).toBeGreaterThan(0);
  const sent = be.calls.find((c) => c.path === "/agent/act")?.body as { allow?: string[] };
  expect(sent?.allow).toContain("calendar_add");
});

test("許した物は設定に出て、毎回確認に戻せる", async ({ page }) => {
  /* 許す口だけ作って戻す口を作らないと、一度押したら二度と戻せない。 */
  const be = await mockBackend(page);
  withApproval(be);
  be.set("/agent/execute", () => ({ json: { ok: true, result: "入れました", show: [] } }));
  await enterApp(page);
  await ask(page, "20日の10時に歯医者を入れて");
  await page.getByRole("button", { name: "いつも許可" }).click({ timeout: 15_000 });

  await page.getByLabel("Settings").click();
  await expect(page.getByText("いつも許可にした操作")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("calendar_add")).toBeVisible();
  await page.getByRole("button", { name: "calendar_add を毎回確認に戻す" }).click();
  await expect(page.getByText("いつも許可にした操作")).toHaveCount(0);
});

test("一度も押していない人には、その区画を出さない", async ({ page }) => {
  await mockBackend(page);
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("いつも許可にした操作")).toHaveCount(0);
});
