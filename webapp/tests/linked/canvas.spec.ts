/**
 * 作った物が、会話の隣に出ることの検証。
 *
 * ここまで道具は全部「文字列」を返していた。だから
 *
 *   「画像を生成しました：https://…（HOMEの『生成物』からも見られます）」
 *
 * としか言えず、頼んだ人は別の画面へ見に行くことになっていた。
 * 作っておいて住所を渡すのは、渡していないのと同じ。
 *
 * 見るのは「出るか」だけでなく **「閉じられるか」「戻れるか」**。
 * かぶせる面はそこが崩れると、閉じ込められた画面になる。
 */

import { test, expect, type Page } from "@playwright/test";
import { enterApp, mockBackend } from "./backend";

/** #画像 を実行して、キャンバスを出す。 */
async function makeImage(page: Page) {
  const ta = page.locator("textarea").first();
  await ta.fill("#画像 猫の絵");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("作った物")).toBeVisible({ timeout: 10_000 });
}

/** 画像を1枚作る道具として /command を答えさせる。 */
function withImage(be: Awaited<ReturnType<typeof mockBackend>>) {
  be.set("/command", () => ({ json: {
    ok: true, kind: "done", tool: "generate_image", result: "画像を生成しました",
    show: [{ kind: "image", url: "https://example.com/cat.png", title: "猫の絵" }],
  } }));
}

test("作った画像が、その場に出る", async ({ page }) => {
  const be = await mockBackend(page);
  withImage(be);
  await enterApp(page);
  await makeImage(page);

  const canvas = page.getByLabel("作った物");
  await expect(canvas.getByRole("img", { name: "猫の絵" })).toBeVisible();
  await expect(canvas.getByText("画像", { exact: true })).toBeVisible();
});

test("閉じられるし、閉じたあとも戻れる", async ({ page }) => {
  // かぶせる面でいちばん困るのは、閉じられないことと、閉じたら
  // 二度と出せないこと。どちらも「閉じ込められた」と感じさせる。
  const be = await mockBackend(page);
  withImage(be);
  await enterApp(page);
  await makeImage(page);

  await page.getByLabel("キャンバスを閉じる").click();
  await expect(page.getByLabel("作った物")).toHaveCount(0);

  // 戻る口が出ている
  const back = page.getByRole("button", { name: /作った物 1/ });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.getByLabel("作った物")).toBeVisible();
});

test("Escでも閉じられる", async ({ page }) => {
  const be = await mockBackend(page);
  withImage(be);
  await enterApp(page);
  await makeImage(page);
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("作った物")).toHaveCount(0);
});

test("会話は後ろに残っている（置き換えない）", async ({ page }) => {
  // キャンバスが会話を消してしまうと、続きが頼めなくなる。
  const be = await mockBackend(page);
  withImage(be);
  await enterApp(page);
  await makeImage(page);
  await expect(page.getByText("画像を生成しました")).toBeVisible();
  await expect(page.locator("textarea").first()).toBeVisible();
});

test("検索結果は、押せるリンクで出る", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/command", () => ({ json: {
    ok: true, kind: "done", tool: "web_search", result: "検索しました",
    show: [{
      kind: "search", query: "紅茶", title: "「紅茶」の検索結果",
      results: [
        { title: "紅茶の入れ方", url: "https://example.com/tea", snippet: "お湯の温度が…" },
        { title: "茶葉の種類", url: "https://other.example.org/leaf", snippet: "産地ごとに…" },
      ],
    }],
  } }));
  await enterApp(page);
  const ta = page.locator("textarea").first();
  await ta.fill("#検索 紅茶");
  await page.keyboard.press("Enter");

  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const link = canvas.getByRole("link", { name: /紅茶の入れ方/ });
  await expect(link).toHaveAttribute("href", "https://example.com/tea");
  // 出どころが読める（長いURLをそのまま出しても、どこの物か分からない）
  await expect(canvas.getByText("example.com")).toBeVisible();
  // 新しいタブで開き、元のタブは渡さない
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test("表はそのまま読める形で出る", async ({ page }) => {
  const be = await mockBackend(page);
  be.set("/command", () => ({ json: {
    ok: true, kind: "done", tool: "create_spreadsheet", result: "作りました",
    show: [{ kind: "table", title: "家計", artifact_id: "a1",
             content: "項目,金額\n家賃,80000\n光熱費,12000" }],
  } }));
  await enterApp(page);
  await page.locator("textarea").first().fill("#表 家計");
  await page.keyboard.press("Enter");

  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await expect(canvas.getByRole("columnheader", { name: "項目" })).toBeVisible();
  await expect(canvas.getByRole("cell", { name: "80000" })).toBeVisible();
});

test("2つ以上作ったら、行き来できる", async ({ page }) => {
  const be = await mockBackend(page);
  let n = 0;
  be.set("/command", () => {
    n += 1;
    return { json: {
      ok: true, kind: "done", tool: "generate_image", result: "作りました",
      show: [{ kind: "image", url: `https://example.com/${n}.png`, title: `${n}枚目` }],
    } };
  });
  await enterApp(page);
  const ta = page.locator("textarea").first();
  for (const q of ["#画像 いぬ", "#画像 ねこ"]) {
    await ta.fill(q);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  }
  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible();
  // 最新が出ている
  await expect(canvas.getByRole("img", { name: "2枚目" })).toBeVisible();
  // 前の物にも戻れる
  await canvas.getByRole("button", { name: /1枚目/ }).click();
  await expect(canvas.getByRole("img", { name: "1枚目" })).toBeVisible();
});

test("閉じても残ることを、閉じる前に言う", async ({ page }) => {
  // 「閉じたら消えるかも」と思わせると、人は閉じられなくなる。
  const be = await mockBackend(page);
  withImage(be);
  await enterApp(page);
  await makeImage(page);
  await expect(page.getByText(/管理 → ファイル.*に残ります/)).toBeVisible();
});

test("図が実際に描かれる（記法のままにしない）", async ({ page }) => {
  // AIが「これは図のほうが早い」と判断したとき、mermaid の記法が
  // そのまま出ると、読める人にしか伝わらない。
  const be = await mockBackend(page);
  be.set("/command", () => ({ json: {
    ok: true, kind: "done", tool: "draw_diagram", result: "図を描きました",
    show: [{ kind: "diagram", title: "頼んでから届くまで",
             source: "flowchart TD\n  A[話しかける] --> B[道具を選ぶ]\n  B --> C[実行]" }],
  } }));
  await enterApp(page);
  await page.locator("textarea").first().fill("#図解 流れ");
  await page.keyboard.press("Enter");

  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  // 図として描かれている（mermaid は動的に読み込むので少し待つ）
  await expect(canvas.locator("svg").first()).toBeVisible({ timeout: 15_000 });
  await expect(canvas.getByText("話しかける")).toBeVisible();
  // 記法がそのまま残っていない
  await expect(canvas.getByText("flowchart TD")).toHaveCount(0);
});

test("描けない図は、書いた物をそのまま見せる", async ({ page }) => {
  // 黙って消すと「AIが何か言おうとしたが出なかった」だけが残る。
  const be = await mockBackend(page);
  be.set("/command", () => ({ json: {
    ok: true, kind: "done", tool: "draw_diagram", result: "図を描きました",
    show: [{ kind: "diagram", title: "こわれた図", source: "flowchart TD\n  A[[[[" }],
  } }));
  await enterApp(page);
  await page.locator("textarea").first().fill("#図解 x");
  await page.keyboard.press("Enter");

  const canvas = page.getByLabel("作った物");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await expect(canvas.getByText(/図を描けませんでした/)).toBeVisible({ timeout: 15_000 });
  // 書いた物そのものが残っている（理由の文にも同じ字が出るので、
  // 元を出している場所を名指しで見る）
  await expect(canvas.locator("pre")).toContainText("flowchart TD");
  await expect(canvas.locator("pre")).toContainText("A[[[[");
});

test("作っていないうちは、何も出さない", async ({ page }) => {
  await mockBackend(page);
  await enterApp(page);
  await page.waitForTimeout(800);
  await expect(page.getByLabel("作った物")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /作った物/ })).toHaveCount(0);
});
