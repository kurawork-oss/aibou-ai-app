/**
 * 会話の読みやすさ（ui-r123）。スマホで実際に使って見つかった3つ。
 *
 * ① コードを含む返事のあと、次の返事で画面全体が落ちていた
 *    （「Application error: a client-side exception has occurred」）。
 *    色つけの部品を useState にそのまま渡していて、React がそれを
 *    「初期値を作る関数」として呼んでしまっていた。一度コードを出した
 *    あとに開く吹き出しは、全部これで落ちる。スマホに限らない。
 *
 * ② 長いコードの行・表を含む返事で、吹き出しがその幅まで広がり、
 *    本文ごと画面の右に切れて読めなかった。
 *
 * ③ 2行以上を打って送ったあと、入力欄が伸びた高さのまま残っていた。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp, sseServer } from "./backend";

const CODE_ANSWER = [
  "## 並べ方",
  "",
  "まず結論です。**期限の近い順**に並べ、同じ日なら優先度で並べます。",
  "",
  "| 日 | やること | 所要 |",
  "|---|---|---|",
  "| 月 | 見積書を送る・返事を待つ | 30分 |",
  "| 水 | 資料の仕上げとレビュー依頼 | 2時間 |",
  "",
  "```python",
  "def schedule(tasks):  # とても長い行が、スマホの幅でどう見えるかを確かめるための行です",
  "    return sorted(tasks, key=lambda t: (t.due, t.priority))",
  "```",
].join("\n");

function tokens(text: string) {
  const out: { token: string }[] = [];
  for (let i = 0; i < text.length; i += 20) out.push({ token: text.slice(i, i + 20) });
  return out;
}

async function say(page: Page, text: string) {
  await page.locator("textarea").first().fill(text);
  await page.getByLabel("Send message").click();
}

test("コードを含む返事のあとに次の返事が来ても、画面が落ちない", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const be = await mockBackend(page);
  await enterApp(page);

  be.set("/chat", () => ({ sse: [...tokens(CODE_ANSWER), { done: true }] }));
  await say(page, "並べ方をコードで");
  // 色つけの部品が読み込まれて、コードに色が付くまで待つ（ここで部品が入る）
  await expect(page.locator(".md-codeblock code.hljs").first()).toBeAttached({ timeout: 15_000 });

  be.set("/chat", () => ({ sse: [{ token: "わかりました。続けます。" }, { done: true }] }));
  await say(page, "ありがとう");
  await expect(page.getByText("わかりました。続けます。")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Application error/)).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("長いコードや表を含む返事でも、本文がスマホの画面の右に切れない", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [...tokens(CODE_ANSWER), { done: true }] }));
  await enterApp(page);
  await say(page, "並べ方をコードで");
  const para = page.getByText(/まず結論です/).first();
  await expect(para).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);

  const m = await para.evaluate((p) => {
    const bubble = p.closest(".md")!.parentElement!.parentElement as HTMLElement;
    const pre = bubble.querySelector(".md-codeblock pre") as HTMLElement;
    const table = bubble.querySelector(".md-tablewrap") as HTMLElement;
    return {
      vw: window.innerWidth,
      paraRight: p.getBoundingClientRect().right,
      bubbleRight: bubble.getBoundingClientRect().right,
      preScrolls: pre.scrollWidth > pre.clientWidth,
      preRight: pre.getBoundingClientRect().right,
      tableRight: table.getBoundingClientRect().right,
    };
  });
  // 吹き出しも本文も、画面の中に収まっている
  expect(m.bubbleRight).toBeLessThanOrEqual(m.vw);
  expect(m.paraRight).toBeLessThanOrEqual(m.vw);
  // 長いコードは、コードの箱の中で横に送る（箱は画面の中）
  expect(m.preScrolls).toBe(true);
  expect(m.preRight).toBeLessThanOrEqual(m.vw);
  expect(m.tableRight).toBeLessThanOrEqual(m.vw);
});

test("長い URL を送っても、自分の吹き出しが画面からはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [{ token: "見ました。" }, { done: true }] }));
  await enterApp(page);
  const url = "https://example.com/very/long/path/that/does/not/break/nicely/on/narrow/screens?with=query";
  await say(page, url);
  const mine = page.getByText(url).first();
  await expect(mine).toBeVisible({ timeout: 10_000 });
  const right = await mine.evaluate((el) => el.getBoundingClientRect().right);
  expect(right).toBeLessThanOrEqual(375);
});

test("2行以上を打って送ったあと、入力欄は1行の高さに戻る", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [{ token: "はい。" }, { done: true }] }));
  await enterApp(page);
  const box = page.locator("textarea").first();
  const one = (await box.boundingBox())!.height;
  await box.fill("1行目の用件です。\n2行目の用件です。\n3行目の用件です。");
  expect((await box.boundingBox())!.height).toBeGreaterThan(one + 10);   // 伸びている
  await page.getByLabel("Send message").click();
  await expect(box).toHaveValue("");
  await expect.poll(async () => (await box.boundingBox())!.height).toBeLessThanOrEqual(one + 1);
});

/* ── 新しい中身を追いかけるか ──────────────────────────────────────
 * 以前は「中身が伸びた後の、底からの距離」で決めていた。それだと
 *   ・読み返していた人が送ると、送った物も確認の札も画面の外のまま
 *     （コアは WAITING なのに、何を待っているのか見えない）
 *   ・表やコードで一度に大きく伸びると、返事の途中で追いかけをやめる
 * になっていた。 */

/** 会話の欄（一番下まで送れる箱） */
function list(page: Page) {
  return page.locator('[aria-live="polite"]').first();
}

test("読み返していても、送ったら新しい物（確認の札）まで下がる", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const be = await mockBackend(page);
  await enterApp(page);
  be.set("/chat", () => ({ sse: [...tokens(CODE_ANSWER), { done: true }] }));
  await say(page, "並べ方をコードで");
  await expect(page.getByText(/まず結論です/).first()).toBeVisible({ timeout: 10_000 });

  // 指（ここではホイール）で上へ送って読み返す
  const box = (await list(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => list(page).evaluate((el) => el.scrollTop)).toBeLessThan(150);

  be.set("/chat", () => ({ sse: [
    { approval: {
      tool: "send_email", params: { to: "boss@example.com", subject: "報告" },
      note: "上司にメールを送ります", level: 3, level_label: "取り返せない",
      why: "送ったメールは取り消せません。", chained: false,
      may_always: false, always_confirm: true } },
    { done: true },
  ] }));
  await say(page, "上司に報告をメールして");
  const approve = page.getByRole("button", { name: "実行する" });
  await expect(approve).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => approve.evaluate((b) => {
    const box = b.closest('[aria-live="polite"]')!.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.bottom;      // 欄の見えている所にある
  })).toBe(true);
});

test("長い返事は、表やコードで大きく伸びても最後まで追いかける", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const be = await mockBackend(page);
  // 1回で大きく伸びる届き方（表とコードがまとめて来る）
  const big = CODE_ANSWER + "\n\n" + CODE_ANSWER.replace("## 並べ方", "## もう一度");
  be.set("/chat", () => ({ sse: [{ token: big.slice(0, 40) }, { token: big.slice(40) }, { token: "\n\n最後の行です。" }, { done: true }] }));
  await enterApp(page);
  await say(page, "長く説明して");
  await expect(page.getByText("最後の行です。")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => list(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(4);
});

test("上へ送って読み返している間は、返事が伸びても引き戻さない", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const be = await mockBackend(page);
  await enterApp(page);
  // 1つ目の長い返事（読み返す元）
  be.set("/chat", () => ({ sse: [...tokens(CODE_ANSWER), { done: true }] }));
  await say(page, "並べ方をコードで");
  await expect(page.getByText(/まず結論です/).first()).toBeVisible({ timeout: 10_000 });

  // 2つ目は、ゆっくり届く返事
  be.set("/chat", () => ({ passthrough: true }));
  const lines = Array.from({ length: 12 }, (_, i) => ({ after: 250, data: { token: `\n\n${i + 1}つ目の説明です。` } }));
  const server = await sseServer([{ after: 100, data: { token: "はい。" } }, ...lines, { after: 100, data: { done: true } }]);
  try {
    await say(page, "続けて");
    await expect(page.getByText("2つ目の説明です。")).toBeAttached({ timeout: 10_000 });
    // 届いている途中で、指で上へ送る（ブラウザが読んでいる所を保つために
    // 数十 px 動かすことがあるので、「上の方まで来た」で見る）
    const box = (await list(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -3000);
    await expect.poll(() => list(page).evaluate((el) => el.scrollTop)).toBeLessThan(150);
    // 残りが届き終わっても、読んでいる所に留まる（底へ引き戻されていない）。
    // ブラウザが読んでいる所を保つために数十 px 動かすことはあるので、
    // 「上の方にいる」かどうかで見る
    await expect(page.getByText("12つ目の説明です。")).toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const m = await list(page).evaluate((el) => ({
      top: el.scrollTop, fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight }));
    expect(m.top).toBeLessThan(150);
    expect(m.fromBottom).toBeGreaterThan(300);
  } finally {
    await server.close();
  }
});

test("前の返事の頭まで戻して読んでから送っても、確認の札まで下がる", async ({ page }) => {
  // 点検で実際に踏んだ手順。ブラウザの位置合わせ（スクロール・アンカー）の
  // scroll を「人が上へ送った」と数えて、札が画面の外に残っていた。
  await page.setViewportSize({ width: 375, height: 667 });
  const be = await mockBackend(page);
  await enterApp(page);
  be.set("/chat", () => ({ sse: [...tokens(CODE_ANSWER + "\n\n参考: https://example.com/a/very/long/path/for/checking"), { done: true }] }));
  await say(page, "並べ方をコードで");
  await expect(page.getByText(/まず結論です/).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText(/まず結論です/).first().scrollIntoViewIfNeeded();

  be.set("/chat", () => ({ sse: [
    { approval: {
      tool: "send_email",
      params: { to: "boss@example.com", subject: "今週の報告", body: "見積書を送りました。資料は水曜に仕上がります。" },
      note: "上司にメールを送ります", level: 3, level_label: "取り返せない",
      why: "送ったメールは取り消せません。", chained: false,
      may_always: false, always_confirm: true } },
    { done: true },
  ] }));
  await say(page, "上司に今週の報告をメールして");
  const approve = page.getByRole("button", { name: "実行する" });
  await expect(approve).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => list(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(4);
});
