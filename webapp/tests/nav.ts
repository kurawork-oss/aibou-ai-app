/**
 * テストが画面を行き来するための、共通の手順。
 *
 * ui-r126 で、行き先を選ぶナビ（実行・管理・もっと）を無くした。画面は
 * 「会話」1つで、ほかの画面は入力欄の「＋」（できること）から開き、
 * 会話の上にかぶさる。閉じるのは「会話に戻る」。
 *
 * テストの中の呼び名（HOME・STUDIO…）はそのまま使えるようにして、
 * ここで今の入口に置き換える。
 */

import type { Page } from "@playwright/test";

/** テストの呼び名 → 「できること」の id（lib/chatActions.ts の ACTIONS） */
const ACTION_OF: Record<string, string> = {
  HOME: "today", BOARD: "board", TASKS: "tasks", ARCHIVE: "files",
  STUDIO: "studio", CODE: "code", SNS: "sns", CAPTURE: "capture", VAULT: "vault",
  ME: "me", AUTO: "autopilot", INCOME: "income", EXTEND: "extend", GUIDE: "guide",
};

/** 「＋」（できること）の押し場所。 */
export function plusButton(page: Page) {
  return page.getByRole("button", { name: "できること", exact: true }).first();
}

/** アプリが使える状態になったか（会話の「＋」が出ている）。 */
export async function waitForHud(page: Page, timeout = 10_000) {
  await plusButton(page).waitFor({ timeout });
}

/** 会話の上に開いた画面を閉じる（開いていなければ何もしない）。 */
export async function backToChat(page: Page) {
  const back = page.getByRole("button", { name: /会話に戻る/ }).first();
  if (await back.isVisible().catch(() => false)) await back.click();
}

/** 画面を開く。呼び名は以前の札（HOME・CHAT・STUDIO…）。 */
export async function goScreen(page: Page, name: string) {
  await backToChat(page);
  if (name === "CHAT") return;
  const id = ACTION_OF[name];
  if (!id) throw new Error(`知らない画面: ${name}`);
  await plusButton(page).click();
  await page.locator(`[data-action="${id}"]`).first().click();
}
