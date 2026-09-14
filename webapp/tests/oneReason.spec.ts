/**
 * 同じ理由を、1つの画面で何度も言わないこと。
 *
 * 見つけ方
 * --------
 * 繋いでいない状態で設定の「つなぐ」を開いたら、こう出ていた（実測）:
 *
 *     使う機能の切り替えは、バックエンド接続後に使えます（DIAGNOSTICS参照）。
 *     Google連携・DB永続化は、バックエンド接続後に使えます（DIAGNOSTICS参照）。
 *     HuggingFaceのモデル登録は、バックエンド接続後に使えます（DIAGNOSTICS参照）。
 *
 * 理由は1つ——繋いでいない——なのに3回言っている。読む人は「別々の問題が
 * 3つあるのか」と考える。機能が多い画面ほど、この足し算で読めなくなる。
 *
 * なぜ文言ではなく「数」を見るか
 * ------------------------------
 * 断り書きは部品ごとに手書きで13か所あり、これからも増える。どれか1つの
 * 文言を覚えさせても、次に足した所は素通りする。**1画面に同じ趣旨が
 * 何度出たか**を数えれば、増やし方に関係なく捕まえられる。
 */

import { test, expect, type Page } from "@playwright/test";

/** その画面に「繋いでから使えます」系の断り書きが何回出ているか。 */
async function excuses(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const seen = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.children.length) continue;                 // 葉だけ見る
      const text = (el.textContent || "").replace(/\s+/g, "");
      if (!text) continue;
      if (!/バックエンド.{0,12}(接続後|繋いでから|未接続)|接続後に使えます/.test(text)) continue;
      // 同じ文が入れ子で二重に数えられないようにする
      let dup = false;
      for (const s of seen) if (s.contains(el)) dup = true;
      if (dup) continue;
      seen.add(el);
      // 行き先（DIAGNOSTICS等）は文の後ろに来るので、切り詰めすぎない
      out.push(text.slice(0, 120));
    }
    return out;
  });
}

async function openSettings(page: Page) {
  await page.goto("/");
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hud = page.getByText("THE FORGE OS").first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await page.getByLabel("Settings").click();
  await page.getByText("CORE SETTINGS").waitFor({ timeout: 10_000 });
}

const TABS = ["基本", "声", "記憶", "見た目", "つなぐ", "KEYCHAIN", "DIAGNOSTICS"];

test("設定のどのタブでも、同じ断り書きは1つまで", async ({ page }) => {
  await openSettings(page);

  const bad: string[] = [];
  for (const t of TABS) {
    await page.getByRole("button", { name: t, exact: true }).click();
    await page.waitForTimeout(300);
    const found = await excuses(page);
    if (found.length > 1) {
      bad.push(`${t}: ${found.length}回\n    ${found.join("\n    ")}`);
    }
  }
  expect(bad, `同じ理由を何度も言っている:\n${bad.join("\n")}`).toEqual([]);
});

test("断り書きを1つに畳んでも、行き先は消えていない", async ({ page }) => {
  // 「使えません」だけにしてしまうと、畳んだぶん不親切になる。
  // どこへ行けばいいかは残っていること。
  await openSettings(page);
  await page.getByRole("button", { name: "つなぐ", exact: true }).click();
  await page.waitForTimeout(300);

  const found = await excuses(page);
  expect(found.length, "つなぐタブに断り書きが出ていない（この確認が空振りしている）")
    .toBe(1);
  expect(found[0]).toMatch(/DIAGNOSTICS/);
});

/* ── 画面のほうも見る ───────────────────────────────────────────────
 *
 * 設定だけでなく、ふだんの画面にも同じ断り書きが出る。ただし
 * **数だけを見てはいけない**。HOMEには
 *
 *     見張りはバックエンド接続後に表示されます。
 *     生成物はバックエンド接続後に表示されます。
 *
 * の2つが出るが、これは別々のウィジェットが自分のことを言っている。
 * 1つにまとめると、どちらが空なのか分からなくなる——直すと悪くなる。
 *
 * 本当の不具合は「**同じ文が2回出る**」ほう。理由は1つなのに何度も
 * 言われると、別の問題がいくつもあるように読める。そこを見る。 */
const MODES = ["HOME", "CHAT", "ME", "CODE", "STUDIO", "SNS", "CAPTURE",
  "VAULT", "TASKS", "AUTO", "BOARD", "ARCHIVE", "EXTEND"] as const;

test("どの画面でも、同じ断り書きが2回は出ない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hud = page.getByText("THE FORGE OS").first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()).catch(() => {}),
    hud.waitFor({ timeout: 10_000 }).catch(() => {}),
  ]);
  await page.getByLabel("Modes", { exact: true }).waitFor({ timeout: 10_000 });

  const bad: string[] = [];
  for (const mode of MODES) {
    await page.getByLabel("Modes", { exact: true }).click();
    await page.locator("nav").filter({ hasText: "MODES" })
      .getByText(mode, { exact: true }).click();
    await page.locator("nav").filter({ hasText: "MODES" })
      .waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(350);

    const found = await excuses(page);
    const seen = new Map<string, number>();
    for (const f of found) seen.set(f, (seen.get(f) ?? 0) + 1);
    for (const [text, n] of seen) {
      if (n > 1) bad.push(`${mode}: 「${text.slice(0, 40)}」が${n}回`);
    }
  }
  expect(bad, `同じ文を何度も出している:\n${bad.join("\n")}`).toEqual([]);
});
