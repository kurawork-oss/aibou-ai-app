/**
 * 生成したHTMLを、このアプリと同じ出どころで動かさない。
 *
 * 見つけた穴: LP・アプリの「別タブで開く」と、ファイルの「開く」は、生成HTMLを
 * そのまま blob: にして開いていた。blob: のURLは作ったページ（このアプリ）と
 * 同じ出どころになるので、生成物の中のスクリプトは、このアプリの localStorage
 * （ログインのセッションが入っている）を読めた。LpBuilder は opener も渡していて、
 * 元のタブの画面まで触れた。生成物はAIが書いた物で、人が確かめてから開く物ではない。
 *
 * いまは外枠（スクリプト無し）＋ sandbox の枠（allow-same-origin 無し）で開く。
 */

import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_SANDBOX, sandboxedTabDoc } from "../src/lib/preview";

/** 生成物のふり。読めてしまう物を画面に書き出す。 */
const SNOOP = `<!DOCTYPE html><html><head><title>x</title></head><body>
<p id="out">動いた</p>
<script>
  var got = "none";
  try { got = String(window.localStorage.getItem("forge_secret")); } catch (e) { got = "error"; }
  var up = "blocked";
  try { up = String(window.parent.document.title); } catch (e) { up = "blocked"; }
  document.body.dataset.storage = got;
  document.body.dataset.parent = up;
</script></body></html>`;

test("外枠にはスクリプトが無く、生成物は sandbox の枠の中にある", () => {
  const doc = sandboxedTabDoc(SNOOP, "テスト");
  expect(doc).not.toContain("<script");                 // 外枠のスクリプトは0行
  expect(doc).toContain(`sandbox="${PREVIEW_SANDBOX}"`);
  expect(PREVIEW_SANDBOX).not.toContain("allow-same-origin");
  // 生成物は srcdoc の中（エスケープ済み）。外への通信を止める CSP も入っている
  expect(doc).toContain("srcdoc=");
  expect(doc).toContain("&lt;script&gt;");
  expect(doc).toContain("connect-src 'none'");
});

test("別タブで開いた生成物は、このアプリの localStorage も元の画面も読めない", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("forge_secret", "セッションの中身"));
  // 本物と同じく、このアプリの出どころの blob: で外枠を開く
  const doc = sandboxedTabDoc(SNOOP, "テスト");
  await page.evaluate((html) => {
    location.href = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  }, doc);
  await page.waitForURL(/^blob:/);
  const inner = page.frameLocator("iframe").locator("#out");
  await expect(inner).toHaveText("動いた");               // 生成物そのものは動く
  const frame = page.frames().find((f) => f !== page.mainFrame())!;
  const seen = await frame.evaluate(() => ({ ...document.body.dataset }));
  expect(seen.storage).not.toBe("セッションの中身");
  expect(seen.parent).toBe("blocked");
});

test("生成HTMLを blob: でそのまま開く所が、ほかに残っていない", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?)$/.test(f) ? [p] : [];
  });
  const bad: string[] = [];
  for (const file of walk(join(process.cwd(), "src"))) {
    if (file.endsWith(join("lib", "preview.ts"))) continue;   // 外枠を作る所だけ
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/text\/html/.test(line) || !/Blob/.test(line)) return;
      const near = lines.slice(i, i + 8).join("\n");
      if (/window\.open\(/.test(near)) bad.push(`${file.split("/src/")[1]}:${i + 1}`);
    });
  }
  expect(bad, `生成HTMLをそのまま開いている:\n${bad.join("\n")}`).toEqual([]);
});
