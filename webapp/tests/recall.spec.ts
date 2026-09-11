/**
 * 端末の中で「関係のある記憶」を引く所の検証。
 *
 * ここが崩れると何が起きるか
 * --------------------------
 * 引けなさすぎると「覚えていない人」になり、引けすぎると関係のない
 * 話を毎回持ち出す人になる。どちらも壊れているとは見えないので、
 * 誰も不具合として報告しない——**黙って質が落ちる**種類の機能。
 *
 * だから「この問いにはこれが出る／これは出ない」を、実例で固定する。
 * 下の例は、作っている最中に実際に外した／直したものを含む。
 */

import { test, expect } from "@playwright/test";
import { normalize, recall, terms, toBlock, type Recallable } from "../src/lib/recall";

/** ふつうの人が覚えさせそうなこと。 */
const SAMPLE = [
  "打ち合わせは毎週火曜の15時から",
  "コーヒーはブラック。砂糖は入れない",
  "妹の誕生日は3月12日",
  "会社の経費精算は月末までに提出する",
  "猫を飼っている。名前はミケ",
  "健康診断は毎年10月",
  "Next.js のビルドは npm run build",
  "パスワードマネージャは 1Password を使っている",
  "本はだいたい Kindle で読む",
  "朝はだいたい7時に起きる",
];

const items: Recallable[] = SAMPLE.map((text, i) => ({
  id: String(i),
  text,
  importance: 0,
  updatedAt: Date.now() - i * 86_400_000,
}));

const top = (q: string) => recall(items, q, { limit: 3 })[0]?.item.text ?? "";

/* ── 引けること ─────────────────────────────────────────────────── */

test("聞き方が違っても、当たるべき記憶が1位に来る", () => {
  const cases: [string, string][] = [
    ["妹 誕生日", "妹の誕生日は3月12日"],
    ["コーヒー", "コーヒーはブラック。砂糖は入れない"],
    ["猫の名前は？", "猫を飼っている。名前はミケ"],
    ["ビルドのコマンド", "Next.js のビルドは npm run build"],
    ["10月に何かある？", "健康診断は毎年10月"],
    ["何時から打ち合わせ", "打ち合わせは毎週火曜の15時から"],
  ];
  for (const [q, want] of cases) {
    expect(top(q), `「${q}」で出たのは: ${top(q) || "（なし）"}`).toBe(want);
  }
});

test("送り仮名が違っても引ける（打合せ ↔ 打ち合わせ）", () => {
  /* 2文字ずつだけで引いていたときは、ここが**1件も当たらなかった**。
     打ち合わせ → 打ち/ち合/合わ/わせ
     打合せ     → 打合/合せ
     共通が無い。1文字ずつを足して直した所。 */
  expect(top("打合せ 何時")).toBe("打ち合わせは毎週火曜の15時から");
});

test("1文字だけの問いでも空にならない", () => {
  const hits = recall([...items, { id: "x", text: "犬は苦手" }], "犬");
  expect(hits[0]?.item.text).toBe("犬は苦手");
});

test("英数字は単語のまま引ける", () => {
  expect(top("1Password")).toContain("1Password");
  expect(top("npm run build")).toContain("npm run build");
});

test("全角・半角、大文字小文字の違いを吸収する", () => {
  expect(normalize("ＡＢＣ　１２３")).toBe("abc 123");
  expect(top("ＮＥＸＴ.ＪＳ")).toContain("Next.js");
});

/* ── 引きすぎないこと ───────────────────────────────────────────── */

test("関係のない問いでは、何も持ち出さない", () => {
  for (const q of ["今日の天気", "為替はどう", "おすすめの映画"]) {
    expect(recall(items, q), `「${q}」で何か出ている`).toEqual([]);
  }
});

test("漢字が1つかすっただけでは出さない", () => {
  /* 1文字ずつを足したとき、「今日の天気」で「妹の誕生日は3月12日」が
     出るようになった（当たっていたのは「日」だけ）。
     問い合わせのどれだけが当たったかも見るようにして直した所。 */
  const hits = recall(items, "今日の天気");
  expect(hits.map((h) => h.item.text)).not.toContain("妹の誕生日は3月12日");
});

test("助詞が一致しただけでは上位に来ない", () => {
  const hits = recall(items, "のはをに");
  expect(hits.length, `助詞だけで ${hits.length} 件出ている`).toBeLessThan(2);
});

/* ── 並び順 ─────────────────────────────────────────────────────── */

test("大事と印を付けた記憶が優先される", () => {
  const marked = items.map((i) => (
    i.text.startsWith("本は") ? { ...i, importance: 2 } : i));
  // どちらも「だいたい」を含む。印のあるほうが上に来ること
  const hits = recall(marked, "だいたい", { limit: 2 });
  expect(hits[0].item.text).toBe("本はだいたい Kindle で読む");
});

test("同じくらい関係するなら、新しいほうを少し優先する", () => {
  const now = Date.now();
  const two: Recallable[] = [
    { id: "old", text: "会議室はA室", updatedAt: now - 400 * 86_400_000 },
    { id: "new", text: "会議室はB室", updatedAt: now },
  ];
  expect(recall(two, "会議室", { now })[0].item.id).toBe("new");
});

test("古い記憶でも、関係していれば出る（新しさだけで消さない）", () => {
  const now = Date.now();
  const old: Recallable[] = [
    { id: "old", text: "実家の住所は北海道", updatedAt: now - 1000 * 86_400_000 },
    { id: "new", text: "今日の昼はカレー", updatedAt: now },
  ];
  expect(recall(old, "実家 住所", { now })[0].item.id).toBe("old");
});

/* ── 端で壊れないこと ───────────────────────────────────────────── */

test("記憶が無いとき・問いが空のときに落ちない", () => {
  expect(recall([], "なにか")).toEqual([]);
  expect(recall(items, "")).toEqual([]);        // 大事な印が無いので空
  expect(recall(items, "   ")).toEqual([]);
});

test("問いが空でも、大事な記憶だけは思い出せる", () => {
  // 「なにか覚えてる？」に答えられるようにしておく
  const marked = items.map((i, n) => (n === 0 ? { ...i, importance: 2 } : i));
  const hits = recall(marked, "");
  expect(hits.length).toBe(1);
  expect(hits[0].item.text).toBe(SAMPLE[0]);
});

test("とても長い問いでも、しきい値が意味を失わない", () => {
  /* 点数を問い合わせの長さで割っていないと、長い問いほど全部の記憶の
     点数が上がって、関係ない物まで返るようになる。 */
  const long = "今日はとても長い文章を書いてみます。".repeat(20);
  expect(recall(items, long).length).toBeLessThan(3);
});

test("記憶に絵文字や改行が入っていても壊れない", () => {
  const odd: Recallable[] = [
    { id: "a", text: "🎂 妹の誕生日\nは3月12日" },
    { id: "b", text: "" },
  ];
  expect(recall(odd, "妹の誕生日")[0]?.item.id).toBe("a");
});

/* ── AIへ渡す形 ─────────────────────────────────────────────────── */

test("AIへ渡す文は、サーバー側と同じ見出しになっている", () => {
  /* 見出しが違うと、両方から届いたときに2つの塊として読まれる。
     サーバー側（memory_store.mem_recall）は「【関連する記憶】」。 */
  const block = toBlock(recall(items, "妹 誕生日"));
  expect(block.startsWith("【関連する記憶】")).toBeTruthy();
  expect(block).toContain("妹の誕生日は3月12日");
});

test("何も当たらなければ、空の見出しを渡さない", () => {
  // 空の「【関連する記憶】」だけを渡すと、AIは「記憶が無い」ではなく
  // 「記憶を渡されたが空だった」と読む
  expect(toBlock(recall(items, "今日の天気"))).toBe("");
});

test("大事な記憶には印が付いて渡る", () => {
  const marked = [{ id: "a", text: "私は甲殻類アレルギー", importance: 2 }];
  expect(toBlock(recall(marked, "アレルギー"))).toContain("★事実");
});

/* ── 分け方そのもの ─────────────────────────────────────────────── */

test("日本語は2文字ずつと1文字ずつ、英数字は単語のまま", () => {
  const t = terms("打ち合わせ");
  expect(t).toContain("打ち");
  expect(t).toContain("ち合");
  expect(t.some((x) => x.endsWith("打"))).toBeTruthy();   // 1文字ぶんもある
  expect(terms("Next.js build")).toEqual(["next", "js", "build"]);
});

test("カタカナはひらがなに寄せない", () => {
  // 「はし」と「ハシ」を同じにすると、取り違えが増える
  const two: Recallable[] = [
    { id: "k", text: "ハシは食器" },
    { id: "h", text: "はしは橋" },
  ];
  const hits = recall(two, "ハシ");
  expect(hits[0].item.id).toBe("k");
});
