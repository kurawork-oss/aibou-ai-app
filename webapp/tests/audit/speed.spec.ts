/**
 * 速さを測る。**直す前に、どこで待っているかを分ける。**
 *
 * 1周の計測で「画面を移るのに 1.3〜1.9秒」と出たが、その中身は
 *
 *   ① メニューを開く（絵が動く）
 *   ② 押してからメニューが閉じ切るまで（絵が動く）
 *   ③ 新しい画面の部品を読み込む（初回だけ）
 *   ④ その画面がサーバーに聞く
 *
 * が混ざっている。混ぜたまま「遅い」と言っても直せない。ここでは
 * ②③④を分けて出す。
 *
 * 会話のほうは「送ってから最初の1文字が出るまで」。ここがこの画面で
 * いちばん効く数字で、前に何度も削ってきた所。
 *
 *   npx playwright test --project=audit tests/audit/speed.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, enablePack, sseServer, type Backend } from "../linked/backend";

const MODES = ["HOME", "CHAT", "ME", "CODE", "STUDIO", "SNS", "CAPTURE",
  "VAULT", "TASKS", "AUTO", "BOARD", "ARCHIVE", "EXTEND", "GUIDE"] as const;

async function enter(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByText("ENTER").first().click();
  await page.locator("textarea").first().waitFor({ timeout: 20_000 });
}

/** その画面に切り替わって、中身が出るまで。 */
async function switchTo(page: Page, mode: string, be: Backend) {
  const before = be.calls.length;
  await page.getByLabel("Modes", { exact: true }).click();
  const menuOpen = Date.now();
  await page.locator("nav").filter({ hasText: "MODES" })
    .getByText(mode, { exact: true }).click();
  const clicked = Date.now();
  // 中身が出た＝古い画面の文字が消えて、新しい物が描かれた
  await page.locator("main, [role=main]").first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => {
    const m = document.querySelector("main, [role=main]") as HTMLElement | null;
    return !!m && (m.innerText || "").trim().length > 20;
  }, undefined, { timeout: 10_000 }).catch(() => {});
  const painted = Date.now();
  return {
    menu: menuOpen - (clicked - (clicked - menuOpen)),   // 開くのにかかった分
    paint: painted - clicked,
    calls: be.calls.length - before,
  };
}

test("画面を移る速さ（2周目＝部品が読み込み済みの状態も見る）", async ({ page }) => {
  test.setTimeout(300_000);
  const be = await mockBackend(page);
  for (const k of ["make", "share", "dev", "income"]) enablePack(be, k);
  await enter(page);

  const first: Record<string, { paint: number; calls: number }> = {};
  for (const m of MODES) {
    const r = await switchTo(page, m, be);
    first[m] = { paint: r.paint, calls: r.calls };
  }
  const second: Record<string, { paint: number; calls: number }> = {};
  for (const m of MODES) {
    const r = await switchTo(page, m, be);
    second[m] = { paint: r.paint, calls: r.calls };
  }

  console.log("\n== 画面を移る（1周目 / 2周目）==");
  console.log("画面        1周目ms 往復  2周目ms 往復");
  for (const m of MODES) {
    console.log(
      `${m.padEnd(10)} ${String(first[m].paint).padStart(6)} ${String(first[m].calls).padStart(4)}  ` +
      `${String(second[m].paint).padStart(6)} ${String(second[m].calls).padStart(4)}`);
  }
  const avg = (o: Record<string, { paint: number }>) =>
    Math.round(Object.values(o).reduce((n, v) => n + v.paint, 0) / MODES.length);
  console.log(`平均: 1周目 ${avg(first)}ms / 2周目 ${avg(second)}ms`);
});

test("会話は、送ってから何ミリ秒で1文字目が出るか", async ({ page }) => {
  test.setTimeout(180_000);
  const be = await mockBackend(page);
  // 本物のSSEを立てて、サーバー側が返し始める瞬間をこちらで決める
  be.set("/chat", () => ({ passthrough: true }));
  const server = await sseServer([
    { after: 120, data: { token: "はい" } },      // サーバーが120msで返し始める
    { after: 10, data: { token: "、わかりました。" } },
    { after: 10, data: { done: true } },
  ]);
  try {
    await enter(page);
    const box = page.locator("textarea").first();
    await box.fill("こんにちは");
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    await page.getByText("はい").first().waitFor({ timeout: 15_000 });
    const shown = Date.now() - t0;
    console.log(`\n送ってから1文字目まで: ${shown}ms（サーバー側の120msを含む）`);
    console.log(`画面側で使った分: 約 ${shown - 120}ms`);
    // 画面側が1秒も食っていたら、それは直す所
    expect(shown - 120, "画面側の下ごしらえが重すぎる").toBeLessThan(1500);
  } finally {
    await server.close();
  }
});

test("メニューの開け閉めに、どれだけ待たされるか", async ({ page }) => {
  /* 画面そのものは 6〜61ms で描かれていた。1周の計測で「1.3〜1.9秒」と
     見えていたのは、**絵が動いている時間**と、こちらが入れた待ちだった。
     待たされているのがどちらなのかを、分けて出す。 */
  test.setTimeout(180_000);
  const be = await mockBackend(page);
  for (const k of ["make", "share", "dev", "income"]) enablePack(be, k);
  await enter(page);

  const opens: number[] = [];
  const closes: number[] = [];
  for (const m of ["HOME", "CHAT", "TASKS", "VAULT", "BOARD"]) {
    let t = Date.now();
    await page.getByLabel("Modes", { exact: true }).click();
    await page.locator("nav").filter({ hasText: "MODES" })
      .getByText(m, { exact: true }).waitFor({ timeout: 10_000 });
    opens.push(Date.now() - t);

    t = Date.now();
    await page.locator("nav").filter({ hasText: "MODES" })
      .getByText(m, { exact: true }).click();
    await page.locator("nav").filter({ hasText: "MODES" })
      .waitFor({ state: "detached", timeout: 10_000 });
    closes.push(Date.now() - t);
  }
  const mid = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`\nメニューが開くまで: ${opens.join(", ")} ms（中央 ${mid([...opens])}）`);
  console.log(`押してから閉じ切るまで: ${closes.join(", ")} ms（中央 ${mid([...closes])}）`);

  /* ブラウザの中でも測る。Playwright 側の待ちや、押す前の当たり判定の
     確認が混ざっていないかを見分けるため。 */
  const inPage: number[] = [];
  for (const m of ["TASKS", "VAULT", "BOARD"]) {
    await page.getByLabel("Modes", { exact: true }).click();
    await page.locator("nav").filter({ hasText: "MODES" })
      .getByText(m, { exact: true }).waitFor({ timeout: 10_000 });
    const ms = await page.evaluate((label: string) => new Promise<number>((done) => {
      const nav = [...document.querySelectorAll("nav")]
        .find((n) => (n.innerText || "").includes("MODES"));
      if (!nav) return done(-1);
      const t0 = performance.now();
      const obs = new MutationObserver(() => {
        if (!document.contains(nav)) { obs.disconnect(); done(Math.round(performance.now() - t0)); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const btn = [...nav.querySelectorAll("button")]
        .find((b) => (b.innerText || "").trim().includes(label));
      (btn as HTMLButtonElement | undefined)?.click();
      setTimeout(() => { obs.disconnect(); done(-1); }, 8000);
    }), m);
    inPage.push(ms);
  }
  console.log(`ブラウザの中で測った消えるまで: ${inPage.join(", ")} ms`);
});

test("送る前に、画面側が何をしているか", async ({ page }) => {
  test.setTimeout(180_000);
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [{ token: "はい" }, { done: true }] }));
  await enter(page);

  const marks = await page.evaluate(async () => {
    const out: Record<string, number> = {};
    const t0 = performance.now();
    // IndexedDB を開くところが、送る前の最初の仕事
    await new Promise<void>((ok) => {
      const req = indexedDB.open("forge_memory");
      req.onsuccess = () => { req.result.close(); ok(); };
      req.onerror = () => ok();
      req.onblocked = () => ok();
    });
    out.openIndexedDB = Math.round(performance.now() - t0);
    return out;
  });
  console.log(`\nIndexedDB を開くまで: ${marks.openIndexedDB}ms`);

  const t0 = Date.now();
  await page.locator("textarea").first().fill("こんにちは");
  await page.keyboard.press("Enter");
  await page.getByText("はい").first().waitFor({ timeout: 15_000 });
  console.log(`送ってから1文字目まで（差し替えた即答のサーバー）: ${Date.now() - t0}ms`);
});

test("送ってから1文字目まで（ブラウザの中で測る）", async ({ page }) => {
  /* Playwright 側から測ると、押す前の当たり判定の確認や待ちの刻みが
     混ざる。**画面の中で**押して、**画面の中で**文字が出た瞬間を取る。 */
  test.setTimeout(180_000);
  const be = await mockBackend(page);
  be.set("/chat", () => ({ sse: [{ token: "はい" }, { done: true }] }));
  await enter(page);

  const runs: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const ms = await page.evaluate(() => new Promise<number>((done) => {
      const box = document.querySelector("textarea") as HTMLTextAreaElement | null;
      if (!box) return done(-1);
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "こんにちは");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      const t0 = performance.now();
      const obs = new MutationObserver(() => {
        if ((document.body.innerText || "").includes("はい")) {
          obs.disconnect();
          done(Math.round(performance.now() - t0));
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      setTimeout(() => { obs.disconnect(); done(-1); }, 8000);
    }));
    runs.push(ms);
    await page.waitForTimeout(400);
  }
  console.log(`\n送ってから1文字目まで（画面の中）: ${runs.join(", ")} ms`);
});
