/**
 * 「開いた人に、何をする画面か伝わるか」の見張り。
 *
 * 点検で分かったこと: 説明のあるモードと無いモードが混ざっていた。
 * VAULT は空の一覧が出るだけで、「ノートブック」が何なのか、作ると何が起きるのかが
 * 分からないまま止まる。説明書には正しく書いてあったのに、画面には出ていなかった。
 *
 * 説明書を開かないと分からない、では説明書を開かない人に届かない。
 * 各モードの冒頭に一言あることを、ここで固定する。
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

test("資料（VAULT）が何をする画面か言っている", () => {
  const v = src("components/Vault.tsx");
  expect(v).toContain("資料 とは");
  // この画面の値打ちは「入れた資料の中身だけを見て答える」こと
  expect(v).toContain("入れた資料の中身だけを見て答える");
  // 読めないPDFがあることを、詰まる前に伝える
  expect(v).toContain("スキャンした写真だけのPDFは読めません");
});

test("VAULT の空状態が、次にやることを言っている", () => {
  const v = src("components/Vault.tsx");
  // 「ノートブックがまだありません」だけだと、何を作ればいいか分からない
  expect(v).toContain("まず");
  expect(v).toContain("入れ物");
  // 例が無いと、名前の付け方から迷う
  expect(v).toMatch(/社内規程/);
  // 専門用語をそのまま出さない
  expect(v).not.toContain("Supabase未接続の場合はここに表示されません");
});

test("SNS が、何を入れて何が返るか言っている", () => {
  const s = src("components/SnsMode.tsx");
  expect(s).toContain("投稿先ごとの書き方に合わせた文案");
});

test("CODE が何をする画面か言っている", () => {
  const c = src("components/CodeMode.tsx");
  expect(c).toContain("その場で動かして確かめる画面です");
});

test("ホワイトボードは、空のときだけ使い方を出す", () => {
  const w = src("components/Whiteboard.tsx");
  expect(w).toContain("考えを広げる場所です");
  // 作業中に出しっぱなしにしない（キャンバスが主役）
  expect(w).toMatch(/nodes\.length === 0 &&/);
  // 操作を邪魔しない
  expect(w).toContain("pointer-events-none");
});

test("手順を実行する3モードは、どれも違いを説明する", () => {
  // 説明が1か所にしか無いと、他の2つから入った人は選べない
  for (const f of ["Autopilot", "Studio", "Dashboard"]) {
    expect(src(`components/${f}.tsx`), `${f} に説明が無い`).toContain("StepRunnersNote");
  }
  const note = src("components/StepRunnersNote.tsx");
  for (const name of ["オートパイロット", "ワークフロー", "自動化"]) {
    expect(note).toContain(name);
  }
});
