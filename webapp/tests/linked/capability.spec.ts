/**
 * 「いま何ができて、何ができないか」を、押す前に知れるか。
 *
 * なぜ要るか
 * ----------
 * できることは30以上あり、どれが**いま本当に使えるか**は鍵・連携・保存先・
 * 機能のパックが絡み合って決まる。その答えはこれまで1か所に無く、利用者は
 * **押して失敗してから**理由を知っていた。
 *
 * ここで見るのは見た目ではなく、**間違った案内をしていないか**。
 * とくに「押しても始まらないボタン」を出していないか。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, type Backend } from "./backend";

const ITEMS = [
  { id: "ai", name: "AI（頭脳）", status: "connected", connected: true,
    kind: "key", pack: "core", tools: [] },
  { id: "memory", name: "記憶", status: "available", connected: true,
    kind: "local", pack: "core", tools: [] },
  { id: "notion", name: "Notion", status: "not_connected", connected: false,
    kind: "oauth", pack: "core", tools: ["notion_add"],
    why: "Notionと繋いでいません",
    next: "設定 → つなぐ →「Notion」を押すと繋がります",
    action: { kind: "oauth", provider: "notion", path: "/connect/notion" } },
  { id: "slack", name: "Slack", status: "configuration_required", connected: false,
    kind: "oauth", pack: "core", tools: [], needs_owner: true,
    why: "Slackのアプリ登録が、まだ済んでいません",
    next: "このアプリの持ち主がSlackの登録を済ませると、押すだけで繋がります",
    action: { kind: "none" } },
  { id: "github", name: "GitHub", status: "unavailable", connected: false,
    kind: "oauth", pack: "dev", tools: [],
    why: "この機能のかたまりを、使わない設定にしてあります",
    next: "設定 → つなぐ →「使う機能」で入れ直せます",
    action: { kind: "pack", name: "dev" } },
];

function withStatus(be: Backend, items: unknown[] = ITEMS) {
  be.set("/capabilities/status", () => ({ json: {
    ok: true, items,
    usable: (items as { id: string; status: string }[])
      .filter((c) => c.status === "connected" || c.status === "available")
      .map((c) => c.id),
  } }));
}

/* 自己診断は「つなぐ」から「しらべる」へ移した。
   「何が使えるか」と「うまく動かないとき」は同じ問いの表と裏なのに、
   別のタブに分かれていて、片方を見た人がもう片方に気づかなかった。 */
async function openConnect(page: Page) {
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "しらべる", exact: true }).click();
  await expect(page.getByText("SELF CHECK")).toBeVisible({ timeout: 10_000 });
}

test("使えないものが、理由と次の一手つきで出る", async ({ page }) => {
  const be = await mockBackend(page);
  withStatus(be);
  await enterApp(page);
  await openConnect(page);

  await expect(page.getByText("Notionと繋いでいません")).toBeVisible();
  await expect(page.getByText(/「Notion」を押すと繋がります/)).toBeVisible();
});

test("押しても始まらないものには、ボタンを出さない", async ({ page }) => {
  /* Slackは「持ち主のアプリ登録がまだ」。ここでボタンを出すと、押しても
     何も起きないボタンを何度も押させることになる。代わりに、誰が何を
     すればいいのかを書く。 */
  const be = await mockBackend(page);
  withStatus(be);
  await enterApp(page);
  await openConnect(page);

  const slack = page.locator("li").filter({ hasText: "Slackのアプリ登録" });
  await expect(slack).toBeVisible();
  await expect(slack.getByRole("link", { name: "いま繋ぐ" })).toHaveCount(0);
  await expect(slack).toContainText("持ち主");

  // 繋げるほうには、ちゃんと出ている（この確認が空振りしていないこと）
  const notion = page.locator("li").filter({ hasText: "Notionと繋いでいません" });
  await expect(notion.getByRole("link", { name: "いま繋ぐ" })).toBeVisible();
});

test("切ってある機能は、壊れているようには見せない", async ({ page }) => {
  const be = await mockBackend(page);
  withStatus(be);
  await enterApp(page);
  await openConnect(page);

  const gh = page.locator("li").filter({ hasText: "GitHub" });
  await expect(gh).toContainText("使わない設定");
  await expect(gh).toContainText("入れ直せます");
});

test("まだ作っていない物を、「使わない設定」とは言わない", async ({ page }) => {
  /* 同じ「使えません」でも、設定で戻せる物と、そもそも無い物は違う。
     一緒の言葉にすると「設定をいじれば使える」と読めてしまう。 */
  const be = await mockBackend(page);
  withStatus(be, [...ITEMS, {
    id: "local_agent", name: "パソコンの中を触る（ローカル相棒）",
    status: "unavailable", connected: false, kind: "off", pack: "dev", tools: [],
    why: "まだ用意していません（別プロセスとして作る予定）",
    next: "いまは Web からできる範囲で代用してください",
    action: { kind: "none" },
  }]);
  await enterApp(page);
  await openConnect(page);

  const row = page.locator("li").filter({ hasText: "ローカル相棒" });
  await expect(row).toContainText("まだありません");
  await expect(row).not.toContainText("使わない設定");
});

test("使えるものは畳んであり、開くと出る", async ({ page }) => {
  // 全部広げると長いだけで読まれない。知りたいのは使えないほう。
  const be = await mockBackend(page);
  withStatus(be);
  await enterApp(page);
  await openConnect(page);

  await expect(page.getByText("AI（頭脳）")).toHaveCount(0);
  await page.getByRole("button", { name: /使えるもの 2件/ }).click();
  await expect(page.getByText("AI（頭脳）")).toBeVisible();
});

test("取れなかったときに、「何も使えない」と読める空にしない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/capabilities/status", () => ({ status: 503, json: { error: "down" } }));
  await enterApp(page);
  await openConnect(page);
  /* 待ち時間を明示する。ここだけ既定の5秒のままで、全体を通したときに
     1度落ちた（単独では3回とも通る）。取りに行って失敗するまでの時間が
     混んでいるぶん伸びる所なので、他の確認と同じ余裕を持たせる。 */
  await expect(page.getByText(/状態を取得できませんでした|取得できませんでした/))
    .toBeVisible({ timeout: 10_000 });
});

test("いくつ使えるかが、最初の1行で分かる", async ({ page }) => {
  const be = await mockBackend(page);
  withStatus(be);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText(/いま\s*2\s*件が使えます/)).toBeVisible();
});
