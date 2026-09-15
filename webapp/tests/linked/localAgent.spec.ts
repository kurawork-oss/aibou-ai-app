/**
 * 手元のパソコンで動く相棒を繋ぐ画面（仕様§29〜§31）。
 *
 * ここで守りたいこと
 * ------------------
 * 合言葉は**1回しか見せられない**（サーバーには照合用の形しか無い）。
 * 「あとで見られます」と読める作りにしてはいけない。
 *
 * そして「合言葉を作った」と「いま動いている」は別のこと。作っただけで
 * 「繋がりました」と出すと、頼んだあとで無言のまま返事が来なくなり、
 * どこが悪いのか分からなくなる。
 */

import { test, expect } from "@playwright/test";
import { mockBackend, enterApp } from "./backend";

async function openConnect(page: import("@playwright/test").Page) {
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "つなぐ", exact: true }).click();
  await expect(page.getByText("手元のパソコン")).toBeVisible({ timeout: 10_000 });
}

test("繋いでいないときは、未接続だと言う", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/local/status", () => ({ json: { ok: true, paired: false, online: false,
    why: "まだ1台も繋いでいません", next: "合言葉を作ります" } }));
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("未接続", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "合言葉を作る" })).toBeVisible();
});

test("合言葉は1回しか見せないと、その場に書いてある", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/local/status", () => ({ json: { ok: true, paired: false, online: false } }));
  be.set("/local/pair", () => ({ json: { ok: true, token: "test-token-abcdef123456" } }));
  await enterApp(page);
  await openConnect(page);
  await page.getByRole("button", { name: "合言葉を作る" }).click();

  await expect(page.getByText("test-token-abcdef123456")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("二度と見られません")).toBeVisible();
  // 動かし方も、その場に出す（別のページを探させない）
  await expect(page.getByText(/aibou_local\.py/)).toBeVisible();
});

test("合言葉を作っただけでは「繋がっています」と言わない", async ({ page }) => {
  /* 作っただけで繋がった顔をすると、頼んだあとで無言になる。 */
  const be = await mockBackend(page);
  be.set("/local/status", () => ({ json: { ok: true, paired: true, online: false,
    why: "合言葉は作ってありますが、手元の相棒が動いていません",
    next: "パソコンで `python aibou_local.py` を動かしてください" } }));
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("動いていません").first()).toBeVisible();
  await expect(page.getByText("繋がっています")).toHaveCount(0);
  await expect(page.getByText(/aibou_local\.py.* を動かして/)).toBeVisible();
});

test("動いていれば、繋がっていると言う", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/local/status", () => ({ json: { ok: true, paired: true, online: true,
    name: "しごと用", waiting: 0, last_seen_ago: 2 } }));
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("繋がっています")).toBeVisible();
  await expect(page.getByRole("button", { name: "繋ぎを切る" })).toBeVisible();
});

test("触ってよい場所を決めるのは手元だと、書いてある", async ({ page }) => {
  /* ここを読み違えると、「サーバーから何でも読まれる」と思われる。
     逆に「サーバーが決められる」と思われるのも困る。 */
  const be = await mockBackend(page);
  be.set("/local/status", () => ({ json: { ok: true, paired: false, online: false } }));
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText(/サーバーからは指定できません/)).toBeVisible();
  await expect(page.getByText(/消す操作とコマンド実行は/)).toBeVisible();
});

test("状態が取れなくても、「繋がっている」とは言わない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/local/status", () => ({ status: 503, json: { error: "down" } }));
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("状態を取得できませんでした").first())
    .toBeVisible({ timeout: 10_000 });
});
