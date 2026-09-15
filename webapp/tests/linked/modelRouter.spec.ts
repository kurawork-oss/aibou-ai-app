/**
 * どの仕事を、どのAIへ回すか（仕様§15・§16）。
 *
 * ここで守りたいのは1つだけ。**勝手に課金しない。**
 *
 * 鍵を入れただけの従量課金サービスを、こちらの判断で使い始めてはいけない。
 * 請求は使う人に行く。鍵を入れる理由は「たまに使いたい」であって
 * 「これから全部これで」ではない。
 *
 * だから画面は、お金がかかる提供元にその印を出し、**選ぶのは本人**に残す。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, type Backend } from "./backend";

const PROVIDERS = [
  { id: "gemini", label: "Gemini", paid: false, ready: true,
    key: "GEMINI_API_KEY", note: "無料枠がある。既定。" },
  { id: "ollama", label: "Ollama（手元）", paid: false, ready: true,
    key: "OLLAMA_URL", note: "自分のパソコンで動く。" },
  { id: "anthropic", label: "Claude", paid: true, ready: true,
    key: "ANTHROPIC_API_KEY", note: "使った分だけ請求される。" },
  { id: "grok", label: "Grok", paid: true, ready: false,
    key: "XAI_API_KEY", note: "使った分だけ請求される。" },
];

function withRoutes(be: Backend) {
  const named: Record<string, string> = { chat: "", code: "", long: "", private: "", vision: "" };
  const compute = () => ({
    chat: named.chat || "gemini",
    code: named.code || "gemini",
    long: named.long || "gemini",
    private: named.private || "ollama",
    vision: named.vision || "gemini",
  });
  const body = () => ({ json: {
    ok: true, providers: PROVIDERS, tasks: Object.keys(named),
    routes: compute(), named: { ...named },
  } });
  be.set("/ai/routes", (call) => {
    const b = call.body as { task?: string; provider?: string } | null;
    if (call.method === "POST" && b?.task) named[b.task] = b.provider ?? "";
    return body();
  });
}

async function openBasic(page: Page) {
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "基本", exact: true }).click();
  await expect(page.getByText("どのAIに任せるか")).toBeVisible({ timeout: 10_000 });
}

test("既定は「おまかせ」で、無料のものが選ばれている", async ({ page }) => {
  const be = await mockBackend(page);
  withRoutes(be);
  await enterApp(page);
  await openBasic(page);

  const chat = page.getByRole("group", { name: "ふつうの会話" });
  await expect(chat).toContainText("いま: Gemini");
  await expect(chat.getByRole("button", { name: "おまかせ" })).toHaveAttribute("aria-pressed", "true");
});

test("お金がかかるAIには、その印が出る", async ({ page }) => {
  /* ここが無いと、料金のかかる物を無料だと思って選ぶ。 */
  const be = await mockBackend(page);
  withRoutes(be);
  await enterApp(page);
  await openBasic(page);

  await page.getByText(/使えるAIの一覧/).click();
  const claude = page.locator("li").filter({ hasText: "Claude" });
  await expect(claude).toContainText("かかります");
  const gem = page.locator("li").filter({ hasText: "無料枠がある" });
  await expect(gem).not.toContainText("かかります");
});

test("鍵が無いAIは、選べる形で出さない", async ({ page }) => {
  // 押しても使えない選択肢を並べても、迷うだけ。
  const be = await mockBackend(page);
  withRoutes(be);
  await enterApp(page);
  await openBasic(page);

  const chat = page.getByRole("group", { name: "コードを書く・直す" });
  await expect(chat.getByRole("button", { name: /Claude/ })).toBeVisible();
  await expect(chat.getByRole("button", { name: /Grok/ })).toHaveCount(0);
});

test("仕事ごとに選べて、選んだことが残る", async ({ page }) => {
  const be = await mockBackend(page);
  withRoutes(be);
  await enterApp(page);
  await openBasic(page);

  const code = page.getByRole("group", { name: "コードを書く・直す" });
  await code.getByRole("button", { name: /Claude/ }).click();
  await expect(code).toContainText("いま: Claude");

  // 選んでいない仕事は、無料のまま（1つ選んだら全部そちら、にしない）
  const chat = page.getByRole("group", { name: "ふつうの会話" });
  await expect(chat).toContainText("いま: Gemini");
});

test("「人に見せたくない物」は、手元のAIに回る", async ({ page }) => {
  const be = await mockBackend(page);
  withRoutes(be);
  await enterApp(page);
  await openBasic(page);

  const priv = page.getByRole("group", { name: "人に見せたくない物" });
  await expect(priv).toContainText("Ollama");
  await expect(priv).toContainText("外へ出さずに");
});

test("使えるAIが1つも無ければ、何をすればいいか言う", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/ai/routes", () => ({ json: {
    ok: true, providers: PROVIDERS.map((p) => ({ ...p, ready: false })),
    tasks: ["chat"], routes: { chat: "none" }, named: { chat: "" },
  } }));
  await enterApp(page);
  await openBasic(page);
  await expect(page.getByText(/「つなぐ」 に鍵を入れて/)).toBeVisible();
  await expect(page.getByText(/無料枠があります/)).toBeVisible();
});
