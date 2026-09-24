/**
 * テストが画面を行き来するための、共通の手順。
 *
 * 以前は右上の「Modes」（15画面を英語の札で並べた一覧）から開いていた。
 * その一覧は、下のナビ（実行・管理）と管理の中の切り替えと**同じ行き先を
 * 別の呼び名で**持っていたので、1つにした（app/page.tsx の DesktopTabs）。
 *
 * テストの中の呼び名（HOME・STUDIO…）はそのまま使えるようにして、
 * ここで今の入口に置き換える。
 */

import type { Page } from "@playwright/test";

/** 管理タブの切り替えに並んでいる物（lib/shell.ts の MANAGE_SURFACES） */
const MANAGE: Record<string, string> = {
  HOME: "今日", BOARD: "ボード", TASKS: "タスク", ARCHIVE: "ファイル",
};

/** 「もっと」の中の物（lib/shell.ts の MORE_SURFACES） */
const MORE: Record<string, string> = {
  STUDIO: "つくる", CODE: "コード", SNS: "SNS", CAPTURE: "録音", VAULT: "資料",
  ME: "きろく", AUTO: "ゴール", INCOME: "副業", EXTEND: "連携", GUIDE: "説明書",
};

/** 下のナビ（スマホ）か、上の切り替え（広い画面）。見えているほうを押す。 */
function tabButton(page: Page, label: "実行" | "管理") {
  return page.locator('nav[aria-label="Mobile navigation"], nav[aria-label="画面の切り替え"]')
    .getByRole("button", { name: label, exact: true }).first();
}

/** アプリが使える状態になったか（実行と管理の切り替えが出ている）。 */
export async function waitForHud(page: Page, timeout = 10_000) {
  await tabButton(page, "管理").waitFor({ timeout });
}

/** 画面を開く。呼び名は以前の札（HOME・CHAT・STUDIO…）。 */
export async function goScreen(page: Page, name: string) {
  if (name === "CHAT") {
    await tabButton(page, "実行").click();
    return;
  }
  await tabButton(page, "管理").click();
  if (MANAGE[name]) {
    await page.getByRole("button", { name: MANAGE[name], exact: true }).first().click();
    return;
  }
  const label = MORE[name];
  if (!label) throw new Error(`知らない画面: ${name}`);
  const more = page.getByRole("button", { name: /もっと/ }).first();
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await page.getByRole("button", { name: new RegExp(`^${label}(\\s|$)`) }).first().click();
}
