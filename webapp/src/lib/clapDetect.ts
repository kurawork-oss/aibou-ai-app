/**
 * clapDetect.ts —「パンパン」（手を2回たたく音）を聞き分ける。
 *
 * カメラ操作モードを、手をたたいて始める・止めるための耳。
 * カメラは止めている間は何も見ていないので、始めるのは音でしかできない。
 *
 * 音の流れ（マイク）は components/ClapListener.tsx が持つ。ここは
 * **1コマぶんの音の大きさ（rms）と高い音の割合（hf）を受け取って、
 * 「たたいた」「2回たたいた」を返すだけ**。だからマイクの無いテストで
 * 確かめられる（tests/clapDetect.spec.ts）。
 *
 * 拍手と、それ以外の音の違い
 * --------------------------
 * - **急に大きくなる。** 直前のコマより何倍も大きく、まわりの静けさ
 *   （ふだんの音の大きさ）よりずっと大きい。
 * - **高い音まで混ざっている。** 拍手は「シャッ」に近い広い音。声や
 *   ピッという電子音は、高い所（2kHz より上）が少ない。
 * - **すぐ消える。** 拍手は 0.1 秒ほどで消える。声は母音が続く。
 *   大きく始まっても続いた音は拍手にしない。
 *
 * 1回では動かさない
 * -----------------
 * 机をたたく・物を置く・咳、は1回なら拍手に似ることがある。
 * 0.12〜0.7 秒の間をあけた2回で初めて動かす。動かしたあと少しの間は、
 * 次の「2回」を数えない（3回たたいて、始めてすぐ止まる、を防ぐ）。
 */

export interface AudioFrame {
  /** ミリ秒（増え続ける時計）。 */
  t: number;
  /** 音の大きさ（-1..1 の波の二乗平均の平方根）。 */
  rms: number;
  /** 2kHz より上の音の割合（0..1）。 */
  hf: number;
}

export interface ClapOptions {
  /** これより小さい音は拍手にしない（遠くの物音）。 */
  minLevel: number;
  /** まわりの静けさの何倍で「大きい」とみなすか。 */
  floorRatio: number;
  /** 直前のコマの何倍で「急に」とみなすか。 */
  riseRatio: number;
  /** 高い音の割合がこれ以上で「広い音」とみなす。 */
  minHf: number;
  /** この間に消えなければ拍手にしない（ms）。 */
  decayMs: number;
  /** 一番大きい所のこの割合まで下がったら「消えた」。 */
  decayRatio: number;
  /** 2回の間がこれより短ければ、同じ1回の響き（ms）。 */
  minGapMs: number;
  /** 2回の間がこれより長ければ、別々の1回（ms）。 */
  maxGapMs: number;
  /** 「2回」で動かしたあと、次を数えない間（ms）。 */
  refractoryMs: number;
}

export const DEFAULT_CLAP: ClapOptions = {
  minLevel: 0.03,
  floorRatio: 6,
  riseRatio: 2.5,
  minHf: 0.2,
  decayMs: 160,
  decayRatio: 0.3,
  minGapMs: 120,
  maxGapMs: 700,
  refractoryMs: 1200,
};

export type ClapEvent =
  | { kind: "clap"; t: number }
  | { kind: "double"; t: number };

export class ClapDetector {
  private opts: ClapOptions;
  /** まわりの静けさ（ふだんの音の大きさ）。ゆっくり追う。 */
  private floor = 0.004;
  private prev = 0;
  private cand: { t: number; peak: number } | null = null;
  private lastClap: number | null = null;
  private quietUntil = -Infinity;

  constructor(opts: Partial<ClapOptions> = {}) {
    this.opts = { ...DEFAULT_CLAP, ...opts };
  }

  /** いまの「まわりの静けさ」（画面に出す用）。 */
  get noiseFloor(): number { return this.floor; }

  step(f: AudioFrame): ClapEvent[] {
    const o = this.opts;
    const out: ClapEvent[] = [];
    if (this.cand) {
      // 始まりの直後は、一番大きい所を探す（窓がまたがると2コマに分かれる）
      if (f.t - this.cand.t <= 40) this.cand.peak = Math.max(this.cand.peak, f.rms);
      if (f.t - this.cand.t > 0 && f.rms < this.cand.peak * o.decayRatio) {
        const t = this.cand.t;
        this.cand = null;
        out.push(...this.onClap(t));
      } else if (f.t - this.cand.t > o.decayMs) {
        // 大きく始まったが続いた音（声など）。拍手ではない
        this.cand = null;
      }
    } else if (
      f.rms >= o.minLevel
      && f.rms >= this.floor * o.floorRatio
      && f.rms >= this.prev * o.riseRatio
      && f.hf >= o.minHf
    ) {
      this.cand = { t: f.t, peak: f.rms };
    }

    // 静けさは、拍手を待っていない間だけ、ゆっくり追う。大きな音で
    // 一気に引き上げない（話し声の間に拍手が埋もれないように）。
    if (!this.cand) {
      const capped = Math.min(f.rms, this.floor * 3 + 0.002);
      this.floor = this.floor * 0.97 + capped * 0.03;
    }
    this.prev = f.rms;
    return out;
  }

  private onClap(t: number): ClapEvent[] {
    const o = this.opts;
    const out: ClapEvent[] = [{ kind: "clap", t }];
    if (t < this.quietUntil) { this.lastClap = null; return out; }
    if (this.lastClap !== null) {
      const gap = t - this.lastClap;
      if (gap >= o.minGapMs && gap <= o.maxGapMs) {
        out.push({ kind: "double", t });
        this.lastClap = null;
        this.quietUntil = t + o.refractoryMs;
        return out;
      }
      // 短すぎる間は、同じ1回の響き。前の1回として数え続ける
      if (gap < o.minGapMs) return out;
    }
    this.lastClap = t;
    return out;
  }
}

/**
 * 1コマぶんの音から、大きさと高い音の割合を出す。
 * time は波（-1..1）、freqDb は AnalyserNode の getFloatFrequencyData（dB）。
 */
export function measure(time: Float32Array, freqDb: Float32Array, sampleRate: number): { rms: number; hf: number } {
  let sum = 0;
  for (let i = 0; i < time.length; i++) sum += time[i] * time[i];
  const rms = Math.sqrt(sum / Math.max(1, time.length));
  const binHz = sampleRate / 2 / Math.max(1, freqDb.length);
  const cut = Math.floor(2000 / binHz);
  let all = 0;
  let high = 0;
  for (let i = 1; i < freqDb.length; i++) {
    const db = freqDb[i];
    if (!Number.isFinite(db)) continue;
    const p = Math.pow(10, db / 10);
    all += p;
    if (i >= cut) high += p;
  }
  return { rms, hf: all > 0 ? high / all : 0 };
}
