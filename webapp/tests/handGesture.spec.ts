/**
 * 手の形の見分けと、誤動作の防ぎ方（lib/handGesture.ts）。
 *
 * カメラは使わない。手の21点を組み立てて渡す。ここが崩れると
 * 「勝手に押す」「止めたのに動く」になるので、押す回数を数えて見張る。
 */

import { test, expect } from "@playwright/test";
import {
  classifyHand, GestureController, GESTURE_HELP, HOLDS, PINCH_OFF, PINCH_ON, toScreen,
  type Effect, type HandPose, type Pt,
} from "../src/lib/handGesture";

/* 手のひらの座標（右 +x・上 +y、手のひらの長さ = 1）で組み立てて、
   画像の座標（0..1、y は下向き）に直す。 */
type Finger = "out" | "curl";
type Thumb = "out" | "in" | "up";

const MCP = { index: [0.35, 0.95], middle: [0, 1], ring: [-0.3, 0.95], pinky: [-0.55, 0.85] } as const;

function finger(m: readonly number[], s: Finger): number[][] {
  const [x, y] = m;
  return s === "out"
    ? [[x, y], [x, y + 0.45], [x, y + 0.75], [x, y + 1.0]]
    : [[x, y], [x, y + 0.3], [x, y + 0.1], [x, y - 0.15]];
}

function thumb(s: Thumb | "pinch"): number[][] {
  const cmc = [0.25, 0.25];
  if (s === "out") return [cmc, [0.5, 0.45], [0.7, 0.65], [0.9, 0.85]];
  if (s === "up") return [cmc, [0.5, 0.45], [0.55, 0.85], [0.65, 1.35]];
  if (s === "pinch") return [cmc, [0.5, 0.45], [0.68, 0.8], [0.8, 1.15]];
  return [cmc, [0.5, 0.45], [0.45, 0.6], [0.1, 0.6]];
}

function hand(
  f: { index?: Finger; middle?: Finger; ring?: Finger; pinky?: Finger; thumb?: Thumb } = {},
  at: { x: number; y: number } = { x: 0.5, y: 0.6 },
  pinch = false,
): Pt[] {
  const u = 0.12;
  const index = pinch
    ? [[0.35, 0.95], [0.45, 1.3], [0.6, 1.35], [0.75, 1.2]]
    : finger(MCP.index, f.index ?? "curl");
  const palm: number[][] = [
    [0, 0],
    ...(pinch ? thumb("pinch") : thumb(f.thumb ?? "in")),
    ...index,
    ...finger(MCP.middle, f.middle ?? "curl"),
    ...finger(MCP.ring, f.ring ?? "curl"),
    ...finger(MCP.pinky, f.pinky ?? "curl"),
  ];
  return palm.map(([x, y]) => ({ x: at.x + x * u, y: at.y - y * u }));
}

const POINT = (at?: { x: number; y: number }) => hand({ index: "out" }, at);
const PINCH = (at?: { x: number; y: number }) => hand({}, at, true);
const FIST = (at?: { x: number; y: number }) => hand({}, at);
const PALM = () => hand({ index: "out", middle: "out", ring: "out", pinky: "out", thumb: "out" });
const VICTORY = () => hand({ index: "out", middle: "out" });

test("形を見分ける", () => {
  const cases: [Pt[], HandPose][] = [
    [POINT(), "point"],
    [PINCH(), "pinch"],
    [FIST(), "fist"],
    [PALM(), "palm"],
    [VICTORY(), "victory"],
    [hand({ index: "out", middle: "out", ring: "out" }), "three"],
    [hand({ thumb: "up" }), "thumbs_up"],
    // 人差し指と小指（どれにも当たらない形）は、何もしない
    [hand({ index: "out", pinky: "out" }), "none"],
  ];
  for (const [lm, want] of cases) expect(classifyHand(lm).pose, want).toBe(want);
});

test("にぎった手を「つまむ」と取り違えない（親指が人差し指に触れていても）", () => {
  const r = classifyHand(FIST());
  expect(r.pinchRatio).toBeLessThan(PINCH_OFF);
  expect(r.pose).toBe("fist");
});

test("つまむ・離すの境目で、行ったり来たりしない", () => {
  // ON と OFF の間の距離: つまんでいたなら、つまんだまま。そうでなければ、つままない
  const base = PINCH();
  const palm = Math.hypot(base[0].x - base[9].x, base[0].y - base[9].y);
  const mid = ((PINCH_ON + PINCH_OFF) / 2) * palm;
  const lm = base.map((p) => ({ ...p }));
  lm[8] = { x: lm[4].x + mid, y: lm[4].y };
  expect(classifyHand(lm, true).pose).toBe("pinch");
  expect(classifyHand(lm, false).pose).not.toBe("pinch");
});

test("点が足りない・手のひらが潰れているときは、何もしない", () => {
  expect(classifyHand([]).pose).toBe("none");
  expect(classifyHand(Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }))).pose).toBe("none");
});

test("映像は鏡に見せるので、左右を入れ替えて画面に出す", () => {
  expect(toScreen({ x: 0.25, y: 0.2 }).x).toBeGreaterThan(0.85);
  expect(toScreen({ x: 0.75, y: 0.2 }).x).toBeLessThan(0.15);
  // 範囲の外は端に貼りつく（画面の外へ出ない）
  const edge = toScreen({ x: -1, y: 2 });
  expect(edge).toEqual({ x: 1, y: 1 });
});

/** 33ms ごとに同じ手を n コマ流す。 */
function feed(ctl: GestureController, lm: Pt[] | null, n: number, clock: { t: number }): Effect[] {
  const out: Effect[] = [];
  for (let i = 0; i < n; i++) { clock.t += 33; out.push(...ctl.step(lm, clock.t)); }
  return out;
}
const kinds = (e: Effect[], k: Effect["kind"]) => e.filter((x) => x.kind === k);

test("つまむと1回だけ押す。つまんだまま待っても連打しない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, POINT(), 6, c);
  const held = feed(ctl, PINCH(), 30, c);
  expect(kinds(held, "click")).toHaveLength(1);
  // 離して、もう一度つまむ → 2回目
  feed(ctl, POINT(), 6, c);
  expect(kinds(feed(ctl, PINCH(), 4, c), "click")).toHaveLength(1);
});

test("押す場所は、指先の位置（つまむ動きでずれる前）", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  const cur = kinds(feed(ctl, POINT({ x: 0.5, y: 0.6 }), 10, c), "cursor").pop() as Extract<Effect, { kind: "cursor" }>;
  expect(cur.visible).toBe(true);
  const click = kinds(feed(ctl, PINCH({ x: 0.5, y: 0.6 }), 3, c), "click")[0] as Extract<Effect, { kind: "click" }>;
  expect(Math.abs(click.x - cur.x)).toBeLessThan(0.02);
  expect(Math.abs(click.y - cur.y)).toBeLessThan(0.02);
});

test("一度も指していないのに、つまんだだけでは押さない（どこを押すか分からない）", () => {
  const ctl = new GestureController();
  expect(kinds(feed(ctl, PINCH(), 10, { t: 0 }), "click")).toHaveLength(0);
});

test("1コマだけ違う形に見えても、切り替えない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  const out: Effect[] = [];
  for (let i = 0; i < 40; i++) {
    out.push(...feed(ctl, i % 5 === 0 ? VICTORY() : POINT(), 1, c));
  }
  expect(kinds(out, "command")).toHaveLength(0);
  expect(ctl.state.pose).toBe("point");
});

test("ピースを止めると、1回だけ「実行」へ", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  const short = feed(ctl, VICTORY(), 10, c); // 330ms: まだ
  expect(kinds(short, "command")).toHaveLength(0);
  const long = feed(ctl, VICTORY(), 40, c);  // 1.6秒まで止める
  expect(kinds(long, "command")).toEqual([{ kind: "command", command: "run" }]);
});

test("手を広げて止めると一時停止。止めている間は、押さない・飛ばない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, POINT(), 6, c);
  const p = feed(ctl, PALM(), 45, c);
  expect(kinds(p, "paused")).toEqual([{ kind: "paused", paused: true }]);
  expect(ctl.state.paused).toBe(true);

  const during = [...feed(ctl, POINT(), 6, c), ...feed(ctl, PINCH(), 6, c), ...feed(ctl, VICTORY(), 40, c)];
  expect(kinds(during, "click")).toHaveLength(0);
  expect(kinds(during, "command")).toHaveLength(0);
  expect((kinds(during, "cursor") as Extract<Effect, { kind: "cursor" }>[]).every((e) => !e.visible)).toBe(true);

  // もう一度広げて止めると戻る
  expect(kinds(feed(ctl, PALM(), 45, c), "paused")).toEqual([{ kind: "paused", paused: false }]);
});

test("にぎって上げると下へ読み進め、下げると戻る", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, FIST({ x: 0.5, y: 0.6 }), 4, c);
  let up = 0;
  for (let i = 1; i <= 10; i++) {
    up += (kinds(feed(ctl, FIST({ x: 0.5, y: 0.6 - i * 0.01 }), 1, c), "scroll") as Extract<Effect, { kind: "scroll" }>[])
      .reduce((s, e) => s + e.dy, 0);
  }
  expect(up).toBeGreaterThan(0);
  let down = 0;
  for (let i = 1; i <= 10; i++) {
    down += (kinds(feed(ctl, FIST({ x: 0.5, y: 0.5 + i * 0.01 }), 1, c), "scroll") as Extract<Effect, { kind: "scroll" }>[])
      .reduce((s, e) => s + e.dy, 0);
  }
  expect(down).toBeLessThan(0);
});

test("にぎった瞬間には、スクロールが飛ばない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, POINT({ x: 0.5, y: 0.3 }), 6, c);
  // 違う高さでにぎる。起点はにぎった位置なので、最初の数コマは動かない
  expect(kinds(feed(ctl, FIST({ x: 0.5, y: 0.7 }), 6, c), "scroll")).toHaveLength(0);
});

test("手が見えなくなったら、カーソルを隠す", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, POINT(), 6, c);
  const gone = kinds(feed(ctl, null, 1, c), "cursor")[0] as Extract<Effect, { kind: "cursor" }>;
  expect(gone.visible).toBe(false);
});

test("止めると効く形には、全部説明がある（説明に無い動きをしない）", () => {
  const helped = new Set(GESTURE_HELP.map((h) => h.pose));
  for (const pose of Object.keys(HOLDS)) expect(helped.has(pose as HandPose), pose).toBe(true);
  for (const p of ["point", "pinch", "fist"] as HandPose[]) expect(helped.has(p), p).toBe(true);
});
