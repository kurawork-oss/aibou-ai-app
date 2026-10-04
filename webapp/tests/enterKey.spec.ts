/**
 * Enter の扱い（lib/enterKey.ts）。
 *
 * 日本語は変換の確定にも Enter を押す。その Enter で送る・保存すると、
 * 書きかけが入る。Safari は確定の Enter に isComposing を付けず、
 * keyCode 229 で送ってくるので、両方を見ないと Safari でだけ起きる。
 *
 * 欄ごとに書き写すと抜けが出る（覚えてほしいこと・手順の名前・台の名前の欄は、
 * isComposing すら見ていなかった）。決まりを1か所に置き、**欄が直に Enter を
 * 見ていないこと**もここで見張る。
 */

import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { enterSends, enterSubmits, isComposingKey, type KeyLike } from "../src/lib/enterKey";

const key = (over: Partial<KeyLike> = {}): KeyLike => ({
  key: "Enter", keyCode: 13, shiftKey: false, ctrlKey: false, metaKey: false,
  nativeEvent: { isComposing: false }, ...over,
});

test("1行の欄: Enter で決定。変換中・Safari の確定（229）では決定しない", () => {
  expect(enterSubmits(key())).toBe(true);
  expect(enterSubmits(key({ nativeEvent: { isComposing: true } }))).toBe(false);
  expect(enterSubmits(key({ keyCode: 229 }))).toBe(false);
  expect(enterSubmits(key({ isComposing: true }))).toBe(false);     // ふつうの KeyboardEvent
  expect(enterSubmits(key({ key: "a", keyCode: 65 }))).toBe(false);
});

test("会話欄: Enter で送る。Shift+Enter は改行、Ctrl/Cmd+Enter は送る、変換中は送らない", () => {
  expect(enterSends(key())).toBe(true);
  expect(enterSends(key({ shiftKey: true }))).toBe(false);
  expect(enterSends(key({ ctrlKey: true }))).toBe(true);
  expect(enterSends(key({ metaKey: true }))).toBe(true);
  expect(enterSends(key({ keyCode: 229 }))).toBe(false);
  expect(enterSends(key({ keyCode: 229, ctrlKey: true }))).toBe(false);   // 確定は確定
  expect(isComposingKey(key({ keyCode: 229 }))).toBe(true);
});

test("欄が Enter を直に見ていない（変換の確定で送ってしまう欄を作らない）", () => {
  const dir = join(process.cwd(), "src", "components");
  // 例外は、日本語を打たない欄だけ（暗証番号）
  const allowed = new Set(["EntryGate.tsx"]);
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
    if (allowed.has(f)) continue;
    readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
      if (!/key === "Enter"/.test(line)) return;
      // 変換中を先に除いている所は良い（ボードの名札・# の一覧）
      if (/isComposingKey\(e\)/.test(line)) return;
      bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  // # の一覧は、関数の頭で isComposingKey を見てから Enter を見る
  const palette = readFileSync(join(dir, "CommandPalette.tsx"), "utf8");
  expect(palette).toMatch(/if \(isComposingKey\(e\)\) return;[\s\S]*e\.key === "Enter"/);
  expect(bad.filter((b) => !b.startsWith("CommandPalette.tsx")),
    `Enter を直に見ている欄（lib/enterKey.ts の enterSubmits / enterSends を使う）:\n${bad.join("\n")}`)
    .toEqual([]);
});
