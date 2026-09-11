/**
 * コアの形（種類）ごとの描画。
 *
 * CoreOrb 側が「舞台づくり（キャンバス・回転・状態のなめらか追従・
 * ポインタ追従・停止制御）」を持ち、ここは「その舞台に何を描くか」だけを持つ。
 * どの形も同じ Ctx を受け取り、毎フレーム計算して描く（画像は使わない）。
 *
 * 形を足すときの決まり
 *   ・シルエットが毎フレーム破綻しないこと（面が輪郭を横切ると羽ばたいて見える）
 *   ・面は必ず奥行き順に並べてから描く（画家のアルゴリズム）
 *   ・半透明の面を重ねるときは、隣接辺の二重塗りに注意する
 */

import type { CorePalette } from "@/lib/coreSkin";

/** 投影結果。z は -1（奥）〜 +1（手前）、s は遠近スケール。 */
export interface Projected {
  sx: number;
  sy: number;
  z: number;
  s: number;
}

export interface ShapeCtx {
  ctx: CanvasRenderingContext2D;
  /** 舞台の中心。 */
  cx: number;
  cy: number;
  /** レイアウト上の直径(px)。線幅などはこれに比例させる。 */
  size: number;
  /** 経過秒。 */
  t: number;
  /** 呼吸（1前後）。 */
  pulse: number;
  /** 発光の強さ 0〜1（状態で変わる）。 */
  glow: number;
  /** シアン寄せの強さ 0〜1（聞き取り中などで上がる）。 */
  cyan: number;
  /** 単位球上の点を投影する。 */
  project: (x: number, y: number, z: number, radius: number) => Projected;
  /**
   * いまのテーマの配色。
   *
   * 既存の形（ピラミッド・多面体…）は色を直に書いている。テーマに
   * 追従させるのは見た目が変わる話なので、ここでは**新しく足した形だけ**
   * が使う。足してすぐ全部に効かせると、今使っている人の画面が黙って
   * 変わってしまう。
   */
  pal: CorePalette;
}

type V3 = [number, number, number];

/* ── 共通のヘルパ ──────────────────────────────────────────────── */

/** 中心のにじみ（どの形でも下地に敷く）。 */
export function bloom(c: ShapeCtx, radius: number, rgb = "150,200,255") {
  const { ctx, cx, cy, glow } = c;
  const g = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius);
  g.addColorStop(0, `rgba(${rgb},${(glow * 0.45).toFixed(3)})`);
  g.addColorStop(0.55, `rgba(${rgb},${(glow * 0.14).toFixed(3)})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** 十字＋斜めの光条（加算合成）。参考画像のきらめきに相当。 */
export function starFlare(c: ShapeCtx, x: number, y: number, len: number, alpha: number) {
  const { ctx } = c;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const core = ctx.createRadialGradient(x, y, 0, x, y, len * 0.28);
  core.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
  core.addColorStop(1, "rgba(200,230,255,0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, len * 0.28, 0, Math.PI * 2);
  ctx.fill();
  // 4本の長い光条＋4本の短い斜め光条
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const L = i % 2 === 0 ? len : len * 0.42;
    const g = ctx.createLinearGradient(x, y, x + Math.cos(a) * L, y + Math.sin(a) * L);
    g.addColorStop(0, `rgba(255,255,255,${(alpha * 0.85).toFixed(3)})`);
    g.addColorStop(1, "rgba(190,225,255,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(0.6, len * 0.03);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L);
    ctx.stroke();
  }
  ctx.restore();
}

/** 決まった並びの擬似乱数（毎フレーム同じ値が要るので Math.random は使わない）。 */
function rand(i: number): number {
  const v = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** 面を奥行き順（奥→手前）に並べる。 */
function sorted<T extends { depth: number }>(faces: T[]): T[] {
  return faces.sort((a, b) => a.depth - b.depth);
}

/* ── 1. クリスタルのピラミッド ─────────────────────────────────── */

const PYR_APEX: V3 = [0, -1.02, 0];
const PYR_BASE: V3[] = [
  [0.86, 0.58, 0.86],
  [-0.86, 0.58, 0.86],
  [-0.86, 0.58, -0.86],
  [0.86, 0.58, -0.86],
];

export function drawPyramid(c: ShapeCtx) {
  const { ctx, size, t, pulse, cyan, project } = c;
  const R = size * 0.40 * pulse;
  bloom(c, size * 0.62, "130,180,255");

  const apex = project(PYR_APEX[0], PYR_APEX[1], PYR_APEX[2], R);
  const base = PYR_BASE.map((v) => project(v[0], v[1], v[2], R));

  // 側面4枚＋底面。面の向きで奥/手前を決め、奥から塗る。
  const faces = PYR_BASE.map((_, i) => {
    const a = base[i];
    const b = base[(i + 1) % 4];
    return { pts: [apex, a, b], depth: (apex.z + a.z + b.z) / 3 };
  });
  faces.push({ pts: [base[0], base[1], base[2]], depth: (base[0].z + base[1].z + base[2].z) / 3 });
  faces.push({ pts: [base[0], base[2], base[3]], depth: (base[0].z + base[2].z + base[3].z) / 3 });

  for (const f of sorted(faces)) {
    const lit = (f.depth + 1) / 2;                    // 0 奥 → 1 手前
    ctx.beginPath();
    f.pts.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
    ctx.closePath();
    // 氷のような面：手前ほど明るい青、奥は沈む
    const g = ctx.createLinearGradient(apex.sx, apex.sy, c.cx, c.cy + R);
    g.addColorStop(0, `rgba(190,220,255,${(0.10 + lit * 0.16).toFixed(3)})`);
    g.addColorStop(1, `rgba(40,90,190,${(0.10 + lit * 0.22).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = `rgba(210,235,255,${(0.22 + lit * 0.55).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.7, size * 0.006);
    ctx.stroke();
  }

  // 内部の筋（結晶のひび）。頂点と底辺の各点を結ぶ決まった線。
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 14; i++) {
    const a = base[i % 4];
    const b = base[(i * 3 + 1) % 4];
    const k = 0.25 + rand(i) * 0.7;
    const p0 = { x: apex.sx + (a.sx - apex.sx) * k, y: apex.sy + (a.sy - apex.sy) * k };
    const p1 = { x: apex.sx + (b.sx - apex.sx) * (1 - k * 0.6), y: apex.sy + (b.sy - apex.sy) * (1 - k * 0.6) };
    ctx.strokeStyle = `rgba(200,230,255,${(0.05 + rand(i + 9) * 0.10).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.4, size * 0.0035);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
  ctx.restore();

  // 頂点のきらめき
  starFlare(c, apex.sx, apex.sy, size * (0.30 + cyan * 0.10) * (0.94 + 0.06 * Math.sin(t * 2.4)), 0.85);
}

/* ── 2. ガラスの多面体（正二十面体） ───────────────────────────── */

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V: V3[] = (() => {
  const raw: V3[] = [];
  for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
    raw.push([0, s1, s2 * PHI], [s1, s2 * PHI, 0], [s2 * PHI, 0, s1]);
  }
  const n = Math.sqrt(1 + PHI * PHI);
  return raw.map(([x, y, z]) => [x / n, y / n, z / n] as V3);
})();

/** 辺の長さから面（3頂点の組）を割り出す。 */
const ICO_F: number[][] = (() => {
  const d2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  let min = Infinity;
  for (let i = 0; i < ICO_V.length; i++)
    for (let j = i + 1; j < ICO_V.length; j++) min = Math.min(min, d2(ICO_V[i], ICO_V[j]));
  const near = (i: number, j: number) => Math.abs(d2(ICO_V[i], ICO_V[j]) - min) < 1e-6;
  const out: number[][] = [];
  for (let i = 0; i < ICO_V.length; i++)
    for (let j = i + 1; j < ICO_V.length; j++)
      for (let k = j + 1; k < ICO_V.length; k++)
        if (near(i, j) && near(j, k) && near(i, k)) out.push([i, j, k]);
  return out;
})();

export function drawIcosa(c: ShapeCtx) {
  const { ctx, size, pulse, cyan, project } = c;
  const R = size * 0.40 * pulse;
  bloom(c, size * 0.58, "150,160,255");

  const P = ICO_V.map((v) => project(v[0], v[1], v[2], R));
  const faces = ICO_F.map((f) => ({
    f,
    depth: (P[f[0]].z + P[f[1]].z + P[f[2]].z) / 3,
  }));

  for (const { f, depth } of sorted(faces)) {
    const front = depth >= 0;
    const lit = (depth + 1) / 2;
    ctx.beginPath();
    f.forEach((i, k) => (k ? ctx.lineTo(P[i].sx, P[i].sy) : ctx.moveTo(P[i].sx, P[i].sy)));
    ctx.closePath();
    // すりガラス：手前の面ほどわずかに明るい紫がかった黒
    ctx.fillStyle = `rgba(${Math.round(28 + lit * 26)},${Math.round(28 + lit * 24)},${Math.round(52 + lit * 44)},${front ? 0.55 : 0.30})`;
    ctx.fill();
    // 稜線。奥は点線にして、ガラス越しに見えている感じを出す
    ctx.setLineDash(front ? [] : [Math.max(1, size * 0.012), Math.max(1, size * 0.016)]);
    ctx.strokeStyle = front
      ? `rgba(228,236,255,${(0.34 + lit * 0.5).toFixed(3)})`
      : `rgba(190,205,255,${(0.10 + lit * 0.14).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.6, size * (front ? 0.0055 : 0.004));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 光を受けた稜線を数本だけ白く飛ばす（参考画像のハイライト）
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const lit = faces.filter((x) => x.depth > 0.55).slice(0, 3);
  for (const { f } of lit) {
    for (let k = 0; k < 3; k++) {
      const a = P[f[k]], b = P[f[(k + 1) % 3]];
      ctx.strokeStyle = `rgba(255,255,255,${(0.30 + cyan * 0.25).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, size * 0.008);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ── 3. ヘックスの球 ───────────────────────────────────────────── */

const HEX_N = 260;
const HEX_PTS: { v: V3; k: number }[] = (() => {
  const out: { v: V3; k: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < HEX_N; i++) {
    const y = 1 - (i / (HEX_N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    out.push({ v: [Math.cos(th) * r, y, Math.sin(th) * r], k: rand(i) });
  }
  return out;
})();

export function drawHexSphere(c: ShapeCtx) {
  const { ctx, cx, cy, size, t, pulse, cyan, project } = c;
  const R = size * 0.40 * pulse;
  bloom(c, size * 0.60, "90,150,255");

  // 球の影（暗い本体）— 鱗の隙間から黒が見えるように先に塗る
  const body = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
  body.addColorStop(0, "rgba(26,36,58,0.95)");
  body.addColorStop(1, "rgba(6,10,20,0.98)");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // 光る帯の位置（ゆっくり上下する）
  const bandY = Math.sin(t * 0.35) * 0.55;
  for (const p of HEX_PTS) {
    const q = project(p.v[0], p.v[1], p.v[2], R);
    if (q.z < 0.02) continue;                        // 手前半球だけ
    const near = 1 - Math.min(1, Math.abs(p.v[1] - bandY) / 0.30);
    const a = 0.20 + q.z * 0.26 + near * 0.54;
    const rr = size * 0.026 * q.s;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const x = q.sx + Math.cos(ang) * rr;
      const y = q.sy + Math.sin(ang) * rr;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    const blue = near > 0.05
      ? `rgba(${Math.round(90 + near * 90)},${Math.round(170 + near * 60)},255,${a.toFixed(3)})`
      : `rgba(74,94,132,${(a * 0.85).toFixed(3)})`;
    ctx.fillStyle = blue;
    ctx.fill();
    if (near > 0.4) {
      ctx.strokeStyle = `rgba(200,240,255,${(near * (0.35 + cyan * 0.3)).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.4, size * 0.002);
      ctx.stroke();
    }
  }

  // 縁のうすい光
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(120,180,255,${(0.20 + cyan * 0.2).toFixed(3)})`;
  ctx.lineWidth = Math.max(0.6, size * 0.005);
  ctx.stroke();
}

/* ── 4. クリスタルの爆ぜ ───────────────────────────────────────── */

const SPIKE_N = 78;
const SPIKES: { v: V3; len: number; w: number; ph: number }[] = (() => {
  const out: { v: V3; len: number; w: number; ph: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SPIKE_N; i++) {
    const y = 1 - (i / (SPIKE_N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    out.push({
      v: [Math.cos(th) * r, y, Math.sin(th) * r],
      len: 0.55 + rand(i) * 0.45,
      w: 0.10 + rand(i + 31) * 0.10,
      ph: rand(i + 77) * Math.PI * 2,
    });
  }
  return out;
})();

export function drawCrystal(c: ShapeCtx) {
  const { ctx, size, t, pulse, cyan, project } = c;
  const R = size * 0.44 * pulse;
  bloom(c, size * 0.62, "170,215,255");

  // 各スパイクを「中心から先端へ伸びる細い三角」として描く。
  // 手前/奥で塗る順を分けないと、奥のスパイクが手前を覆う。
  const list = SPIKES.map((s) => {
    const grow = 0.88 + 0.12 * Math.sin(t * 1.6 + s.ph);
    const tip = project(s.v[0] * s.len * grow, s.v[1] * s.len * grow, s.v[2] * s.len * grow, R);
    // 先端に垂直な2点を作るため、任意の直交軸を1本とる
    const up: V3 = Math.abs(s.v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const px = s.v[1] * up[2] - s.v[2] * up[1];
    const py = s.v[2] * up[0] - s.v[0] * up[2];
    const pz = s.v[0] * up[1] - s.v[1] * up[0];
    const n = Math.hypot(px, py, pz) || 1;
    const w = s.w * 0.5;
    const a = project((px / n) * w, (py / n) * w, (pz / n) * w, R);
    const b = project((-px / n) * w, (-py / n) * w, (-pz / n) * w, R);
    return { tip, a, b, depth: tip.z };
  });

  for (const s of sorted(list)) {
    const lit = (s.depth + 1) / 2;
    ctx.beginPath();
    ctx.moveTo(s.a.sx, s.a.sy);
    ctx.lineTo(s.tip.sx, s.tip.sy);
    ctx.lineTo(s.b.sx, s.b.sy);
    ctx.closePath();
    const g = ctx.createLinearGradient(c.cx, c.cy, s.tip.sx, s.tip.sy);
    g.addColorStop(0, `rgba(40,70,120,${(0.30 + lit * 0.25).toFixed(3)})`);
    g.addColorStop(0.6, `rgba(150,200,250,${(0.30 + lit * 0.45).toFixed(3)})`);
    g.addColorStop(1, `rgba(240,250,255,${(0.45 + lit * 0.5).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fill();
    if (s.depth > 0.3) {
      ctx.strokeStyle = `rgba(255,255,255,${((s.depth - 0.3) * (0.5 + cyan * 0.3)).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.4, size * 0.0025);
      ctx.stroke();
    }
  }
  starFlare(c, c.cx, c.cy, size * 0.22, 0.5 + cyan * 0.2);
}

/* ── 5. 光るリング（ポータル） ─────────────────────────────────── */

export function drawPortal(c: ShapeCtx) {
  const { ctx, cx, cy, size, t, pulse, cyan, glow } = c;
  const R = size * 0.40 * pulse;
  // 面を向けた状態と真横のあいだをゆっくり往復する（参考GIFの動き）
  const tilt = 0.06 + 0.94 * (0.5 + 0.5 * Math.sin(t * 0.42));
  const ry = R * tilt;

  bloom(c, size * 0.62, "110,150,255");

  // 内側の暗い面
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, R * 0.92, ry * 0.92, 0, 0, Math.PI * 2);
  const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.92);
  inner.addColorStop(0, "rgba(20,30,70,0.75)");
  inner.addColorStop(1, "rgba(6,10,26,0.92)");
  ctx.fillStyle = inner;
  ctx.fill();
  ctx.restore();

  // リング本体（外側の青い発光＋内側の白い芯）
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const [k, w, col, a] of [
    [1.06, 0.10, "80,130,255", 0.30 + glow * 0.3],
    [1.0, 0.045, "150,190,255", 0.55],
    [0.97, 0.016, "255,255,255", 0.85],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * k, ry * k, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${col},${a.toFixed(3)})`;
    ctx.lineWidth = Math.max(0.8, size * w);
    ctx.stroke();
  }
  ctx.restore();

  // 中心の点
  starFlare(c, cx, cy, size * (0.16 + cyan * 0.08) * (0.92 + 0.08 * Math.sin(t * 2.1)), 0.9);
}

/* ── ドット（昔のゲームの球）─────────────────────────────────────
 *
 * 「粗く描く」だけではドットにならない。昔の絵が昔の絵に見えるのは、
 * 次の3つが**同時に**守られているから。
 *
 *   ① 画素が格子に揃っている（中途半端な位置に点が無い）
 *   ② 色数が少ない（なめらかな階調を作らない）
 *   ③ 動きが飛び飛び（なめらかに補間しない）
 *
 * ③が効く。位置を丸めずに回すと、いくら粗く描いても「粗い今の絵」に
 * しか見えない。角度も明るさも段に落として、カクッと動かす。
 */
export function drawPixelOrb(c: ShapeCtx) {
  const { ctx, cx, cy, size, t, pulse, glow, cyan, pal } = c;

  // 玉を覆う格子。奇数にして、中心の画素を1つに決める（偶数だと芯が割れる）
  const CELLS = 19;
  const r = (size * 0.34 * pulse);
  const px = (r * 2) / CELLS;                 // 1画素の大きさ
  // 格子の原点も画素に揃える。ここがずれると、縁が1列だけ半端に出る
  const ox = Math.round(cx - r);
  const oy = Math.round(cy - r);
  const cell = Math.max(1, Math.round(px));

  // ③ 時間を段に落とす（毎秒6コマ。昔のゲームのアニメの速さ）
  const frame = Math.floor(t * 6);
  const spin = (frame % 24) / 24 * Math.PI * 2;

  // ② 色は4段だけ。palette の6段から、間を飛ばして取る
  const steps = [pal.body[0], pal.body[2], pal.body[4], pal.body[5]];

  const mid = (CELLS - 1) / 2;

  /* にじみ。
     最初は四角く塗りつぶしていたが、暗い背景では**コアの後ろに青い箱**が
     置いてあるようにしか見えなかった。丸い階調を敷くのも違う（そこだけ
     今の絵になる）。だから画素の輪を、外へ向かって薄くしながら重ねる。 */
  const halo = 0.22 + glow * 0.42;
  ctx.save();
  for (let ring = 1; ring <= 3; ring++) {
    ctx.globalAlpha = halo * (0.42 / ring);
    ctx.fillStyle = `rgb(${pal.bloomOut})`;
    const rr = 1 + ring * 0.16;             // 玉より少し外側の輪
    for (let gy = -ring; gy < CELLS + ring; gy++) {
      for (let gx = -ring; gx < CELLS + ring; gx++) {
        const dx = (gx - mid) / mid;
        const dy = (gy - mid) / mid;
        const d = Math.hypot(dx, dy);
        if (d <= rr - 0.16 || d > rr) continue;
        ctx.fillRect(ox + gx * cell, oy + gy * cell, cell, cell);
      }
    }
  }
  ctx.restore();
  for (let gy = 0; gy < CELLS; gy++) {
    for (let gx = 0; gx < CELLS; gx++) {
      const dx = (gx - mid) / mid;
      const dy = (gy - mid) / mid;
      const d = Math.hypot(dx, dy);
      if (d > 1) continue;                    // ① 円の外は描かない（＝階段状の縁になる）

      // 明るさ：中心が明るく、縁へ向かって暗い。光の当たる向きを少しだけ
      // ずらして、平らな円盤ではなく球に見せる
      const shade = d * 0.82 + (dx * 0.18 + dy * 0.12) + Math.sin(spin + dy * 2) * 0.06;
      let idx = shade < 0.22 ? 0 : shade < 0.52 ? 1 : shade < 0.84 ? 2 : 3;
      // 聞き取り中は、芯が一段明るくなる（状態が見て分かるように）
      if (cyan > 0.2 && idx > 0 && ((gx + gy + frame) % 7 === 0)) idx -= 1;
      ctx.fillStyle = steps[idx];
      ctx.fillRect(ox + gx * cell, oy + gy * cell, cell, cell);
    }
  }

  // きらめき：決まった画素が、決まったコマだけ白く抜ける
  const spark = [[4, 5], [14, 6], [6, 13], [13, 14], [9, 3]];
  ctx.fillStyle = `rgba(${pal.shellHot},1)`;
  for (let i = 0; i < spark.length; i++) {
    if ((frame + i * 5) % 18 >= 3) continue;  // 3コマだけ光って消える
    const [sx, sy] = spark[i];
    ctx.fillRect(ox + sx * cell, oy + sy * cell, cell, cell);
  }

  // 回る点。角度も画素に落とすので、カクカクと回る
  const ringR = r + cell * 2.5;
  for (let i = 0; i < 3; i++) {
    const a = spin * (i % 2 === 0 ? 1 : -1) + (i * Math.PI * 2) / 3;
    const bx = Math.round((cx + Math.cos(a) * ringR) / cell) * cell;
    const by = Math.round((cy + Math.sin(a) * ringR * 0.42) / cell) * cell;
    ctx.fillStyle = i === 0 ? `rgba(${pal.ping},1)` : `rgba(${pal.ringLight},0.9)`;
    ctx.fillRect(bx, by, cell, cell);
  }
}

/* ── 種類 → 描画関数 ───────────────────────────────────────────── */

export const SHAPE_DRAWERS = {
  pyramid: drawPyramid,
  icosa: drawIcosa,
  hex: drawHexSphere,
  crystal: drawCrystal,
  portal: drawPortal,
  pixel: drawPixelOrb,
} as const;

export type ShapeKey = keyof typeof SHAPE_DRAWERS;
