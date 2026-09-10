/**
 * ゴール（AUTO）と副業（INCOME）を、繋がっている状態で見る。
 *
 * この2つは「勝手に進む」種類の機能なので、見たいのは進むことではなく
 *
 *   ・人が承認するまで、外へ出て行かないこと
 *   ・進んでいないのに、進んだように見せないこと
 *   ・持ち主でない人に、持ち主の物を見せないこと
 *
 * の3つ。自動で動く物ほど、止まっている理由が分かることが要る。
 */

import { test, expect, type Page } from "@playwright/test";
import { enterApp, mockBackend, type Backend } from "./backend";

/**
 * 管理タブの「もっと」から画面を開く。
 *
 * 「もっと」の各行き先は、名前と説明が1つのボタンに入っている
 * （例：「ゴール分解して進める」）。同じ言葉はHOMEの計器にも出るので
 * （例：「0副業」）、説明まで含めた名前で押して取り違えを避ける。
 */
async function openMore(page: Page, tile: RegExp, mark: () => Promise<void>) {
  await page.getByLabel("Mobile navigation").getByText("管理", { exact: true }).click();
  await page.getByRole("button", { name: /もっと/ }).click();
  await page.getByRole("button", { name: tile }).click();
  await mark();
}

/** その画面が開いたことの目印。 */
const seeText = (page: Page, re: RegExp) => async () => {
  await expect(page.getByText(re).first()).toBeVisible({ timeout: 10_000 });
};
const seePlaceholder = (page: Page, re: RegExp) => async () => {
  await expect(page.getByPlaceholder(re)).toBeVisible({ timeout: 10_000 });
};

/* ── ゴール（分解して進める） ────────────────────────────────────── */
const MISSION = {
  id: "m1", goal: "提案資料を仕上げる", status: "active", current: 1,
  steps: [
    { n: 1, title: "資料の骨子を作る", status: "done", result: "3章構成にした" },
    { n: 2, title: "図をつくる", status: "pending" },
    { n: 3, title: "見直す", status: "pending" },
  ],
};

test("ゴールは、どこまで進んだかが見える", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/autopilot/missions", { json: { items: [MISSION] } });
  await enterApp(page);
  await openMore(page, /^ゴール\s*分解して進める$/, seePlaceholder(page, /新商品ローンチ/));

  await expect(page.getByText("提案資料を仕上げる")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("資料の骨子を作る")).toBeVisible();
  await expect(page.getByText("図をつくる")).toBeVisible();
});

test("済んだ手順の結果が読める（やった顔だけしない）", async ({ page }) => {
  // 「done」と出るだけだと、何をしたのか確かめられない。
  const be = await mockBackend(page);
  be.set("/autopilot/missions", { json: { items: [MISSION] } });
  await enterApp(page);
  await openMore(page, /^ゴール\s*分解して進める$/, seePlaceholder(page, /新商品ローンチ/));
  await expect(page.getByText("3章構成にした")).toBeVisible({ timeout: 10_000 });
});

test("1手が失敗したら、失敗として出す", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/autopilot/missions", { json: { items: [{
    ...MISSION, status: "failed",
    steps: [{ n: 1, title: "資料の骨子を作る", status: "failed", result: "AIの利用券がありません" }],
  }] } });
  await enterApp(page);
  await openMore(page, /^ゴール\s*分解して進める$/, seePlaceholder(page, /新商品ローンチ/));
  await expect(page.getByText("AIの利用券がありません")).toBeVisible({ timeout: 10_000 });
});

test("作れなかったときに、作った顔をしない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/autopilot/missions", (call) =>
    call.method === "POST"
      ? { status: 409, json: { detail: "保存先がつながっていないため、保存できませんでした。" } }
      : { json: { items: [] } });
  await enterApp(page);
  await openMore(page, /^ゴール\s*分解して進める$/, seePlaceholder(page, /新商品ローンチ/));

  await page.getByPlaceholder(/新商品ローンチ/).fill("提案資料を仕上げる");
  await page.getByRole("button", { name: /SET GOAL/ }).click();
  await expect(page.getByText(/保存先がつながっていない/)).toBeVisible({ timeout: 10_000 });
});

/* ── 副業（承認してから外に出す） ───────────────────────────────── */
function withIncome(be: Backend) {
  be.set("/income/summary", { json: { pending: 1, approved: 0, done: 0, failed: 0 } });
  be.set("/income/jobs", { json: { items: [
    { id: "j1", theme: "雪のロッジの環境音", status: "pending", created_at: "2026-09-01T00:00:00Z" },
  ] } });
}

test("副業は、承認待ちのまま止まっていることが分かる", async ({ page }) => {
  const be = await mockBackend(page);
  withIncome(be);
  await enterApp(page);
  await openMore(page, /^副業\s*収益の自動化$/, seeText(page, /承認キュー/));
  await expect(page.getByText("雪のロッジの環境音")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("承認待ち").first()).toBeVisible();
});

test("承認が通らなかったら、通ったように見せない", async ({ page }) => {
  // お金が絡む所で「承認しました」と嘘を言うのが、いちばん困る。
  const be = await mockBackend(page);
  withIncome(be);
  be.set("/income/approve", { status: 409, json: { detail: "保存先がつながっていません" } });
  await enterApp(page);
  await openMore(page, /^副業\s*収益の自動化$/, seeText(page, /承認キュー/));
  await page.getByRole("button", { name: "✓ 承認" }).first().click();
  await expect(page.getByText(/失敗|できません|つながっていません/).first())
    .toBeVisible({ timeout: 10_000 });
});

test("持ち主でない人には、副業を案内しない", async ({ page }) => {
  // 押せる物を出しておいて 403 を返すより、出さないほうが分かりやすい。
  const be = await mockBackend(page);
  be.set("/account/profile", { json: { is_owner: false, owner_only_modes: ["income"] } });
  await enterApp(page);
  await page.getByLabel("Mobile navigation").getByText("管理", { exact: true }).click();
  // HOMEの計器（「0副業」）に出ていないこと——押した先で断られるより良い
  await expect(page.getByRole("button", { name: /副業/ })).toHaveCount(0);
  // ナビの一覧にも出ていないこと
  await page.getByRole("button", { name: /もっと/ }).click();
  await expect(page.getByRole("button", { name: /^説明書\s*使い方$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /副業/ })).toHaveCount(0);
});
