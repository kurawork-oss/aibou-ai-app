/**
 * `#` のコマンド窓の検証。
 *
 * この機能の値打ちは「打ちながら絞れる」ことにある。絞れないなら、
 * 15モードが40項目になっただけで、何も良くなっていない。
 *
 * 特に日本語で壊れやすいのが2つ。
 *   1. かなで引けない … 日本語入力は必ずかなを通る。「#がぞう」の時点で
 *      候補が出ないと、変換を確定するまで何も出ず、使い物にならない。
 *   2. # を勝手に食う … 文中の `#` はハッシュタグや見出しで書きたい。
 *      そこで候補を出すと、ふつうの文が書けなくなる。
 *
 * どちらも「動くけれど使えない」壊れ方で、実装を見ても気づきにくいので
 * ここで固定する。サーバ側の同じ判断は api/tests の find() 側にある。
 */

import { test, expect } from "@playwright/test";
import { filterCommands, readHashInput } from "../src/components/CommandPalette";
import type { CommandItem } from "../src/lib/api";

const c = (cmd: string, label: string, yomi = ""): CommandItem =>
  ({ cmd, label, yomi, arg: "", icon: "•", pack: "core", direct: true } as CommandItem);

const ITEMS: CommandItem[] = [
  c("タスク", "タスクを追加", "たすく task todo"),
  c("画像", "画像をつくる", "がぞう image picture"),
  c("画面録画", "画面を録る", "がめんろくが record"),
  c("検索", "Webを検索する", "けんさく search"),
  c("状況", "いまの状況をまとめる", "じょうきょう status"),
];

/* ── 絞り込み ───────────────────────────────────────────────────── */
test("空のときは全部出る（一覧としても使える）", () => {
  expect(filterCommands(ITEMS, "")).toEqual(ITEMS);
  expect(filterCommands(ITEMS, "   ")).toEqual(ITEMS);
});

test("かなで引ける（日本語入力は変換前にかなを通る）", () => {
  const hits = filterCommands(ITEMS, "がぞう");
  expect(hits.map((x) => x.cmd)).toEqual(["画像"]);
});

test("かなの途中でも、行き先が見えている", () => {
  // 「が」の時点で画像と画面録画の2つ。ここで0件になると、打ちながら
  // 選ぶという使い方そのものが成り立たない。
  expect(filterCommands(ITEMS, "が").map((x) => x.cmd))
    .toEqual(["画像", "画面録画"]);
});

test("漢字でもローマ字でも引ける", () => {
  expect(filterCommands(ITEMS, "画像").map((x) => x.cmd)).toEqual(["画像"]);
  expect(filterCommands(ITEMS, "image").map((x) => x.cmd)).toEqual(["画像"]);
  expect(filterCommands(ITEMS, "IMAGE").map((x) => x.cmd)).toEqual(["画像"]);
});

test("前方一致が、含むだけのものより上に来る", () => {
  // 「さく」は 検索(けんさく) に含まれるだけ。前方一致がある場合は
  // そちらを先に出す（打った人が狙っているのは前方一致のほう）。
  const hits = filterCommands([...ITEMS, c("作る", "何かを作る", "さくる make")], "さく");
  expect(hits[0].cmd).toBe("作る");
  expect(hits.map((x) => x.cmd)).toContain("検索");
});

test("説明文でも引ける（名前を思い出せないとき）", () => {
  const hits = filterCommands(ITEMS, "まとめ");
  expect(hits.map((x) => x.cmd)).toEqual(["状況"]);
});

test("無い名前は0件（近い物を勝手に出さない）", () => {
  // ここで適当に似た物を出すと、Enterで別の道具が走る。
  expect(filterCommands(ITEMS, "ぜんぜんちがう")).toEqual([]);
});

/* ── どこから候補を出すか ───────────────────────────────────────── */
test("行頭の # で候補が開く", () => {
  expect(readHashInput("#")).toEqual({ active: true, query: "" });
  expect(readHashInput("#がぞう")).toEqual({ active: true, query: "がぞう" });
  // 全角の＃も同じ（日本語入力だと全角で出ることがある）
  expect(readHashInput("＃がぞう")).toEqual({ active: true, query: "がぞう" });
});

test("文中の # では開かない（ハッシュタグや見出しを書けるように）", () => {
  expect(readHashInput("これは #tag です").active).toBeFalsy();
  expect(readHashInput("見出しは ## で書く").active).toBeFalsy();
  expect(readHashInput("").active).toBeFalsy();
  expect(readHashInput("画像を作って").active).toBeFalsy();
});

test("空白を打った時点で閉じる（そこから先は引数）", () => {
  // 「#画像 猫の絵」と打つとき、空白のあとも候補が出続けると
  // 引数を打っている間ずっと窓が邪魔をする。
  expect(readHashInput("#画像 猫の絵").active).toBeFalsy();
  expect(readHashInput("#画像　猫の絵").active).toBeFalsy();   // 全角空白
});
