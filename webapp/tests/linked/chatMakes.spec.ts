/**
 * 会話で作ったページ・アプリ・動画の絵コンテが、その場で使える形で出るか。
 * そして「管理 → ファイル」に、作った物が全部並ぶか。
 *
 * ・ページとアプリは sandbox の枠（allow-same-origin 無し）で動く。
 *   生成物のスクリプトが、このアプリのログイン情報に触れない
 * ・動画は絵コンテまで。書き出しは押したときだけ（数十秒かかるため）
 * ・以前「ファイル」はアプリしか出さず、キャンバスの「閉じても「管理 →
 *   ファイル」に残ります」を押すと、押した先に無かった
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, openManage } from "./backend";

const HTML = `<!DOCTYPE html><html><head><title>森のカフェ</title></head>
<body><h1 id="h">森のカフェ</h1></body></html>`;

async function say(page: Page, text: string) {
  await page.locator("textarea").first().fill(text);
  await page.keyboard.press("Enter");
}

test("会話で作ったページは、sandbox の枠の中で動く", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [
    { tool: "create_lp" },
    { show: { kind: "site", artifact_id: "a1", title: "森のカフェ", html: HTML, app: false } },
    { token: "ページを作りました。" }, { done: true },
  ] }));
  await enterApp(page);
  await say(page, "森のカフェのホームページを作って");

  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const frame = canvas.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
  expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  await expect(canvas.frameLocator("iframe").locator("#h")).toHaveText("森のカフェ");
  // 閉じても残る（ファイルに並ぶ）ことを、その場で言う
  await expect(canvas.getByText(/閉じても「管理 → ファイル」に残ります/)).toBeVisible();
});

test("別のタブで開いても、sandbox の枠の外には出ない", async ({ page, context }) => {
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [
    { show: { kind: "site", artifact_id: "a1", title: "森のカフェ", html: HTML, app: true } },
    { done: true },
  ] }));
  await enterApp(page);
  await say(page, "アプリを作って");
  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    canvas.getByRole("button", { name: /別のタブで大きく開く/ }).click(),
  ]);
  await tab.waitForLoadState("domcontentloaded");
  expect(await tab.locator("script").count()).toBe(0);          // 外枠にスクリプトは無い
  const sandbox = await tab.locator("iframe").getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");
  await expect(tab.frameLocator("iframe").locator("#h")).toHaveText("森のカフェ");
  // 元のタブへは戻れない（opener を渡していない）
  expect(await tab.evaluate(() => window.opener === null)).toBe(true);
});

test("動画は絵コンテで出て、押したときだけ書き出す", async ({ page }) => {
  const be = await mockBackend(page, {
    "/video/aspects": { json: { aspects: [], available: true, subtitles_available: true } },
    "/video": { json: { video_base64: "AAAAIGZ0eXBpc29t" } },
  });
  be.set("/chat", () => ({ sse: [
    { show: { kind: "video", title: "朝のストレッチ", aspect: "9:16", scenes: [
      { narration: "おはようございます", visual: "朝日" },
      { narration: "肩を回します", visual: "人が肩を回す" }] } },
    { done: true },
  ] }));
  await enterApp(page);
  await say(page, "朝のストレッチの動画を作って");

  const canvas = page.getByLabel("作った物");
  await expect(canvas.getByText("肩を回します")).toBeVisible({ timeout: 10_000 });
  expect(be.count("/video")).toBe(0);                          // 押すまでは書き出さない
  await canvas.getByRole("button", { name: /動画にする（9:16）/ }).click();
  await expect(canvas.locator("video")).toBeVisible({ timeout: 10_000 });
  const sent = be.calls.find((c) => c.path === "/video")!.body as { aspect: string; scenes: unknown[] };
  expect(sent.aspect).toBe("9:16");
  expect(sent.scenes).toHaveLength(2);
});

test("書き出せない置き場では、そう言って押させ続けない", async ({ page }) => {
  const be = await mockBackend(page, {
    "/video/aspects": { json: { aspects: [], available: false, subtitles_available: false } },
  });
  be.set("/chat", () => ({ sse: [
    { show: { kind: "video", title: "朝", aspect: "16:9", scenes: [{ narration: "おはよう" }] } },
    { done: true },
  ] }));
  await enterApp(page);
  await say(page, "動画");
  const canvas = page.getByLabel("作った物");
  await canvas.getByRole("button", { name: /動画にする/ }).click();
  await expect(canvas.getByText(/この置き場では動画を書き出せません/)).toBeVisible({ timeout: 10_000 });
  expect(be.count("/video")).toBe(0);
});

test("ファイルには、アプリ以外に作った物も並ぶ", async ({ page }) => {
  await mockBackend(page, {
    "/artifacts": { json: { items: [
      { id: "d1", kind: "document", title: "議事録まとめ", mime: "text/markdown", size: 10 },
      { id: "s1", kind: "site", title: "森のカフェ", mime: "text/html", size: 100 },
      { id: "w1", kind: "webapp", title: "家計簿", mime: "text/html", size: 100 },
    ] } },
    "/artifacts/s1": { json: { id: "s1", kind: "site", title: "森のカフェ", mime: "text/html",
                               size: 100, content: HTML } },
  });
  await enterApp(page);
  await openManage(page, "ファイル");

  const made = page.getByRole("region", { name: "作った物" });
  await expect(made).toBeVisible({ timeout: 10_000 });
  await expect(made.getByText("議事録まとめ")).toBeVisible();
  await expect(made.getByText("森のカフェ")).toBeVisible();
  await expect(made.getByText("家計簿")).toHaveCount(0);       // アプリはアプリの一覧へ
  await expect(page.getByText("家計簿").first()).toBeVisible();

  // ページは中身の文字ではなく、sandbox の枠で動かして見せる
  await made.getByRole("listitem").filter({ hasText: "森のカフェ" })
    .getByRole("button", { name: "開く" }).click();
  const viewer = page.getByRole("dialog", { name: "森のカフェ" });
  const frame = viewer.locator("iframe");
  await expect(frame).toBeVisible({ timeout: 10_000 });
  expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  await expect(viewer.frameLocator("iframe").locator("#h")).toHaveText("森のカフェ");
});
