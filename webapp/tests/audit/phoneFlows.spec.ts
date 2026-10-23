/**
 * スマホで「使っている途中」の画面を撮る（点検。合否は決めない）。
 *
 *   npx playwright test --project=audit tests/audit/phoneFlows.spec.ts
 *
 * phone.spec.ts は画面を開いた直後しか見ない。使いづらさの多くは、
 * 話しかけた後・確認が出た後・一覧を開いた後に出る。ここでは
 *   会話（長い返事・表・コード）／確認の札／実行モードの経過／履歴／
 *   作った物／今日（中身あり）／ボード／設定の各タブ
 * を iPhone の大きさで撮り、横にはみ出す物・覆われた押し所・小さい字を数える。
 * 結果は audit/phone-flows.json と audit/phone/flow-*.png。
 */

import { test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mockBackend, enterApp, openManage, type Backend } from "../linked/backend";

const OUT = path.join(process.cwd(), "audit");
const SHOTS = path.join(OUT, "phone");

const LONG_ANSWER = [
  "## 今週の段取り",
  "",
  "まず結論です。**月曜に見積書を送り**、水曜までに資料を仕上げるのが安全です。",
  "",
  "1. 見積書を送る（A社・金額は先週の打ち合わせのとおり）",
  "2. ブログの下書きを仕上げる",
  "3. 支払いの承認を済ませる",
  "",
  "| 日 | やること | 所要 |",
  "|---|---|---|",
  "| 月 | 見積書を送る・返事を待つ | 30分 |",
  "| 水 | 資料の仕上げとレビュー依頼 | 2時間 |",
  "| 金 | ふりかえり | 15分 |",
  "",
  "```python",
  "def schedule(tasks):  # とても長い行が、スマホの幅でどう見えるかを確かめるための行です",
  "    return sorted(tasks, key=lambda t: (t.priority, t.due))",
  "```",
  "",
  "参考: https://example.com/very/long/path/that/does/not/break/nicely/on/narrow/screens?with=query&and=more",
].join("\n");

function chunk(text: string, n = 24): { token: string }[] {
  const out: { token: string }[] = [];
  for (let i = 0; i < text.length; i += n) out.push({ token: text.slice(i, i + n) });
  return out;
}

interface Row { flow: string; viewport: string; overflowX: string[]; covered: string[]; tiny: number }

async function measure(page: Page, flow: string): Promise<Row> {
  const vp = page.viewportSize()!;
  const m = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const overflowX: string[] = [];
    // 画面の右端から外へ出ている物（横に送れる箱の中は除く）
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > vh) continue;
      if (r.right <= vw + 1) continue;
      let scrolled = false;
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") { scrolled = true; break; }
      }
      if (scrolled) continue;
      // 画面に貼り付いた物（飾りの光・引っ込めた引き出し）は、ページを横に
      // 広げない（横に送れるようにはならない）ので数えない
      let fixed = false;
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") { fixed = true; break; }
      }
      if (fixed) continue;
      overflowX.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 40)} right=${Math.round(r.right)}`);
      if (overflowX.length > 8) break;
    }
    // 押せる物の真ん中に、別の「画面に貼り付いた小さい物」が乗っていないか
    const covered: string[] = [];
    for (const el of Array.from(document.querySelectorAll("button, a[href], textarea, input, select"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || st.pointerEvents === "none") continue;
      let clipped = false;
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (/auto|scroll|hidden/.test(s.overflowY + s.overflowX)) {
          const b = n.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom) { clipped = true; break; }
        }
      }
      if (clipped) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top || top === el || el.contains(top) || top.contains(el)) continue;
      let floating: Element | null = null;
      for (let n: Element | null = top; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") {
          const b = n.getBoundingClientRect();
          if ((b.width * b.height) / (vw * vh) > 0.6) break;
          floating = n; break;
        }
      }
      if (!floating) continue;
      covered.push(`「${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20)}」← 「${(top.textContent || top.getAttribute("aria-label") || "").trim().slice(0, 20)}」`);
    }
    let tiny = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent || "").trim();
      const el = n.parentElement;
      if (!t || !el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > vh) continue;
      if (parseFloat(getComputedStyle(el).fontSize) < 11) tiny += t.length;
    }
    const docWide = document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth;
    if (docWide > 1) overflowX.unshift(`ページ全体が横に ${docWide}px 送れる`);
    return { overflowX, covered, tiny };
  });
  return { flow, viewport: `${vp.width}x${vp.height}`, ...m };
}

async function shot(page: Page, rows: Row[], name: string) {
  await page.waitForTimeout(500);
  const vp = page.viewportSize()!;
  rows.push(await measure(page, name));
  await page.screenshot({ path: path.join(SHOTS, `flow-${vp.width}-${name}.png`) });
}

async function say(page: Page, text: string) {
  const ta = page.locator("textarea").first();
  await ta.fill(text, { timeout: 5000 });
  await page.getByLabel("Send message").click({ timeout: 5000 });
}

function withData(be: Backend) {
  be.set("/home/summary", { json: {
    tasks: { open: 4 }, missions: { active: 1 }, automations: { total: 2 },
    income: { pending: 0 }, events: { total: 3 }, notifications: { unread: 2 },
  } });
  be.set("/agenda", { json: { items: [
    { id: "e1", title: "A社と打ち合わせ", start: "2026-10-23T10:00:00", end: "2026-10-23T11:00:00" },
    { id: "e2", title: "歯医者", start: "2026-10-23T18:30:00", end: "2026-10-23T19:00:00" },
  ] } });
  be.set("/notifications", { json: { items: [
    { id: "n1", title: "見張り: 価格が下がりました", body: "見ていたページの値段が 12,800円 → 9,800円", read: false, created_at: "2026-10-23T08:00:00" },
  ] } });
}

for (const vp of [{ width: 375, height: 667 }, { width: 390, height: 844 }]) {
  test(`スマホの使い方の流れ ${vp.width}x${vp.height}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(vp);
    fs.mkdirSync(SHOTS, { recursive: true });
    const be = await mockBackend(page);
    withData(be);
    const rows: Row[] = [];
    await enterApp(page);

    // 1) 長い返事（見出し・番号・表・コード・長いURL）
    be.set("/chat", () => ({ sse: [...chunk(LONG_ANSWER), { done: true }] }));
    await say(page, "今週の段取りを、表とコードも使って教えて");
    await page.getByText("今週の段取り").first().waitFor({ timeout: 10_000 });
    await shot(page, rows, "chat-long");
    // 返事の頭まで戻して撮る（長い返事の読み始め）
    await page.getByText("まず結論です").first().scrollIntoViewIfNeeded();
    await shot(page, rows, "chat-long-top");

    // 2) 確認の札（取り返せない操作）
    be.set("/chat", () => ({ sse: [
      { approval: {
        tool: "send_email",
        params: { to: "boss@example.com", subject: "今週の報告", body: "見積書を送りました。資料は水曜に仕上がります。" },
        note: "上司にメールを送ります", level: 3, level_label: "取り返せない",
        why: "送ったメールは取り消せません。", chained: false,
        may_always: false, always_confirm: true } },
      { done: true },
    ] }));
    await say(page, "上司に今週の報告をメールして");
    await page.waitForTimeout(800);
    await shot(page, rows, "chat-approval");

    // 3) 作った物（画像）
    be.set("/chat", () => ({ sse: [
      { tool: "generate_image" },
      { show: { kind: "image", url: "https://example.com/cat.png", title: "猫の絵" } },
      { token: "猫の絵を作りました。" }, { done: true },
    ] }));
    await say(page, "猫の絵を作って");
    await page.getByLabel("作った物").waitFor({ timeout: 10_000 }).catch(() => {});
    await shot(page, rows, "chat-canvas");
    await page.getByLabel("キャンバスを閉じる").click({ timeout: 3000 }).catch(() => {});

    // 4) 履歴
    const hist = page.getByRole("button", { name: /履歴/ }).first();
    if (await hist.isVisible().catch(() => false)) {
      await hist.click({ timeout: 3000 }).catch(() => {});
      await shot(page, rows, "chat-history");
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.click(vp.width - 10, vp.height / 2).catch(() => {});
      await page.waitForTimeout(300);
    }

    // 5) 実行（司令塔）モードの経過
    be.set("/agent/act", () => ({ sse: [
      { phase: "start" },
      { phase: "prepare", what: "記憶を読み込み", ms: 120 },
      { phase: "thinking" },
      { phase: "tool", tool: "calendar_list", note: "今日の予定を見る", ms: 420 },
      { phase: "observation", result: "予定が2件あります（10:00 A社と打ち合わせ／18:30 歯医者）", ms: 420 },
      { phase: "tool", tool: "add_task", note: "見積書をタスクに入れる", ms: 180 },
      { phase: "observation", result: "タスクに追加しました: 見積書を送る", ms: 180 },
      { phase: "final", text: "今日の予定は2件です。見積書の件はタスクに入れておきました。" },
      { phase: "done", steps: 2 },
    ] }));
    const agentBtn = page.getByRole("button", { name: /実行（司令塔）/ });
    if (await agentBtn.isVisible().catch(() => false)) {
      await agentBtn.click({ timeout: 3000 }).catch(() => {});
      await say(page, "今日の予定を見て、見積書をタスクに入れて");
      await page.getByText(/今日の予定は2件です/).first().waitFor({ timeout: 10_000 }).catch(() => {});
      await shot(page, rows, "agent-trace");
    }

    // 6) 今日（中身あり）
    await openManage(page, "今日");
    await shot(page, rows, "home-data");

    // 7) ボード
    await page.getByRole("button", { name: "ボード", exact: true }).click({ timeout: 5000 }).catch(() => {});
    await shot(page, rows, "board");

    // 8) 設定の各タブ
    await page.getByLabel("Settings").click({ timeout: 5000 }).catch(() => {});
    for (const t of ["基本", "見た目と声", "記憶", "つなぐ", "しらべる"]) {
      const tab = page.getByRole("button", { name: t, exact: true });
      if (await tab.isVisible().catch(() => false)) {
        await tab.click({ timeout: 3000 }).catch(() => {});
        await shot(page, rows, `settings-${t}`);
      }
    }

    const file = path.join(OUT, `phone-flows-${vp.width}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  });
}
