/**
 * 画面を開くたびに、サーバーへ何回・どう聞いているかの見張り。
 *
 * 無料のバックエンドは寝ているので、**1往復の無駄がそのまま体感の遅さ**
 * になる。目で見ても分からないので数字で押さえる。
 *
 * 実測で2つ見つかって直した所を、ここで固定する。
 *   ・/keys を2つの部品がそれぞれ取っていた（同時に2回）
 *   ・生成物だけ「他が終わってから」取っていた（+1往復 ≒ +317ms）
 *
 * 見るのは「本数」だけでなく **「並んでいるか」**。本数が同じでも
 * 数珠つなぎなら、遅さは本数ぶん積み上がる。
 */

import { test, expect } from "@playwright/test";
import { enterApp, mockBackend, openManage, type Backend } from "./backend";

/**
 * 画面を出すのに要る問い合わせ**ではない**もの。
 *
 * ここで見たいのは「画面を1枚出すのに何往復しているか」なので、
 * 画面と関係なく走る物は数えない。数えると、裏の仕事が増えるたびに
 * 「数珠つなぎになった」と誤検知する。
 *
 *   /health      … 寝ているサーバーを起こすのが役目。何度でも叩く
 *   /memory/sync … 記憶の合流。開いた数秒後にタイマーで1回走る
 */
const BACKGROUND = ["/health", "/memory/sync"];
const isBackground = (path: string) => BACKGROUND.some((p) => path.startsWith(p));

/** 最初の1本から数えて、どれだけ同時に飛んでいるか。 */
function spread(be: Backend, withinMs = 200) {
  const calls = be.calls.filter((c) => !isBackground(c.path));
  if (!calls.length) return { total: 0, together: 0 };
  const t0 = calls[0].at;
  return {
    total: calls.length,
    together: calls.filter((c) => c.at - t0 <= withinMs).length,
  };
}

test("同じ物を2回聞かない（起動と管理タブ）", async ({ page }) => {
  const be = await mockBackend(page);
  await enterApp(page);
  // 画面と関係なく走る物（起こし・記憶の合流）は数えない
  const dupOnBoot = be.duplicates().filter((d) => !isBackground(d));
  expect(dupOnBoot, `起動で同じ物を2回:\n${dupOnBoot.join("\n")}`).toEqual([]);

  be.reset();
  await openManage(page, "今日");
  await expect(page.getByText("PERSONAL COCKPIT")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  const dup = be.duplicates().filter((d) => !isBackground(d));
  expect(dup, `管理タブで同じ物を2回:\n${dup.join("\n")}`).toEqual([]);
});

test("管理タブの読み込みは、数珠つなぎにしない", async ({ page }) => {
  const be = await mockBackend(page);
  be.latency = 200;                    // 1往復ぶん遅らせて、つながりを見えるようにする
  await enterApp(page);

  be.reset();
  await openManage(page, "今日");
  await expect(page.getByText("PERSONAL COCKPIT")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);

  const s = spread(be);
  expect(s.total).toBeGreaterThan(4);   // 数えられている（0本で通らないように）
  // 全部が最初のひとかたまりで出ていること。1本でも後ろにずれていたら、
  // それは他の返事を待っている（生成物が実際そうなっていた）。
  expect(s.together, `${s.total}本のうち同時に出たのは${s.together}本`
    + `\n並び:\n${be.calls.filter((c) => !isBackground(c.path))
        .map((c, _i, a) => `  +${c.at - a[0].at}ms ${c.path}`).join("\n")}`)
    .toBe(s.total);
});

test("開いていない画面のぶんまで聞かない", async ({ page }) => {
  // 会話を開いただけで全画面ぶん取りに行くと、使わない物の待ち時間を払う。
  const be = await mockBackend(page);
  await enterApp(page);
  await page.waitForTimeout(800);

  const paths = new Set(be.calls.map((c) => c.path));
  for (const p of ["/tasks", "/agenda", "/artifacts", "/watch", "/home/summary", "/income/summary"]) {
    expect(paths.has(p), `会話を開いただけで ${p} を取っている`).toBeFalsy();
  }
});

test("タスクとファイルは、1往復で開く", async ({ page }) => {
  const be = await mockBackend(page);
  await enterApp(page);

  for (const [label, path] of [["タスク", "/tasks"], ["ファイル", "/artifacts"]] as const) {
    be.reset();
    await openManage(page, label);
    await page.waitForTimeout(900);
    expect(be.count(path), `${label} が ${path} を ${be.count(path)}回`).toBe(1);
  }
});
