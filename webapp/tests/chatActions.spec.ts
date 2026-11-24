/**
 * 会話の「できること」（lib/chatActions.ts）。
 *
 * 見張りたいのは2つ。
 *   1. 「タスク見せて」「声を変えて」「Gmail とつないで」だけの短い頼みは、その場で開く
 *   2. **少しでも中身がある頼み（仕事）は、横取りしない**（AIへ回す）
 * 2 が崩れると「タスクを3つ足して」が画面を開くだけで終わり、頼めなくなる。
 */

import { test, expect } from "@playwright/test";
import {
  ACTIONS, CONNECT_NAMES, filterActions, matchAction, readSlashInput, visibleActions,
} from "../src/lib/chatActions";
import { EXTENSIONS } from "../src/lib/extensions";

const hit = (t: string, ctx = {}) => {
  const m = matchAction(t, ctx);
  if (!m) return null;
  return m.kind === "action" ? m.action.id : `connect:${m.service}`;
};

test("画面を開く短い頼みは、その場で開く", () => {
  expect(hit("タスク見せて")).toBe("tasks");
  expect(hit("タスクを開いて")).toBe("tasks");
  expect(hit("やることリストを見せてください")).toBe("tasks");
  expect(hit("ボード")).toBe("board");
  expect(hit("ファイルを見せて")).toBe("files");
  expect(hit("今日の画面を開いて")).toBe("today");
  expect(hit("説明書を開いて")).toBe("guide");
  expect(hit("連携の画面を出して")).toBe("extend");
  expect(hit("ＳＮＳを開いて")).toBe("sns"); // 全角でも
});

test("設定を変える短い頼みは、そのタブで開く", () => {
  expect(hit("声を変えて")).toBe("look");
  expect(hit("テーマを変えたい")).toBe("look");
  expect(hit("設定")).toBe("settings");
  expect(hit("設定を開いて")).toBe("settings");
  expect(hit("名前を変えて")).toBe("settings");
  expect(hit("記憶を見せて")).toBe("memory");
  expect(hit("手元のPCの設定を開いて")).toBe("pc");
});

test("つなぐ短い頼みは、そのサービスのつなぎ方を開く", () => {
  expect(hit("Gmailとつないで")).toBe("connect:google");
  expect(hit("gmail と つないで")).toBe("connect:google");
  expect(hit("Googleカレンダーと連携したい")).toBe("connect:google");
  expect(hit("LINEと連携して")).toBe("connect:line");
  expect(hit("Slackにつなげて")).toBe("connect:slack");
  expect(hit("Notionを使えるようにして")).toBe("connect:notion");
});

test("カメラ操作を始める頼み", () => {
  expect(hit("カメラ操作を始めて")).toBe("camera");
  expect(hit("カメラで操作したい")).toBe("camera");
});

test("中身のある頼み（仕事）は、横取りしない", () => {
  for (const t of [
    "タスクを3つ追加して",
    "今日の予定を教えて",
    "ボードに案をまとめて",
    "声が小さいのはなぜ？",
    "Gmailで山田さんにメールを送って",
    "設定ファイルを書いて",
    "カレンダーを見せて",       // 予定を読むのはAIの仕事（つなぐ画面ではない）
    "LINEで家族に連絡して",
    "このファイルを要約して",
    "",
    "タスク".repeat(10),
  ]) {
    expect(hit(t), t).toBeNull();
  }
});

test("持ち主だけの物・切った機能は、頼んでも開かない", () => {
  expect(hit("副業を開いて", { isOwner: true })).toBe("income");
  expect(hit("副業を開いて", { isOwner: false })).toBeNull();
  expect(hit("コードを開いて", { packs: ["make"] })).toBeNull();
  expect(hit("コードを開いて", { packs: ["dev"] })).toBe("code");
  expect(visibleActions(ACTIONS, { isOwner: false }).some((a) => a.id === "income")).toBe(false);
  // 分からないうち（null）は絞らない
  expect(visibleActions(ACTIONS, {}).some((a) => a.id === "income")).toBe(true);
});

test("「/」で打ちながら絞る", () => {
  expect(readSlashInput("/たす")).toEqual({ active: true, query: "たす" });
  expect(readSlashInput("／声")).toEqual({ active: true, query: "声" });
  expect(readSlashInput("/タスク 足して").active).toBe(false); // 空白のあとは普通の文
  expect(readSlashInput("こんにちは").active).toBe(false);
  expect(filterActions(ACTIONS, "たす")[0].id).toBe("tasks");
  expect(filterActions(ACTIONS, "声")[0].id).toBe("look");
  expect(filterActions(ACTIONS, "")).toHaveLength(ACTIONS.length);
});

test("つなぐ先の名前が、連携の画面に実在する", () => {
  const ids = new Set(EXTENSIONS.map((e) => e.id));
  for (const c of CONNECT_NAMES) expect(ids.has(c.service), c.service).toBe(true);
});

test("一覧の名前と印がそろっている（空や重複が無い）", () => {
  const ids = ACTIONS.map((a) => a.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const a of ACTIONS) {
    expect(a.label.trim(), a.id).not.toBe("");
    expect(a.hint.trim(), a.id).not.toBe("");
    expect(a.mark.trim(), a.id).not.toBe("");
  }
});
