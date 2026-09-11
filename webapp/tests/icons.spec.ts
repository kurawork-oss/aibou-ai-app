/**
 * アイコンの検証。
 *
 * なぜ要るのか
 * ------------
 * アイコンの不具合は、**その端末に入れるまで見えない**。
 * ホーム画面に置いて初めて「白い額縁が付いている」「文字が切れている」
 * 「タブが白い染みになっている」と分かる。しかも見た目の話なので、
 * 誰も落ちたと気づかないまま出ていく。
 *
 * ここで押さえるのは、端末の決まりから**数で決まる**ことだけ。
 *
 *   iOS      … 自分で角を丸める。透明や白い角があると、丸めた外に残る
 *   Android  … 外周を円で切る。中心から4割の円より外は消える
 *   タブ     … 16px。二段の文字は読めない（実際ただの染みになった）
 *
 * 絵そのものが良いかは目で見るしかない。ここは見ない。
 */

import { test, expect } from "@playwright/test";
import { join } from "node:path";
import sharp from "sharp";

const PUBLIC = join(process.cwd(), "public");
const p = (f: string) => join(PUBLIC, f);

/** マニフェストと <head> が指している物が、全部ある前提。 */
const EXPECTED: [string, number][] = [
  ["icon-512.png", 512],
  ["icon-192.png", 192],
  ["icon-maskable-512.png", 512],
  ["icon-maskable-192.png", 192],
  ["apple-touch-icon.png", 180],
  ["aibou_icon.png", 512],
  ["favicon-32.png", 32],
  ["favicon-16.png", 16],
];

for (const [file, size] of EXPECTED) {
  test(`${file} が ${size}x${size} で、透明を含まない`, async () => {
    const m = await sharp(p(file)).metadata();
    expect(m.width, file).toBe(size);
    expect(m.height, file).toBe(size);
    // 透明があると、iOS が丸めた外側にその形が残って縁が汚れる
    expect(m.hasAlpha, `${file} に透明が入っている`).toBeFalsy();
  });
}

test("角に白が残っていない（iOSが丸めたときに額縁にならない）", async () => {
  /* 渡された元絵は、角丸四角のまわりが白い。そのまま使うと、丸めた縁に
     白がはみ出して額縁のように見える。角を地の色で埋めてあること。 */
  for (const file of ["icon-512.png", "apple-touch-icon.png", "icon-192.png"]) {
    const { data, info } = await sharp(p(file)).raw().toBuffer({ resolveWithObject: true });
    const { width: w, channels: c } = info;
    const at = (x: number, y: number) => {
      const i = (y * w + x) * c;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const corners = [[2, 2], [w - 3, 2], [2, info.height - 3], [w - 3, info.height - 3]];
    for (const [x, y] of corners) {
      const [r, g, b] = at(x, y);
      expect(Math.min(r, g, b), `${file} の角 (${x},${y}) が明るい: ${r},${g},${b}`)
        .toBeLessThan(90);
    }
  }
});

test("maskable は、円で切られても文字が残る", async () => {
  /* Android は中心から4割の円で切る。その外に明るい物（＝文字）があると、
     切られて読めなくなる。円の外が地の色だけであることを見る。 */
  const file = "icon-maskable-512.png";
  const { data, info } = await sharp(p(file)).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const cx = w / 2;
  const cy = h / 2;
  const safe = w * 0.4;           // 保証される円の半径

  let outsideBright = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (Math.hypot(x - cx, y - cy) <= safe) continue;
      const i = (y * w + x) * c;
      // 文字は真っ白。縁の照りもあるので、はっきり白い所だけ数える
      if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) outsideBright++;
    }
  }
  // 0 でなくてよい（銀の縁の照りが少し出る）。文字が出ていたら桁が違う
  expect(outsideBright, `円の外に明るい画素が ${outsideBright} 個ある`).toBeLessThan(400);
});

test("maskable の中身は、ちゃんと絵が入っている（真っ黒ではない）", async () => {
  // 余白を作りすぎて絵が消えていないか。上のテストだけだと真っ黒でも通る
  const { data, info } = await sharp(p("icon-maskable-512.png"))
    .raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  let bright = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * c;
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) bright++;
    }
  }
  expect(bright, "明るい所が無い＝絵が入っていない").toBeGreaterThan(300);
});

test("タブの札も、渡された絵そのまま（切り出しに戻っていない）", async () => {
  /* ここは一度**逆のことを見張っていた**。
     16px に二段の文字を詰めても読めないので、「A」の一文字だけを切り出して
     札にしていた——読みやすさで言えばそのほうが良い。
     が、それは渡された絵と違う物が出るということで、持ち主から
     「Aのドアップになっている」と言われた。読みやすさより
     **渡した絵がそのまま出ること**を取る、という指定。

     なので今度は「絵をそのまま縮めた物と同じであること」を見る。
     16px では二段の文字は読めず、紺と銀の塊に見える。それは承知のうえ。 */
  for (const [file, n] of [["favicon-32.png", 32], ["favicon-16.png", 16]] as const) {
    const fav = await sharp(p(file)).raw().removeAlpha().toBuffer();
    const shrunk = await sharp(p("icon-512.png")).resize(n, n).raw().removeAlpha().toBuffer();
    let diff = 0;
    const len = Math.min(fav.length, shrunk.length);
    for (let i = 0; i < len; i++) diff += Math.abs(fav[i] - shrunk[i]);
    // 実測 1.6〜2.2（縮め方の違いぶんだけ）。切り出しに戻ると 12 を超える
    expect(diff / len, `${file} が、絵をそのまま縮めた物と違う`).toBeLessThan(6);
  }
});

test("タブの札は、地と文字の差がはっきりしている", async () => {
  // 小さいほど、明暗の差が無いと何も見えない
  const { data, info } = await sharp(p("favicon-16.png"))
    .raw().toBuffer({ resolveWithObject: true });
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  expect(hi - lo, `16px の明暗の幅が ${Math.round(hi - lo)} しかない`).toBeGreaterThan(110);
});

test("favicon.ico に 16/32/48 が入っている", async () => {
  const { readFileSync } = await import("node:fs");
  const d = readFileSync(p("favicon.ico"));
  expect(d.readUInt16LE(0)).toBe(0);        // 予約
  expect(d.readUInt16LE(2)).toBe(1);        // 1 = アイコン
  const n = d.readUInt16LE(4);
  expect(n).toBe(3);
  const sizes = Array.from({ length: n }, (_, i) => d.readUInt8(6 + i * 16));
  expect(sizes.sort((a, b) => a - b)).toEqual([16, 32, 48]);
});

test("マニフェストが指すアイコンが、全部ある", async () => {
  const { readFileSync } = await import("node:fs");
  const man = JSON.parse(readFileSync(p("manifest.webmanifest"), "utf8"));
  for (const icon of man.icons) {
    const file = String(icon.src).replace(/^\//, "");
    const m = await sharp(p(file)).metadata();
    const [w] = String(icon.sizes).split("x").map(Number);
    expect(m.width, `${file} の大きさが manifest と違う`).toBe(w);
  }
  // maskable が宣言されていること（無いとAndroidで白い枠の中に縮んで出る）
  expect(man.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBeTruthy();
});
