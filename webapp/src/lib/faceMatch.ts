/**
 * faceMatch.ts — 登録した顔と、いま映っている顔が同じ人かを決める。
 *
 * 顔の特徴（1024個の数）は Human（@vladmandic/human）の faceres が出す。
 * 比べ方はその計算と同じにしてある（Human の match.similarity と同じ式）。
 * ライブラリを読み込まずに確かめられるよう、ここに持っている。
 *
 * これは「鍵」ではない
 * --------------------
 * 判定はブラウザの中で行う。ブラウザの中の判定は、その気になれば
 * 書き換えられるし、写真でだませることもある。だからこれは
 * **「登録した人がカメラの前にいる間だけ、手で操作できる」ための確認**で、
 * ログインの代わりではない。データを守っているのは、今までどおり
 * ログインとサーバー側の権限（RLS）。画面にもそう書く。
 */

/** Human と同じ距離（ユークリッド距離の2乗 × 倍率）。 */
export function faceDistance(a: number[], b: number[], multiplier = 25): number {
  if (!a?.length || a.length !== b?.length) return Number.MAX_SAFE_INTEGER;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.round(100 * multiplier * sum) / 100;
}

/** 0（別人）〜1（同じ）。Human の similarity と同じ正規化（0.2〜0.8）。 */
export function faceSimilarity(a: number[], b: number[]): number {
  const d = faceDistance(a, b);
  if (d === Number.MAX_SAFE_INTEGER) return 0;
  if (d === 0) return 1;
  const norm = (1 - Math.sqrt(d) / 100 - 0.2) / (0.8 - 0.2);
  return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100;
}

/** 登録した何枚かのうち、いちばん近いもの。 */
export function bestSimilarity(sample: number[], enrolled: number[][]): number {
  let best = 0;
  for (const e of enrolled) best = Math.max(best, faceSimilarity(sample, e));
  return best;
}

/**
 * どこから「同じ人」とみなすか。
 *
 * Human の説明では 0.5 を超えれば同じ人とみなせる。暗い部屋や眼鏡で
 * 本人が弾かれることがあるので、設定で選べるようにしてある。
 * 「試す」で実際の値を見て決められる（設定 →「基本」）。
 */
export const STRICTNESS = {
  loose: { label: "ゆるめ", threshold: 0.5 },
  normal: { label: "ふつう", threshold: 0.56 },
  strict: { label: "きびしめ", threshold: 0.62 },
} as const;
export type Strictness = keyof typeof STRICTNESS;

export function isStrictness(v: unknown): v is Strictness {
  return typeof v === "string" && v in STRICTNESS;
}

/** 登録に何枚撮るか。 */
export const ENROLL_SAMPLES = 5;

/**
 * 撮った何枚かが、同じ1人の顔になっているか。
 * 途中で別の人が映った・ぶれた、を登録前に弾く。
 */
export function samplesConsistent(samples: number[][], threshold: number = STRICTNESS.loose.threshold): boolean {
  if (samples.length < 2) return false;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      if (faceSimilarity(samples[i], samples[j]) < threshold) return false;
    }
  }
  return true;
}

/** 顔の向き（ラジアン）が正面に近いか。横顔は特徴がぶれる。 */
export function isFrontal(yaw: number | undefined, pitch: number | undefined, limit = 0.35): boolean {
  if (yaw === undefined || pitch === undefined) return true; // 向きが取れないときは止めない
  return Math.abs(yaw) <= limit && Math.abs(pitch) <= limit;
}

/* ── 端末に置く形 ────────────────────────────────────────────────
 * 1024個の小数を文字で並べると 1枚 20KB を超える。Float32 の並びを
 * base64 にすれば 5.5KB で、精度も特徴を比べるのに十分。 */

export function encodeDescriptor(d: number[]): string {
  const f = new Float32Array(d);
  const bytes = new Uint8Array(f.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function decodeDescriptor(s: string): number[] {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Array.from(new Float32Array(bytes.buffer));
}

/* ── 操作してよいか（顔の門） ──────────────────────────────────── */

export type GateState =
  | "checking"  // まだ1度も見ていない
  | "ok"        // 登録した人がいる
  | "absent"    // 顔が見えない
  | "stranger"; // 登録した人ではない顔だけが見える

export interface GateOptions {
  /** 何回続けて一致したら開けるか。 */
  confirmHits: number;
  /** 開いたあと、本人が見えなくなってから何 ms で閉めるか。 */
  absentMs: number;
  /** 何回続けて別人だったら「別人」と言うか。 */
  strangerHits: number;
}

export const DEFAULT_GATE: GateOptions = { confirmHits: 2, absentMs: 5000, strangerHits: 2 };

/**
 * 1回の確認ごとに observe() を呼ぶ。similarity は、映っている顔のうち
 * 登録した顔にいちばん近い値。顔が1つも無ければ null。
 *
 * 開いたあとは、少し顔をそらした・一瞬隠れた程度では閉めない。
 * 閉めるのは、本人が absentMs のあいだ1度も確認できなかったとき。
 */
export class FaceGate {
  state: GateState = "checking";
  private hits = 0;
  private strangers = 0;
  private lastOkAt = -Infinity;
  private opts: GateOptions;

  constructor(private threshold: number, opts: Partial<GateOptions> = {}) {
    this.opts = { ...DEFAULT_GATE, ...opts };
  }

  observe(similarity: number | null, t: number): GateState {
    const match = similarity !== null && similarity >= this.threshold;
    if (match) {
      this.hits++;
      this.strangers = 0;
      this.lastOkAt = t;
    } else {
      this.hits = 0;
      this.strangers = similarity !== null ? this.strangers + 1 : 0;
    }

    if (this.state === "ok") {
      if (t - this.lastOkAt > this.opts.absentMs) {
        this.state = this.strangers >= this.opts.strangerHits ? "stranger" : "absent";
      }
    } else if (this.hits >= this.opts.confirmHits) {
      this.state = "ok";
    } else if (this.strangers >= this.opts.strangerHits) {
      this.state = "stranger";
    } else if (similarity === null) {
      this.state = "absent";
    }
    return this.state;
  }
}
