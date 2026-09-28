/**
 * 書いている最中の記憶を、合流が取りこぼさないこと（lib/memory.ts・lib/memorySync.ts）。
 *
 * 記憶の時刻は書く**前**に付く。合流は「前回の目印より後に変わった物」を送る。
 * 開いた直後の合流と「覚える」が重なると、目印より前の時刻を持ったまま
 * 書き終わる物が出る。その物は、その回にも次の回にも入らず、二度と上がらない
 * ——2台目の端末で、覚えたはずの1件だけが出てこない（テストで実際に踏んだ）。
 *
 * ここは端末の保存先が無い環境（Node）で動くので、メモリの控えで確かめる。
 */

import { test, expect } from "@playwright/test";
import * as memory from "../src/lib/memory";

test("合流は、書いている最中の記憶が書き終わるのを待ってから集める", async () => {
  const pending = memory.add("書いている途中の記憶");
  let settled = false;
  const waiting = memory.writesSettled().then(() => { settled = true; });
  expect(settled).toBe(false);                     // まだ書いている
  await pending;
  await waiting;
  expect(settled).toBe(true);
  const texts = (await memory.changedSince(0)).map((m) => m.text);
  expect(texts).toContain("書いている途中の記憶");
});

test("書いていなければ、待たずにすぐ進む", async () => {
  let settled = false;
  await memory.writesSettled().then(() => { settled = true; });
  expect(settled).toBe(true);
});

test("目印と同じ時刻に書かれた記憶も、次の合流に入る", async () => {
  const item = await memory.add("同じミリ秒の記憶");
  expect(item).not.toBeNull();
  const texts = (await memory.changedSince(item!.updatedAt)).map((m) => m.text);
  expect(texts).toContain("同じミリ秒の記憶");
});
