/**
 * 変わったことが、開いている画面にすぐ出るか（仕様§38・lib/live.ts）。
 *
 * サーバーは人ごとに1本の流れ（/events）で「何が変わったか」だけを流す。
 * 画面はそれを聞いて、いつもの読み込みで取り直す。
 *
 *   会話で「タスクに入れて」 → 開いているタスク画面に出る
 *   会話で「付箋を貼って」   → 開いているボードに出る
 *
 * 気をつけること:
 *   ・自分のタブが書いた変化では読み直さない（書いた画面は新しい物を持っている。
 *     ボードは読み直すと書いている途中の手元が巻き戻る）
 *   ・流れを返さないサーバー（古い版）には、開き直し続けない
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, openManage } from "./backend";

const TASK = { id: "t1", title: "会話で足したタスク", status: "pending", priority: "mid" };

/** このタブの名前（どの問い合わせにも X-AIbou-Tab で付いている）。 */
function watchTab(page: Page): () => string {
  let tab = "";
  page.on("request", (r) => { tab = tab || r.headers()["x-aibou-tab"] || ""; });
  return () => tab;
}

test("会話で足したタスクが、開いているタスク画面に出る", async ({ page }) => {
  let n = 0;
  await mockBackend(page, {
    "/tasks": () => ({ json: { items: n++ === 0 ? [] : [TASK] } }),
    "/events": { sse: [{ kind: "hello" }, { kind: "tasks" }] },
  });
  await enterApp(page);
  await openManage(page, "タスク");
  await expect(page.getByText("会話で足したタスク")).toBeVisible({ timeout: 10_000 });
});

test("自分のタブが書いた変化では、読み直さない", async ({ page }) => {
  const tab = watchTab(page);
  const be = await mockBackend(page, {
    "/events": () => ({ sse: [{ kind: "hello" }, { kind: "tasks", from: tab() }] }),
  });
  await enterApp(page);
  expect(tab()).not.toBe("");
  await openManage(page, "タスク");
  await expect.poll(() => be.count("/events"), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(be.count("/tasks"), "自分の書いた変化で読み直している").toBe(1);
});

test("会話で貼った付箋が、開いているボードに出る", async ({ page }) => {
  let n = 0;
  const NOTE = { id: "n1", x: 40, y: 40, text: "会話で貼った付箋", color: "yellow" };
  await mockBackend(page, {
    "/boards": { json: { items: [{ id: "b1", name: "企画", count: 0 }] } },
    "/boards/b1": () => ({ json: { id: "b1", name: "企画", edges: [],
                                   nodes: n++ === 0 ? [] : [NOTE] } }),
    "/events": { sse: [{ kind: "hello" }, { kind: "board" }] },
  });
  await enterApp(page);
  await openManage(page, "ボード");
  await expect(page.getByText("会話で貼った付箋")).toBeVisible({ timeout: 10_000 });
});

test("流れを返さないサーバーには、開き直し続けない", async ({ page }) => {
  const be = await mockBackend(page);           // /events は JSON（古い版と同じ）
  await enterApp(page);
  await openManage(page, "タスク");
  await expect.poll(() => be.count("/events"), { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(3000);
  expect(be.count("/events")).toBe(1);
});
