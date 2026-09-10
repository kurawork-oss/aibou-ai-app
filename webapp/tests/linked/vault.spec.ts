/**
 * 資料（VAULT）— 入れた物だけを根拠に答える画面。
 *
 * ここは「嘘をつくと一番困る」画面。ネットの一般論ではなく、入れた資料に
 * 書いてあることだけを言う、という約束で使われるので
 *
 *   ・入っていないのに「入りました」 → 根拠のない答えが返る土台になる
 *   ・答えの出どころが分からない     → 確かめようがない
 *
 * のどちらも、機能が壊れているより悪い。
 *
 * 実際、取り込みで嘘をついていた。サーバーが 409 で断って理由まで
 * 書いているのに、画面は「✓ 取り込みました（0字）」と出していた。
 * その形を、ここで固定する。
 */

import { test, expect, type Page } from "@playwright/test";
import { enterApp, mockBackend, type Backend } from "./backend";

/** 入れ物を1つ持っている状態にする。 */
function withVault(be: Backend) {
  be.set("/vault/notebooks", { json: { items: [{ id: "nb1", name: "社内規程", doc_count: 2 }] } });
  // n（出典番号）はサーバーが振る。画面は [1][2] として出し、
  // 回答の出典と突き合わせられるようにしている。
  be.set("/vault/docs", { json: { items: [
    { n: 1, title: "就業規則.pdf", chars: 12000 },
    { n: 2, title: "経費.md", chars: 800 },
  ] } });
}

/** 資料の画面を開いて、入れ物を選ぶところまで。 */
async function openNotebook(page: Page) {
  await page.getByLabel("Mobile navigation").getByText("管理", { exact: true }).click();
  await page.getByRole("button", { name: /もっと/ }).click();
  await page.getByRole("button", { name: /資料/ }).click();
  await expect(page.getByText("VAULT とは")).toBeVisible({ timeout: 10_000 });
  // 入れ物は押せる物として並ぶ（説明文にも同じ言葉が出るので、押せる方を取る）
  await page.getByRole("button", { name: /社内規程/ }).first().click();
}

/**
 * PDF を入れる。
 *
 * txt/md のようなテキスト系は、ブラウザ側で読んでフォームに載せる別経路に
 * 行く（サーバーへは送らない）。サーバーの取り込みを通すのは PDF 等なので、
 * ここは必ず PDF にする。
 */
const upload = (page: Page) =>
  page.locator('input[type="file"]').first().setInputFiles({
    name: "就業規則.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 ..."),
  });

test("入れてある資料が見える", async ({ page }) => {
  const be = await mockBackend(page);
  withVault(be);
  await enterApp(page);
  await openNotebook(page);
  await expect(page.getByText("就業規則.pdf")).toBeVisible({ timeout: 10_000 });
});

test("取り込みを断られたら、理由を出す（入ったと言わない）", async ({ page }) => {
  // ここが「✓ a.txt を取り込みました（0字）」と出ていた所。
  const be = await mockBackend(page);
  withVault(be);
  be.set("/vault/upload", {
    status: 409,
    json: { detail: "保存先がつながっていないため、保存できませんでした。拡張機能（EXTEND）→ Supabase から自分のデータベースを接続してください。" },
  });
  await enterApp(page);
  await openNotebook(page);
  await upload(page);

  await expect(page.getByText(/自分のデータベースを接続/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/を取り込みました/)).toHaveCount(0);
});

test("取り込めたときは、何字入ったかまで言う", async ({ page }) => {
  // 「入りました」だけだと、中身の無いPDFが通ったのか分からない。
  const be = await mockBackend(page);
  withVault(be);
  be.set("/vault/upload", { json: { ok: true, title: "就業規則", chars: 12345 } });
  await enterApp(page);
  await openNotebook(page);
  await upload(page);
  await expect(page.getByText(/12,345字/)).toBeVisible({ timeout: 10_000 });
});

test("答えには、どの資料から取ったかが付く", async ({ page }) => {
  // 出どころが無いと、一般論と区別が付かない。
  const be = await mockBackend(page);
  withVault(be);
  be.set("/vault/query", { json: {
    answer: "有給は入社6か月後から10日付与されます[1]。",
    sources: [{ n: 1, title: "就業規則.pdf" }, { n: 2, title: "経費.md" }],
    cited: [1],
  } });
  await enterApp(page);
  await openNotebook(page);

  await page.getByPlaceholder("このノートブックに質問する…").fill("有給は何日？");
  await page.getByRole("button", { name: "質問" }).click();

  await expect(page.getByText(/入社6か月後/)).toBeVisible({ timeout: 10_000 });
  // 見た資料と、実際に引用した資料の両方が分かる
  await expect(page.getByText("出典（1件を引用）")).toBeVisible();
  await expect(page.getByText("[1] 就業規則.pdf")).toBeVisible();
  await expect(page.getByText("[2] 経費.md")).toBeVisible();
});

test("出典番号の付かない答えには、根拠が無いかもしれないと書く", async ({ page }) => {
  // 資料を見たことにして、実は資料に無いことを言ってしまう——この画面で
  // いちばん困る壊れ方。番号が付かなかったことを、そのまま伝える。
  const be = await mockBackend(page);
  withVault(be);
  be.set("/vault/query", { json: {
    answer: "一般に有給は入社6か月後からです。",
    sources: [{ n: 1, title: "就業規則.pdf" }],
    cited: [],
  } });
  await enterApp(page);
  await openNotebook(page);
  await page.getByPlaceholder("このノートブックに質問する…").fill("有給は何日？");
  await page.getByRole("button", { name: "質問" }).click();
  await expect(page.getByText(/根拠が無い内容が含まれている可能性/)).toBeVisible({ timeout: 10_000 });
});

test("全部は読めなかったときに、全部読んだ顔をしない", async ({ page }) => {
  const be = await mockBackend(page);
  withVault(be);
  be.set("/vault/query", { json: {
    answer: "第20条にあります[1]。",
    sources: [{ n: 1, title: "就業規則.pdf" }],
    cited: [1], partial: true,
  } });
  await enterApp(page);
  await openNotebook(page);
  await page.getByPlaceholder("このノートブックに質問する…").fill("有給は何日？");
  await page.getByRole("button", { name: "質問" }).click();
  await expect(page.getByText(/全文ではありません/)).toBeVisible({ timeout: 10_000 });
});

test("資料に無いことを聞かれたら、無いと言う", async ({ page }) => {
  // ここで一般論を混ぜるのが、この画面のいちばんの裏切り。
  const be = await mockBackend(page);
  withVault(be);
  be.set("/vault/query", { json: {
    answer: "入れていただいた資料の中には、その記載が見つかりませんでした。",
    sources: [],
  } });
  await enterApp(page);
  await openNotebook(page);
  await page.getByPlaceholder("このノートブックに質問する…").fill("来期の株価は？");
  await page.getByRole("button", { name: "質問" }).click();
  await expect(page.getByText(/見つかりませんでした/)).toBeVisible({ timeout: 10_000 });
});

test("答えられなかったときは、そう言う（黙って空にしない）", async ({ page }) => {
  const be = await mockBackend(page);
  withVault(be);
  be.set("/vault/query", { status: 503, json: { error: "AIの利用券が設定されていません" } });
  await enterApp(page);
  await openNotebook(page);
  await page.getByPlaceholder("このノートブックに質問する…").fill("有給は何日？");
  await page.getByRole("button", { name: "質問" }).click();
  await expect(page.getByText(/利用券が設定されていません/)).toBeVisible({ timeout: 10_000 });
});

async function openVaultEmpty(page: Page) {
  await page.getByLabel("Mobile navigation").getByText("管理", { exact: true }).click();
  await page.getByRole("button", { name: /もっと/ }).click();
  await page.getByRole("button", { name: /資料/ }).click();
  await expect(page.getByText("VAULT とは")).toBeVisible({ timeout: 10_000 });
}

test("保存先が無いなら、作る前に言い切る", async ({ page }) => {
  // 「決まっていないと残りません」だと、自分がどちらなのか分からない
  // まま作ることになる。いまどうなっているかを言う。
  const be = await mockBackend(page);
  be.set("/vault/notebooks", { json: { items: [] } });
  be.set("/account/database", { json: { available: true, connected: false } });
  await enterApp(page);
  await openVaultEmpty(page);
  await expect(page.getByText(/いま保存先が繋がっていないので/)).toBeVisible({ timeout: 10_000 });
});

test("保存先があるなら、残ると言う（無用に脅さない）", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/vault/notebooks", { json: { items: [] } });
  be.set("/account/database", { json: { available: true, connected: true } });
  await enterApp(page);
  await openVaultEmpty(page);
  await expect(page.getByText(/保存先は繋がっています/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/残りません/)).toHaveCount(0);
});

test("持ち主はサーバー既定のDBに残る（そこで「無い」と言わない）", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/vault/notebooks", { json: { items: [] } });
  be.set("/account/database", { json: { available: true, connected: false, using_server_db: true } });
  await enterApp(page);
  await openVaultEmpty(page);
  await expect(page.getByText(/保存先は繋がっています/)).toBeVisible({ timeout: 10_000 });
});

test("分からないうちは、どちらとも言わない", async ({ page }) => {
  // 憶測で「残りません」と出すと、繋いである人に嘘の警告を出すことになる。
  const be = await mockBackend(page);
  be.set("/vault/notebooks", { json: { items: [] } });
  be.set("/account/database", { status: 503, json: { detail: "確認できません" } });
  await enterApp(page);
  await openVaultEmpty(page);
  await expect(page.getByText(/残りません/)).toHaveCount(0);
  await expect(page.getByText(/繋がっています/)).toHaveCount(0);
});
