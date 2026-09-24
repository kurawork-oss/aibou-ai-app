/**
 * 点検（sweep）— 全部の画面と設定を回って、**苦情・重複・はみ出し**を集める。
 *
 * survey.spec.ts が「どれだけ重いか」を数えるのに対して、こちらは
 * 「どこが壊れているか・どこがダブっているか」を拾う。
 *
 *   コンソールの苦情   … React の警告（key の重複・入れ子にできない要素）も含む。
 *                        開発サーバーで回すのはこのため（本番では消える）
 *   落ちた           … 画面のスクリプトが例外で止まった
 *   同じ見出し・同じ説明 … 1つの画面に同じ区切り・同じ文章が2回以上
 *   はみ出し          … 390px の画面の右へ出ている物（横に揺れる原因）
 *   同じid            … 押したつもりの所と違う物が動く原因
 *   壊れた画像
 *
 * 合格・不合格は決めない。audit/<project>.json（sweep-offline / sweep-linked）に書き出すだけ。
 *
 *   npx playwright test -c playwright.sweep.config.ts
 */

import { test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mockBackend, enablePack } from "../linked/backend";
import { goScreen } from "../nav";

const MODES = ["HOME", "CHAT", "ME", "CODE", "STUDIO", "SNS", "CAPTURE",
  "VAULT", "TASKS", "INCOME", "AUTO", "BOARD", "ARCHIVE", "EXTEND", "GUIDE"] as const;
const TABS = ["基本", "見た目と声", "記憶", "つなぐ", "しらべる"] as const;

interface Finding { where: string; kind: string; detail: string }

/** その画面に今見えている物の中から、問題らしき物を拾う。 */
async function inspect(page: Page, where: string): Promise<Finding[]> {
  return page.evaluate((where: string) => {
    const out: { where: string; kind: string; detail: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
    };
    const say = (el: Element) => {
      const t = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim().slice(0, 50);
      const cls = (el.getAttribute("class") || "").split(" ").slice(0, 3).join(".");
      return `<${el.tagName.toLowerCase()}${cls ? "." + cls : ""}> "${t}"`;
    };
    /* 横スクロールする箱の中は、はみ出しではない（そういう作り） */
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (["auto", "scroll", "hidden", "clip"].includes(s.overflowX)) return true;
      }
      return false;
    };

    // 画面ごと横に揺れるか（これが本当に困る形）
    const page = document.scrollingElement || document.documentElement;
    if (page.scrollWidth > page.clientWidth + 1) {
      out.push({ where, kind: "横に揺れる",
        detail: `ページの幅 ${page.scrollWidth} / 画面 ${page.clientWidth}` });
    }

    // はみ出し（いちばん外側の物だけ数える。中身まで全部並ぶと読めない）。
    // 画面に固定した飾り（position: fixed）は、はみ出しても揺れの原因にならない
    const fixed = (el: Element) => {
      for (let p: Element | null = el; p; p = p.parentElement) {
        if (getComputedStyle(p).position === "fixed") return true;
      }
      return false;
    };
    const over: Element[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) {
        if (inScroller(el) || fixed(el)) continue;
        if (over.some((o) => o.contains(el))) continue;
        over.push(el);
      }
    }
    for (const el of over.slice(0, 8)) {
      const r = el.getBoundingClientRect();
      out.push({ where, kind: "はみ出し",
        detail: `${say(el)} left=${Math.round(r.left)} right=${Math.round(r.right)} (幅${vw})` });
    }

    // 同じ id
    const ids = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll("[id]"))) {
      ids.set(el.id, (ids.get(el.id) || 0) + 1);
    }
    for (const [id, n] of ids) {
      if (n > 1) out.push({ where, kind: "同じid", detail: `#${id} ×${n}` });
    }

    // 同じ見出し（区切りの札）が2つ以上見えている
    const heads = Array.from(document.querySelectorAll(
      "h1, h2, h3, h4, summary, [class*='tracking-[0.2em]'], [class*='tracking-[0.22em]']"))
      .filter(visible)
      .map((el) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length >= 2 && t.length <= 40);
    const seenH = new Map<string, number>();
    for (const h of heads) seenH.set(h, (seenH.get(h) || 0) + 1);
    for (const [h, n] of seenH) {
      if (n > 1) out.push({ where, kind: "同じ見出し", detail: `「${h}」×${n}` });
    }

    // 同じ説明文（24字以上の文が、同じ画面に2回以上）
    const paras = Array.from(document.querySelectorAll("p, li, div"))
      .filter((el) => visible(el) && el.children.length === 0)
      .map((el) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length >= 24);
    const seenP = new Map<string, number>();
    for (const p of paras) seenP.set(p, (seenP.get(p) || 0) + 1);
    for (const [p, n] of seenP) {
      if (n > 1) out.push({ where, kind: "同じ説明", detail: `「${p.slice(0, 60)}」×${n}` });
    }

    // 壊れた画像
    for (const img of Array.from(document.querySelectorAll("img"))) {
      if (visible(img) && img.complete && img.naturalWidth === 0) {
        out.push({ where, kind: "壊れた画像", detail: img.getAttribute("src") || "" });
      }
    }
    return out;
  }, where);
}

test("全画面を回って、苦情・重複・はみ出しを集める", async ({ page }, info) => {
  const findings: Finding[] = [];
  let where = "起動";
  page.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const t = msg.text();
    // 開発サーバー自身の案内は数えない
    if (/React DevTools|\[Fast Refresh\]|\[HMR\]|webpack-hmr|Download the/.test(t)) return;
    findings.push({ where, kind: `console.${msg.type()}`, detail: t.slice(0, 400) });
  });
  page.on("pageerror", (e) => findings.push({ where, kind: "落ちた", detail: String(e).slice(0, 400) }));

  const be = await mockBackend(page);
  for (const k of ["make", "share", "dev", "income"]) enablePack(be, k);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^▸?\s*ENTER$/ }).click({ timeout: 120_000 });
  // 繋いでいないビルドは、起動画面でもう1回押す（ENTER OFFLINE）
  const offline = page.getByText("ENTER OFFLINE");
  await Promise.race([
    offline.waitFor({ timeout: 30_000 }).then(() => offline.click()),
    page.locator("textarea").first().waitFor({ timeout: 120_000 }),
  ]).catch(() => {});
  await page.locator("textarea").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  findings.push(...await inspect(page, "起動"));

  for (const mode of MODES) {
    where = `画面/${mode}`;
    try {
      await goScreen(page, mode);
    } catch {
      findings.push({ where, kind: "入口が無い", detail: mode });
      continue;
    }
    await page.waitForTimeout(2500);        // 開発サーバーは初回に組み立てるので長めに待つ
    findings.push(...await inspect(page, where));
  }

  // 管理タブの「もっと」
  where = "管理/もっと";
  await goScreen(page, "TASKS");
  await page.waitForTimeout(1000);
  const more = page.getByRole("button", { name: /もっと/ });
  if (await more.count()) {
    await more.first().click();
    await page.waitForTimeout(500);
    findings.push(...await inspect(page, where));
    await more.first().click();
  }

  await page.getByLabel("Settings").click();
  await page.waitForTimeout(1500);
  for (const tab of TABS) {
    where = `設定/${tab}`;
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.waitForTimeout(2500);
    findings.push(...await inspect(page, where));
  }

  // 同じ所を2回以上聞いた道（開いたまま回っただけで、2回聞くのは無駄）
  const dup = be.duplicates();

  const out = { at: new Date().toISOString(), project: info.project.name,
    findings, duplicate_requests: dup };
  const dir = path.join(process.cwd(), "audit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${info.project.name}.json`), JSON.stringify(out, null, 2));

  // 同じ苦情を1つにまとめて出す
  const seen = new Map<string, string[]>();
  for (const f of findings) {
    const key = `${f.kind} | ${f.detail}`;
    seen.set(key, [...(seen.get(key) || []), f.where]);
  }
  console.log(`\n== ${info.project.name}: ${seen.size}種類 ==`);
  for (const [k, wheres] of seen) {
    console.log(`- ${k}\n    @ ${[...new Set(wheres)].join(", ")}`);
  }
  console.log(`\n2回以上聞いた道: ${dup.join(", ") || "なし"}`);
});
