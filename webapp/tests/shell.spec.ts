/**
 * 画面を「会話」1つにした対応表の検証（ui-r126）。
 *
 * ここで守りたいのは1点だけ。
 *
 *   **入口を会話にまとめただけで、画面は1つも消していない。**
 *
 * ナビを無くしたとき、いちばん起きやすい事故は「どこからも開けない画面が
 * できる」こと。しかも壊れ方が静かで、その画面を使わない人は気づかない。
 * だから View の一覧と、会話の「できること」（lib/chatActions.ts）を
 * 突き合わせる。新しい画面を足して載せ忘れたら、ここで落ちる。
 */

import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OVERLAY_VIEWS, TODAY_WIDGETS, VIEWS, isView } from "../src/lib/shell";
import { ACTIONS } from "../src/lib/chatActions";
import { DEFAULT_ORDER, type WidgetId } from "../src/lib/homeLayout";

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const api = (p: string) => readFileSync(join(process.cwd(), "..", "api", p), "utf8");
const viewTargets = ACTIONS.flatMap((a) => (a.target.kind === "view" ? [a.target.view] : []));

test("会話から呼べない画面が生まれていない", () => {
  const reachable = new Set<string>(["chat", ...viewTargets]);
  const orphans = VIEWS.filter((v) => !reachable.has(v));
  expect(orphans, `どこからも開けない画面:\n${orphans.join(", ")}`).toEqual([]);
});

test("画面の一覧が1か所にしかない", () => {
  expect(src("app/page.tsx")).not.toMatch(/type View =\s*"/);
  expect(src("app/page.tsx")).toContain("type View = ShellView");
});

test("行き先を選ばせるナビが、もう無い（入口は会話の「＋」1つ）", () => {
  const page = src("app/page.tsx");
  expect(page).not.toContain("function MobileNav");
  expect(page).not.toContain("function ManageBar");
  expect(page).not.toContain("function DesktopTabs");
  expect(page).not.toMatch(/aria-label="画面の切り替え"/);
});

test("サーバーが案内する飛び先が、実在する画面である", () => {
  const targets = [...api("capabilities.py").matchAll(/"view":\s*"([a-z]+)"/g)].map((m) => m[1]);
  expect(targets.length, "capabilities.py の view が読めていない").toBeGreaterThan(3);
  const dead = [...new Set(targets)].filter((v) => !isView(v));
  expect(dead, `実在しない飛び先:\n${dead.join(", ")}`).toEqual([]);
});

test("同じ画面が「できること」に2回載っていない・会話そのものは載っていない", () => {
  expect(new Set(viewTargets).size, `重複:\n${viewTargets.join(", ")}`).toBe(viewTargets.length);
  expect(viewTargets).not.toContain("chat");
});

test("「今日」に会話欄を置かない", () => {
  expect(TODAY_WIDGETS).not.toContain("agent" as WidgetId);
  expect(new Set(TODAY_WIDGETS)).toEqual(new Set(DEFAULT_ORDER.filter((id) => id !== "agent")));
});

test("重い作業場（コード・ボード・つくる）も、会話から開ける", () => {
  for (const v of OVERLAY_VIEWS) expect(viewTargets, `${v} が会話から開けない`).toContain(v);
});

test("持ち主だけの画面が、他の人に案内されない", () => {
  expect(ACTIONS.find((a) => a.target.kind === "view" && a.target.view === "income")?.ownerOnly).toBeTruthy();
});

/* ── 無くした入口で案内していないか ──────────────────────────────
 *
 * ナビを無くしたあとも、文言に「管理 → もっと →「連携」」が残っていた
 * （鍵の入れ方・保存先の案内・作った物の在り処）。押す所が無い案内は、
 * 案内が無いより悪い。サーバー側の文は api/test_screen_names.py で見ている。
 * 数えるのは文字列だけ（コメントは経緯の記録なので外す）。 */
const OLD_NAV = /管理\s?→|もっと\s?→|「管理」|「もっと」|管理タブ|下のナビ/;

function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")          // /* … */ と {/* … */}
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");     // // …（https:// は残す）
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

test("画面の文言が、無くした入口（管理・もっと・下のナビ）を指していない", () => {
  const bad: string[] = [];
  const files = sourceFiles(join(process.cwd(), "src"));
  expect(files.length, "読めたファイルが少ない（見張りが空振りしている）").toBeGreaterThan(50);
  for (const file of files) {
    withoutComments(readFileSync(file, "utf8")).split("\n").forEach((line, i) => {
      if (OLD_NAV.test(line)) bad.push(`${file.replace(process.cwd() + "/", "")}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  expect(bad, `無くした入口で案内している:\n${bad.join("\n")}`).toEqual([]);
});

test("見張りが空振りしていない", () => {
  for (const s of ["管理 → もっと →「連携」", "管理 →「ボード」で確認できます", "下のナビの裏"]) {
    expect(OLD_NAV.test(s), s).toBe(true);
  }
  for (const s of ["在庫管理アプリ", "「もっと〇〇して」", "入力欄の「＋」→「連携」"]) {
    expect(OLD_NAV.test(s), s).toBe(false);
  }
  // コメントは数えない・文字列の中の https:// は消さない
  expect(withoutComments('// 管理 → もっと\nconst a = "https://x";')).toBe('\nconst a = "https://x";');
});
