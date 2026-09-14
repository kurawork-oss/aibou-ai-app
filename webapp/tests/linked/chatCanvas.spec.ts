/**
 * ふだんの会話で何かを作ったとき、作った物がその場に出るか。
 *
 * なぜここが要るか
 * ----------------
 * 「作った物を隣に出す」仕組み（キャンバス）は、**実行（司令塔）モードに
 * しか繋がっていなかった**。既定の会話モードでも道具は動く——
 * 「タスクに追加して」「猫の絵を作って」は会話のまま実行される——のに、
 * 受け口が token / error / done しか無く、出来た物は捨てられていた。
 *
 * 捨てられた結果、画面に残るのは
 *
 *     「画像を生成しました：https://…（HOMEの『生成物』からも見られます）」
 *
 * だけ。作っておいて別の場所へ行かせるのは、渡していないのと同じ。
 * しかも黙って捨てるので、不具合として報告されない。
 *
 * ついでに、道具が動いている最中の無言も直す。画像生成は10秒かかることが
 * あり、その間ずっと「……」だと止まって見える。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enterApp } from "./backend";

const IMAGE = { kind: "image", url: "https://example.com/cat.png", title: "猫の絵" };

/** 会話の返事。道具を使い、物を作り、最後に報告する流れ。 */
function chatThatMakes(extra: Record<string, unknown>[] = []) {
  return {
    sse: [
      { tool: "generate_image" },
      { show: IMAGE },
      ...extra,
      { token: "猫の絵を作りました。" },
      { done: true },
    ],
  };
}

async function say(page: Page, text: string) {
  const ta = page.locator("textarea").first();
  await ta.fill(text);
  await page.keyboard.press("Enter");
}

test("会話で作った画像が、その場に出る", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/chat", () => chatThatMakes());
  await enterApp(page);
  await say(page, "猫の絵を作って");

  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await expect(canvas.getByRole("img", { name: "猫の絵" })).toBeVisible();
});

test("何をしているかが、返事より先に出る", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/chat", () => chatThatMakes());
  await enterApp(page);
  await say(page, "猫の絵を作って");

  // 実行モードと同じ言葉で出す（TOOL_LABELS の「画像を生成」）
  await expect(page.getByText("画像を生成")).toBeVisible({ timeout: 10_000 });
});

test("返事も、いつも通り出る（経過表示が本文を食わない）", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/chat", () => chatThatMakes());
  await enterApp(page);
  await say(page, "猫の絵を作って");
  await expect(page.getByText("猫の絵を作りました。")).toBeVisible({ timeout: 10_000 });
});

test("ふつうの会話では、キャンバスは出ない", async ({ page }) => {
  // 何にでも出すと、キャンバスが会話のログになって肝心の物が埋もれる。
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [{ token: "こんにちは。" }, { done: true }] }));
  await enterApp(page);
  await say(page, "やあ");
  await expect(page.getByText("こんにちは。")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel("作った物")).toHaveCount(0);
});

test("会話で作った物も、閉じて戻せる", async ({ page }) => {
  // かぶせる面で困るのは、閉じられないことと、閉じたら二度と出せないこと。
  const be = await mockBackend(page);
  be.set("/chat", () => chatThatMakes());
  await enterApp(page);
  await say(page, "猫の絵を作って");
  await expect(page.getByLabel("作った物")).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("キャンバスを閉じる").click();
  await expect(page.getByLabel("作った物")).toHaveCount(0);

  const back = page.getByRole("button", { name: /作った物 1/ });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.getByLabel("作った物")).toBeVisible();
});

test("戻る口が、会話／実行の切り替えを隠さない", async ({ page }) => {
  /* 出した物へ戻る浮きボタンは、下から74pxの決め打ちで置かれていた。
     スマホではそこがちょうど会話／実行の切り替えの高さで、
     「実行（司令塔）」が半分隠れていた（実機幅390pxで確認）。
     入力欄の高さは中身で変わるので、測った値の上に置く。 */
  const be = await mockBackend(page);
  be.set("/chat", () => chatThatMakes());
  await page.setViewportSize({ width: 390, height: 844 });
  await enterApp(page);
  await say(page, "猫の絵を作って");
  await expect(page.getByLabel("作った物")).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("キャンバスを閉じる").click();

  // 戻る口は出ている（この確認が空振りしていないこと）
  await expect(page.getByRole("button", { name: /作った物 1/ })).toBeVisible();

  /* 真ん中1点だけでは足りない。決め打ちの74pxで置いたとき、隠れていたのは
     「実行（司令塔）」の**右半分**で、真ん中は生きていた——それで最初、
     この確認は壊れた状態でも通ってしまった。面で見る。 */
  const hidden = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("button"))) {
      const label = (el.textContent || "").trim();
      if (!/会話|実行（司令塔）|履歴/.test(label)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      let dead = 0, total = 0;
      for (let fx = 0.1; fx <= 0.9; fx += 0.2) {
        for (let fy = 0.25; fy <= 0.75; fy += 0.25) {
          total++;
          const top = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) dead++;
        }
      }
      if (dead) {
        out.push(`「${label}」の ${Math.round((dead / total) * 100)}% が押せない`);
      }
    }
    return out;
  });
  expect(hidden, hidden.join("\n")).toEqual([]);
});

test("2つ作ったら、2つとも残る", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/chat", () => ({
    sse: [
      { tool: "web_search" },
      { show: { kind: "search", query: "猫", results: [
        { title: "ねこ大全", url: "https://example.com/neko", snippet: "猫の話" }] } },
      { tool: "generate_image" },
      { show: IMAGE },
      { token: "調べて、絵にしました。" },
      { done: true },
    ],
  }));
  await enterApp(page);
  await say(page, "猫を調べて絵にして");

  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  // 2つ以上あるときだけ出る切り替えが、ちゃんと2つぶん出ている
  await expect(canvas.getByRole("button", { name: /検索結果|猫/ }).first()).toBeVisible();
  await expect(canvas.getByRole("img", { name: "猫の絵" })).toBeVisible();
});
