/**
 * 俯瞰の調査 — **意見ではなく数字**を出す。
 *
 * なぜ要るか
 * ----------
 * 「ごちゃごちゃしている」「中途半端」は、そのままでは直せない。どこが、
 * どれだけ、と言えて初めて手が入る。前にここを測ったときに分かったのが
 *
 *     設定「CORE」タブ  縦 1406px（画面3.2枚ぶん）／押せる物 29個
 *
 * で、そこから設定を割り直した。同じやり方で、**全部の画面**を測る。
 *
 * 測り方で1度つまずいた
 * ----------------------
 * はじめ `body.scrollHeight` を見ていたら、どの画面も「844 か 1664」に
 * なった。この画面は `h-[100dvh]` の枠の中で**内側の箱**がスクロールする
 * 作りなので、body はいつも画面ちょうどになる。ぴったり同じ数が並ぶのは、
 * 測る場所を間違えているしるしだった。
 *
 * 次に「スクロールしている箱のうち一番大きい物」に変えたら、今度はどの
 * タブも 1664 で揃った——中身と関係の無い外枠を掴んでいた。
 * いまは**その画面の中身が入っている箱**を名指しで測っている。
 *
 * 接続先ありのビルドを見る
 * ------------------------
 * オフラインのビルドでは、設定の中身の多くが「繋いでから使えます」の1行に
 * 畳まれる。それを測っても、**誰も使っていない姿**の数字しか出ない。
 *
 * これはテストではない
 * --------------------
 * 合格・不合格を決めない。数えて `audit/survey.json` に書き出すだけ。
 * 直すかどうかは、数字を見てから決める。
 *
 *   npx playwright test --project=audit
 */

import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mockBackend, enablePack } from "../linked/backend";

const MODES = ["HOME", "CHAT", "ME", "CODE", "STUDIO", "SNS", "CAPTURE",
  "VAULT", "TASKS", "AUTO", "BOARD", "ARCHIVE", "EXTEND", "GUIDE"] as const;

const TABS = ["基本", "見た目と声", "記憶", "つなぐ", "しらべる"] as const;

/** 設定の中身が入っている箱（ここだけを測る）。
 *
 * クラス名（`max-h-[60vh]`）で掴んでいたら、そのクラスを直した瞬間に
 * 当たらなくなり、**どのタブも同じ数字**に戻った。見た目のためのクラスを
 * 目印に使うと、直すたびに測れなくなる。印を別に付けてある。 */
const PANEL = "[data-settings-body]";
/** ふだんの画面の中身が入っている所。 */
const MAIN = "main, [role=main]";

interface Shot {
  where: string;
  /** 中身の縦の長さ（px）。 */
  height: number;
  /** 見えている窓の高さ（px）。 */
  window: number;
  /** 窓の何杯ぶんスクロールするか。1.0 なら画面に収まっている。 */
  screens: number;
  /** 押せる物（ボタン・リンク・入力・選択）。 */
  tappable: number;
  /** 文字数（読む量）。 */
  chars: number;
  /** 44px に満たない押しどころ（指で押しにくい）。 */
  tiny: number;
  /** その中身（直す所を名指しするため）。 */
  tinyList: string[];
  /** 何も無い（空っぽの画面か）。 */
  empty: boolean;
  /** 出ていたコンソールの苦情。 */
  complaints: string[];
  /** 押してから中身が出るまで（ms。待ち時間は引いてある）。 */
  ms: number;
}

async function measure(page: Page, where: string, sel: string, ms: number,
                       complaints: string[]): Promise<Shot> {
  const m = await page.evaluate((selector: string) => {
    const box = (document.querySelector(selector) as HTMLElement | null)
      ?? document.body;
    const tap = Array.from(box.querySelectorAll(
      "button, a[href], input, select, textarea, [role=button], [role=tab]"));
    const visible = tap.filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    });
    /* 指で押しにくい物を数える。
       **押しどころは、その要素とは限らない。** チェックボックスが
       `<label>` に包まれていれば、文字の所を押しても入る——実際に指が
       触れる的は label のほう。要素だけを見ると 13×13 に見えて、
       直す必要の無い所を「小さすぎる」と数えてしまう（実際にそうなった）。 */
    let tiny = 0;
    const tinyList: string[] = [];
    for (const el of visible) {
      const hit = el.closest("label") ?? el;
      const r = hit.getBoundingClientRect();
      if (r.height >= 44 && r.width >= 44) continue;
      tiny += 1;
      tinyList.push(`${Math.round(r.width)}×${Math.round(r.height)} ` +
        `${el.tagName.toLowerCase()} "${((el as HTMLElement).innerText
          || el.getAttribute("aria-label")
          || (el as HTMLInputElement).placeholder || "").replace(/\s+/g, " ").slice(0, 30)}"`);
    }
    const text = (box.innerText || "").replace(/\s+/g, " ").trim();
    const client = box.clientHeight || window.innerHeight;
    return {
      height: Math.round(Math.max(box.scrollHeight, client)),
      window: Math.round(client),
      tappable: visible.length,
      chars: text.length,
      tiny,
      tinyList,
      empty: text.length < 40,
    };
  }, sel);
  return {
    where, ...m,
    screens: Math.round((m.height / (m.window || 1)) * 100) / 100,
    complaints: [...complaints],
    ms,
  };
}

test("全画面と全設定タブを測る", async ({ page }) => {
  test.setTimeout(300_000);

  const complaints: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const t = msg.text();
    if (/Failed to load resource|net::ERR/.test(t)) return;
    complaints.push(`${msg.type()}: ${t.slice(0, 160)}`);
  });
  page.on("pageerror", (e) => complaints.push(`crash: ${String(e).slice(0, 160)}`));

  const be = await mockBackend(page);
  // 全部の機能を入れた状態で見る（切ってある物まで測っても仕方がない）
  for (const k of ["make", "share", "dev", "income"]) enablePack(be, k);

  const shots: Shot[] = [];

  const t0 = Date.now();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByText("ENTER").first().click();
  await page.locator("textarea").first().waitFor({ timeout: 20_000 });
  const boot = Date.now() - t0;

  for (const mode of MODES) {
    complaints.length = 0;
    const started = Date.now();
    await page.getByLabel("Modes", { exact: true }).click();
    await page.locator("nav").filter({ hasText: "MODES" })
      .getByText(mode, { exact: true }).click();
    await page.locator("nav").filter({ hasText: "MODES" })
      .waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    const painted = Date.now() - started;
    await page.waitForTimeout(500);       // 中身が落ち着くのを待つ（時間には数えない）
    shots.push(await measure(page, `画面/${mode}`, MAIN, painted, complaints));
  }

  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible({ timeout: 10_000 });
  for (const tab of TABS) {
    complaints.length = 0;
    const started = Date.now();
    await page.getByRole("button", { name: tab, exact: true }).click();
    const painted = Date.now() - started;
    await page.waitForTimeout(500);
    shots.push(await measure(page, `設定/${tab}`, PANEL, painted, complaints));
  }

  const out = {
    at: new Date().toISOString(),
    viewport: "390×844",
    boot_ms: boot,
    round_trips: be.calls.length,
    duplicates: be.duplicates(),
    shots: [...shots].sort((a, b) => b.screens - a.screens),
  };
  const dir = path.join(process.cwd(), "audit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "survey.json"), JSON.stringify(out, null, 2));

  console.log("\n== 中身/窓 = 何杯スクロールするか | 押せる物 | 文字 | 44px未満 | 出るまで ==");
  for (const s of out.shots) {
    console.log(
      `${s.where.padEnd(18)} ${String(s.height).padStart(5)}/${String(s.window).padStart(4)} ` +
      `= ${String(s.screens).padStart(5)}杯  ` +
      `押${String(s.tappable).padStart(3)} 字${String(s.chars).padStart(5)} ` +
      `小${String(s.tiny).padStart(3)} ${String(s.ms).padStart(5)}ms` +
      `${s.empty ? "  ←空" : ""}${s.complaints.length ? `  ←苦情${s.complaints.length}` : ""}`);
  }
  console.log(`\n起動（開く〜会話欄）: ${boot}ms`);
  console.log(`全部見て回ったときの往復: ${be.calls.length}回`);
  console.log(`2回以上聞いた道: ${be.duplicates().join(", ") || "なし"}`);
  const small = out.shots.filter((s) => s.tiny)
    .flatMap((s) => s.tinyList.map((t) => `${s.where}: ${t}`));
  if (small.length) {
    console.log("\n== 指で押しにくい所（44px未満） ==");
    for (const t of small) console.log("  " + t);
  }
  const bad = shots.flatMap((s) => s.complaints.map((c) => `${s.where}: ${c}`));
  if (bad.length) {
    console.log("\n== コンソールの苦情 ==");
    for (const b of [...new Set(bad)]) console.log("  " + b);
  }
});
