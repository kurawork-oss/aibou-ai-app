/**
 * スマホでの当たりの見張り。
 *
 * 目で見ても気づけないので、数字で押さえる。全モードを実機サイズで開き、
 *   ・押せるものが小さすぎないか（Appleの目安 44px）
 *   ・横に切れていないか
 *   ・コンソールにエラーが出ていないか
 * を測る。
 *
 * 「横に切れていないか」は、ページ全体だけを見ても分からない。内側の枠が
 * 横スクロールになっていると、ページは 393px のままで中身だけが切れる。
 * TASKS の入力欄が画面外に出ていたのはこれで、最初の点検では見逃していた。
 * だから「自分の中身が自分より広い枠」を探す。
 */

import { test, expect, type Page } from "@playwright/test";
import { goScreen, waitForHud } from "./nav";

const MODES = ["HOME", "CHAT", "ME", "CODE", "STUDIO", "SNS", "CAPTURE",
  "VAULT", "TASKS", "AUTO", "BOARD", "ARCHIVE", "EXTEND", "GUIDE"] as const;

/** 押せるものの最小の大きさ（Apple の目安）。 */
const MIN_TAP = 44;

async function enterApp(page: Page) {
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hud = page.getByText("THE FORGE OS").first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await waitForHud(page);
}

async function goMode(page: Page, label: string) {
  await goScreen(page, label);
  await page.waitForTimeout(400);
}

/** その画面で、小さすぎる操作対象と、横に切れている枠を数える。 */
async function measure(page: Page, minTap: number) {
  return page.evaluate((MIN) => {
    const small: { label: string; w: number; h: number; cls: string }[] = [];
    for (const el of Array.from(document.querySelectorAll(
      'button, a, [role="button"], select'))) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      if (b.height < MIN || b.width < MIN) {
        small.push({
          label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30),
          w: Math.round(b.width), h: Math.round(b.height),
          cls: (el.className || "").toString().slice(0, 60),
        });
      }
    }

    const clipped: { cls: string; client: number; content: number; text: string }[] = [];
    const SCROLLY = new Set(["auto", "scroll"]);
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth < 120) continue;
      const st = getComputedStyle(el);
      const cls = (el.className || "").toString();
      // 意図して横に流している所は数えない。ブラウザは overflow-y:auto を付けると
      // overflow-x も auto に繰り上げるので、計算値だけでは意図が読めない。
      // 書き手が overflow-x-* / overflow-hidden を明示したかどうかで見る。
      if (/\boverflow-x-(auto|scroll)\b/.test(cls)) continue;
      if (/\boverflow-hidden\b/.test(cls) || st.overflowX === "hidden") continue;
      if (!SCROLLY.has(st.overflowX)) continue;
      clipped.push({
        cls: cls.slice(0, 70), client: el.clientWidth, content: el.scrollWidth,
        text: (el.textContent || "").trim().slice(0, 40),
      });
    }
    return { small, clipped };
  }, minTap);
}

test("スマホの全モードで、押せるものが44px以上ある", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });   // iPhone 14 Pro
  await page.goto("/");
  await enterApp(page);

  const bad: string[] = [];
  for (const mode of MODES) {
    await goMode(page, mode);
    const { small } = await measure(page, MIN_TAP);
    for (const s of small) {
      bad.push(`${mode}: ${s.w}x${s.h} 「${s.label}」 class="${s.cls}"`);
    }
  }
  expect(bad, `44px未満の操作対象:\n${bad.join("\n")}`).toEqual([]);
});

test("スマホの全モードで、中身が横に切れていない", async ({ page }) => {
  // 狭い端末ほど出やすいので、いちばん狭いところで見る
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await enterApp(page);

  const bad: string[] = [];
  for (const mode of MODES) {
    await goMode(page, mode);
    const { clipped } = await measure(page, MIN_TAP);
    for (const c of clipped) {
      bad.push(`${mode}: 枠${c.client}px に中身${c.content}px 「${c.text}」 class="${c.cls}"`);
    }
  }
  expect(bad, `横に切れている所:\n${bad.join("\n")}`).toEqual([]);
});

test("下のナビと本文の文字が、読める大きさである", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "HOME");

  const tiny = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.children.length) continue;
      const text = (el.textContent || "").trim();
      if (text.length < 3) continue;
      const st = getComputedStyle(el);
      const size = parseFloat(st.fontSize);
      // HUDの細い英字ラベル（label-mono 等）は、この見た目そのものなので対象外。
      // 読ませたい日本語の本文だけを見る。
      // 親までさかのぼって見る。ボタンに label-mono があり、文字が中の span に
      // 置かれていると、その span だけ見て「本文」と取り違える。
      let hud = false;
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
        if (/label-mono|brand-sub|brand-wordmark/.test((n.className || "").toString())) {
          hud = true; break;
        }
      }
      if (hud) continue;
      if (size && size < 10) out.push(`${size}px: ${text.slice(0, 30)}`);
    }
    return out;
  });
  expect(tiny, `10px未満の本文:\n${tiny.join("\n")}`).toEqual([]);

  // 下のナビは HUD ラベルだが、行き先そのものなので読める大きさが要る
  const navSize = await page.getByLabel("Mobile navigation")
    .getByText("管理", { exact: true })
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(navSize).toBeGreaterThanOrEqual(10);
});

/* ── 畳んだ先（開かないと出てこない所）────────────────────────────
 *
 * 上の見張りは「モードを開いて測る」ので、押して初めて出る面は通らない。
 * ナビを2つに畳んだぶん、行き先はそういう面へ移った——つまり、いちばん
 * 測れていない所へ移った。ここで開いてから測る。 */
test("管理タブの「もっと」を開いても、押せるものが44px以上ある", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "HOME");
  await page.getByRole("button", { name: /もっと/ }).click();
  await page.waitForTimeout(400);
  // 開いたことを確かめてから測る（閉じたまま測ると、何も無いので必ず通る）
  await expect(page.getByRole("button", { name: /説明書/ })).toBeVisible();

  const { small, clipped } = await measure(page, MIN_TAP);
  expect(small.map((s) => `${s.w}x${s.h} 「${s.label}」`),
    "「もっと」の中に小さすぎる行き先がある").toEqual([]);
  expect(clipped.map((c) => `枠${c.client}px に中身${c.content}px 「${c.text}」`),
    "「もっと」の中が横に切れている").toEqual([]);
});

/* ── 重なり ────────────────────────────────────────────────────────
 *
 * 「スマホのUIが被りすぎている」と報告があった。上の2つ（大きさ・横の
 * 切れ）はどちらも通っていて、それでも被っていた——**別の物が上に乗って
 * いる**のは、どちらの測り方でも見えないため。
 *
 * ここでは押せる物の真ん中を突いて、返ってくるのが自分（か自分の中身）か
 * を見る。別人が返ってきたら、その分だけ覆われている。
 *
 * 実際に見つかった例: 出した物へ戻る「作った物」の浮きボタンが、下から
 * 74px の決め打ちで置かれていて、会話／実行の切り替えにちょうど重なり、
 * 「実行（司令塔）」が半分隠れていた。 */
async function covered(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll(
      'button, a, [role="button"], select, textarea, input'))) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      /* 巻き上がって見えていない物は数えない。
         スクロールの箱からはみ出した所を突くと、当然その下の物が返る。
         最初これを入れ忘れて、**画面外まで送られたボタン**を「下のナビに
         覆われている」と報告しかけた（HOMEの「+ 追加」は箱の底が764pxで、
         実際にはy=789——つまり見えていなかった）。 */
      let clipped = false;
      let box: Element | null = el.parentElement;
      while (box && box !== document.body) {
        const s = getComputedStyle(box);
        if (/auto|scroll|hidden/.test(s.overflowY + s.overflowX)) {
          const b = box.getBoundingClientRect();
          if (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom) { clipped = true; break; }
        }
        box = box.parentElement;
      }
      if (clipped) continue;
      const top = document.elementFromPoint(cx, cy);
      if (!top) continue;
      if (top === el || el.contains(top) || top.contains(el)) continue;
      /* 数えるのは「**画面に貼り付いた小さい物**が乗っている」場合だけ。
         浮かせた取っ手・通知・丸ボタンの類で、置く高さを決め打ちにすると
         その下にある物を静かに押せなくする。実際そうなっていた。

         数えない物が2つある。
          ・画面いっぱいに被せる面（CODE・ボード・キャンバス・設定）
            ——後ろを触らせないために出しているので、隠れて正しい
          ・流れの中で前に出ている物
            ——画面そのものが切り替わっているだけで、後ろの面が残って
              見えるのは描き順の話。押せなくなっているわけではない

         最初この線を引かずに測って、**60か所が重なっている**と出た。
         中身を見たら、開いたままの一覧と、切り替わった先の画面だった。 */
      let floating: Element | null = null;
      const screen = window.innerWidth * window.innerHeight;
      let n: Element | null = top;
      while (n && n !== document.body) {
        if (getComputedStyle(n).position === "fixed") {
          const b = n.getBoundingClientRect();
          if ((b.width * b.height) / screen > 0.6) break;   // 被せ面 → 見ない
          floating = n;
          break;
        }
        n = n.parentElement;
      }
      if (!floating) continue;
      const t = top.getBoundingClientRect();
      const name = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24);
      const by = (top.getAttribute("aria-label") || top.textContent || "").trim().slice(0, 24);
      out.push(`「${name}」(${Math.round(r.width)}x${Math.round(r.height)}) が`
        + `「${by}」(${Math.round(t.width)}x${Math.round(t.height)}) に覆われている`);
    }
    return out;
  });
}

test("スマホで、押せるものが他の物に覆われていない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await enterApp(page);

  const bad: string[] = [];
  for (const mode of MODES) {
    await goMode(page, mode);
    /* 「もっと」の一覧が閉じてから測る（開いたままだと、その一覧に覆われた
       所まで重なりとして数えてしまう）。 */
    await expect(page.getByRole("button", { name: /▲ もっと/ })).toHaveCount(0);
    await page.waitForTimeout(300);
    for (const line of await covered(page)) bad.push(`${mode}: ${line}`);
  }
  expect(bad, `重なっている所:\n${bad.join("\n")}`).toEqual([]);
});

test("設定を開いても、押せるものが44px以上ある", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.waitForTimeout(600);
  await expect(page.getByText("CORE SETTINGS")).toBeVisible();

  const bad: string[] = [];
  for (const t of ["基本", "見た目と声", "記憶", "つなぐ", "しらべる"]) {
    await page.getByRole("button", { name: t, exact: true }).click();
    await page.waitForTimeout(400);
    const { small, clipped } = await measure(page, MIN_TAP);
    for (const s of small) bad.push(`${t}: ${s.w}x${s.h} 「${s.label}」 class="${s.cls}"`);
    for (const c of clipped) {
      bad.push(`${t}: 枠${c.client}px に中身${c.content}px 「${c.text}」`);
    }
  }
  expect(bad, `設定の中で直したい所:\n${bad.join("\n")}`).toEqual([]);
});
