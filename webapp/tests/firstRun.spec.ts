/**
 * 初回設定の案内の検証。
 *
 * ここを間違えると害が両方向に出る:
 *  - 済んでいる人に出し続ける → うるさいだけで、次から誰も読まない
 *  - 済んでいない人に出さない → 「保存されていない」に後から気づく（実際に起きた）
 * さらに、繋がっていないだけのときに「鍵を入れて」と促すと原因を誤解させる。
 */

import { test, expect } from "@playwright/test";
import {
  firstRunComplete, firstRunSteps, shouldShowFirstRun, type FirstRunInput,
} from "../src/lib/firstRun";

const NOTHING: FirstRunInput = { keys: [], db: { connected: false }, guideTouched: false };
const ALL_DONE: FirstRunInput = {
  keys: [{ name: "GEMINI_API_KEY", set: true }],
  db: { connected: true },
  guideTouched: true,
};

test("何も設定していない人には3つとも残る", () => {
  const steps = firstRunSteps(NOTHING);
  expect(steps.filter((s) => !s.done)).toHaveLength(3);
  expect(shouldShowFirstRun(NOTHING, false)).toBe(true);
  expect(firstRunComplete(NOTHING)).toBe(false);
});

test("全部済んだら、もう出さない", () => {
  expect(firstRunComplete(ALL_DONE)).toBe(true);
  expect(shouldShowFirstRun(ALL_DONE, false)).toBe(false);
});

test("「あとで」を押した人には出さない", () => {
  expect(shouldShowFirstRun(NOTHING, true)).toBe(false);
});

test("鍵は GEMINI でも HF でも足りる", () => {
  const hf: FirstRunInput = { ...NOTHING, keys: [{ name: "HF_TOKEN", set: true }] };
  expect(firstRunSteps(hf).find((s) => s.key === "ai-key")?.done).toBe(true);
});

test("欄はあるが未入力の鍵は「済み」にしない", () => {
  // GET /keys は未設定の鍵も set:false で返す。存在するだけで済み扱いにしない。
  const empty: FirstRunInput = { ...NOTHING, keys: [{ name: "GEMINI_API_KEY", set: false }] };
  expect(firstRunSteps(empty).find((s) => s.key === "ai-key")?.done).toBe(false);
});

test("関係ない鍵だけでは「済み」にしない", () => {
  const other: FirstRunInput = { ...NOTHING, keys: [{ name: "GITHUB_TOKEN", set: true }] };
  expect(firstRunSteps(other).find((s) => s.key === "ai-key")?.done).toBe(false);
});

test("状態が取れないときは案内を出さない（繋がっていないのが原因のため）", () => {
  const blind: FirstRunInput = { keys: null, db: null, guideTouched: false };
  expect(shouldShowFirstRun(blind, false)).toBe(false);
  expect(firstRunComplete(blind)).toBe(false);   // 済んだ扱いにもしない
});

test("片方だけ取れたときは、取れた分で判定する", () => {
  const half: FirstRunInput = { keys: null, db: { connected: true }, guideTouched: false };
  expect(shouldShowFirstRun(half, false)).toBe(true);
  expect(firstRunSteps(half).find((s) => s.key === "db")?.done).toBe(true);
});

test("案内文に、押す場所が書いてある", () => {
  // 「設定してください」だけでは、どこを押すか分からないまま止まる
  for (const s of firstRunSteps(NOTHING)) {
    expect(s.hint.length).toBeGreaterThan(10);
    expect(s.title).not.toMatch(/[A-Za-z]{4,}/);   // 見出しは日本語だけ
  }
  const key = firstRunSteps(NOTHING).find((s) => s.key === "ai-key")!;
  // 連携は1画面に寄せたので、案内もそこを指す。
  // 呼び名はナビに出ている言葉（「連携」）と揃える。
  expect(key.hint).toContain("連携");
  const db = firstRunSteps(NOTHING).find((s) => s.key === "db")!;
  // 放置したときに何が起きるかを言う。以前は「消えます」だったが、
  // 黙って消すのをやめて、その場で断るようにしたので文言も変えた
  expect(db.hint).toContain("保存できません");
});
