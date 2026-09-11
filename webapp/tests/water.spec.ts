/**
 * 水面の計算の検証。
 *
 * 見た目が良いかは目で見るしかないが、**数で決まる性質**はここで押さえる。
 * この3つが崩れると、それぞれ次の形で表に出る：
 *
 *   放っておいても凪がない → 波が延々と残り、電池を食い続ける
 *   触っても動かない       → 「触ったら水が動く」が成立しない
 *   点数が増え続ける       → 広い画面（PC）だけ重い
 *
 * 描画（canvas）は使わない。物理の部分は素のままで動くようにしてあるので、
 * ブラウザを開かずに確かめられる。
 */

import { test, expect } from "@playwright/test";
import { Water } from "../src/lib/water";

test("触ると動き、放っておくと必ず凪ぐ", async () => {
  const w = new Water({ cell: 4, damping: 0.95, rainEvery: 0 });
  w.resize(200, 200);

  expect(w.energy(), "触る前から暴れている").toBe(0);

  w.drop(100, 100, 1.5, 3);
  for (let i = 0; i < 6; i++) w.step(1 / 60);
  const stirred = w.energy();
  expect(stirred, "触っても動かない").toBeGreaterThan(0);

  // 15秒ぶん進めれば、目で見て止まっている状態になっていること
  for (let i = 0; i < 900; i++) w.step(1 / 60);
  expect(w.energy(), "いつまでも波が残る").toBeLessThan(stirred * 0.01);
});

test("波は広がる（落とした所だけで終わらない）", async () => {
  // 中心だけ光って終わりだと、水ではなく点滅になる。
  const w = new Water({ cell: 4, damping: 0.99, rainEvery: 0 });
  w.resize(200, 200);
  w.drop(100, 100, 2, 2);

  const far = () => {
    // 中心から十分離れた所の高さ（広がってきたかを見る）
    const gx = Math.round(100 / w.cell);
    const gy = Math.round(100 / w.cell);
    return Math.abs(w.heightAt(gx + 10, gy)) + Math.abs(w.heightAt(gx, gy + 10));
  };

  expect(far(), "落とした瞬間に遠くが動いている").toBeLessThan(1e-6);
  for (let i = 0; i < 40; i++) w.step(1 / 60);
  expect(far(), "波が広がっていない").toBeGreaterThan(0);
});

test("画面が広くても、計算する点は増え続けない", async () => {
  const sizes: [number, number][] = [[393, 852], [1440, 900], [2560, 1440]];
  const seen = sizes.map(([pw, ph]) => {
    const w = new Water({ cell: 6, maxCells: 14000 });
    w.resize(pw, ph);
    return { size: `${pw}x${ph}`, cells: w.gridWidth * w.gridHeight, cell: w.cell };
  });

  for (const r of seen) {
    // 切り上げのぶん少し超えるが、桁で増えないこと
    expect(r.cells, `${r.size} → ${r.cells}点`).toBeLessThan(16000);
  }
  // 広い画面ほど粗くなっている（点数ではなく粗さで払っている）
  expect(seen[2].cell, "広い画面でも粗くなっていない").toBeGreaterThan(seen[0].cell);
  // 狭い画面は、指定した細かさのまま
  expect(seen[0].cell).toBe(6);
});

test("端の外を叩いても壊れない", async () => {
  // 画面外の指（スワイプの行き過ぎ）で配列の外に書くと、黙って壊れる。
  const w = new Water({ cell: 4, rainEvery: 0 });
  w.resize(100, 100);
  for (const [x, y] of [[-50, -50], [0, 0], [99, 99], [500, 500]] as const) {
    w.drop(x, y, 2, 4);
  }
  for (let i = 0; i < 60; i++) w.step(1 / 60);
  expect(Number.isFinite(w.energy()), "値が壊れている").toBeTruthy();
});

test("触らなくても、たまに雨粒が落ちる", async () => {
  // 完全に止まった水面は壁紙に見えて、触れることに気づいてもらえない。
  const w = new Water({ cell: 4, damping: 0.99, rainEvery: 0.5 });
  w.resize(200, 200);
  for (let i = 0; i < 120; i++) w.step(1 / 60);   // 2秒ぶん
  expect(w.energy(), "放っておくと完全に静止したまま").toBeGreaterThan(0);
});

test("雨を止める指定が効く", async () => {
  const w = new Water({ cell: 4, rainEvery: 0 });
  w.resize(200, 200);
  for (let i = 0; i < 600; i++) w.step(1 / 60);
  expect(w.energy()).toBe(0);
});
