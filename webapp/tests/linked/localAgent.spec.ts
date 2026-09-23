/**
 * 手元のパソコンを繋ぐ画面（仕様§29〜§31）。
 *
 * ここで守りたいこと
 * ------------------
 * 合言葉は**1回しか見せられない**（サーバーには照合用の形しか無い）。
 * 「あとで見られます」と読める作りにしてはいけない。
 *
 * そして「合言葉を作った」と「いま動いている」は別のこと。作っただけで
 * 「繋がりました」と出すと、頼んだあとで無言のまま返事が来なくなり、
 * どこが悪いのか分からなくなる。
 *
 * 何台でも繋げる
 * --------------
 * ノートPCとデスクトップを両方繋いだままにしたい（スマホには要らない）。
 * 2台以上あるときは、**どちらに頼んだのか分かる**ことが要る。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, type Backend } from "./backend";

async function openConnect(page: Page) {
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "つなぐ", exact: true }).click();
  await expect(page.getByText("手元のパソコン")).toBeVisible({ timeout: 10_000 });
}

/** 台の一覧をこう返す、という土台。 */
function withDevices(be: Backend, devices: unknown[], over: Record<string, unknown> = {}) {
  const live = (devices as { online: boolean }[]).some((d) => d.online);
  be.set("/local/status", () => ({ json: {
    ok: true, paired: devices.length > 0, online: live, devices, ...over } }));
}

test("繋いでいないときは、未接続だと言う", async ({ page }) => {
  const be = await mockBackend(page);
  withDevices(be, [], { why: "まだ1台も繋いでいません", next: "合言葉を作ります" });
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("未接続", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "合言葉を作る" })).toBeVisible();
});

test("合言葉は1回しか見せないと、その場に書いてある", async ({ page }) => {
  const be = await mockBackend(page);
  withDevices(be, []);
  be.set("/local/pair", () => ({ json: {
    ok: true, token: "test-token-abcdef123456", name: "しごとのノート" } }));
  await enterApp(page);
  await openConnect(page);
  await page.getByRole("button", { name: "合言葉を作る" }).click();
  await page.getByLabel("この台の名前").fill("しごとのノート");
  await page.getByRole("button", { name: "合言葉を作る" }).click();

  await expect(page.getByText("test-token-abcdef123456")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("二度と見られません")).toBeVisible();
  // どの台の合言葉なのかが分かる
  await expect(page.getByText(/「しごとのノート」の合言葉/)).toBeVisible();
  // 動かし方も、その場に出す（別のページを探させない）
  await expect(page.getByText(/aibou_local\.py/)).toBeVisible();
});

test("合言葉を作っただけでは「繋がっています」と言わない", async ({ page }) => {
  /* 作っただけで繋がった顔をすると、頼んだあとで無言になる。 */
  const be = await mockBackend(page);
  withDevices(be, [
    { device: "d1", name: "ノート", online: false, last_seen_ago: null },
  ], { why: "合言葉は作ってありますが、手元の相棒が動いていません",
       next: "パソコンで `python aibou_local.py` を動かしてください" });
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("動いていません").first()).toBeVisible();
  await expect(page.getByText(/まだ一度も動いていません/)).toBeVisible();
  await expect(page.getByText(/^\d+台が動いています$/)).toHaveCount(0);
  await expect(page.getByText(/aibou_local\.py.* を動かして/)).toBeVisible();
});

test("動いていれば、何台動いているかを出す", async ({ page }) => {
  const be = await mockBackend(page);
  withDevices(be, [
    { device: "d1", name: "しごとのノート", online: true, last_seen_ago: 2 },
  ]);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("1台が動いています")).toBeVisible();
  await expect(page.getByText("しごとのノート")).toBeVisible();
});

test("2台目を足す口がある（1台目を切らずに）", async ({ page }) => {
  /* ここが無いと、デスクトップを繋ぐためにノートを切ることになる。 */
  const be = await mockBackend(page);
  withDevices(be, [
    { device: "d1", name: "ノート", online: true, last_seen_ago: 1 },
  ]);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByRole("button", { name: "もう1台つなぐ" })).toBeVisible();
  // 「切る」は台ごとに出る（全部まとめて切るボタンにしない）
  await expect(page.getByRole("button", { name: "ノート の繋ぎを切る" })).toBeVisible();
});

test("2台動いているときは、頼み方が変わると先に言う", async ({ page }) => {
  /* 黙って選ぶと「ノートを読んだつもりがデスクトップだった」が起きる。
     聞き返す作りにしてあるので、そのことを先に出しておく。 */
  const be = await mockBackend(page);
  withDevices(be, [
    { device: "d1", name: "ノート", online: true, last_seen_ago: 1 },
    { device: "d2", name: "デスクトップ", online: true, last_seen_ago: 3 },
  ]);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("2台が動いています")).toBeVisible();
  await expect(page.getByText(/どちらに頼むかは名前で言ってください/)).toBeVisible();
  await expect(page.getByText(/勝手に選ばずに聞き返します/)).toBeVisible();
});

test("1台のときは、その注意を出さない", async ({ page }) => {
  // 要らない注意を足すと、読むものが増えるだけ
  const be = await mockBackend(page);
  withDevices(be, [
    { device: "d1", name: "ノート", online: true, last_seen_ago: 1 },
  ]);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText(/どちらに頼むかは名前で/)).toHaveCount(0);
});

test("台には名前を付けられる", async ({ page }) => {
  const be = await mockBackend(page);
  withDevices(be, [
    { device: "d1", name: "パソコン", online: true, last_seen_ago: 1 },
  ]);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByRole("button", { name: "パソコン の名前を変える" })).toBeVisible();
});

test("触ってよい場所を決めるのは手元だと、書いてある", async ({ page }) => {
  /* ここを読み違えると、「サーバーから何でも読まれる」と思われる。
     逆に「サーバーが決められる」と思われるのも困る。 */
  const be = await mockBackend(page);
  withDevices(be, []);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText(/サーバーからは指定できません/)).toBeVisible();
  await expect(page.getByText(/消す操作とコマンド実行は/)).toBeVisible();
});

test("スマホには要らないと書いてある", async ({ page }) => {
  /* 3台ぶん入れようとして、スマホで詰まる人が出る。 */
  const be = await mockBackend(page);
  withDevices(be, []);
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText(/スマホには要りません/)).toBeVisible();
});

test("状態が取れなくても、「繋がっている」とは言わない", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/local/status", () => ({ status: 503, json: { error: "down" } }));
  await enterApp(page);
  await openConnect(page);
  await expect(page.getByText("状態を取得できませんでした").first())
    .toBeVisible({ timeout: 10_000 });
});

test("ログインが要るサイトの話が、条件と一緒に出る", async ({ page }) => {
  /* ここを書かないと、いちばん価値のある使い方に気づかれない。
     同時にいちばん危ない使い方でもあるので、条件を離さずに出す。 */
  const be = await mockBackend(page);
  withDevices(be, [
    { device: "d1", name: "ノート", online: true, last_seen_ago: 1 },
  ]);
  await enterApp(page);
  await openConnect(page);

  await page.getByText("ログインが要るサイトも見せる").click();
  await expect(page.getByText(/誰にもログインしていません/)).toBeVisible();
  await expect(page.getByText(/開いてよいサイトを先に決めます/)).toBeVisible();
  await expect(page.getByText(/押すほうは設定に関わらず必ず確認します/)).toBeVisible();
  // パスワードを渡す話にしない
  await expect(page.getByText(/パスワードをAIbouに渡すことはありません/)).toBeVisible();
});
