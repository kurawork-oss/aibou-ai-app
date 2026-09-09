/**
 * 「先に何を設定すればいいか」の案内の検証。
 *
 * ここが弱いと、押した先で「401」「503」という数字だけが返ってきて、
 * 利用者は何をすればいいのか分からないまま止まる（実際にそうなった）。
 * 数字と英語ではなく、次にやることが出ることを確かめる。
 */

import { test, expect } from "@playwright/test";
import { explain, MODE_NEEDS, NEED, needMessage } from "../src/lib/needs";

/* ── 失敗の言い換え ──────────────────────────────────────────────── */
test("401 は「次に何をするか」まで書く", () => {
  // 「GitHub repos failed (401)」をそのまま出していたのが元の姿
  const m = explain(new Error("GitHub repos failed (401)"));
  expect(m).not.toContain("401");
  expect(m).toContain("サインアウト");         // 自分で試せること
  expect(m).toContain("SUPABASE_JWT_SECRET");  // 管理者にそのまま伝えられる名前
  // 設定名以外に英語の説明を混ぜない（読む人には意味が分からないため）
  expect(m.replace("SUPABASE_JWT_SECRET", "")).not.toMatch(/[A-Za-z]{4,}/);
});

test("403 は管理者専用だと伝える", () => {
  expect(explain(new Error("Income failed (403)"))).toContain("管理者専用");
});

test("503 は鍵の確認へ誘導する", () => {
  expect(explain(new Error("Forge failed (503)"))).toContain("KEYCHAIN");
});

test("429 は待つように伝える", () => {
  expect(explain(new Error("Chat failed (429)"))).toContain("待って");
});

test("通信できないときは、通信の話だと分かるようにする", () => {
  expect(explain(new TypeError("Failed to fetch"))).toContain("繋がりませんでした");
});

test("接続先が未設定なら、そう言う", () => {
  expect(explain(new Error("NEXT_PUBLIC_API_URL is not set."))).toContain("接続先");
});

test("知らないエラーは握りつぶさない", () => {
  // 「失敗しました」で潰すと、原因の手掛かりが消える
  expect(explain(new Error("Some new upstream problem"))).toContain("Some new upstream problem");
});

test("空でも何か返す", () => {
  expect(explain(null, "保存").length).toBeGreaterThan(0);
  expect(explain(undefined).length).toBeGreaterThan(0);
});

/* ── 足りないものの案内 ──────────────────────────────────────────── */
test("案内には、何が要るかと、どこで入れるかが入る", () => {
  const m = needMessage(NEED.GEMINI_API_KEY);
  expect(m).toContain("AIを動かすための利用券");   // やさしい言い方
  expect(m).toContain("KEYCHAIN");                 // 入れる場所
  expect(m).toContain("歯車");                     // 探し方
  expect(m).toContain("aistudio.google.com");      // 取りに行く場所
});

test("鍵の名前ではなく、何のためのものかを先に言う", () => {
  for (const need of Object.values(NEED)) {
    expect(need.label.length, need.key).toBeGreaterThan(4);
    // ラベル自体が英語の鍵名そのままになっていないこと
    expect(need.label).not.toBe(need.key);
  }
});

test("AIを使う画面には、AIの鍵が必要だと書いてある", () => {
  for (const mode of ["chat", "home", "vault", "studio", "capture", "sns", "code"]) {
    expect(MODE_NEEDS[mode], mode).toContain("GEMINI_API_KEY");
  }
});

test("鍵が無くても最後まで使える画面は、必要だと言わない", () => {
  // ホワイトボード（付箋・線・保存）はAIを使わない。それでも画面の頭に
  // 「先に設定が必要です」と出していて、使える物を使えないと言っていた。
  // AIを使うのは AUTOMATION タブだけなので、案内はそちらに置く。
  expect(MODE_NEEDS["board"]).toBeUndefined();
  expect(MODE_NEEDS["board_auto"]).toContain("GEMINI_API_KEY");
  // タスク・予定・ファイルも、鍵ではなくバックエンドの話（別の案内が出る）
  for (const mode of ["tasks", "archive", "board", "extend", "guide"]) {
    expect(MODE_NEEDS[mode], `${mode} が鍵を要求している`).toBeUndefined();
  }
});

test("無くても使える機能は、画面を止めない扱いにする", () => {
  // GitHub連携はCODEの一部。無いだけで画面全体を「使えない」にしない
  expect(NEED.GITHUB_TOKEN.optional).toBeTruthy();
  expect(NEED.GEMINI_API_KEY.optional).toBeFalsy();
});

test("必要な鍵は、KEYCHAINに実在する名前を指している", () => {
  // 存在しない鍵名を案内すると、設定画面で探しても見つからない
  const known = [
    "GEMINI_API_KEY", "GITHUB_TOKEN", "NOTION_TOKEN",
    "GOOGLE_CLIENT_ID", "EMAIL_ADDRESS",
  ];
  for (const [mode, keys] of Object.entries(MODE_NEEDS)) {
    for (const k of keys) {
      expect(known, `${mode} が知らない鍵を要求している: ${k}`).toContain(k);
      expect(NEED[k], `${k} の説明が無い`).toBeTruthy();
    }
  }
});
