/**
 * 設定の「使う機能」の入り切りを、繋がっている画面で見る。
 *
 * 見たいのは3つ。
 *   ・切れないものは切れない（仕事の基本を切ると相棒が何も出来なくなる）
 *   ・保存できていないのに、切り替わったふりをしない
 *   ・切ったら `#` の候補からも消える（再読込なしで）
 *
 * 3つ目は、開いたときに1回だけ候補を取っていたので実際に抜けていた。
 * 「開発」を切ったあとも `#コード` が候補に残っていた。
 */

import { test, expect } from "@playwright/test";
import { enterApp, mockBackend } from "./backend";

/** 設定を開いて CORE を表示する。 */
async function openSettings(page: import("@playwright/test").Page) {
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible();
}

/** そのかたまりの行（指で触るのはここ）。 */
const row = (page: import("@playwright/test").Page, hint: string) =>
  page.locator("label").filter({ hasText: hint });

test("4つのかたまりが出て、仕事の基本は切れない", async ({ page }) => {
  await mockBackend(page);
  await enterApp(page);
  await openSettings(page);

  await expect(page.getByText("USE THESE")).toBeVisible();
  // 名前は「仕事の基本（切れません）」のように但し書きが付くので、
  // 押すもの（スイッチ）の名前で見る。
  for (const label of ["仕事の基本", "つくる", "発信する", "開発"]) {
    await expect(page.getByRole("switch", { name: `${label}を使う` })).toBeVisible();
  }
  // 何ができるようになるのかも、押す前に書いてある
  await expect(page.getByText("画像・スライド・資料")).toBeVisible();
  // 切れないことを、押す前に書いてある
  await expect(page.getByText("（切れません）")).toBeVisible();
  await expect(page.getByRole("switch", { name: "仕事の基本を使う" })).toBeDisabled();
  // 切っても画面が消えるわけではないことも、先に書いてある
  await expect(page.getByText(/画面は消えない/)).toBeVisible();
});

test("切ると、送った中身に常時ONが残っている", async ({ page }) => {
  const be = await mockBackend(page);
  await enterApp(page);
  await openSettings(page);

  await row(page, "コード・GitHub").click();
  await expect.poll(() => be.count("/capabilities/packs")).toBe(1);

  const sent = be.calls.find((c) => c.path === "/capabilities/packs")!
    .body as { packs: string[] };
  expect(sent.packs).not.toContain("dev");
  expect(sent.packs).toContain("core");     // 勝手に外していない
});

test("保存を断られたら、理由を出して切り替えない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/capabilities/packs", {
    status: 409,
    json: { detail: "保存先がつながっていないため、保存できませんでした。拡張機能（EXTEND）→ Supabase から自分のデータベースを接続してください。" },
  });
  await enterApp(page);
  await openSettings(page);

  const sw = page.getByRole("switch", { name: "発信するを使う" });
  await expect(sw).not.toBeChecked();
  await row(page, "SNS・LP・記事").click();

  // 次に何をすればいいかが、そのまま出る
  await expect(page.getByText(/自分のデータベースを接続/)).toBeVisible();
  // 直しようのない案内（通信のせい）にしない
  await expect(page.getByText(/通信を確かめ/)).toHaveCount(0);
  // 切り替わったふりもしない
  await expect(sw).not.toBeChecked();
});

test("切ったら、再読込なしで # の候補からも消える", async ({ page }) => {
  await mockBackend(page);
  await enterApp(page);

  const ta = page.locator("textarea").first();
  await ta.fill("#");
  await expect(page.getByText("コードの作業場を開く")).toBeVisible();
  await ta.fill("");

  await openSettings(page);
  await row(page, "コード・GitHub").click();
  await expect(page.getByRole("switch", { name: "開発を使う" })).not.toBeChecked();
  await page.getByRole("button", { name: "✕" }).first().click();

  await page.locator("textarea").first().fill("#");
  await expect(page.getByText("コードの作業場を開く")).toHaveCount(0);
  // 他は残っている（切ったもの以外を巻き込んでいない）
  await expect(page.getByText("タスクを追加")).toBeVisible();
});
