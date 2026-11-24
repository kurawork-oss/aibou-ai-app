/**
 * ペット（lib/pets.ts）。コアの状態 → ペットの様子 の対応を見張る。
 *
 * ChatGPT のペットと同じく、いちばん大事なのは「確認待ち」を見落とさせないこと。
 * 承認・連携待ちは、作業中より目立つ様子（needs_input）にする。
 */

import { test, expect } from "@playwright/test";
import { DEFAULT_PET, PETS, PET_OFF, moodOf, petById, petSays, readPet } from "../src/lib/pets";
import type { CoreState } from "../src/lib/coreState";

const ALL: CoreState[] = [
  "idle", "listening", "thinking", "planning", "working", "speaking",
  "waiting_user", "setup_required", "completed", "error",
];

test("確認待ち（承認・連携）は「確認待ち」、失敗は「困った」、終わりは「できた」", () => {
  expect(moodOf("waiting_user")).toBe("needs_input");
  expect(moodOf("setup_required")).toBe("needs_input");
  expect(moodOf("error")).toBe("blocked");
  expect(moodOf("completed")).toBe("ready");
  for (const s of ["thinking", "planning", "working", "speaking"] as CoreState[]) {
    expect(moodOf(s), s).toBe("running");
  }
  expect(moodOf("listening")).toBe("listening");
  expect(moodOf("idle")).toBe("idle");
});

test("待機中は何も言わない。それ以外は一言ある", () => {
  expect(petSays("idle")).toBe("");
  for (const s of ALL.filter((x) => x !== "idle")) expect(petSays(s), s).not.toBe("");
});

test("ペットは名前・説明がそろい、重ならない。既定の子がいる", () => {
  const ids = PETS.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).not.toContain(PET_OFF);
  expect(petById(DEFAULT_PET)).toBeTruthy();
  for (const p of PETS) {
    expect(p.name.trim(), p.id).not.toBe("");
    expect(p.about.trim(), p.id).not.toBe("");
  }
  expect(PETS.length).toBeGreaterThanOrEqual(3);
});

test("覚えられない端末では、既定の子を出す", () => {
  expect(readPet()).toBe(DEFAULT_PET);
});

/* ── 会話からの呼び方（lib/chatActions.ts） ─────────────────────── */

import { matchAction } from "../src/lib/chatActions";

const said = (t: string) => {
  const m = matchAction(t);
  if (!m) return null;
  if (m.kind === "connect") return `connect:${m.service}`;
  return m.kind === "pet-hide" ? "pet-hide" : m.action.id;
};

test("「ペット変えて」「ペットを選びたい」「ペット」は、選ぶ窓", () => {
  for (const t of ["ペット変えて", "ペットを変えたい", "ペットを選びたい", "ペット見せて", "ペット出して", "ペット", "/ペット".slice(1)]) {
    expect(said(t), t).toBe("pet");
  }
});

test("「ペット隠して」「ペット消して」は、その場で隠す", () => {
  for (const t of ["ペット隠して", "ペットを消して", "ペットをしまって", "ペット非表示にして"]) {
    expect(said(t), t).toBe("pet-hide");
  }
});

test("ペットの話をしているだけの文は、AIへ回す", () => {
  for (const t of ["ペットの名前を考えて", "ペットを飼いたい", "猫のペットについて教えて", "ペットショップを探して"]) {
    expect(said(t), t).toBeNull();
  }
});
