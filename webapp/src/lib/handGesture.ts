/**
 * handGesture.ts — 手の21点から「いまの手の形」と「やること」を決める。
 *
 * カメラ操作モード（components/CameraControl.tsx）の頭脳。ここには
 * カメラも画面も出てこない。**点の並びを受け取って、やることを返すだけ**。
 * そうしておけば、カメラの無いテストでも形の見分けと誤動作の防ぎ方を
 * 確かめられる（tests/handGesture.spec.ts）。
 *
 * 2巡目（ui-r125）で変えたこと —「反応しにくい・分かりにくい」への答え
 * --------------------------------------------------------------------
 * - **カーソルは、手のどんな形でも付いてくる。** 以前は「人差し指を立てた」と
 *   見分けられたときだけ動いた。指をカメラに向けると指が短く映って見分け
 *   られず、カーソルが止まっていた。いまは指の付け根（人差し指と中指の
 *   付け根の間）を追う。ここは指を曲げても・つまんでも動かないので、
 *   つまんだ瞬間に押す場所がずれることもない。
 * - **止めて押せる（ドウェル）。** ボタンの上で1秒止めると押す。つまむのが
 *   苦手でも押せる。押したあとは、別の物に移るまで同じ物を押し直さない。
 * - **覚える形を減らした。** 画面の移動（ピース→実行・指3本→管理）はやめて、
 *   カーソルで入力欄の「＋」を押す形にした。残した形は2つだけ:
 *   ✌（ピース）で閉じる、👍（親指）で一時停止。どちらも、止めている間は
 *   カーソルの横に「あと少し」の輪が出る（画面側）。
 * - **つまむの判定をゆるめた**（実際の手は、指先がぴったり付かない）。
 *
 * 誤動作を防ぐために決めたこと（1巡目から変えていない）
 * ------------------------------------------------------
 * - 1コマだけ違う形に見えても切り替えない。同じ形が数コマ続いたら切り替える。
 * - 「つまむ」は近づく距離と離れる距離を変える（ヒステリシス）。
 * - 押すのは「つまんだ瞬間」に1回だけ。つまんだまま待っても連打しない。
 * - 閉じる・一時停止の形は、しばらく止めたときだけ効く。
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
  /** カーソルに使う点（人差し指と中指の付け根の間）。画像の座標 0..1。 */
  cursor: Pt;
  /** スクロールに使う点（手首と中指の付け根の間）。指を曲げても動かない所。 */
  anchor: Pt;
  /** 手のひらの長さ（画像の高さに対する割合）。遠すぎ・近すぎの案内に使う。 */
  palm: number;
}

/** これより近づいたら「つまんだ」。 */
export const PINCH_ON = 0.38;
/** これより離れたら「離した」。ON と離しておかないと、境目で押し続ける。 */
export const PINCH_OFF = 0.55;
/** 「つまみかけ」の始まり（画面の輪が縮み始める距離）。 */
const PINCH_FAR = 0.95;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

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
  const full = lm.length >= 21;
  const cursor = full ? mid(lm[INDEX_MCP], lm[MIDDLE_MCP]) : (lm[0] ?? { x: 0.5, y: 0.5 });
  const anchor = full ? mid(lm[WRIST], lm[MIDDLE_MCP]) : cursor;
  const palm = full ? dist(lm[WRIST], lm[MIDDLE_MCP]) : 0;
  const none: HandReading = {
    pose: "none", pinchRatio: Infinity, cursor, anchor, palm,
    fingers: { thumb: false, index: false, middle: false, ring: false, pinky: false },
  };
  if (!full || !(palm > 1e-4)) return none;

  const fingers = {
    thumb: thumbOut(lm),
    index: fingerOut(lm, FINGERS.index),
    middle: fingerOut(lm, FINGERS.middle),
    ring: fingerOut(lm, FINGERS.ring),
    pinky: fingerOut(lm, FINGERS.pinky),
  };
  const tip = lm[FINGERS.index[3]];
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

/** 0（指が離れている）〜1（つまんだ）。画面で輪を縮めて「あと少し」を見せる。 */
export function pinchCloseness(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return clamp01((PINCH_FAR - ratio) / (PINCH_FAR - PINCH_ON));
}

/* ── 揺れを抑える（One Euro Filter） ─────────────────────────────────
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
  constructor(private minCutoff = 0.9, private beta = 3.5, private dCutoff = 1) {}
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
 * 映像は鏡にして見せるので、左右を入れ替える（右へ動かすと右へ行く）。
 * 範囲が狭いほど、少しの動きで大きく動く（=「はやい」）。 */

export interface Region { x0: number; x1: number; y0: number; y1: number }

export const SPEEDS = {
  slow: { label: "ゆっくり", region: { x0: 0.12, x1: 0.88, y0: 0.12, y1: 0.8 } },
  normal: { label: "ふつう", region: { x0: 0.22, x1: 0.78, y0: 0.2, y1: 0.7 } },
  fast: { label: "はやい", region: { x0: 0.3, x1: 0.7, y0: 0.27, y1: 0.62 } },
} as const;
export type Speed = keyof typeof SPEEDS;
export const DEFAULT_REGION: Region = SPEEDS.normal.region;

export function isSpeed(v: unknown): v is Speed {
  return typeof v === "string" && v in SPEEDS;
}

export function toScreen(p: Pt, region: Region = DEFAULT_REGION, mirror = true): Pt {
  const nx = clamp01((p.x - region.x0) / (region.x1 - region.x0));
  const ny = clamp01((p.y - region.y0) / (region.y1 - region.y0));
  return { x: mirror ? 1 - nx : nx, y: ny };
}

/* ── 形 → やること ───────────────────────────────────────────────── */

export type Command = "close" | "pause";

export type Effect =
  /** 画面の座標 0..1。visible=false のときは隠す。 */
  | { kind: "cursor"; x: number; y: number; visible: boolean }
  /** how: どうやって押したか（画面の言い方を変える）。 */
  | { kind: "click"; x: number; y: number; how: "pinch" | "dwell" }
  /** 画面の高さに対する割合。正 = 下へ読み進める。 */
  | { kind: "scroll"; dy: number }
  | { kind: "command"; command: "close" }
  | { kind: "paused"; paused: boolean };

/** しばらく止めると効く形。ms はどれだけ止めるか。 */
export const HOLDS: Partial<Record<HandPose, { command: Command; ms: number }>> = {
  victory: { command: "close", ms: 800 },
  thumbs_up: { command: "pause", ms: 1000 },
};

/**
 * 画面に出す説明。上から「まずこれだけ」の順。HOLDS と並びを合わせてある
 * （テストが見張る）。
 */
export const GESTURE_HELP: { pose: HandPose | "move" | "dwell"; mark: string; how: string; does: string }[] = [
  { pose: "move", mark: "✋", how: "手のひらをカメラに向けて動かす", does: "カーソルが付いてくる" },
  { pose: "dwell", mark: "⏱", how: "ボタンの上で1秒止める", does: "押す" },
  { pose: "pinch", mark: "🤏", how: "親指と人差し指でつまむ", does: "すぐ押す" },
  { pose: "fist", mark: "✊", how: "にぎったまま上下に動かす", does: "スクロール" },
  { pose: "victory", mark: "✌", how: "ピースで少し止める", does: "閉じる（Esc と同じ）" },
  { pose: "thumbs_up", mark: "👍", how: "親指を立てて少し止める", does: "一時停止／再開" },
];

/** 押し方。どちらでも押せるのが既定（つまむのが苦手な人がいる）。 */
export const CLICK_MODES = {
  both: { label: "両方", pinch: true, dwell: true },
  pinch: { label: "つまむだけ", pinch: true, dwell: false },
  dwell: { label: "止めるだけ", pinch: false, dwell: true },
} as const;
export type ClickMode = keyof typeof CLICK_MODES;
export function isClickMode(v: unknown): v is ClickMode {
  return typeof v === "string" && v in CLICK_MODES;
}

export interface ControllerOptions {
  /** 何コマ同じ形が続いたら切り替えるか。 */
  stableFrames: number;
  /** つまむの切り替えに要るコマ数（押すのは早く反応させたい）。 */
  pinchFrames: number;
  /** 押したあと、次に押せるまで（ms）。 */
  clickCooldownMs: number;
  /** 押す場所を、どれだけ前のカーソルにするか（ms）。 */
  clickLookbackMs: number;
  /** 手の上下の動きを、どれだけのスクロールにするか。 */
  scrollGain: number;
  region: Region;
  clickMode: ClickMode;
  /** 止めて押すまで（ms）。 */
  dwellMs: number;
  /** 止めている間に、カーソルがこれ以上動いたら数え直す（画面に対する割合）。 */
  dwellTolerance: number;
}

export const DEFAULT_CONTROLLER: ControllerOptions = {
  stableFrames: 3,
  pinchFrames: 2,
  clickCooldownMs: 400,
  clickLookbackMs: 80,
  scrollGain: 2.2,
  region: DEFAULT_REGION,
  clickMode: "both",
  dwellMs: 1000,
  dwellTolerance: 0.035,
};

/** カーソルの下にある押せる物（画面側が前のコマのカーソル位置で調べて渡す）。 */
export interface Hover {
  /** 同じ物かを見分ける印（要素ごとに変わらない値）。 */
  key: string | number;
  /** 手では押させない物（承認ボタンなど）。止めても押さない。 */
  blocked?: boolean;
}

/** 画面がカーソルのそばに出す「いま何をしているか」。 */
export interface ControllerView {
  pose: HandPose;
  paused: boolean;
  /** 止めて押す、の進み具合（0..1）。止めていなければ 0。 */
  dwell: number;
  /** 止めると効く形の進み具合。 */
  hold: { command: Command; progress: number } | null;
  /** つまみかけ（0..1）。 */
  pinch: number;
  /** 手の映り方の困りごと。 */
  framing: "ok" | "far" | "near" | "edge";
}

const DWELL_POSES: ReadonlySet<HandPose> = new Set(["palm", "point", "three", "none"]);

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
  private dwellKey: string | number | null = null;
  private dwellSince = 0;
  private dwellFrom: Pt | null = null;
  private dwellDone = false;
  private lastView: ControllerView = {
    pose: "none", paused: false, dwell: 0, hold: null, pinch: 0, framing: "ok",
  };

  constructor(opts: Partial<ControllerOptions> = {}) {
    this.opts = { ...DEFAULT_CONTROLLER, ...opts };
  }

  /** いまの形（安定した方）と、一時停止中か。 */
  get state(): { pose: HandPose; paused: boolean } {
    return { pose: this.stable, paused: this.paused };
  }

  /** カーソルのそばに出す物（最後の step の時点）。 */
  get view(): ControllerView {
    return this.lastView;
  }

  /** 外から止める・戻す（パネルのボタン）。 */
  setPaused(p: boolean) {
    this.paused = p;
    this.scrollY = null;
    this.resetDwell();
  }

  private resetDwell() {
    this.dwellKey = null;
    this.dwellFrom = null;
    this.dwellDone = false;
  }

  /**
   * 1コマ進める。lm は手の21点（画像の座標 0..1）、手が見えなければ null。
   * t はミリ秒（performance.now() など、増え続ける時計）。
   * hover は、前のコマのカーソルの下にあった押せる物（無ければ null）。
   */
  step(lm: Pt[] | null, t: number, hover: Hover | null = null): Effect[] {
    const out: Effect[] = [];
    if (!lm || lm.length < 21) {
      // 手が見えなくなったら、形も揺れ止めも最初から。戻ってきた手が
      // 前の位置から滑ってくると、どこを指しているのか分からない。
      this.raw = "none"; this.rawCount = 0;
      this.stable = "none"; this.holdFired = false;
      this.pinched = false; this.scrollY = null;
      this.fx.reset(); this.fy.reset(); this.trail = [];
      this.resetDwell();
      this.lastView = { pose: "none", paused: this.paused, dwell: 0, hold: null, pinch: 0, framing: "ok" };
      out.push({ kind: "cursor", x: this.cursor?.x ?? 0.5, y: this.cursor?.y ?? 0.5, visible: false });
      return out;
    }

    const mode = CLICK_MODES[this.opts.clickMode];
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
      if (r.pose === "pinch" && mode.pinch && !this.paused
          && t - this.lastClickAt >= this.opts.clickCooldownMs && this.cursor) {
        const at = this.pointBefore(t - this.opts.clickLookbackMs);
        out.push({ kind: "click", x: at.x, y: at.y, how: "pinch" });
        this.lastClickAt = t;
        // つまんで押した物を、止めて押し直さない
        this.dwellDone = true;
      }
    }

    // カーソル: どの形でも付いてくる。つまんでいる間・にぎっている間だけ
    // 止める（押す場所・スクロールする場所がずれない）。
    const frozen = this.stable === "pinch" || r.pose === "pinch" || this.stable === "fist";
    if (!this.paused && !frozen) {
      const s = toScreen(r.cursor, this.opts.region);
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

    // 止めて押す
    let dwell = 0;
    const canDwell = mode.dwell && !this.paused && this.cursor !== null
      && DWELL_POSES.has(this.stable) && DWELL_POSES.has(r.pose)
      && hover !== null && !hover.blocked;
    if (canDwell && this.cursor && hover) {
      const moved = this.dwellFrom
        ? Math.hypot(this.cursor.x - this.dwellFrom.x, this.cursor.y - this.dwellFrom.y)
        : Infinity;
      if (hover.key !== this.dwellKey) {
        this.dwellKey = hover.key;
        this.dwellSince = t;
        this.dwellFrom = this.cursor;
        this.dwellDone = false;
      } else if (moved > this.opts.dwellTolerance && !this.dwellDone) {
        // 同じボタンの上でも、大きく動いたら数え直す（通りがかりで押さない）
        this.dwellSince = t;
        this.dwellFrom = this.cursor;
      }
      if (!this.dwellDone) {
        dwell = clamp01((t - this.dwellSince) / this.opts.dwellMs);
        if (dwell >= 1 && t - this.lastClickAt >= this.opts.clickCooldownMs) {
          out.push({ kind: "click", x: this.cursor.x, y: this.cursor.y, how: "dwell" });
          this.lastClickAt = t;
          this.dwellDone = true;
          dwell = 0;
        }
      }
    } else if (hover === null || hover.key !== this.dwellKey) {
      // ボタンから外れたら、次に乗ったときに数え直す
      this.resetDwell();
    } else {
      // 押せない形（にぎる・ピース等）にしている間は、数えない
      this.dwellSince = t;
    }

    // しばらく止める形
    let hold: ControllerView["hold"] = null;
    const h = HOLDS[this.stable];
    if (h && !this.holdFired && (!this.paused || h.command === "pause")) {
      const progress = clamp01((t - this.stableSince) / h.ms);
      hold = { command: h.command, progress };
      if (progress >= 1) {
        this.holdFired = true;
        hold = null;
        if (h.command === "pause") {
          this.setPaused(!this.paused);
          out.push({ kind: "paused", paused: this.paused });
        } else {
          out.push({ kind: "command", command: h.command });
        }
      }
    }

    const framing: ControllerView["framing"] =
      r.palm < 0.07 ? "far"
        : r.palm > 0.38 ? "near"
          : (r.anchor.x < 0.06 || r.anchor.x > 0.94 || r.anchor.y < 0.04 || r.anchor.y > 0.96) ? "edge"
            : "ok";
    this.lastView = {
      pose: this.stable,
      paused: this.paused,
      dwell,
      hold,
      pinch: mode.pinch && !this.paused ? pinchCloseness(r.pinchRatio) : 0,
      framing,
    };

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
