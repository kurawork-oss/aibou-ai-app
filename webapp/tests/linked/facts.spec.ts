/**
 * 会話から事実を取り出して覚えるか（webapp/src/lib/facts.ts）。
 *
 * ここで本当に見たいこと
 * ----------------------
 * これまで記憶に入っていたのは、本人の発言を**形で**選り分けた物だけ
 * だった。問いかけと指示は落とす決まりなので、
 *
 *     「今度の沖縄、3泊で考えてるんだけどおすすめある？」
 *
 * のように**問いの形をした事実**は1件も残らなかった。
 *
 * そして、直し方を間違えるともっと悪くなる。返事の**前**に1往復足すと、
 * そのぶんまるごと「返事が始まるまでの待ち時間」になる。何度も削ってきた
 * 所なので、ここは順番そのものを見張る。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, type Backend } from "./backend";

/** 会話を1往復させる。SSEは即返る（時間は別のテストで見る）。 */
async function say(page: Page, text: string) {
  await page.locator("textarea").first().fill(text);
  await page.keyboard.press("Enter");
}

function withChat(be: Backend, reply = "いいですね。") {
  be.set("/chat", () => ({ sse: [{ token: reply }, { done: true }] }));
}

test("問いの形をした事実が、記憶に残る", async ({ page }) => {
  const be = await mockBackend(page);
  withChat(be);
  be.set("/memory/extract", (call) => {
    const body = call.body as { turns?: { role: string; content: string }[] };
    // 会話がちゃんと届いているか（ここが空だと、何も取れなくて当然）
    const said = (body.turns || []).filter((t) => t.role === "user")
      .map((t) => t.content).join("");
    return { json: { ok: true, facts: said.includes("沖縄")
      ? [{ text: "2026年10月に沖縄へ3泊で行く予定がある", importance: 0 }]
      : [] } };
  });

  await enterApp(page);
  await say(page, "今度の沖縄、3泊で考えてるんだけどおすすめある？ここ数年ずっと行きたかった場所なんだよね。子どもがまだ小さいから、あまり移動の多くない過ごし方がいいと思ってる。");

  await expect.poll(() => be.count("/memory/extract"), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // 記憶の画面に出ること。出ないなら「覚えた」と言っているだけ。
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "記憶", exact: true }).click();
  await expect(page.getByText("2026年10月に沖縄へ3泊で行く予定がある"))
    .toBeVisible({ timeout: 10_000 });
});

test("取り出した記憶には、AIが起こした物だと印が付く", async ({ page }) => {
  /* 本人が言っていない文が記憶に増える。どこから来たかが分からないと、
     「こんなこと言ってない」を確かめる手立てが無い。 */
  const be = await mockBackend(page);
  withChat(be);
  be.set("/memory/extract", () => ({ json: { ok: true,
    facts: [{ text: "犬を飼っている", importance: 0 }] } }));

  await enterApp(page);
  await say(page, "うちの犬がさ、最近よく吠えるんだよね。散歩の時間を朝から夜に変えたせいかな。もう8歳だし、耳が遠くなってきたのもあるのかも。どうしたらいい？");
  await expect.poll(() => be.count("/memory/extract"), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "記憶", exact: true }).click();
  const row = page.locator("div").filter({ hasText: /^犬を飼っている$/ }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  // 同じ枠の中に「· AI」が出ている
  await expect(page.getByText("· AI").first()).toBeVisible();
});

test("記憶を取りに行くのは、返事が終わったあと", async ({ page }) => {
  /* ここが逆だと、会話のたびに1往復ぶん待たされる。返事が始まるまでの
     時間は、この画面でいちばん効く数字なので、順番を固定する。 */
  const be = await mockBackend(page);
  const order: string[] = [];
  be.set("/chat", () => { order.push("chat"); return { sse: [{ token: "はい" }, { done: true }] }; });
  be.set("/memory/extract", () => { order.push("extract"); return { json: { ok: true, facts: [] } }; });

  await enterApp(page);
  await say(page, "来月から新しい会社で働くことになったよ。エンジニアのチームに入る予定で、いまの会社は今月いっぱい。通勤が片道1時間から20分になるのが一番うれしい。");
  await expect.poll(() => order.includes("extract"), { timeout: 15_000 }).toBe(true);
  expect(order.indexOf("chat")).toBeLessThan(order.indexOf("extract"));
});

test("相づちだけの短い往復では、取りに行かない", async ({ page }) => {
  /* 1発言ごとに呼ぶと、往復の数＝発言の数になる。「うん」からは何も
     取れないので、呼ぶだけ無駄で費用だけかかる。 */
  const be = await mockBackend(page);
  withChat(be, "はい");
  be.set("/memory/extract", () => ({ json: { ok: true, facts: [] } }));

  await enterApp(page);
  await say(page, "うん");
  await page.waitForTimeout(3_000);
  expect(be.count("/memory/extract")).toBe(0);
});

test("切っておくと、会話は送られない", async ({ page }) => {
  const be = await mockBackend(page);
  withChat(be);
  be.set("/memory/extract", () => ({ json: { ok: true, facts: [] } }));

  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "記憶", exact: true }).click();
  const toggle = page.getByRole("checkbox").first();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.getByLabel("Close settings").click({ position: { x: 8, y: 8 } });

  await say(page, "来月から新しい会社で働くことになったよ。エンジニアのチームに入る予定だし、引っ越しもある。通勤が片道1時間から20分になるのが一番うれしいところ。");
  await page.waitForTimeout(3_000);
  expect(be.count("/memory/extract")).toBe(0);
});

test("溜めている途中で閉じても、次に開いたときに拾う", async ({ page }) => {
  /* 「だまってから取りに行く」ので、その手前で閉じられることがある。
     溜めたぶんがメモリにしか無いと、そこで消える——しかも本人からは
     「一言も覚えていない」ようにしか見えない。 */
  const be = await mockBackend(page);
  withChat(be, "はい");
  be.set("/memory/extract", () => ({ json: { ok: true,
    facts: [{ text: "犬を飼っている", importance: 0 }] } }));

  await enterApp(page);
  await say(page, "うちの犬ね");                 // 短い＝すぐには取りに行かない
  await expect(page.getByText("はい").first()).toBeVisible({ timeout: 10_000 });
  expect(be.count("/memory/extract")).toBe(0);

  // だまっている途中で読み込み直す（タブを閉じたのと同じ）
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("textarea").first().waitFor({ timeout: 20_000 });
  await expect.poll(() => be.count("/memory/extract"), { timeout: 15_000 })
    .toBeGreaterThan(0);
});

test("取りに行けなくても、会話は何も変わらない", async ({ page }) => {
  const be = await mockBackend(page);
  withChat(be, "おめでとうございます。");
  be.set("/memory/extract", () => ({ status: 500, json: { error: "down" } }));

  await enterApp(page);
  await say(page, "来月から新しい会社で働くことになったよ。エンジニアのチームに入る予定で、いまの会社は今月いっぱい。通勤が片道1時間から20分になるのが一番うれしい。");
  await expect(page.getByText("おめでとうございます。")).toBeVisible({ timeout: 10_000 });
  // 画面に断り書きが出ていないこと（頼んでいない処理の失敗を報せない）
  await expect(page.getByText(/記憶.*失敗|覚えられませんでした/)).toHaveCount(0);
});
