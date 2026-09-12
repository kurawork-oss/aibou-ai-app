/**
 * 「その発言を覚えるか」の線引き。
 *
 * ここが崩れると何が起きるか
 * --------------------------
 * ゆるすぎると、長期記憶が「うん」「どう？」で埋まる。AIへ渡せるのは
 * 6件なので、そのぶん本当に効く記憶が届かない。
 *
 * **きつすぎるほうが怖い。** 覚えるべきことを覚えなかった場合、本人には
 * それが見えない——「なんとなく賢くない」としか感じられず、不具合として
 * 報告されない。しかも、そのとき元の発言はもう残っていない。
 *
 * なので下の表は、**入れる側を厚く**書いてある。迷う形は入れる。
 */

import { test, expect } from "@playwright/test";
import { worthRemembering } from "../src/lib/worthRemembering";

/* ── 覚えるべき物（ここが落ちるのがいちばん困る） ─────────────────── */

const KEEP = [
  "甲殻類アレルギーがある",
  "打ち合わせは毎週火曜の15時から",
  "妹の誕生日は3月12日",
  "コーヒーはブラック。砂糖は入れない",
  "猫を飼っている。名前はミケ",
  "健康診断は毎年10月",
  "実家は北海道",
  "来月の沖縄旅行が楽しみだ",
  "パスワードマネージャは 1Password を使っている",
  "朝はだいたい7時に起きる",
  // 言い切らない形。事実を含んでいるので残す
  "最近ちょっと腰が痛い",
  "週末はたいてい家にいる",
  // 少し長い独り言も、あとで効くことがある
  "転職を考えているけど、いまの職場の人間関係は悪くない",
  // 英語
  "I am allergic to shellfish",
];

for (const text of KEEP) {
  test(`覚える: ${text}`, () => {
    const v = worthRemembering(text);
    expect(v.keep, `外された理由: ${v.why}`).toBeTruthy();
  });
}

/* ── 覚えなくてよい物 ───────────────────────────────────────────── */

const SKIP: [string, string][] = [
  ["うん", "相づち"],
  ["ありがとう", "相づち"],
  ["OK", "相づち"],
  ["了解", "相づち"],
  ["なるほど", "相づち"],
  ["お願いします", "相づち"],
  ["はい", "相づち"],
  ["次", "相づち"],
  ["どう？", "問いかけ"],
  ["できた？", "問いかけ"],
  ["猫の名前教えて", "指示・問いかけ"],
  ["これ直して", "指示"],
  ["もう一回やって", "指示"],
  ["一覧を出して", "指示"],
  ["明日の予定を見せて", "指示"],
  ["요약", "短すぎる"],
];

for (const [text, why] of SKIP) {
  test(`覚えない（${why}）: ${text}`, () => {
    const v = worthRemembering(text);
    expect(v.keep, `入ってしまった: ${text}`).toBeFalsy();
  });
}

/* ── 「覚えて」と言われたとき ───────────────────────────────────── */

test("「覚えて」と言われたら、必ず覚える", () => {
  const v = worthRemembering("私は猫アレルギーです。覚えておいて");
  expect(v.keep).toBeTruthy();
  expect(v.importance, "頼まれた記憶が、ふつうの扱いになっている").toBe(2);
});

test("「覚えて」は、ほかの条件より先に効く", () => {
  /* 「この番号覚えて」は命令形でもある。判定の順番を間違えると、
     **頼まれた物を落とす**——いちばん困る外し方。 */
  for (const text of ["この番号覚えて", "覚えといて", "忘れないでね、火曜は休み"]) {
    const v = worthRemembering(text);
    expect(v.keep, `「${text}」が落ちた（理由: ${v.why}）`).toBeTruthy();
    expect(v.importance).toBe(2);
  }
});

test("「覚えておいて」の前置きは、保存する文から外す", () => {
  // 「覚えておいて」自体が記憶の中身に混ざると、あとで読んで邪魔になる
  const v = worthRemembering("火曜は休みです。覚えておいて");
  expect(v.text).toContain("火曜は休み");
  expect(v.text).not.toContain("覚えて");
});

test("前置きしか無いときは、文を空にしない", () => {
  // 「覚えておいて」だけ送られたとき、中身が空の記憶を作らない
  const v = worthRemembering("覚えておいて");
  expect(v.text.trim().length, "空の記憶ができている").toBeGreaterThan(0);
});

/* ── 端で壊れないこと ───────────────────────────────────────────── */

test("空文字や空白で落ちない", () => {
  for (const text of ["", "   ", "\n"]) {
    expect(worthRemembering(text).keep).toBeFalsy();
  }
});

test("とても長い文でも判定できる", () => {
  const long = "私は" + "あ".repeat(5000) + "が好きです";
  expect(worthRemembering(long).keep).toBeTruthy();
});

test("外した理由が必ず残る（あとで調べられる）", () => {
  const v = worthRemembering("うん");
  expect(v.keep).toBeFalsy();
  expect(v.why.length, "なぜ外したのか分からない").toBeGreaterThan(0);
});

/* ── 上限に達したとき、何から捨てるか ───────────────────────────── */

import { dropOrder, type MemoryItem } from "../src/lib/memory";

const DAY = 86_400_000;
const item = (over: Partial<MemoryItem>): MemoryItem => ({
  id: String(Math.random()), text: "", kind: "note", importance: 0,
  createdAt: 0, updatedAt: 0, source: "me", ...over,
});

test("昨日の雑談より、半年前の事実を残す", () => {
  /* ここが「大事さ→古い順」だけだった頃、**昨日の「うん」が残って
     半年前の「甲殻類アレルギー」が消えた**。どちらも大事さ0なら古いほうから
     捨てるので、毎日入ってくる会話が必ず勝ってしまう。
     長期記憶としては逆で、古くても効き続ける物のほうが価値がある。 */
  const now = Date.now();
  const old = item({ text: "甲殻類アレルギー", kind: "fact", updatedAt: now - 180 * DAY });
  const fresh = item({ text: "さっきの話", kind: "note", updatedAt: now });

  const order = dropOrder([old, fresh]);
  expect(order[0].text, "半年前の事実のほうが先に捨てられている").toBe("さっきの話");
});

test("会話から拾った物どうしなら、古いほうから捨てる", () => {
  const now = Date.now();
  const a = item({ text: "古い話", updatedAt: now - 10 * DAY });
  const b = item({ text: "新しい話", updatedAt: now });
  expect(dropOrder([b, a])[0].text).toBe("古い話");
});

test("大事と印を付けた物は、印の無い物より後に残る", () => {
  const now = Date.now();
  const marked = item({ text: "大事な話", importance: 2, updatedAt: now - 100 * DAY });
  const plain = item({ text: "ふつうの話", importance: 0, updatedAt: now - 1 * DAY });
  expect(dropOrder([marked, plain])[0].text).toBe("ふつうの話");
});

test("事実どうしなら、大事さ→古さで決まる", () => {
  const now = Date.now();
  const low = item({ text: "印なしの事実", kind: "fact", importance: 0, updatedAt: now });
  const high = item({ text: "大事な事実", kind: "fact", importance: 2, updatedAt: now - 300 * DAY });
  expect(dropOrder([high, low])[0].text).toBe("印なしの事実");
});
