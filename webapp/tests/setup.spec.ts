/**
 * はじめる手順の検証。
 *
 * ここが壊れると、渡された人が最初の30分で詰む。特に確かめたいのは
 *   ・バックエンドに繋がっていなくても、手順が読めること
 *     （繋ぎ方の案内を、繋がないと読めない場所に置いてはいけない。実際に踏んだ）
 *   ・貼り付けるSQLが、本物のスキーマと一致していること
 *   ・自分のDBの繋ぎ方が、押すボタンの文言まで書いてあること
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETUP_STEPS, SCHEMA_SQL_URL } from "../src/lib/setup";


/** GUIDEを開く（どのテストからも使う）。 */
async function openGuide(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const off = page.getByText("ENTER OFFLINE");
  const hud = page.getByLabel("Modes", { exact: true });
  await Promise.race([
    off.waitFor({ timeout: 8_000 }).then(() => off.click()).catch(() => {}),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await hud.waitFor({ timeout: 10_000 });
  await hud.click();
  await page.locator("nav").filter({ hasText: "MODES" }).getByText("GUIDE", { exact: true }).click();
  await page.waitForTimeout(800);
}

const ROOT = join(__dirname, "..", "..");
const PUBLIC = join(__dirname, "..", "public");

/* ── 中身 ────────────────────────────────────────────────────────── */
test("最初から最後まで、抜けなく並んでいる", () => {
  const ids = SETUP_STEPS.map((s) => s.id);
  for (const need of ["account", "supabase-project", "supabase-sql",
                      "supabase-keys", "connect", "ai-key"]) {
    expect(ids, `手順に ${need} が無い`).toContain(need);
  }
  // 順番も大事（テーブルを作る前に接続情報を取っても意味がない）
  expect(ids.indexOf("supabase-project")).toBeLessThan(ids.indexOf("supabase-sql"));
  expect(ids.indexOf("supabase-sql")).toBeLessThan(ids.indexOf("connect"));
});

test("各手順に、実際の操作が書いてある", () => {
  for (const s of SETUP_STEPS) {
    expect(s.title, s.id).toBeTruthy();
    expect(s.steps.length, s.id).toBeGreaterThan(0);
    for (const line of s.steps) expect(line.length).toBeGreaterThan(4);
  }
});

test("自分のDBの繋ぎ方が、押す場所まで書いてある", () => {
  // 「つなぐで繋いでください」だけだと、どこにあるか分からない
  const connect = SETUP_STEPS.find((s) => s.id === "connect")!;
  const text = connect.steps.join(" ");
  expect(text).toContain("設定");
  expect(text).toContain("つなぐ");
  expect(text).toContain("自分のデータベース");
  expect(text).toContain("接続");
});

test("service_role の危険性を必ず伝える", () => {
  const keys = SETUP_STEPS.find((s) => s.id === "supabase-keys")!;
  const text = keys.steps.join(" ") + (keys.caution ?? []).join(" ");
  expect(text).toContain("service_role");
  expect(text).toMatch(/人に見せない|貼らない/);
  expect(text).toContain("anon");        // anonキーとの取り違えを防ぐ
});

test("繋ぐまで保存されないことを伝える", () => {
  const all = SETUP_STEPS.flatMap((s) => [...(s.caution ?? []), s.detail ?? ""]).join(" ");
  expect(all).toMatch(/保存されません|保存されない/);
});

/* ── 貼り付けるSQL ───────────────────────────────────────────────── */
test("SQLはアプリ自身が配信する（バックエンド不要）", () => {
  // ここが外部のURLやAPIになっていると、繋がっていない人がSQLを取れない
  expect(SCHEMA_SQL_URL.startsWith("/")).toBeTruthy();
  const sqlStep = SETUP_STEPS.find((s) => s.id === "supabase-sql")!;
  expect(sqlStep.codeUrl).toBe(SCHEMA_SQL_URL);
});

test("配信するSQLが、本物のスキーマと同じ", () => {
  // 片方だけ直すと、説明どおりにやったのにテーブルが足りない状態になる
  const shipped = readFileSync(join(PUBLIC, "supabase_schema.sql"), "utf8");
  const real = readFileSync(join(ROOT, "supabase_schema.sql"), "utf8");
  expect(shipped, "webapp/public のSQLが本体と違う。コピーし直してください").toBe(real);
});

test("SQLは何度実行しても壊れない形になっている", () => {
  const sql = readFileSync(join(PUBLIC, "supabase_schema.sql"), "utf8").toUpperCase();
  expect(sql.split("CREATE TABLE").length).toBe(sql.split("CREATE TABLE IF NOT EXISTS").length);
  expect(sql).toContain("USER_CONNECTIONS");     // 接続台帳も含まれていること
});

test("SQLがHTTPで配信されている", async ({ request }) => {
  const res = await request.get(SCHEMA_SQL_URL);
  expect(res.status(), "SQLが配信されていない").toBe(200);
  expect(await res.text()).toContain("CREATE TABLE IF NOT EXISTS");
});

/* ── 画面での見え方 ──────────────────────────────────────────────── */
test("バックエンド未接続でも、はじめる手順が読める", async ({ page }) => {
  // テストは NEXT_PUBLIC_API_URL 空（＝未接続）で動く。まさにその状況。
  await page.goto("/");
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const off = page.getByText("ENTER OFFLINE");
  const hud = page.getByLabel("Modes", { exact: true });
  await Promise.race([
    off.waitFor({ timeout: 8_000 }).then(() => off.click()).catch(() => {}),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await hud.waitFor({ timeout: 10_000 });
  await hud.click();
  await page.locator("nav").filter({ hasText: "MODES" }).getByText("GUIDE", { exact: true }).click();

  // 「はじめる」タブが既定で開いていること
  await expect(page.getByText("はじめる手順")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("2. 自分の保存先を作る")).toBeVisible();
  await expect(page.getByText("5. アプリと保管庫をつなぐ")).toBeVisible();

  // 手順を開くと、貼り付けるものが取れること
  await page.getByText("3. 保管庫に棚を作る").click();
  await expect(page.getByRole("button", { name: /貼り付けるSQL/ })).toBeVisible({ timeout: 10_000 });
});

test("閉じていても「何をさせられるのか」が読める", async ({ page }) => {
  // 見出しだけだと、押して開くまで内容が分からず、身構えてしまう
  await openGuide(page);
  await expect(page.getByText(/あなた専用の「保管庫」を1つ用意します/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/中身は読まなくて大丈夫です/)).toBeVisible();
});

test("どこまで済んだかを覚えている", async ({ page }) => {
  // 設定は数日に分けてやる人もいる。開き直すたびに最初からでは困る
  await openGuide(page);
  await expect(page.getByText("0 / 7 完了")).toBeVisible({ timeout: 10_000 });

  await page.getByText("1. アカウントを作る").click();
  await page.getByRole("button", { name: /できた（次へ）/ }).click();
  await expect(page.getByText("1 / 7 完了")).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await openGuide(page);
  await expect(page.getByText("1 / 7 完了")).toBeVisible({ timeout: 10_000 });
});

test("用語のいいかえが読める", async ({ page }) => {
  await openGuide(page);
  await page.getByText("聞き慣れない言葉が出てきたら").click();
  await expect(page.getByText(/あなたのデータをしまっておく倉庫/)).toBeVisible();
  await expect(page.getByText(/倉庫の合鍵/)).toBeVisible();
});

test("章がタブで分かれていて、縦に全部並ばない", async ({ page }) => {
  await openGuide(page);
  await expect(page.getByRole("tab")).toHaveCount(4);
  // 「はじめる」を見ているとき、プライバシー本文までは出ていない
  await expect(page.getByText("あなたのデータがどこに入るか")).toBeHidden();
  await page.getByRole("tab", { name: /データと安全/ }).click();
  await expect(page.getByText("あなたのデータがどこに入るか")).toBeVisible();
});
