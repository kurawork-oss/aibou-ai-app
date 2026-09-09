/**
 * HOMEの並び替え・表示切替ロジックの検証。
 *
 * 事故になりやすいのは「順番が壊れる」「消したものが戻せない」「アプリ更新で
 * 新しいウィジェットが永久に出てこない」なので、そこを重点的に確かめる。
 */

import { test, expect } from "@playwright/test";
import {
  DEFAULT_HIDDEN, DEFAULT_ORDER, defaultLayout, normalize, visible, move,
  toggleHidden, toggleWide, isWide,
  type HomeLayout, type WidgetId,
} from "../src/lib/homeLayout";

test("default layout shows every widget in the documented order", () => {
  const l = defaultLayout();
  expect(l.order).toEqual(DEFAULT_ORDER);
  // エージェントの欄は既定で隠す。会話は「実行」タブに1つだけ置く形にしたので、
  // ここにも置くと同じことを2か所でやることになる（実際そうなっていた）。
  // 消してはいないので、カスタマイズから戻せる。
  expect(l.hidden).toEqual(DEFAULT_HIDDEN);
  expect(visible(l)).toEqual(DEFAULT_ORDER.filter((id) => !DEFAULT_HIDDEN.includes(id)));
  expect(visible(l)).not.toContain("agent" as WidgetId);
  // 見張りと予定は既定で横長
  expect(isWide(l, "watch")).toBeTruthy();
  expect(isWide(l, "agenda")).toBeTruthy();
  expect(isWide(l, "connect")).toBeFalsy();
});

test("the hidden agent widget can be brought back", () => {
  // 隠しただけで消していないことを担保する（使いたい人が戻せる）。
  let l = defaultLayout();
  expect(visible(l)).not.toContain("agent" as WidgetId);
  l = toggleHidden(l, "agent");
  expect(visible(l)).toContain("agent" as WidgetId);
});

/* ── 保存値の正規化 ─────────────────────────────────────────────── */
test("unknown ids in a saved layout are dropped", () => {
  const l = normalize({ order: ["agenda", "nope", "agent"], hidden: ["ghost"], wide: ["zzz"] });
  expect(l.order).not.toContain("nope" as WidgetId);
  expect(l.hidden).toEqual([]);
  expect(l.wide).toEqual([]);
});

test("a widget added in a later version still appears", () => {
  // 古い保存（3つしか知らない）→ 残りが末尾に足される
  const l = normalize({ order: ["agenda", "agent", "dials"] });
  expect(l.order.slice(0, 3)).toEqual(["agenda", "agent", "dials"]);
  expect(new Set(l.order)).toEqual(new Set(DEFAULT_ORDER));
  expect(l.order.length).toBe(DEFAULT_ORDER.length);
});

test("duplicates in a saved layout collapse to one", () => {
  const l = normalize({ order: ["agent", "agent", "dials"], hidden: ["dials", "dials"] });
  expect(l.order.filter((x) => x === "agent")).toHaveLength(1);
  expect(l.hidden).toEqual(["dials"]);
});

test("garbage input falls back to the default", () => {
  expect(normalize(null).order).toEqual(DEFAULT_ORDER);
  expect(normalize("broken").order).toEqual(DEFAULT_ORDER);
  expect(normalize({ order: "not-an-array" }).order).toEqual(DEFAULT_ORDER);
});

/* ── 並べ替え ───────────────────────────────────────────────────── */
// ウィジェットが増えても壊れないよう、名前ではなく既定の並びの位置で書く。
test("moving a widget swaps it with its neighbour", () => {
  const [first, second] = DEFAULT_ORDER;
  let l = defaultLayout();
  l = move(l, second, -1);
  expect(visible(l).slice(0, 2)).toEqual([second, first]);
  l = move(l, second, 1);
  expect(visible(l).slice(0, 2)).toEqual([first, second]);
});

test("moving past the ends does nothing", () => {
  const l = defaultLayout();
  expect(move(l, "agent", -1).order).toEqual(l.order);
  expect(move(l, "connect", 1).order).toEqual(l.order);
});

test("moving skips over hidden widgets", () => {
  // 2番目を隠すと、1番目の次に見えているのは3番目。
  // 隠れたものと入れ替えても見た目が変わらないので、見えている順で動かす。
  const [first, second, third] = DEFAULT_ORDER;
  let l = toggleHidden(defaultLayout(), second);
  expect(visible(l).slice(0, 2)).toEqual([first, third]);
  l = move(l, third, -1);
  expect(visible(l)[0]).toBe(third);
  expect(visible(l)[1]).toBe(first);
});

test("moving a hidden widget is a no-op", () => {
  const l = toggleHidden(defaultLayout(), "connect");
  expect(move(l, "connect", -1)).toEqual(l);
});

/* ── 表示 / 非表示 ──────────────────────────────────────────────── */
test("hiding then showing restores the original position", () => {
  const before = visible(defaultLayout());
  let l = toggleHidden(defaultLayout(), "agenda");
  expect(visible(l)).not.toContain("agenda" as WidgetId);
  l = toggleHidden(l, "agenda");
  expect(visible(l)).toEqual(before);      // 末尾に飛ばされない
});

test("every widget can be hidden (empty home is allowed)", () => {
  let l: HomeLayout = defaultLayout();
  for (const id of visible(l)) l = toggleHidden(l, id);
  expect(visible(l)).toEqual([]);
  expect(l.order).toEqual(DEFAULT_ORDER);   // 戻せるように順序は残す
});

/* ── 幅 ─────────────────────────────────────────────────────────── */
test("width toggles independently of order and visibility", () => {
  let l = defaultLayout();
  l = toggleWide(l, "connect");
  expect(isWide(l, "connect")).toBeTruthy();
  l = toggleWide(l, "watch");
  expect(isWide(l, "watch")).toBeFalsy();
  // 並びは変わらない
  expect(l.order).toEqual(DEFAULT_ORDER);
});

test("hidden widgets keep their width setting", () => {
  let l = toggleWide(defaultLayout(), "notifications");
  l = toggleHidden(l, "notifications");
  l = toggleHidden(l, "notifications");
  expect(isWide(l, "notifications")).toBeTruthy();
});
