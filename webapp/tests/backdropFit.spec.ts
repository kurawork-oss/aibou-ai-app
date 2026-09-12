/**
 * 背景が、画面ぴったりに敷かれているか。
 *
 * なぜ専用のファイルなのか
 * ------------------------
 * この不具合は**実機の倍率でしか出なかった**。
 *
 * canvas は置き換え要素なので、width / height 属性がそのままレイアウト上の
 * 大きさになる。`position: fixed; inset: 0` を付けても引き伸ばされない。
 * Backdrop3D は綺麗に描くために解像度を `画面 × devicePixelRatio`（最大2倍）
 * で取っているので、**箱まで2倍**になっていた。結果、実機では背景の左上
 * だけが拡大されて映る——「思っていたよりアップで、画質が悪い」。
 *
 * ほかのテストは Playwright の既定（dpr=1）で走っている。ちょうどこの
 * 不具合が消える唯一の値で、そこだけを見ていたので気づけなかった。
 * だから、ここは**倍率をこちらで決める**。
 *
 * 見るのは「canvas の箱＝画面」という1点だけ。見た目の良し悪しは目で見る
 * しかないが、これは数で決まる。
 */

import { test, expect, type Page } from "@playwright/test";

/** 実機で実際にある倍率。1 は「これまで唯一見ていた値」なので残す。 */
const CASES = [
  { w: 390, h: 740, dpr: 1, label: "スマホ・等倍" },
  { w: 390, h: 740, dpr: 3, label: "スマホ（iPhone）" },
  { w: 414, h: 896, dpr: 2, label: "スマホ（大きめ）" },
  { w: 1536, h: 864, dpr: 1.25, label: "ノートPC（Windows 125%）" },
  { w: 1440, h: 900, dpr: 2, label: "ノートPC（Retina）" },
];

/** 背景を canvas で描くものと、CSSで敷くもの。どちらも同じ層に乗っている。 */
const BACKGROUNDS = ["water-chrome", "chrome-flat", "stars"];

async function enterApp(page: Page) {
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offline = page.getByText("ENTER OFFLINE");
  const settings = page.getByLabel("Settings");
  await Promise.race([
    offline.waitFor({ timeout: 8_000 }).then(() => offline.click()).catch(() => {}),
    settings.waitFor({ timeout: 10_000 }).catch(() => {}),
  ]);
  await expect(settings).toBeVisible({ timeout: 10_000 });
}

for (const c of CASES) {
  test.describe(`${c.label}（${c.w}×${c.h} / dpr ${c.dpr}）`, () => {
    test.use({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: c.dpr });

    for (const bg of BACKGROUNDS) {
      test(`${bg} の背景が、画面ぴったりに敷かれている`, async ({ page }) => {
        await page.goto("/");
        await page.evaluate((bg) => {
          localStorage.setItem("forge_skin", "cyber");
          localStorage.setItem("forge_bg", bg);
        }, bg);
        await page.reload({ waitUntil: "domcontentloaded" });
        await enterApp(page);
        await page.waitForTimeout(2000);       // 絵の取得と、最初の1コマ

        const fit = await page.evaluate(() => {
          const el = document.querySelector(".forge-backdrop");
          if (!el) return null;                // 無地など、層そのものが無い背景
          const r = el.getBoundingClientRect();
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            x: Math.round(r.x), y: Math.round(r.y),
            vw: window.innerWidth, vh: window.innerHeight,
          };
        });
        expect(fit, "背景の層が見つからない").not.toBeNull();

        const f = fit!;
        // 1px は端数のぶん。2倍・1.25倍のずれはここで落ちる
        expect(Math.abs(f.w - f.vw),
          `横が ${f.w}px（画面は ${f.vw}px）＝ ${(f.w / f.vw).toFixed(2)}倍に伸びている`)
          .toBeLessThanOrEqual(1);
        expect(Math.abs(f.h - f.vh),
          `縦が ${f.h}px（画面は ${f.vh}px）＝ ${(f.h / f.vh).toFixed(2)}倍に伸びている`)
          .toBeLessThanOrEqual(1);
        // 左上からずれていないこと（はみ出した箱は、位置でも分かる）
        expect(Math.abs(f.x) + Math.abs(f.y), `背景が ${f.x},${f.y} から始まっている`)
          .toBeLessThanOrEqual(1);
      });
    }
  });
}
