/**
 * アプリのアイコンを、渡された1枚から全サイズ作る。
 *
 *   node tools/make-icon.mjs
 *
 * 元にするのは tools/icon-source.jpg（作ってもらった絵をそのまま置いてある）。
 * 描き起こしはしない——この道具の仕事は「1枚を、置き場ごとの決まりに
 * 合わせて切り出す」ことだけ。
 *
 * なぜ書き出しを手作業にしないのか
 * --------------------------------
 * アイコンは 16px から 512px まで9種類要る。手で書き出すと、直したときに
 * どれか1つが古いまま残る。1つの元から全部作れば、その事故が起きない。
 *
 * 置き場ごとの決まり（ここを外すと、端末の上で崩れる）
 * ----------------------------------------------------
 *   apple-touch … iOS が**自分で角を丸める**。こちらで角丸も透明も入れない。
 *                 入れると、丸めた外側に元の角が残って縁が汚れる
 *   maskable    … Android が外周を**円で切り落とす**。中心から4割の円より
 *                 外は消えるので、絵を縮めて余白を作る
 *   favicon     … タブに出る 16px。二段の文字は読めないので「A」1文字にする
 *   それ以外    … そのまま四角で出す（今までのアイコンもそう）
 *
 * 白い余白の扱い
 * --------------
 * 渡された絵は、角丸四角のまわりが**白**になっている。そのまま使うと、
 * iOS が丸めた縁に白がはみ出して、額縁のように見える。
 * 角の白だけを外側から塗りつぶして、地の紺で埋める。
 * （内側の白い文字は縁と繋がっていないので、塗りつぶしは届かない）
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = path.resolve("tools/icon-source.jpg");
const OUT = path.resolve("public");

/** 角の白を埋める色。絵の中心から採った紺。 */
const INK_BG = { r: 0, g: 5, b: 24 };

/** これ以上明るければ「余白の白」とみなす。
 *  銀の縁はいちばん明るい所で 220 前後なので、十分に離してある。 */
const WHITE = 248;

/* ── 1. 読む ───────────────────────────────────────────────────── */

const src = sharp(SRC);
const meta = await src.metadata();
const { data, info } = await src.raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const C = info.channels;

const isWhite = (i) => data[i] >= WHITE && data[i + 1] >= WHITE && data[i + 2] >= WHITE;

/* ── 2. 角丸四角の外接を測る ─────────────────────────────────────
 *
 * 決め打ちの座標で切ると、絵を差し替えたときに黙ってずれる。毎回測る。 */

let x0 = W, y0 = H, x1 = 0, y1 = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isWhite((y * W + x) * C)) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
}
const cw = x1 - x0 + 1;
const ch = y1 - y0 + 1;
console.log(`角丸四角の位置: (${x0},${y0}) ${cw}x${ch}`);

/* ── 3. 角の白を、外側から塗りつぶす ─────────────────────────────
 *
 * 四隅から塗り広げる。内側の白い文字は縁と繋がっていないので届かない。
 * 幾何学的に角丸を計算して切る手もあるが、絵の角の形が想定とわずかに
 * 違うだけで、銀の縁を削ってしまう。実際の白だけを狙うほうが安全。 */

const filled = new Uint8Array(W * H);
const stack = [];
const push = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const p = y * W + x;
  if (filled[p]) return;
  if (!isWhite(p * C)) return;
  filled[p] = 1;
  stack.push(p);
};
for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
while (stack.length) {
  const p = stack.pop();
  const x = p % W;
  const y = (p - x) / W;
  push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
}

let painted = 0;
for (let p = 0; p < W * H; p++) {
  if (!filled[p]) continue;
  const i = p * C;
  data[i] = INK_BG.r; data[i + 1] = INK_BG.g; data[i + 2] = INK_BG.b;
  painted++;
}

/* 塗りが内側へ漏れていないかを、面積で確かめる。
   期待は「余白＋四隅」。絵の半分が塗られたら、どこかで漏れている。 */
const ratio = painted / (W * H);
console.log(`白を埋めた面積: ${(ratio * 100).toFixed(1)}%`);
if (ratio > 0.45) {
  throw new Error(`塗りつぶしが内側へ漏れています（${(ratio * 100).toFixed(1)}%）。`
    + "銀の縁が明るすぎる可能性があるので WHITE を上げてください。");
}

/** 白を埋め終えた元画像（1024px）。ここから切り出す。 */
const cleaned = await sharp(Buffer.from(data), { raw: { width: W, height: H, channels: C } })
  .png().toBuffer();

/** 角丸四角だけを切り出したもの（四隅は紺で埋まっている）。 */
const squircle = await sharp(cleaned)
  .extract({ left: x0, top: y0, width: cw, height: ch })
  .png().toBuffer();

/* ── 3.5 「A」1文字を切り出す ───────────────────────────────────
 *
 * 座標は実測値（下の MARK）。自動で探すのは**やめた**。
 *
 * 最初は「白い所を探して1文字目を取る」で書いたが、この絵は
 * クロムの照り返しでできていて、その照りも白い。明るさで分けようが
 * ないので、上辺の 1x4px の光を「1文字目」として切り出していた。
 *
 * 代わりに、切り出した中身が**文字らしいか**を数で確かめる。
 * 絵を差し替えて座標がずれたら、黙って別の所を切るのではなく落ちる。 */

/** 「A」1文字の位置（元画像 1024px での実測。x196..351 / y341..498）。 */
const MARK = { left: 195, top: 341, size: 158 };

const mark = await sharp(cleaned)
  .extract({ left: MARK.left, top: MARK.top, width: MARK.size, height: MARK.size })
  .png().toBuffer();

/* 検算：切り出した中の「白い画素」の割合。
   文字なら1〜4割くらい。0に近ければ地だけを切っているし、
   大きすぎれば白い面を切っている。どちらも「A」ではない。 */
{
  const m = await sharp(mark).raw().toBuffer({ resolveWithObject: true });
  const px = m.info.width * m.info.height;
  let bright = 0;
  for (let i = 0; i < m.data.length; i += m.info.channels) {
    if (m.data[i] >= 246 && m.data[i + 1] >= 246 && m.data[i + 2] >= 246) bright++;
  }
  const frac = bright / px;
  console.log(`「A」の切り出し: ${MARK.size}px / 白い画素 ${(frac * 100).toFixed(1)}%`);
  if (frac < 0.08 || frac > 0.5) {
    throw new Error(`切り出した所に文字が見当たりません（白 ${(frac * 100).toFixed(1)}%）。`
      + "絵を差し替えたなら MARK を測り直してください。");
  }
}

/* ── 4. 書き出す ─────────────────────────────────────────────── */

const rgb = `rgb(${INK_BG.r},${INK_BG.g},${INK_BG.b})`;

/** そのまま四角いっぱいに。 */
async function full(size) {
  return sharp(squircle)
    .resize(size, size, { fit: "fill", kernel: "lanczos3" })
    .flatten({ background: rgb })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Android 用。外周が円で切られるので、絵を縮めて余白を作る。
 *
 * `inset` は片側の空き。0.10 なら絵は 80%。文字の端まで
 * 中心から4割の円に収まるかは、tests/icons.spec.ts で測っている。
 */
async function maskable(size, inset = 0.10) {
  const inner = Math.round(size * (1 - inset * 2));
  const art = await sharp(squircle)
    .resize(inner, inner, { fit: "fill", kernel: "lanczos3" })
    .png().toBuffer();
  const pad = Math.round((size - inner) / 2);
  return sharp({ create: { width: size, height: size, channels: 3, background: INK_BG } })
    .composite([{ input: art, left: pad, top: pad }])
    /* composite を挟むと、地を3チャンネルで作っていても透明の層が付く。
       flatten は「下に地を敷く」だけで層は残るので、removeAlpha で落とす。
       透明のまま出すと、丸めた外側にその形が残って縁が汚れる。 */
    .flatten({ background: rgb })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function monogram(size) {
  return sharp(mark)
    .resize(size, size, { fit: "fill", kernel: "lanczos3" })
    .flatten({ background: rgb })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

await mkdir(OUT, { recursive: true });

const TARGETS = [
  { file: "icon-512.png", make: () => full(512) },
  { file: "icon-192.png", make: () => full(192) },
  { file: "aibou_icon.png", make: () => full(512) },
  // iOS は自分で角を丸める。角丸も透明も入れない
  { file: "apple-touch-icon.png", make: () => full(180) },
  // Android は外周を円で切る。縮めて余白を作る
  { file: "icon-maskable-512.png", make: () => maskable(512) },
  { file: "icon-maskable-192.png", make: () => maskable(192) },
  // タブの大きさ。二段の文字は読めないので「A」1文字
  { file: "favicon-32.png", make: () => monogram(32) },
  { file: "favicon-16.png", make: () => monogram(16) },
];

for (const t of TARGETS) {
  await writeFile(path.join(OUT, t.file), await t.make());
  console.log("wrote", t.file);
}

/* favicon.ico は 16/32/48 を1つに束ねる（ブラウザによって使う大きさが違う）。 */
const ico = await Promise.all([16, 32, 48].map(async (n) => ({ n, png: await monogram(n) })));
await writeFile(path.join(OUT, "favicon.ico"), buildIco(ico));
console.log("wrote favicon.ico (16/32/48)");
console.log(`元: ${meta.width}x${meta.height} ${meta.format}`);

/** PNG を並べて ICO にする（ICO は PNG をそのまま入れてよい）。 */
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);          // 1 = アイコン
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  const body = [];
  for (const { n, png } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(n >= 256 ? 0 : n, 0);
    e.writeUInt8(n >= 256 ? 0 : n, 1);
    e.writeUInt8(0, 2);              // 色数（0 = 256色超）
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);           // プレーン
    e.writeUInt16LE(32, 6);          // ビット深度
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
    body.push(png);
  }
  return Buffer.concat([head, ...dir, ...body]);
}
