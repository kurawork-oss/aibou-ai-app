/**
 * 説明書に載せる画面写真が、本当に配信されているかの検証。
 *
 * 写真のパスはバックエンド（api/guide.py）が持ち、ファイル本体は webapp が
 * 配信する。持ち主が分かれているので、片方だけ直すと「altテキストだけが並ぶ
 * 説明書」になる。api 側は「ファイルがそこにあるか」を見ているが、
 * 置いてあっても配信されなければ意味がないので、ここは実際にHTTPで取る。
 *
 * 画面そのものの表示は app.spec.ts の GUIDE のテストが見ている。ここは
 * 「写真が全部そろって配信されているか」だけを担当する。
 */

import { test, expect } from "@playwright/test";
import { goScreen } from "./nav";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const GUIDE_DIR = join(__dirname, "..", "public", "guide");

/** 画面写真の一覧（ファイル名がそのままモードのid）。 */
function shots(): string[] {
  return readdirSync(GUIDE_DIR).filter((f) => f.endsWith(".webp")).sort();
}

test("全モードぶんの画面写真がそろっている", () => {
  const ids = shots().map((f) => f.replace(/\.webp$/, ""));
  // ランチャーに出る画面 + 設定 + 自分のDB
  for (const id of [
    "chat", "home", "me", "tasks", "board", "vault", "code",
    "studio", "capture", "sns", "income", "autopilot", "archive",
    "settings", "database",
  ]) {
    expect(ids, `説明書の画面写真が無い: ${id}`).toContain(id);
  }
});

test("画面写真が空ファイルでない", () => {
  for (const f of shots()) {
    expect(statSync(join(GUIDE_DIR, f)).size, `壊れている: ${f}`).toBeGreaterThan(2000);
  }
});

test("画面写真がHTTPで配信されている", async ({ request }) => {
  for (const f of shots()) {
    const res = await request.get(`/guide/${f}`);
    expect(res.status(), `配信されていない: /guide/${f}`).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("image/webp");
  }
});

test("説明書を開いても、画面が横にはみ出さない", async ({ page }) => {
  // SQLのような長い行を出すと、親を押し広げて画面全体が横スクロールしうる
  // （グリッド／フレックスの子は既定で縮まないため）。実際に踏んだので見張る。
  await page.goto("/");
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const off = page.getByText("ENTER OFFLINE");
  const hud = page.locator('nav[aria-label="Mobile navigation"], nav[aria-label="画面の切り替え"]').getByRole("button", { name: "管理", exact: true }).first();
  await Promise.race([
    off.waitFor({ timeout: 8_000 }).then(() => off.click()).catch(() => {}),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await hud.waitFor({ timeout: 10_000 });
  await goScreen(page, "GUIDE");
  await page.waitForTimeout(1500);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "説明書の画面が横にはみ出している").toBeLessThanOrEqual(1);
});
