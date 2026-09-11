/**
 * 端末への通知（Web Push）の、繋がっているときの振る舞い。
 *
 * ここで見たいこと
 * ----------------
 * 通知は「押しても何も起きない」形で失敗する機能で、しかも失敗しても
 * ブラウザは何も言わない。だからこの画面でいちばん大事なのは、
 * **できなかったときに理由を出すこと**。
 *
 *   ・接続先が無い       → 「接続先が無い」と言う
 *   ・許可を断られた     → 設定から戻せる、と言う
 *   ・購読を作れなかった → 「有効にしました」と言わない
 *
 * この最後が肝。ここで嘘をつくと、本人は通知が来るつもりで待ち続ける。
 *
 * 本物の push サービスへは繋がない（ここにその経路が無い）。
 * 確かめられるのは「サーバーと正しくやりとりするか」「駄目なときに
 * 黙らないか」まで。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend } from "./backend";

async function enterApp(page: Page) {
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offline = page.getByText("ENTER OFFLINE");
  const settings = page.getByLabel("Settings");
  await Promise.race([
    offline.waitFor({ timeout: 8_000 }).then(() => offline.click()).catch(() => {}),
    settings.waitFor({ timeout: 10_000 }).catch(() => {}),
  ]);
  await expect(settings).toBeVisible({ timeout: 10_000 });
}

async function openPushSettings(page: Page) {
  await page.getByLabel("Settings").click();
  await expect(page.getByText("端末への通知")).toBeVisible({ timeout: 8_000 });
}

/** 本物らしい公開鍵（65バイトの非圧縮点を base64url にしたもの）。 */
const KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

test("鍵はサーバーから取りに行く（画面に埋め込まない）", async ({ page, context }) => {
  // 鍵をビルドに焼き込むと、変えたときに全員の購読が黙って死ぬ。
  // 毎回サーバーに聞く作りかどうかを、往復の数で見る。
  await context.grantPermissions(["notifications"]);
  const be = await mockBackend(page);
  be.set("/push/key", { json: { key: KEY } });
  be.set("/push/subscribe", { json: { ok: true, stored: "db" } });

  await page.goto("/");
  await enterApp(page);
  be.reset();
  await openPushSettings(page);
  await page.getByRole("button", { name: /通知を許可する/ }).click();
  await page.waitForTimeout(1500);

  expect(be.count("/push/key"), "鍵をサーバーに聞いていない").toBeGreaterThan(0);
});

test("購読を作れなかったら「有効にしました」と言わない", async ({ page, context }) => {
  /* いちばん困る嘘。ここで成功と出すと、本人は通知が来るつもりで待つ。
     この環境には本物の push サービスが無いので、購読は必ず失敗する
     ——つまりこのテストは「失敗したときの言い方」をそのまま見ている。 */
  await context.grantPermissions(["notifications"]);
  const be = await mockBackend(page);
  be.set("/push/key", { json: { key: KEY } });
  be.set("/push/subscribe", { json: { ok: true } });

  await page.goto("/");
  await enterApp(page);
  await openPushSettings(page);
  await page.getByRole("button", { name: /通知を許可する/ }).click();
  await page.waitForTimeout(2000);

  const panel = page.locator("section", { hasText: "端末への通知" });
  const text = await panel.innerText();
  const claimsOn = text.includes("届きます") && text.includes("ためしに1通送る");
  if (!claimsOn) {
    // 失敗した場合：理由が出ていること（黙って元に戻らないこと）
    expect(text, `理由が出ていない:\n${text}`).toMatch(/できません|できませんでした|お試しください/);
  } else {
    // まれに購読が作れた場合：ちゃんとサーバーへ登録していること
    expect(be.count("/push/subscribe")).toBeGreaterThan(0);
  }
});

test("サーバーが鍵を返せないときは、その理由を出す", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  const be = await mockBackend(page);
  be.set("/push/key", { status: 500, json: {} });

  await page.goto("/");
  await enterApp(page);
  await openPushSettings(page);
  await page.getByRole("button", { name: /通知を許可する/ }).click();
  await page.waitForTimeout(1500);

  // 札と説明文の両方に出るので、説明文のほうを名指しする
  await expect(page.getByText(/鍵を取得できませんでした|接続先（バックエンド）/))
    .toBeVisible({ timeout: 5_000 });
});

test("許可を断られたら、設定から戻せると伝える", async ({ page, context }) => {
  // 一度断ると、次からダイアログすら出ない。ここで黙ると詰む。
  await context.clearPermissions();
  const be = await mockBackend(page);
  be.set("/push/key", { json: { key: KEY } });

  await page.goto("/");
  await page.addInitScript(() => {
    // 断られた状態を作る（Playwright には「拒否」を与える口が無い）
    Object.defineProperty(Notification, "permission", { get: () => "denied" });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await openPushSettings(page);

  // 札（短い）と説明文（長い）の両方に出る。両方あることを確かめる
  await expect(page.getByText("拒否されています", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/設定（サイトの権限）から許可に戻して/)).toBeVisible();
  // 押しても無駄なボタンは出さない
  await expect(page.getByRole("button", { name: /通知を許可する/ })).toBeDisabled();
});

test("通知の受け口（sw.js）が配られている", async ({ page }) => {
  // これが 404 だと、許可まで通ったのに1通も届かない
  const res = await page.request.get("/sw.js");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body, "push を受け取る所が無い").toContain('addEventListener("push"');
  expect(body, "押したときの処理が無い").toContain('addEventListener("notificationclick"');
  // キャッシュは持たせない（更新したのに古い画面が出続ける事故を避ける）
  expect(body).not.toContain("caches.open");
});
