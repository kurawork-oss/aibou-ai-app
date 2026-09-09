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
  await page.getByLabel("Modes", { exact: true }).waitFor({ timeout: 10_000 });
}

async function goMode(page: Page, label: string) {
  await page.getByLabel("Modes", { exact: true }).click();
  await page.locator("nav").filter({ hasText: "MODES" }).getByText(label, { exact: true }).click();
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
