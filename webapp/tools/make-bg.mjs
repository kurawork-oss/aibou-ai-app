/**
 * 背景の絵を、配る形（webp）に焼く。
 *
 * なぜ道具にするのか
 * ------------------
 * 一度きりのコマンドで作ると、**その絵がどう作られたのか誰も分からなく
 * なる**。品質をいくつにしたのか、縮めたのか、見本は何ピクセルなのか。
 * あとで絵を差し替えるとき、前と違う設定で焼いて画質だけ変わる。
 *
 * ここで一度やらかしている: `sharp(webpのバッファ).toFile()` と書いて
 * **2回エンコードした**。1回目は品質90、2回目は既定の80。129KB のはずの
 * ファイルが 87KB になり、画質も落ちていた。元から一気に書けば起きない。
 *
 * 使い方:
 *   node tools/make-bg.mjs <元の画像> [出す名前] [品質]
 *   例) node tools/make-bg.mjs ~/chrome.png skin-chrome-wide
 *       node tools/make-bg.mjs ~/tall.jpg skin-chrome-tall 86
 *
 * 出す物:
 *   public/<名前>.webp        本体（選んだときだけ落とす）
 *   public/<名前>-thumb.webp  一覧に出す見本（本体の 1/15 ほど）
 *
 * 焼いたあと、**lib/background.ts の bytes を実寸に直すこと**。
 * ここがずれると、人に見せる「約◯KB」が嘘になる。
 * tests/appearance.spec.ts がそこを見張っている。
 */

import sharp from "sharp";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

/* 本体の品質。滑らかな階調の絵なので、低すぎると紺の所に帯が出る。
   既定は 90。ただし**測ってから決めること**——下の「ずれ」が同じなら、
   低いほうを選ぶ。実例:

     横の絵 1672×941   q90 126KB（ずれ 1.23）
     縦の絵 1200×2133  q90 235KB（ずれ 1.22）/ q86 185KB（ずれ 1.36）

   縦は q86 にした。50KB 減って、ずれは 0.14/255 しか増えない。
   この絵を落とすのはスマホの人なので、そこは軽いほうがよい。 */
const QUALITY = Number(process.argv[4]) || 90;
/* 見本の大きさ。一覧のカードは実測で 92×58 前後なので、その2倍強。
   本体をそのまま出すと、一覧を開いた瞬間に全部落ちる。 */
const THUMB = { width: 320, height: 180, quality: 74 };

const [src, nameArg] = process.argv.slice(2);
if (!src) {
  console.error("使い方: node tools/make-bg.mjs <元の画像> [出す名前]");
  process.exit(1);
}
const name = nameArg || basename(src).replace(/\.[^.]+$/, "");
const out = (suffix = "") => resolve("public", `${name}${suffix}.webp`);

const meta = await sharp(src).metadata();

/* 元より大きくしない。引き伸ばした絵は、容量だけ増えて鮮明にはならない。 */
await sharp(src).webp({ quality: QUALITY, effort: 6 }).toFile(out());
await sharp(src)
  .resize(Math.min(THUMB.width, meta.width), Math.min(THUMB.height, meta.height), { fit: "cover" })
  .webp({ quality: THUMB.quality, effort: 6 })
  .toFile(out("-thumb"));

/* どれだけ壊れたかを実測して出す。「たぶん大丈夫」で配らない。 */
const raw = async (f) => (await sharp(f).resize(400, 400, { fit: "fill" })
  .raw().removeAlpha().toBuffer());
const [a, b] = [await raw(src), await raw(out())];
let max = 0, sum = 0;
for (let i = 0; i < a.length; i++) {
  const d = Math.abs(a[i] - b[i]);
  if (d > max) max = d;
  sum += d;
}

const size = (f) => statSync(f).size;
console.log(`元:     ${meta.width}x${meta.height} ${meta.format}`);
console.log(`本体:   ${out()}  ${size(out())} byte  (品質 ${QUALITY})`);
console.log(`見本:   ${out("-thumb")}  ${size(out("-thumb"))} byte`);
console.log(`ずれ:   平均 ${(sum / a.length).toFixed(2)} / 最大 ${max}（0-255）`);
console.log(`\nlib/background.ts の bytes を ${size(out())} に直してください。`);
