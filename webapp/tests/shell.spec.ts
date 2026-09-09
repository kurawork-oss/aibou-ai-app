/**
 * 画面を「実行 / 管理」の2つに畳んだ対応表の検証。
 *
 * ここで守りたいのは1点だけ。
 *
 *   **ナビが案内する数を減らしただけで、画面は1つも消していない。**
 *
 * 15タブを2タブにしたとき、いちばん起きやすい事故は「畳んだ拍子に
 * どこからも開けない画面ができる」こと。しかも壊れ方が静かで、
 * その画面を使わない人（＝作った本人）は気づかない。
 *
 * だから View の一覧と、ナビからたどれる先を突き合わせる。
 * 新しい画面を足して案内し忘れたら、ここで落ちる。
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANAGE_SURFACES, MORE_SURFACES, OVERLAY_VIEWS, RUN_VIEW, TABS, VIEWS,
  TODAY_WIDGETS, isView, surfaceOf, tabOf, type ShellView,
} from "../src/lib/shell";
import { DEFAULT_ORDER, type WidgetId } from "../src/lib/homeLayout";

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const api = (p: string) => readFileSync(join(process.cwd(), "..", "api", p), "utf8");

test("ナビからたどれない画面が生まれていない", () => {
  const reachable = new Set<string>([
    RUN_VIEW,
    ...MANAGE_SURFACES.map((s) => s.view),
    ...MORE_SURFACES.map((s) => s.view),
  ]);
  const orphans = VIEWS.filter((v) => !reachable.has(v));
  expect(orphans, `どこからも開けない画面:\n${orphans.join(", ")}`).toEqual([]);
});

test("画面の一覧が1か所にしかない", () => {
  // page.tsx が自前の並びを持ち直すと、片方だけ増えても型では気づけない。
  // 実際それで「サーバーは案内するが、押しても開かない」画面が出た。
  expect(src("app/page.tsx")).not.toMatch(/type View =\s*"/);
  expect(src("app/page.tsx")).toContain("type View = ShellView");
});

test("サーバーが案内する飛び先が、実在する画面である", () => {
  // capabilities.py の "view" は画面側の名前をそのまま書いている。
  // 実在しない名前でも例外にならず、押しても何も起きないだけなので、
  // 気づかれずに残る（"files" が実際そうなっていた）。
  const targets = [...api("capabilities.py").matchAll(/"view":\s*"([a-z]+)"/g)]
    .map((m) => m[1]);
  expect(targets.length, "capabilities.py の view が読めていない").toBeGreaterThan(3);
  const dead = [...new Set(targets)].filter((v) => !isView(v));
  expect(dead, `実在しない飛び先:\n${dead.join(", ")}`).toEqual([]);
});

test("下のナビは2タブ。実行は会話に行く", () => {
  expect(TABS.map((t) => t.key)).toEqual(["run", "manage"]);
  expect(RUN_VIEW).toBe("chat");
  expect(tabOf("chat")).toBe("run");
});

test("会話以外はすべて管理タブに属する", () => {
  // 「実行」に2つ以上入ると、話す場所が1つに決まらなくなる。
  for (const v of VIEWS as readonly ShellView[]) {
    if (v === RUN_VIEW) continue;
    expect(tabOf(v), `${v} が実行タブに入っている`).toBe("manage");
  }
});

test("管理タブの切り替えは、いま居る場所を指す", () => {
  expect(surfaceOf("home")).toBe("today");
  expect(surfaceOf("tasks")).toBe("tasks");
  // 「もっと」の中の画面は、4つのどれでもない（null）。
  // ここで嘘の場所を指すと、押していないタブが光る。
  expect(surfaceOf("capture")).toBeNull();
  expect(surfaceOf("chat")).toBeNull();
});

test("同じ画面が2か所に案内されていない", () => {
  const all = [...MANAGE_SURFACES, ...MORE_SURFACES].map((s) => s.view);
  expect(new Set(all).size, `重複:\n${all.join(", ")}`).toBe(all.length);
  // 実行タブの会話が、管理の一覧にも顔を出していない
  expect(all).not.toContain(RUN_VIEW);
});

test("「今日」に会話欄を置かない", () => {
  // HOMEのエージェント欄と実行タブのチャットで、同じことを2か所で
  // やっていた。会話は1つに寄せる。
  expect(TODAY_WIDGETS).not.toContain("agent" as WidgetId);
  // 会話以外のウィジェットは全部載っている（畳んだ拍子に落ちていない）
  expect(new Set(TODAY_WIDGETS)).toEqual(
    new Set(DEFAULT_ORDER.filter((id) => id !== "agent")),
  );
});

test("会話にかぶせて開く作業場は、管理からも開ける", () => {
  // 実行タブから `#` で開ける重い画面（コード・ボード・つくる）は、
  // `#` を知らない人のために管理側にも入口が要る。
  const inManage = new Set([...MANAGE_SURFACES, ...MORE_SURFACES].map((s) => s.view));
  for (const v of OVERLAY_VIEWS) {
    expect(inManage.has(v), `${v} が管理からたどれない`).toBeTruthy();
  }
});

test("持ち主だけの画面が、他の人に案内されない", () => {
  // 副業（収益）は持ち主専用。ここが漏れると、他の人に押せない物が見える。
  const income = MORE_SURFACES.find((m) => m.view === "income");
  expect(income?.ownerOnly).toBeTruthy();
});
