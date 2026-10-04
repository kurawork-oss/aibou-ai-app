/**
 * スマホの使いづらさを、数字で出す（点検。合否は決めない）。
 *
 *   npx playwright test --project=audit tests/audit/phone.spec.ts
 *
 * 画面ごとに、iPhone の大きさで撮って測る:
 *   ・上の飾り（ロゴ・コア）が、縦の何割を取っているか
 *   ・中身に使える高さ
 *   ・小さすぎる文字（12px 未満）が、文字の何割か
 *   ・入力欄の文字が 16px 未満か（iOS は触った瞬間に拡大して、戻らない）
 *   ・44px 未満の押せる物の数
 * 結果は audit/phone.json と audit/phone/*.png に書く。
 */

import { test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mockBackend, enablePack } from "../linked/backend";
import { goScreen } from "../nav";

const SCREENS = ["CHAT", "HOME", "TASKS", "BOARD", "ARCHIVE", "STUDIO", "VAULT", "AUTO",
  "ME", "EXTEND", "CAPTURE", "SNS", "CODE", "GUIDE"] as const;

const OUT = path.join(process.cwd(), "audit");

interface Row {
  where: string;
  viewport: string;
  headerBottom: number;     // 中身が始まる高さ（px）
  navTop: number;           // 下のナビが始まる高さ（px）
  contentHeight: number;
  headerShare: number;      // 上の飾りが縦の何割か
  smallTextShare: number;   // 12px 未満の文字の割合
  tinyTextShare: number;    // 11px 未満
  zoomInputs: string[];     // 16px 未満の入力欄
  smallTaps: number;        // 44px 未満の押せる物
}

async function enter(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByText("ENTER").first().click();
  await page.locator("textarea").first().waitFor({ timeout: 20_000 });
}

async function measure(page: Page, where: string): Promise<Row> {
  const vp = page.viewportSize()!;
  const m = await page.evaluate(() => {
    const vh = window.innerHeight;
    const nav = document.querySelector('nav[aria-label="Mobile navigation"]') as HTMLElement | null;
    const navTop = nav && nav.getBoundingClientRect().height > 0 ? nav.getBoundingClientRect().top : vh;
    // 中身の始まり: ビューの入れ物（data-view）か、main の最初の見える子
    const view = document.querySelector("main > section") as HTMLElement | null;
    const headerBottom = view ? view.getBoundingClientRect().top : 0;

    let total = 0, small = 0, tiny = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent || "").trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.opacity === "0") continue;
      const fs = parseFloat(cs.fontSize);
      total += t.length;
      if (fs < 12) small += t.length;
      if (fs < 11) tiny += t.length;
    }
    const zoomInputs: string[] = [];
    document.querySelectorAll("input, textarea, select").forEach((el) => {
      const e = el as HTMLElement;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const t = (e as HTMLInputElement).type || "";
      if (["checkbox", "radio", "range", "file", "hidden", "color"].includes(t)) return;
      const fs = parseFloat(getComputedStyle(e).fontSize);
      if (fs < 16) zoomInputs.push(`${e.tagName.toLowerCase()}[${e.getAttribute("aria-label") || e.getAttribute("placeholder") || ""}] ${fs}px`);
    });
    let smallTaps = 0;
    document.querySelectorAll("button, a[href], [role=button], select, input[type=checkbox]").forEach((el) => {
      // チェックボックスは、包んでいる <label> の行のどこを押しても切り替わる。
      // 押しどころはその行（globals.css で 44px）なので、四角ではなく行を測る。
      const target = (el as HTMLInputElement).type === "checkbox" ? (el.closest("label") ?? el) : el;
      const r = (target as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh) return;
      if (Math.min(r.width, r.height) < 44 && Math.max(r.width, r.height) < 44) smallTaps++;
      else if (r.height < 32 || r.width < 32) smallTaps++;
    });
    return { vh, navTop, headerBottom, total, small, tiny, zoomInputs, smallTaps };
  });
  return {
    where,
    viewport: `${vp.width}x${vp.height}`,
    headerBottom: Math.round(m.headerBottom),
    navTop: Math.round(m.navTop),
    contentHeight: Math.round(m.navTop - m.headerBottom),
    headerShare: +(m.headerBottom / m.vh).toFixed(2),
    smallTextShare: m.total ? +(m.small / m.total).toFixed(2) : 0,
    tinyTextShare: m.total ? +(m.tiny / m.total).toFixed(2) : 0,
    zoomInputs: m.zoomInputs,
    smallTaps: m.smallTaps,
  };
}

for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
  test(`スマホの点検 ${vp.width}x${vp.height}`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(vp);
    const be = await mockBackend(page);
    for (const p of ["share", "dev"]) enablePack(be, p);
    await enter(page);
    const rows: Row[] = [];
    const dir = path.join(OUT, "phone");
    fs.mkdirSync(dir, { recursive: true });
    for (const s of SCREENS) {
      try {
        await goScreen(page, s);
      } catch {
        continue;
      }
      await page.waitForTimeout(700);
      rows.push(await measure(page, s));
      await page.screenshot({ path: path.join(dir, `${vp.width}-${s}.png`) });
    }
    // 設定
    await page.getByLabel("Settings").click().catch(() => {});
    await page.waitForTimeout(700);
    rows.push(await measure(page, "SETTINGS"));
    await page.screenshot({ path: path.join(dir, `${vp.width}-SETTINGS.png`) });
    fs.writeFileSync(path.join(OUT, `phone-${vp.width}.json`), JSON.stringify(rows, null, 2));
  });
}
