/**
 * スマホで「使いづらい」と言われた所の見張り（ui-r122）。
 *
 * 実機の大きさで測ったら、こうなっていた:
 *   ・上の飾り（状態の列＋108pxのコア＋名前）だけで縦の25〜37%
 *     （iPhone SE で 245px / 667px）。タスクの一覧が1画面目に入らない
 *   ・入力欄が全部 14px。iPhone は 16px 未満の欄を触ると拡大して戻さない
 *   ・会話の入力欄の横にボタンが4つ並び、打つ所が 150px ほど
 *   ・Enter で送るので、画面のキーボードでは2行以上を書けない
 *   ・机用の案内（ENTERで送信・Ctrl+V）がスマホにも出ている
 *   ・iPhone SE では「もっと」の最後（説明書）が下のナビの裏に入って押せない
 * 直した所が戻らないように、数字で押さえる。
 */

import { test, expect, type Page } from "@playwright/test";
import { goScreen, waitForHud } from "./nav";

const SE = { width: 375, height: 667 };      // iPhone SE（いちばん縦が短い）
const PRO = { width: 390, height: 844 };     // iPhone 14 Pro
const DESK = { width: 1280, height: 800 };

async function enterApp(page: Page) {
  await page.goto("/");
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hud = page.getByRole("heading", { name: /THE FORGE OS/ }).first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await waitForHud(page);
}

/** 画面の中身が始まる高さ（上の飾りの下端） */
function contentTop(page: Page) {
  return page.locator("main > section").evaluate((el) => el.getBoundingClientRect().top);
}

for (const vp of [SE, PRO]) {
  test(`上の飾りは1列にまとまり、縦の1割ほどで収まる（${vp.width}x${vp.height}）`, async ({ page }) => {
    await page.setViewportSize(vp);
    await enterApp(page);
    const top = await contentTop(page);
    // 以前は 212〜256px。いまは 70px ほど。少し余裕を見て 100px まで
    expect(top).toBeLessThanOrEqual(100);
    // 名前は1行（「THE FORGE OS」まで並べると3段に折れていた）。
    // 読み上げの名前にはシステム名を残す
    const h1 = page.getByRole("heading", { name: /THE FORGE OS/ }).first();
    await expect(h1).toHaveText("AIbou");
    const box = await h1.boundingBox();
    expect(box!.height).toBeLessThan(30);
    // 繋がっているか・いま何をしているかは、名前の下に出ている（このビルドは繋がっていない）。
    // 切れずに最後まで見えている
    const status = page.getByText(/^OFFLINE( · [A-Z]+)?$/);
    await expect(status).toBeVisible();
    expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
}

test("広い画面では、大きいコアと名前の飾りがそのまま出る", async ({ page }) => {
  await page.setViewportSize(DESK);
  await enterApp(page);
  await expect(page.getByText("THE FORGE OS", { exact: true }).first()).toBeVisible();
  expect(await contentTop(page)).toBeGreaterThan(150);
});

test("スマホの入力欄は、どの画面でも 16px 以上（触っても拡大しない）", async ({ page }) => {
  await page.setViewportSize(PRO);
  await enterApp(page);
  const bad: string[] = [];
  for (const s of ["CHAT", "HOME", "TASKS", "BOARD", "VAULT", "ME", "CODE", "STUDIO", "SNS", "AUTO"]) {
    await goScreen(page, s);
    await page.waitForTimeout(300);
    const small = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("input, textarea, select").forEach((el) => {
        const e = el as HTMLInputElement;
        if (["checkbox", "radio", "range", "color", "file", "hidden"].includes(e.type)) return;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const size = parseFloat(getComputedStyle(e).fontSize);
        if (size < 16) out.push(`${e.tagName.toLowerCase()}「${e.placeholder || e.getAttribute("aria-label") || ""}」${size}px`);
      });
      return out;
    });
    for (const line of small) bad.push(`${s}: ${line}`);
  }
  // 設定（別の面）も
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible();
  const inSettings = await page.evaluate(() =>
    [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), textarea, select")]
      .filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0)
      .map((e) => parseFloat(getComputedStyle(e).fontSize))
      .filter((n) => n < 16));
  for (const n of inSettings) bad.push(`SETTINGS: ${n}px`);
  expect(bad, `16px 未満の入力欄:\n${bad.join("\n")}`).toEqual([]);
});

test("iPhone SE でも、「もっと」の最後（説明書）まで押せる", async ({ page }) => {
  await page.setViewportSize(SE);
  await enterApp(page);
  await page.getByLabel("Mobile navigation").getByText("管理", { exact: true }).click();
  await page.getByRole("button", { name: /もっと/ }).click();
  // 下のナビの裏に入っていると、ここでナビが押されて止まる
  await page.getByRole("button", { name: /^説明書/ }).click({ timeout: 5_000 });
  await expect(page.getByRole("heading", { name: /の説明書/ })).toBeVisible({ timeout: 5_000 });
});

test("スマホの会話欄: 打ち始めたら声のボタンを引っこめて、打つ所を広げる", async ({ page }) => {
  await page.setViewportSize(SE);
  await enterApp(page);
  const box = page.locator("textarea").first();
  // 何も無いときは、話して始められる（声の2つ）。送るボタンはまだ要らない
  await expect(page.getByLabel("Start voice input")).toBeVisible();
  await expect(page.getByLabel("会話モード")).toBeVisible();
  await expect(page.getByLabel("Send message")).toHaveCount(0);
  const before = (await box.boundingBox())!.width;

  await box.fill("明日の予定を教えて");
  await expect(page.getByLabel("Send message")).toBeVisible();
  await expect(page.getByLabel("Start voice input")).toHaveCount(0);
  await expect(page.getByLabel("会話モード")).toHaveCount(0);
  const after = (await box.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 30);
  expect(after).toBeGreaterThanOrEqual(220);

  // 消せば、声のボタンが戻る
  await box.fill("");
  await expect(page.getByLabel("Start voice input")).toBeVisible();
});

test("スマホでは、机用の案内（ENTERで送信・Ctrl+V）を出さない。広い画面では出す", async ({ page }) => {
  await page.setViewportSize(PRO);
  await enterApp(page);
  await expect(page.locator("textarea").first()).toBeVisible();
  await expect(page.getByText(/ENTERで送信/)).toHaveCount(0);
  // 案内の文字も短く（長いと2行目に折れて切れていた）
  await expect(page.getByPlaceholder("メッセージ…", { exact: true })).toBeVisible();

  await page.setViewportSize(DESK);
  await expect(page.getByText(/ENTERで送信/)).toBeVisible();
  await expect(page.getByPlaceholder("AIbou にメッセージ…", { exact: true })).toBeVisible();
});

test("Safari の「変換を確定する Enter」（keyCode 229）では送らない", async ({ page }) => {
  await page.setViewportSize(PRO);
  await enterApp(page);
  const box = page.locator("textarea").first();
  await box.fill("へんかんちゅう");
  // Safari は確定の Enter を isComposing=false・keyCode 229 で送ってくる
  await box.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 229, bubbles: true, cancelable: true,
    }));
  });
  await page.waitForTimeout(300);
  await expect(box).toHaveValue("へんかんちゅう");          // 送られて空になっていない
  // ふつうの Enter は送る（机の端末）
  await box.press("Enter");
  await expect(box).toHaveValue("");
});

test.describe("指で打つ端末", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PRO });

  test("Enter は改行になり、送らない（送るのは ➤）", async ({ page }) => {
    await enterApp(page);
    const touch = await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches);
    test.skip(!touch, "このブラウザは指の端末として振る舞わない");
    const box = page.locator("textarea").first();
    await box.fill("1行目");
    await box.press("Enter");
    await box.pressSequentially("2行目");
    await expect(box).toHaveValue("1行目\n2行目");
    await page.getByLabel("Send message").tap();
    await expect(box).toHaveValue("");
  });
});

test.describe("指で打つ端末（横向き）", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });

  test("横にして幅が広くなっても、入力欄は 16px 以上（拡大しない）", async ({ page }) => {
    await enterApp(page);
    const touch = await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches);
    test.skip(!touch, "このブラウザは指の端末として振る舞わない");
    const size = await page.locator("textarea").first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  });
});

test("スマホのタスク: 追加の欄はタイトルと「追加」だけ。打ち始めたら詳細が出る", async ({ page }) => {
  await page.setViewportSize(SE);
  await enterApp(page);
  await goScreen(page, "TASKS");
  const title = page.getByPlaceholder("タスクのタイトル…");
  await expect(title).toBeVisible({ timeout: 5_000 });
  await expect(page.getByPlaceholder("詳細（任意）…")).toHaveCount(0);
  await expect(page.getByLabel("期限")).toHaveCount(0);

  // 「追加」はタイトルの横（下の欄を閉じていても押せる）
  const add = page.getByRole("button", { name: "+ ADD TASK" });
  const [t, a] = [(await title.boundingBox())!, (await add.boundingBox())!];
  expect(Math.abs(t.y + t.height / 2 - (a.y + a.height / 2))).toBeLessThan(4);
  expect(a.x).toBeGreaterThan(t.x + t.width - 1);

  await title.fill("牛乳を買う");
  await expect(page.getByPlaceholder("詳細（任意）…")).toBeVisible();
  await expect(page.getByLabel("期限")).toBeVisible();
  // 期限とプロジェクトが切れずに読める幅（3つを1段に詰めると「mm/dd,」で切れていた）
  expect((await page.getByLabel("期限").boundingBox())!.width).toBeGreaterThanOrEqual(150);
  expect((await page.getByLabel("プロジェクト").boundingBox())!.width).toBeGreaterThanOrEqual(250);

  // 数字の4つは1段（2段だと縦 130px を使っていた）
  const ys = await page.locator(".panel", { hasText: /^\d+\s*(PENDING|ACTIVE|AWAITING|DONE)$/ })
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(ys).toHaveLength(4);
  expect(new Set(ys).size).toBe(1);
});

/* 管理タブのどの画面も、中身が上の切り替え（今日・ボード…・もっと）の上に
   はみ出していないこと。
   コード画面の開始画面は、高さいっぱいの箱で中央寄せにしていたので、中身が
   高いスマホでは上下へ同じだけはみ出した。上に出た分は切り替えと案内に
   重なり、スクロールしても戻ってこなかった（iPhone で説明文が被って読めない）。 */
for (const vp of [SE, PRO]) {
  test(`管理タブの画面の中身が、切り替えの上にはみ出さない（${vp.width}x${vp.height}）`, async ({ page }) => {
    await page.setViewportSize(vp);
    await enterApp(page);
    const bad: string[] = [];
    for (const s of ["HOME", "TASKS", "BOARD", "ARCHIVE", "STUDIO", "CODE", "SNS", "CAPTURE",
      "VAULT", "ME", "AUTO", "EXTEND", "GUIDE"]) {
      await goScreen(page, s);
      await expect(page.getByRole("button", { name: /▲ もっと/ })).toHaveCount(0);
      await page.waitForTimeout(500);   // 開くときの動き（奥から出てくる）が収まるまで
      const over = await page.evaluate(() => {
        const more = [...document.querySelectorAll("button")]
          .find((b) => /もっと/.test(b.textContent || ""));
        const section = document.querySelector("main > section");
        if (!more || !section) return ["切り替えが見つからない"];
        const bar = more.parentElement!.parentElement!;       // ManageBar の外枠
        const barBottom = bar.getBoundingClientRect().bottom;
        const out: string[] = [];
        for (const el of Array.from(section.querySelectorAll("*"))) {
          if (bar.contains(el) || el.children.length) continue;
          // 切り替えより前に並ぶ物（「設定すると使えます」の案内）は、上にあって正しい
          if (bar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) continue;
          const text = (el.textContent || "").trim();
          if (!text) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          let skip = false;
          for (let n: Element | null = el; n && n !== section; n = n.parentElement) {
            const st = getComputedStyle(n);
            if (st.position === "fixed") { skip = true; break; }      // 被せ面は別の話
            if (n !== el && /auto|scroll|hidden/.test(st.overflowY)) {
              const b = n.getBoundingClientRect();
              if (r.top < b.top - 1) { skip = true; break; }          // 箱の中で巻き上がっている
            }
          }
          if (skip) continue;
          if (r.top < barBottom - 1) out.push(`「${text.slice(0, 24)}」top=${Math.round(r.top)} 切り替えの下端=${Math.round(barBottom)}`);
        }
        return out;
      });
      for (const line of over) bad.push(`${s}: ${line}`);
    }
    expect(bad, `切り替えの上にはみ出している:\n${bad.join("\n")}`).toEqual([]);
  });
}

test("「◯◯ とは」の補足は、スマホでは畳み、広い画面では最初から出す", async ({ page }) => {
  await page.setViewportSize(PRO);
  await enterApp(page);
  await goScreen(page, "AUTO");
  await expect(page.getByText("オートパイロット とは")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/ゴールだけ決めて/)).toBeVisible();          // 1文目は出ている
  const detail = page.getByText(/ボード › AUTOMATION の ?自動化/);
  await expect(detail).toBeHidden();
  await page.getByText("ほかとの違い").click();
  await expect(detail).toBeVisible();

  await page.setViewportSize(DESK);
  await expect(page.getByText("ほかとの違い")).toHaveCount(0);
  await expect(detail).toBeVisible();
});

test("スマホの「きろく」: 相談の欄を広く取り、経験の箱は押すと開く", async ({ page }) => {
  await page.setViewportSize(SE);
  await enterApp(page);
  await goScreen(page, "ME");
  const head = page.getByText("LIFE PARTNER");
  await expect(head).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(400);
  const m = await head.evaluate((el) => {
    const box = el.closest(".overflow-y-auto")!.getBoundingClientRect();
    return { top: el.getBoundingClientRect().top, boxTop: box.top, boxH: box.height };
  });
  // 説明の頭が欄の上に隠れていない（以前は開いた瞬間に下へ送っていた）
  expect(m.top).toBeGreaterThanOrEqual(m.boxTop - 1);
  // 相談の欄が潰れていない（箱と半分ずつ分けて 150px ほどだった）
  expect(m.boxH).toBeGreaterThanOrEqual(250);

  // 箱は見出しだけ。押すと開き、「とじる」で戻る
  const offlineNote = page.getByText(/バックエンド未接続のため箱は使えません/);
  await expect(offlineNote).toHaveCount(0);
  await page.getByRole("button", { name: /経験の箱/ }).click();
  await expect(offlineNote).toBeVisible();
  await page.getByRole("button", { name: /とじる/ }).click();
  await expect(offlineNote).toHaveCount(0);
});

test("広い画面のタスクは、詳細の欄を最初から出す", async ({ page }) => {
  await page.setViewportSize(DESK);
  await enterApp(page);
  await goScreen(page, "TASKS");
  await expect(page.getByPlaceholder("詳細（任意）…")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel("期限")).toBeVisible();
});
