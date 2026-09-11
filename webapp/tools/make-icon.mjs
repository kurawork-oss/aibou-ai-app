/**
 * アプリのアイコンを作る。
 *
 *   node tools/make-icon.mjs
 *
 * 何を作るか
 * ----------
 * 黒から水色へ斜めに流れる下地に、白で AIBOU / agentcore を置いたもの。
 * 送ってもらった参考画像（Anker Soundcore のアイコン）の**雰囲気**——
 * 暗い地に一方向の光、上に太い大文字、下に細い小文字——に合わせてある。
 *
 * 文字の形について
 * ----------------
 * 参考画像の書体は、そのメーカーの商標そのもの（とくに天辺を水平に
 * 切った A は、あの会社のロゴの一番の特徴）。なぞると、別の製品の
 * アイコンに他社のロゴを載せることになるので、そこだけは写していない。
 * 代わりに、素性の近い幾何学サンセリフ（Inter）で組んである。
 * 並び・太さの差・字間・色は参考画像に合わせているので、見た印象は近い。
 *
 * なぜ画像を置かずに生成するのか
 * ------------------------------
 * アイコンは 16px から 512px まで9種類要る。手で書き出すと、直したときに
 * どれか1つが古いまま残る（実際、他のアプリでよくある）。1つの元から
 * 全部作れば、その事故が起きない。
 *
 * 使う書体は次の手順で用意してある（このスクリプトは入っている前提で動く）:
 *   .next/static/media の Inter(woff2) → TTF へ変換 → wght 700/400 で固定
 *   → ~/.fonts へ置いて fc-cache
 * 入っていなければ、汎用のサンセリフに落ちる（形は変わるが破綻はしない）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const OUT = path.resolve("public");
const SIZE = 1024;              // 元の大きさ。ここから全部を縮めて作る

/* ── 色 ────────────────────────────────────────────────────────────
 * 参考画像から拾った3点。暗い側を広くとり、水色は右下の3割ほどに寄せる。
 * 均等に混ぜると「水色のアイコン」になってしまい、あの落ち着きが出ない。 */
const INK = "#ffffff";
const STOPS = [
  { at: 0.00, c: "#000305" },   // 上：ほぼ黒
  { at: 0.38, c: "#01131c" },   // ここまで暗いままにするのが肝
  { at: 0.60, c: "#063a52" },
  { at: 0.80, c: "#24a5d8" },
  { at: 1.00, c: "#7eeaff" },   // 下：明るい水色
];

/** 斜めに走る光の帯。参考画像の「刷いたような」筋。 */
const STREAKS = [
  { off: -0.40, w: 0.34, a: 0.20 },
  { off: 0.02, w: 0.12, a: 0.11 },
  { off: 0.24, w: 0.06, a: 0.07 },
  { off: 0.62, w: 0.20, a: 0.09 },
];

const FONT_BOLD = "AibouIcon Bold, Inter, Liberation Sans, DejaVu Sans, sans-serif";
const FONT_LIGHT = "AibouIcon Light, Inter, Liberation Sans, DejaVu Sans, sans-serif";

/**
 * アイコン1枚ぶんの SVG。
 *
 * `inset` は「四辺をどれだけ空けるか」（0〜0.25）。Android の maskable は
 * 外側が丸く切り落とされるので、文字を内側へ寄せる必要がある。
 * 切られない用途では 0 にして、隅まで色を使う。
 */
function svg(size, { inset = 0, radius = 0, mark = false } = {}) {
  const s = size;
  const pad = s * inset;
  const inner = s - pad * 2;

  // 文字の大きさと位置は、参考画像の比率をそのまま使う
  const capH = inner * 0.112;             // AIBOU の高さ
  const xH = inner * 0.084;               // agentcore の高さ
  const cx = s / 2;
  const y1 = pad + inner * 0.545;         // AIBOU のベースライン
  const y2 = pad + inner * 0.678;         // agentcore のベースライン

  const streaks = STREAKS.map(({ off, w, a }) => {
    // 左下→右上へ走る帯。回転で作ると端が欠けるので、十分長い矩形を回す
    const x = s * (0.18 + off);
    return `<rect x="${x.toFixed(1)}" y="${(-s * 0.6).toFixed(1)}" ` +
      `width="${(s * w).toFixed(1)}" height="${(s * 2.2).toFixed(1)}" ` +
      `fill="url(#streak)" opacity="${a}" transform="rotate(28 ${cx} ${s / 2})"/>`;
  }).join("");

  /** ふだんの二段組み（AIBOU / agentcore）。 */
  const wordmark = () => `
    <text x="${cx}" y="${y1.toFixed(1)}" fill="${INK}" text-anchor="middle"
          font-family="${FONT_BOLD}" font-weight="700"
          font-size="${capH.toFixed(1)}" letter-spacing="${(capH * 0.085).toFixed(1)}"
          >AIBOU</text>
    <text x="${cx}" y="${y2.toFixed(1)}" fill="${INK}" text-anchor="middle"
          font-family="${FONT_LIGHT}" font-weight="400"
          font-size="${(xH / 0.727).toFixed(1)}" letter-spacing="${(xH * 0.055).toFixed(1)}"
          >agentcore</text>`;

  /* 小さい札用の「A」1文字。
     16px に二段の文字を詰めると、読めないどころか**ただの白い染み**になる
     （実際そうなった）。ブラウザのタブに出るのはこの大きさなので、
     そこだけは1文字に割り切る。地と書体は同じなので、別物には見えない。 */
  const markText = () => `
    <text x="${cx}" y="${(pad + inner * 0.715).toFixed(1)}" fill="${INK}" text-anchor="middle"
          font-family="${FONT_BOLD}" font-weight="700"
          font-size="${(inner * 0.58).toFixed(1)}">A</text>`;

  const clip = radius > 0
    ? `<clipPath id="round"><rect width="${s}" height="${s}" rx="${(s * radius).toFixed(1)}" ry="${(s * radius).toFixed(1)}"/></clipPath>`
    : "";
  const g = radius > 0 ? ' clip-path="url(#round)"' : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="bg" x1="0.66" y1="0" x2="0.28" y2="1">
      ${STOPS.map((p) => `<stop offset="${p.at}" stop-color="${p.c}"/>`).join("\n      ")}
    </linearGradient>
    <linearGradient id="streak" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.45" stop-color="#bff2ff" stop-opacity="1"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${(s * 0.022).toFixed(1)}"/>
    </filter>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.17"/>
      <stop offset="0.30" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <!-- 上を黒へ沈める。参考画像は上半分がほぼ真っ黒で、そこに文字が乗る。
         帯をどこに置いても上が黒くなるよう、帯の**後**からかける。 -->
    <linearGradient id="crush" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000205" stop-opacity="0.92"/>
      <stop offset="0.34" stop-color="#000205" stop-opacity="0.62"/>
      <stop offset="0.62" stop-color="#000205" stop-opacity="0.14"/>
      <stop offset="0.86" stop-color="#000205" stop-opacity="0"/>
    </linearGradient>
    ${clip}
  </defs>
  <g${g}>
    <rect width="${s}" height="${s}" fill="url(#bg)"/>
    <g filter="url(#soft)">${streaks}</g>
    <rect width="${s}" height="${s}" fill="url(#crush)"/>
    <rect width="${s}" height="${s}" fill="url(#sheen)"/>
    ${mark ? markText() : wordmark()}
  </g>
</svg>`;
}

/**
 * 作るもの。
 *
 *   maskable … Android が外側を丸く切る。文字は内側へ寄せる（inset）
 *   apple    … iOS が自分で角を丸める。角丸は付けない・透明も入れない
 *   その他   … そのまま四角で出す（今までのアイコンもそうなっている）
 */
const TARGETS = [
  { file: "icon-512.png", size: 512, inset: 0 },
  { file: "icon-192.png", size: 192, inset: 0 },
  { file: "icon-maskable-512.png", size: 512, inset: 0.10 },
  { file: "icon-maskable-192.png", size: 192, inset: 0.10 },
  { file: "apple-touch-icon.png", size: 180, inset: 0 },
  { file: "aibou_icon.png", size: 512, inset: 0 },
  // タブに出る大きさ。二段の文字は読めないので「A」1文字にする
  { file: "favicon-32.png", size: 32, inset: 0, mark: true },
  { file: "favicon-16.png", size: 16, inset: 0, mark: true },
];

await mkdir(OUT, { recursive: true });

for (const t of TARGETS) {
  /* 小さい札は、大きく描いてから縮める。16px で直接描くと、字が潰れて
     ただの白い染みになる（実際そうなった）。 */
  const draw = Math.max(t.size, 512);
  const buf = Buffer.from(svg(draw, { inset: t.inset, mark: t.mark }));
  await sharp(buf, { density: 384 })
    .resize(t.size, t.size, { fit: "fill", kernel: "lanczos3" })
    .flatten({ background: "#01060c" })      // 透明を残さない（既存の並びに合わせる）
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, t.file));
  console.log("wrote", t.file, `${t.size}x${t.size}`);
}

/* favicon.ico は 16/32/48 を1つに束ねる。ブラウザによって使う大きさが違う。 */
const ico = await Promise.all([16, 32, 48].map(async (n) => {
  const buf = Buffer.from(svg(512, { inset: 0, mark: true }));
  return { n, png: await sharp(buf, { density: 384 }).resize(n, n).png().toBuffer() };
}));
await writeFile(path.join(OUT, "favicon.ico"), buildIco(ico));
console.log("wrote favicon.ico (16/32/48)");

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
