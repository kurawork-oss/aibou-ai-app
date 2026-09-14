/**
 * 秘密を、端末の記憶に入れない（仕様§12・§22）。
 *
 * なぜ端末側にも要るのか
 * ----------------------
 * 記憶は端末の中（IndexedDB）とサーバー側の両方にある。サーバー側だけで
 * 止めても、**端末に残った鍵は合流でサーバーへ上がる**。
 *
 * そして記憶はあとで会話に混ぜてAIへ渡る。一度でも鍵を口にすると、
 * 以後ずっと毎回それが送られる。
 *
 * 行き過ぎにも気をつける。「パスワードを変えた」のような**値を含まない文**
 * まで弾くと、生活の記録が穴だらけになり、本人には理由も分からない。
 */

import { test, expect } from "@playwright/test";
import { hasSecret, secretReason, redact, MASK } from "../src/lib/secretsGuard";
import { worthRemembering } from "../src/lib/worthRemembering";

/* 見本の鍵は、**その場で組み立てる**。
   本物そっくりの文字列をファイルに直接書くと、GitHub の秘密検出に
   引っかかって push そのものが止まる（実際に止まった）。中身は作り物だが、
   形が本物と同じなのだから当然で、検出側が正しい。
   頭の印だけ残して、続きをここで伸ばす。試したいのは「その形を見つけ
   られるか」なので、これで足りる。 */
const BODY = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(3);
const fake = (prefix: string, n = 36) => prefix + BODY.slice(0, n);

const SECRETS = [
  fake("AIza", 35),                                   // Google
  fake("sk-" + "ant-api03-", 36),                     // Anthropic
  fake("hf_", 34),                                    // HuggingFace
  fake("gh" + "p_", 36),                              // GitHub
  "xox" + "b-123456789012-1234567890123-" + BODY.slice(0, 24),   // Slack
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0." + BODY.slice(0, 20),
  "postgresql://user:hunter2@db.example.com:5432/postgres",
];

const SAFE = [
  "甲殻類アレルギーがある",
  "打ち合わせは毎週火曜の15時から",
  "パスワードを変えた",
  "GEMINI_API_KEY を設定した",
  "田中さんのメールは tanaka@example.com",
  "注文番号は A1B2C3D4",
];

for (const text of SECRETS) {
  test(`鍵は弾く: ${text.slice(0, 18)}…`, () => {
    expect(hasSecret(text)).toBe(true);
    const why = secretReason(text);
    expect(why).toBeTruthy();
    // 理由に鍵そのものを載せない（理由は画面に出る）
    expect(why).not.toContain(text.slice(0, 18));
  });
}

for (const text of SAFE) {
  test(`ふつうの文は覚える: ${text.slice(0, 14)}`, () => {
    expect(hasSecret(text)).toBe(false);
  });
}

test("「パスワードは ○○」は弾くが、「変えた」は残す", () => {
  expect(hasSecret("Wi-Fiのパスワードは Tr0ub4dor&3xK9 です")).toBe(true);
  expect(hasSecret("パスワードを変えた")).toBe(false);
});

test("「覚えて」と頼まれても、鍵は入れない", () => {
  /* ここが肝心。「このキー覚えといて」は、いちばん入りそうな言い方で、
     しかも「覚えて」の判定は他の条件より先に効く。順番を間違えると
     素通りする。 */
  const v = worthRemembering(`このキー覚えといて ${fake("sk-" + "ant-api03-", 36)}`);
  expect(v.keep).toBe(false);
  expect(v.why).toContain("キー");
});

test("ふつうの「覚えて」は、これまで通り覚える", () => {
  const v = worthRemembering("甲殻類アレルギーがあるって覚えといて");
  expect(v.keep).toBe(true);
});

test("伏せると、鍵が消えて文は残る", () => {
  const out = redact(`キーは ${fake("sk-" + "ant-api03-", 36)} だよ`);
  expect(out).not.toContain("ant-api03");
  expect(out).toContain("キーは");
  expect(out).toContain(MASK);
});

test("伏せた文には、もう秘密が無い", () => {
  for (const text of SECRETS) {
    expect(hasSecret(redact(text)), `伏せきれていない: ${text.slice(0, 20)}`).toBe(false);
  }
});

test("ふつうの文は、伏せても変わらない", () => {
  for (const text of SAFE) expect(redact(text)).toBe(text);
});

test("端末とサーバーが、同じ形を見ている", async () => {
  /* 片方だけ直すと、端末で弾いた物がサーバーで通る（またはその逆）。
     合流で上げ下げするので、**ずれた瞬間に片側が漏れる**。

     突き合わせるのは「見ている形の名前」。正規表現そのものを比べると、
     書き方の違いだけで落ちて、意味の無い赤になる。 */
  const fs = await import("node:fs/promises");
  /* 表の1行だけを拾う。行をまたがない形に絞らないと、説明文まで
     引っかかって、何が違うのか読めない差分になる（最初そうなった）。 */
  const pick = (text: string, re: RegExp) =>
    new Set([...text.matchAll(re)].map((m) => m[1]));

  const here = pick(await fs.readFile("src/lib/secretsGuard.ts", "utf-8"),
    /\[\s*"([^"\n]+)",\s*\//g);
  const there = pick(await fs.readFile("../api/secrets_guard.py", "utf-8"),
    /\(\s*"([^"\n]+)",\s*re\.compile/g);

  expect(here.size, "端末側の一覧が読めていない（この確認が空振りしている）")
    .toBeGreaterThan(5);
  const onlyHere = [...here].filter((n) => !there.has(n));
  const onlyThere = [...there].filter((n) => !here.has(n));
  expect({ onlyHere, onlyThere }).toEqual({ onlyHere: [], onlyThere: [] });
});
