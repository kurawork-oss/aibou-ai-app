/**
 * 見張り（監視して、変わったときだけ報せる）の検証。
 *
 * 要望: タスク・業務・予定・メール・Slack・LINE を監視して報告してほしい。
 *
 * この機能で一番やってはいけないのは、次の2つを混ぜること。
 *   「新着なし」        … 見に行けて、無かった
 *   「見に行けていない」 … そもそも確認できていない
 * メールが読めていないのに「異常なし」と出るのが、いちばん困る形なので、
 * その線引きが実装から消えていないことをここで固定する。
 */

import { test, expect, type Page } from "@playwright/test";
import { goScreen, waitForHud } from "./nav";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const api = (p: string) => readFileSync(join(process.cwd(), "..", "api", p), "utf8");

async function enterApp(page: Page) {
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hudH1 = page.getByText("THE FORGE OS").first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()),
    hudH1.waitFor({ timeout: 10_000 }),
  ]);
  await waitForHud(page);
}

/** 起動直後はHOMEとは限らないので、明示的に開く。 */
async function goHome(page: Page) {
  await goScreen(page, "HOME");
  await page.locator("[data-widget]").first().waitFor({ timeout: 10_000 });
}

/* ── 画面に出ていること ─────────────────────────────────────────── */
test("HOMEに見張りのウィジェットがある", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goHome(page);
  await expect(page.locator('[data-widget="watch"]')).toHaveCount(1);
});

test("バックエンド未接続のときは、見張れていないことを言う", async ({ page }) => {
  // ここで「異常なし」と出してしまうと、何も見ていないのに安心させることになる
  await page.goto("/");
  await enterApp(page);
  await goHome(page);
  const card = page.locator('[data-widget="watch"]');
  await expect(card).toContainText("バックエンド接続後");
  await expect(card).not.toContainText("いま気にすべきものはありません");
});

test("カスタマイズ画面に見張りが並んでいる", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goHome(page);
  await page.getByRole("button", { name: /カスタマイズ/ }).click();
  await expect(page.getByLabel("見張りを隠す")).toHaveCount(1);
});

/* ── 「読めていない」を握りつぶさないこと ───────────────────────── */
test("読めなかった対象を、新着ゼロと同じ場所に出さない", () => {
  const panel = src("components/WatchPanel.tsx");
  expect(panel).toContain("見に行けていません（新着が無いのではありません）");
  // 失敗した対象だけを集めて別枠に出している
  expect(panel).toMatch(/broken\s*=\s*sources\.filter/);
  // 未設定は失敗ではないので、赤の枠に混ぜない
  expect(panel).toMatch(/!s\.setup_needed/);
});

test("報告の本文にも、見に行けなかった理由が必ず載る", () => {
  const w = api("watch.py");
  expect(w).toContain("見に行けなかったもの（新着が無いのではなく、確認できていません）");
  // 源が落ちても他は見る（1つの失敗で全部が黙らない）
  expect(w).toMatch(/except Exception as e:\s*\n\s*#[^\n]*\n\s*res = \{"ok": False/);
});

test("朝の報告は、読めなかったぶんをAIに通さない", () => {
  // まとめさせると「特に問題ありません」に化けることがある。そこは消してはいけない
  const p = api("proactive.py");
  expect(p).toContain("読めなかったものは AI に通さず");
  expect(p).toMatch(/return \(text or fallback\) \+ trouble_text/);
});

/* ── 通知のうるささを抑える作りが残っていること ─────────────────── */
test("見張りを始めた初回は一斉通知しない", () => {
  const w = api("watch.py");
  expect(w).toContain("控えが無い状態で読めたときは、中身をまとめて鳴らさない");
});

test("同じ失敗を毎回鳴らさない（直ったときは報せる）", () => {
  const w = api("watch.py");
  expect(w).toContain("last_error");
  expect(w).toContain("読めるようになりました");
});

test("毎分は外に見に行かない（対象ごとに最短の間隔がある）", () => {
  const w = api("watch.py");
  expect(w).toMatch(/"key": "mail"[^\n]*min_interval": 300/);
  expect(w).toMatch(/"key": "slack"[^\n]*min_interval": 300/);
});

/* ── 内部の持ち回りが外に漏れないこと ───────────────────────────── */
test("覚えている鍵の一覧をAPIで返さない", () => {
  // seen は最大300件。画面に返す必要が無いうえ、毎回運ぶと重い
  const w = api("watch.py");
  expect(w).toContain("def public(");
  expect(w).toMatch(/not k\.startswith\("_"\)/);
});

/* ── LINE の受信口 ──────────────────────────────────────────────── */
test("LINEの受信は署名を確かめてから保存する", () => {
  const i = api("inbox.py");
  expect(i).toContain("def verify_line_signature");
  expect(i).toContain("hmac.compare_digest");
  // 整形し直した本文で作ると必ず食い違う。生のバイト列を使うこと
  expect(i).toContain("受け取った生のバイト列をそのまま使うこと");

  const m = api("main.py");
  expect(m).toContain("signature mismatch");
  // 検証できない状態では受け付けない（誰でも書き込める口にしない）
  expect(m).toContain("LINE_CHANNEL_SECRET が未設定です");
});

test("受信口のURLは利用者ごとに違い、IDからは作れない", () => {
  const i = api("inbox.py");
  expect(i).toContain("def webhook_token");
  expect(i).toMatch(/hmac\.new\(secret\.encode\(\)/);
});

test("LINEの受信口URLを画面から取れる", () => {
  const panel = src("components/WatchPanel.tsx");
  expect(panel).toContain("LINE Developers の Webhook URL");
  expect(panel).toContain("{API_URL}{hook.path}");
});

/* ── Slack ──────────────────────────────────────────────────────── */
test("Slackは送信用Webhookでは読めないと書いてある", () => {
  const list = src("lib/extensions.ts");
  const s = list.slice(list.indexOf('id: "slack"'), list.indexOf('id: "discord"'));
  expect(s).toContain("Webhookは投稿専用です。読むには別途Botトークンが要ります。");
  expect(s).toContain("SLACK_BOT_TOKEN");
  // 既存の利用者が突然「未接続」にならないよう、読む側の鍵は任意
  expect(s).toMatch(/SLACK_BOT_TOKEN[^\n]*optional: true/);
});

test("LINEの受信用シークレットも任意にしてある", () => {
  const list = src("lib/extensions.ts");
  const l = list.slice(list.indexOf('id: "line"'), list.indexOf('id: "slack"'));
  expect(l).toMatch(/LINE_CHANNEL_SECRET[^\n]*optional: true/);
});

/* ── 会話から呼べること ─────────────────────────────────────────── */
test("エージェントが見張りの報告を呼べる", () => {
  const t = api("tools.py");
  expect(t).toContain('"watch_report": _do_watch_report');
  expect(t).toContain("読めなかった対象はその理由も返るので、そのまま伝えること");
});
