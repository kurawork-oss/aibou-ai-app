/**
 * 決まった手順（保存して、毎回同じに流す）。
 *
 * ここで守りたいこと
 * ------------------
 * 1. **流す前に、流す手順そのものを見せる。** 手順を流す道具の引数は
 *    名前だけ。名前だけで流すと、中身が書き換えられていても気づけない
 * 2. 流す口は確認の門を通る口（/agent/execute）だけ。画面に専用の
 *    「押せば流れる口」を作らない
 * 3. うまくいったブラウザ操作は、その場で名前を付けて残せる
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, type Backend } from "./backend";

const MORNING = {
  id: "r1", name: "朝のケース確認", description: "",
  url: "https://intra.example.co.jp/cases",
  steps: [
    { do: "fill", target: "検索", value: "{顧客名}" },
    { do: "click", target: "検索する" },
  ],
  params: ["顧客名"], touches: true, last_result: "✓ 2手を流しました",
};

async function openConnect(page: Page) {
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "つなぐ", exact: true }).click();
  await expect(page.getByRole("region", { name: "決まった手順" })).toBeVisible({ timeout: 10_000 });
}

function withRecipes(be: Backend, items: unknown[]) {
  be.set("/recipes", () => ({ json: { items } }));
}

test("まだ無いときは、どうすれば残せるかを言う", async ({ page }) => {
  const be = await mockBackend(page);
  withRecipes(be, []);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText(/この手順を保存/)).toBeVisible();
});

test("流す前に、値を入れた形の手順を見せてから流す", async ({ page }) => {
  const be = await mockBackend(page);
  withRecipes(be, [MORNING]);
  be.set("/agent/execute", () => ({ json: { result: "手順「朝のケース確認」を最後まで流しました", show: [] } }));
  await enterApp(page);
  await openConnect(page);

  await page.getByRole("button", { name: "朝のケース確認 を流す" }).click();
  const run = page.getByRole("button", { name: "この手順で流す" });
  // 値が空のうちは流せない
  await expect(run).toBeDisabled();
  await page.getByLabel("顧客名").fill("山田商事");
  const shown = page.getByRole("list", { name: "流す手順" });
  await expect(shown).toContainText("「検索」に「山田商事」と入力");
  await expect(shown).toContainText("「検索する」を押す");
  await expect(page.getByText(/あなたとして/)).toBeVisible();
  expect(be.count("/agent/execute")).toBe(0);

  await run.click();
  await expect.poll(() => be.count("/agent/execute"), { timeout: 10_000 }).toBe(1);
  const sent = be.calls.find((c) => c.path === "/agent/execute")?.body as
    { tool?: string; params?: { name?: string; values?: Record<string, string> }; level?: number };
  expect(sent?.tool).toBe("recipe_run");
  expect(sent?.params?.name).toBe("朝のケース確認");
  expect(sent?.params?.values?.["顧客名"]).toBe("山田商事");
  expect(sent?.level).toBe(3);
  await expect(page.getByLabel("流した結果")).toContainText("最後まで流しました");
});

test("やめたら流さない", async ({ page }) => {
  const be = await mockBackend(page);
  withRecipes(be, [MORNING]);
  await enterApp(page);
  await openConnect(page);
  await page.getByRole("button", { name: "朝のケース確認 を流す" }).click();
  await page.getByRole("button", { name: "やめる" }).click();
  await expect(page.getByRole("button", { name: "この手順で流す" })).toHaveCount(0);
  expect(be.count("/agent/execute")).toBe(0);
});

test("消すと、その手順だけ消える", async ({ page }) => {
  const be = await mockBackend(page);
  withRecipes(be, [MORNING]);
  be.set("/recipes/r1", () => ({ json: { ok: true, name: "朝のケース確認" } }));
  await enterApp(page);
  await openConnect(page);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "朝のケース確認 を消す" }).click();
  await expect.poll(() => be.calls.filter((c) => c.path === "/recipes/r1"
    && c.method === "DELETE").length, { timeout: 10_000 }).toBe(1);
});

test("最後にうまく流れたかが見える", async ({ page }) => {
  const be = await mockBackend(page);
  withRecipes(be, [{ ...MORNING, last_result: "✗ 2手目で止めました（見つかりませんでした）" }]);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText(/2手目で止めました/)).toBeVisible();
});

test("会話の確認カードに、流す手順そのものが出る", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [
    { approval: {
      tool: "recipe_run", params: { name: "朝のケース確認", values: { "顧客名": "山田商事" } },
      note: "", level: 3, level_label: "取り返せない",
      why: "保存した手順を、手元の専用ブラウザで流します。", chained: false,
      may_always: false, always_confirm: true,
      detail: "手順「朝のケース確認」（2手）\n開く: https://intra.example.co.jp/cases\n"
        + "1. 「検索」に「山田商事」と入力\n2. 「検索する」を押す" } },
    { done: true },
  ] }));
  await enterApp(page);
  await page.locator("textarea").first().fill("朝のケース確認を流して");
  await page.keyboard.press("Enter");
  const shown = page.getByLabel("流す手順");
  await expect(shown).toBeVisible({ timeout: 15_000 });
  await expect(shown).toContainText("「検索する」を押す");
});

test("押し終えた操作を、その場で手順として残せる", async ({ page }) => {
  const be = await mockBackend(page);
  const steps = [{ do: "fill", target: "検索", value: "山田商事" }, { do: "click", target: "検索する" }];
  be.set("/chat", () => ({ sse: [
    { approval: {
      tool: "browser_act", params: { url: "https://intra.example.co.jp/cases", steps },
      note: "", level: 3, level_label: "取り返せない", why: "", chained: false,
      may_always: false, always_confirm: true } },
    { done: true },
  ] }));
  be.set("/agent/execute", () => ({ json: {
    result: "【案件一覧】https://intra.example.co.jp/cases\n（ノート / 専用ブラウザ（Playwright）で実行）",
    show: [] } }));
  be.set("/recipes", (call) => (call.method === "POST"
    ? { json: { ok: true, stored: "db", replaced: false } }
    : { json: { items: [] } }));
  await enterApp(page);
  await page.locator("textarea").first().fill("山田商事のケースを開いて");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "実行する" }).click({ timeout: 15_000 });

  await page.getByRole("button", { name: "この手順を保存" }).click({ timeout: 10_000 });
  await page.getByLabel("手順の名前").fill("山田商事のケース");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect.poll(() => be.calls.filter((c) => c.path === "/recipes"
    && c.method === "POST").length, { timeout: 10_000 }).toBe(1);
  const sent = be.calls.find((c) => c.path === "/recipes" && c.method === "POST")?.body as
    { name?: string; url?: string; steps?: unknown[] };
  expect(sent?.name).toBe("山田商事のケース");
  expect(sent?.url).toBe("https://intra.example.co.jp/cases");
  expect(sent?.steps).toHaveLength(2);
  await expect(page.getByText(/「山田商事のケースを流して」/)).toBeVisible();
});

test("うまくいかなかった操作には、保存を出さない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [
    { approval: {
      tool: "browser_act", params: { url: "https://intra.example.co.jp/cases",
        steps: [{ do: "click", target: "検索する" }] },
      note: "", level: 3, level_label: "取り返せない", why: "", chained: false,
      may_always: false, always_confirm: true } },
    { done: true },
  ] }));
  be.set("/agent/execute", () => ({ json: {
    result: "intra.example.co.jp を操作できる場所がありません。", show: [] } }));
  await enterApp(page);
  await page.locator("textarea").first().fill("ケースを開いて");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "実行する" }).click({ timeout: 15_000 });
  await expect(page.getByText(/操作できる場所がありません/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "この手順を保存" })).toHaveCount(0);
});
