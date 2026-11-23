/**
 * handGesture.ts — 手の21点から「いまの手の形」と「やること」を決める。
 *
 * カメラ操作モード（components/CameraControl.tsx）の頭脳。ここには
 * カメラも画面も出てこない。**点の並びを受け取って、やることを返すだけ**。
 * そうしておけば、カメラの無いテストでも形の見分けと誤動作の防ぎ方を
 * 確かめられる（tests/handGesture.spec.ts）。
 *
 * 誤動作を防ぐために決めたこと
 * ----------------------------
 * - 1コマだけ違う形に見えても動かない。同じ形が数コマ続いたら切り替える。
 *   手の認識は1コマずつ揺れるので、これが無いと勝手に押す。
 * - 「つまむ」は近づく距離と離れる距離を変える（ヒステリシス）。
 *   同じ値にすると、境目で押す・離すを何度も繰り返す。
 * - 押すのは「つまんだ瞬間」に1回だけ。つまんだまま待っても連打しない。
 *   押す場所は、つまむ動きで指先がずれる**少し前**の位置にする。
 * - 画面を切り替える形（ピースなど）は、しばらく止めたときだけ効く。
 *   手を動かしている途中でたまたまその形になっても飛ばない。
 */

export type Pt = { x: number; y: number };

/** 21点の並び（MediaPipe と同じ。Human の手の点もこの順で返る）。 */
const WRIST = 0;
const THUMB_MCP = 2;
const THUMB_IP = 3;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
const FINGERS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
} as const;

export type HandPose =
  | "point"      // 人差し指だけ立てる
  | "pinch"      // 親指と人差し指でつまむ
  | "fist"       // にぎる
  | "palm"       // 手を広げる
  | "victory"    // ピース
  | "three"      // 指3本
  | "thumbs_up"  // 親指を立てる
  | "none";      // どれでもない

export interface HandReading {
  pose: HandPose;
  /** 親指の先と人差し指の先の距離 ÷ 手のひらの長さ。 */
  pinchRatio: number;
  fingers: { thumb: boolean; index: boolean; middle: boolean; ring: boolean; pinky: boolean };
  /** カーソルに使う点（人差し指の先）。画像の座標 0..1。 */
  tip: Pt;
  /** スクロールに使う点（手首と中指の付け根の間）。指を曲げても動かない所。 */
  anchor: Pt;
}

/** これより近づいたら「つまんだ」。 */
export const PINCH_ON = 0.32;
/** これより離れたら「離した」。ON と離しておかないと、境目で押し続ける。 */
export const PINCH_OFF = 0.48;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** a→b と b→c の向きがどれだけ揃っているか（1 = まっすぐ、負 = 折り返し）。 */
function straightness(a: Pt, b: Pt, c: Pt): number {
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  return n === 0 ? 0 : (v1x * v2x + v1y * v2y) / n;
}

function fingerOut(lm: Pt[], f: readonly number[]): boolean {
  const [mcp, pip, , tip] = f;
  const wrist = lm[WRIST];
  // 曲げた指は、先が手のひらの側へ折り返す。伸びた指は、先がいちばん遠い。
  return straightness(lm[mcp], lm[pip], lm[tip]) > 0.55
    && dist(wrist, lm[tip]) > dist(wrist, lm[pip]) * 1.1;
}

function thumbOut(lm: Pt[]): boolean {
  // 親指は曲がる向きが他の指と違うので、小指の付け根からの離れ方で見る。
  // 握り込んだ親指は、先が付け根より小指に近い。
  const away = dist(lm[THUMB_TIP], lm[PINKY_MCP]) > dist(lm[THUMB_MCP], lm[PINKY_MCP]) * 1.1;
  return away && straightness(lm[THUMB_MCP], lm[THUMB_IP], lm[THUMB_TIP]) > 0.5;
}

/**
 * 1コマぶんの手の形を読む。
 *
 * `wasPinched` は直前に「つまんでいた」か。離す側のしきい値を使うのに要る。
 */
export function classifyHand(lm: Pt[], wasPinched = false): HandReading {
  const tip = lm[FINGERS.index[3]] ?? { x: 0, y: 0 };
  const anchor = lm.length >= 21
    ? { x: (lm[WRIST].x + lm[MIDDLE_MCP].x) / 2, y: (lm[WRIST].y + lm[MIDDLE_MCP].y) / 2 }
    : tip;
  const none: HandReading = {
    pose: "none", pinchRatio: Infinity, tip, anchor,
    fingers: { thumb: false, index: false, middle: false, ring: false, pinky: false },
  };
  if (lm.length < 21) return none;
  const palm = dist(lm[WRIST], lm[MIDDLE_MCP]);
  if (!(palm > 1e-4)) return none;

  const fingers = {
    thumb: thumbOut(lm),
    index: fingerOut(lm, FINGERS.index),
    middle: fingerOut(lm, FINGERS.middle),
    ring: fingerOut(lm, FINGERS.ring),
    pinky: fingerOut(lm, FINGERS.pinky),
  };
  const pinchRatio = dist(lm[THUMB_TIP], tip) / palm;
  const r = { ...none, fingers, pinchRatio };

  // にぎった手も、親指の先が人差し指に触れている。違いは人差し指の先が
  // 手のひらに入っているかどうか（つまむときは前に出ている）。
  const indexReach = dist(lm[WRIST], tip) / palm;
  const pinchLimit = wasPinched ? PINCH_OFF : PINCH_ON;
  if (pinchRatio < pinchLimit && indexReach > 0.9) return { ...r, pose: "pinch" };

  const { thumb, index, middle, ring, pinky } = fingers;
  const n = [index, middle, ring, pinky].filter(Boolean).length;
  if (n === 0) {
    // 画像の y は下向きに増える。親指の先が人差し指の付け根より上にある。
    if (thumb && lm[THUMB_TIP].y < lm[INDEX_MCP].y - 0.25 * palm) return { ...r, pose: "thumbs_up" };
    return { ...r, pose: "fist" };
  }
  if (index && n === 1) return { ...r, pose: "point" };
  if (index && middle && n === 2) return { ...r, pose: "victory" };
  if (index && middle && ring && n === 3) return { ...r, pose: "three" };
  if (n === 4) return { ...r, pose: "palm" };
  return r;
}

/* ── 指先の揺れを抑える（One Euro Filter） ─────────────────────────────
 * 止めているときは強くならし、速く動かしたときは遅れないようにする。
 * ただの平均だと「止まるとき震える」か「動かすと遅れる」の片方になる。 */

class LowPass {
  private y: number | null = null;
  filter(x: number, a: number): number {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }
  reset() { this.y = null; }
}

const alpha = (dt: number, cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt);

export class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private prevX: number | null = null;
  private prevT: number | null = null;
  constructor(private minCutoff = 1.2, private beta = 4, private dCutoff = 1) {}
  /** t は秒。 */
  filter(value: number, t: number): number {
    let dt = this.prevT === null ? 1 / 30 : t - this.prevT;
    if (!(dt > 0)) dt = 1 / 30;
    const d = this.prevX === null ? 0 : (value - this.prevX) / dt;
    const ed = this.dx.filter(d, alpha(dt, this.dCutoff));
    const out = this.x.filter(value, alpha(dt, this.minCutoff + this.beta * Math.abs(ed)));
    this.prevX = value;
    this.prevT = t;
    return out;
  }
  reset() { this.x.reset(); this.dx.reset(); this.prevX = null; this.prevT = null; }
}

/* ── カメラの中の範囲 → 画面 ─────────────────────────────────────────
 * カメラの端まで手を伸ばさなくても、画面の端に届くようにする。
 * 映像は鏡にして見せるので、左右を入れ替える（右へ動かすと右へ行く）。 */

export interface Region { x0: number; x1: number; y0: number; y1: number }
export const DEFAULT_REGION: Region = { x0: 0.2, x1: 0.8, y0: 0.15, y1: 0.7 };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function toScreen(p: Pt, region: Region = DEFAULT_REGION, mirror = true): Pt {
  const nx = clamp01((p.x - region.x0) / (region.x1 - region.x0));
  const ny = clamp01((p.y - region.y0) / (region.y1 - region.y0));
  return { x: mirror ? 1 - nx : nx, y: ny };
}

/* ── 形 → やること ───────────────────────────────────────────────── */

export type Command = "run" | "manage" | "close" | "pause";

export type Effect =
  /** 画面の座標 0..1。visible=false のときは隠す。 */
  | { kind: "cursor"; x: number; y: number; visible: boolean }
  | { kind: "click"; x: number; y: number }
  /** 画面の高さに対する割合。正 = 下へ読み進める。 */
  | { kind: "scroll"; dy: number }
  | { kind: "command"; command: Exclude<Command, "pause"> }
  | { kind: "paused"; paused: boolean };

/** しばらく止めると効く形。ms はどれだけ止めるか。 */
export const HOLDS: Partial<Record<HandPose, { command: Command; ms: number }>> = {
  victory: { command: "run", ms: 700 },
  three: { command: "manage", ms: 700 },
  thumbs_up: { command: "close", ms: 700 },
  // 一時停止は、ふだんの「手を広げて休める」と重なるので長めにする
  palm: { command: "pause", ms: 1200 },
};

/** 画面に出す説明。HOLDS と並びを合わせてある（テストが見張る）。 */
export const GESTURE_HELP: { pose: HandPose; mark: string; how: string; does: string }[] = [
  { pose: "point", mark: "☝", how: "人差し指を立てて動かす", does: "カーソルを動かす" },
  { pose: "pinch", mark: "🤏", how: "親指と人差し指でつまむ", does: "押す（クリック）" },
  { pose: "fist", mark: "✊", how: "にぎったまま上下に動かす", does: "スクロール" },
  { pose: "victory", mark: "✌", how: "ピースで少し止める", does: "実行（会話）へ" },
  { pose: "three", mark: "３", how: "指3本で少し止める", does: "管理へ" },
  { pose: "thumbs_up", mark: "👍", how: "親指を立てて少し止める", does: "閉じる（Esc と同じ）" },
  { pose: "palm", mark: "🖐", how: "手を広げて1秒ほど止める", does: "一時停止／再開" },
];

export interface ControllerOptions {
  /** 何コマ同じ形が続いたら切り替えるか。 */
  stableFrames: number;
  /** つまむの切り替えに要るコマ数（押すのは早く反応させたい）。 */
  pinchFrames: number;
  /** 押したあと、次に押せるまで（ms）。 */
  clickCooldownMs: number;
  /** 押す場所を、どれだけ前の指先にするか（ms）。 */
  clickLookbackMs: number;
  /** 手の上下の動きを、どれだけのスクロールにするか。 */
  scrollGain: number;
  region: Region;
}

export const DEFAULT_CONTROLLER: ControllerOptions = {
  stableFrames: 3,
  pinchFrames: 2,
  clickCooldownMs: 400,
  clickLookbackMs: 120,
  scrollGain: 2.2,
  region: DEFAULT_REGION,
};

export class GestureController {
  private opts: ControllerOptions;
  private raw: HandPose = "none";
  private rawCount = 0;
  private stable: HandPose = "none";
  private stableSince = 0;
  private holdFired = false;
  private pinched = false;
  private paused = false;
  private lastClickAt = -Infinity;
  private cursor: Pt | null = null;
  private trail: { t: number; p: Pt }[] = [];
  private fx = new OneEuro();
  private fy = new OneEuro();
  private scrollY: number | null = null;

  constructor(opts: Partial<ControllerOptions> = {}) {
    this.opts = { ...DEFAULT_CONTROLLER, ...opts };
  }

  /** いまの形（安定した方）と、一時停止中か。 */
  get state(): { pose: HandPose; paused: boolean } {
    return { pose: this.stable, paused: this.paused };
  }

  /** 外から止める・戻す（パネルのボタン）。 */
  setPaused(p: boolean) {
    this.paused = p;
    this.scrollY = null;
  }

  /**
   * 1コマ進める。lm は手の21点（画像の座標 0..1）、手が見えなければ null。
   * t はミリ秒（performance.now() など、増え続ける時計）。
   */
  step(lm: Pt[] | null, t: number): Effect[] {
    const out: Effect[] = [];
    if (!lm || lm.length < 21) {
      // 手が見えなくなったら、形も揺れ止めも最初から。戻ってきた手が
      // 前の位置から滑ってくると、どこを指しているのか分からない。
      this.raw = "none"; this.rawCount = 0;
      this.stable = "none"; this.holdFired = false;
      this.pinched = false; this.scrollY = null;
      this.fx.reset(); this.fy.reset(); this.trail = [];
      out.push({ kind: "cursor", x: this.cursor?.x ?? 0.5, y: this.cursor?.y ?? 0.5, visible: false });
      return out;
    }

    const r = classifyHand(lm, this.pinched);
    this.pinched = r.pose === "pinch";

    if (r.pose === this.raw) this.rawCount++;
    else { this.raw = r.pose; this.rawCount = 1; }
    const need = (r.pose === "pinch" || this.stable === "pinch") ? this.opts.pinchFrames : this.opts.stableFrames;
    if (r.pose !== this.stable && this.rawCount >= need) {
      this.stable = r.pose;
      this.stableSince = t;
      this.holdFired = false;
      this.scrollY = null;
      if (r.pose === "pinch" && !this.paused && t - this.lastClickAt >= this.opts.clickCooldownMs && this.cursor) {
        const at = this.pointBefore(t - this.opts.clickLookbackMs);
        out.push({ kind: "click", x: at.x, y: at.y });
        this.lastClickAt = t;
      }
    }

    // カーソル: 人差し指が立っている間だけ動かす。つまんでいる間・
    // にぎっている間は止める（押す場所・スクロールする場所がずれない）。
    if (!this.paused && r.fingers.index && r.pose !== "pinch" && this.stable !== "pinch" && this.stable !== "fist") {
      const s = toScreen(r.tip, this.opts.region);
      const sec = t / 1000;
      this.cursor = { x: this.fx.filter(s.x, sec), y: this.fy.filter(s.y, sec) };
      this.trail.push({ t, p: this.cursor });
      while (this.trail.length > 30) this.trail.shift();
    }

    // スクロール: にぎった手の上下。にぎった瞬間の位置を起点にする。
    if (!this.paused && this.stable === "fist") {
      const y = r.anchor.y;
      if (this.scrollY === null) this.scrollY = y;
      else {
        const dy = y - this.scrollY;
        if (Math.abs(dy) > 0.002) {
          const span = this.opts.region.y1 - this.opts.region.y0;
          // つかんで動かす向き: 手を上げると、中身も上がる（下を読み進める）
          out.push({ kind: "scroll", dy: (-dy / span) * this.opts.scrollGain });
          this.scrollY = y;
        }
      }
    }

    // しばらく止める形
    const hold = HOLDS[this.stable];
    if (hold && !this.holdFired && t - this.stableSince >= hold.ms) {
      this.holdFired = true;
      if (hold.command === "pause") {
        this.setPaused(!this.paused);
        out.push({ kind: "paused", paused: this.paused });
      } else if (!this.paused) {
        out.push({ kind: "command", command: hold.command });
      }
    }

    out.push({
      kind: "cursor",
      x: this.cursor?.x ?? 0.5, y: this.cursor?.y ?? 0.5,
      visible: !this.paused && this.cursor !== null,
    });
    return out;
  }

  private pointBefore(t: number): Pt {
    let best = this.cursor as Pt;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      best = this.trail[i].p;
      if (this.trail[i].t <= t) break;
    }
    return best;
  }
}
