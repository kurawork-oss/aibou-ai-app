/**
 * スマホで、繋がっているときにだけ出る所（ui-r122）。
 *
 * ── 上の状態の行 ──
 * 繋がっていると「LINK ACTIVE · ONLINE」だったが、右のボタンに押されて
 * 「LINK ACTIVE…」で切れ、いま何をしているか（ONLINE・THINKING…）が
 * 見えなかった。繋がっているかは点の色で分かるので、状態だけを出す。
 *
 * ── タスク画面で、一覧が1画面目に入るか ──
 *
 * 以前の iPhone SE（375×667）では、上の飾り（245px）・数字の箱2段（130px）・
 * 追加の欄（265px）だけで画面が埋まり、タスクが1件も見えなかった。
 * 「タスクを見る画面なのに、タスクを見るにはスクロールが要る」。
 *
 * オフラインのビルドでは一覧が出ない（読み込めない旨が出る）ので、
 * こちらで中身を入れて確かめる。
 */

import { test, expect } from "@playwright/test";
import { mockBackend, enterApp, openManage } from "./backend";

const TASKS = [
  { id: "t1", title: "見積書を送る", content: "A社の件", status: "pending", priority: "high", due: "2026-10-03", project: "仕事" },
  { id: "t2", title: "ブログの下書きを仕上げる", content: "", status: "in_progress", priority: "mid", due: "2026-10-08", project: "発信" },
  { id: "t3", title: "支払いの承認", content: "", status: "awaiting_approval", priority: "mid", project: "" },
  { id: "t4", title: "歯医者を予約する", content: "", status: "pending", priority: "low", project: "" },
];

test("iPhone SE で、最初の2件が下のナビより上に見えている", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mockBackend(page, { "/tasks": { json: { items: TASKS } } });
  await enterApp(page);
  await openManage(page, "タスク");
  await expect(page.getByText("見積書を送る")).toBeVisible({ timeout: 10_000 });

  const navTop = await page.getByLabel("Mobile navigation")
    .evaluate((el) => el.getBoundingClientRect().top);
  for (const title of ["見積書を送る", "ブログの下書きを仕上げる"]) {
    const box = (await page.getByText(title, { exact: true }).boundingBox())!;
    expect(box.y + box.height, `${title} がナビの裏か画面の外にある`).toBeLessThanOrEqual(navTop);
  }
});

test("完了の丸は、押せる広さ 44px・見える丸は小さいまま。押すと完了になる", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const be = await mockBackend(page, { "/tasks": { json: { items: TASKS } } });
  await enterApp(page);
  await openManage(page, "タスク");
  const done = page.getByRole("button", { name: "完了にする" }).first();
  await expect(done).toBeVisible({ timeout: 10_000 });
  const tap = (await done.boundingBox())!;
  expect(tap.width).toBeGreaterThanOrEqual(44);
  expect(tap.height).toBeGreaterThanOrEqual(44);
  const ring = (await done.locator("span").first().boundingBox())!;
  expect(ring.width).toBeLessThan(30);

  be.reset();
  await done.click();
  await expect(page.getByText("タスクを完了にしました")).toBeVisible();
  const put = be.calls.find((c) => c.path === "/tasks/t1" && c.method !== "GET");
  expect(put?.body).toMatchObject({ status: "completed" });
});

test("繋がっているときの状態の行は、いま何をしているかが切れずに見える（SE）", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mockBackend(page);
  await enterApp(page);
  const status = page.getByText(/^(ONLINE|SETUP|THINKING|WAITING)$/);
  await expect(status).toBeVisible({ timeout: 10_000 });
  expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(page.getByText(/^LINK ACTIVE/)).toHaveCount(0);
});
