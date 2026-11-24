/**
 * 手の形の見分けと、誤動作の防ぎ方（lib/handGesture.ts）。
 *
 * カメラは使わない。手の21点を組み立てて渡す。ここが崩れると
 * 「勝手に押す」「止めたのに動く」「動かしたのに付いてこない」になるので、
 * 押す回数とカーソルの動きを数えて見張る。
 */

import { test, expect } from "@playwright/test";
import {
  classifyHand, GestureController, GESTURE_HELP, HOLDS, PINCH_OFF, PINCH_ON, pinchCloseness,
  SPEEDS, toScreen, type ControllerOptions, type Effect, type HandPose, type Hover, type Pt,
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
  u = 0.12,
): Pt[] {
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

type At = { x: number; y: number };
const POINT = (at?: At) => hand({ index: "out" }, at);
const PINCH = (at?: At) => hand({}, at, true);
const FIST = (at?: At) => hand({}, at);
const PALM = (at?: At) => hand({ index: "out", middle: "out", ring: "out", pinky: "out", thumb: "out" }, at);
const VICTORY = (at?: At) => hand({ index: "out", middle: "out" }, at);
const THUMBS_UP = (at?: At) => hand({ thumb: "up" }, at);

test("形を見分ける", () => {
  const cases: [Pt[], HandPose][] = [
    [POINT(), "point"],
    [PINCH(), "pinch"],
    [FIST(), "fist"],
    [PALM(), "palm"],
    [VICTORY(), "victory"],
    [hand({ index: "out", middle: "out", ring: "out" }), "three"],
    [THUMBS_UP(), "thumbs_up"],
    // 人差し指と小指（どれにも当たらない形）
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
  const base = PINCH();
  const palm = Math.hypot(base[0].x - base[9].x, base[0].y - base[9].y);
  const mid = ((PINCH_ON + PINCH_OFF) / 2) * palm;
  const lm = base.map((p) => ({ ...p }));
  lm[8] = { x: lm[4].x + mid, y: lm[4].y };
  expect(classifyHand(lm, true).pose).toBe("pinch");
  expect(classifyHand(lm, false).pose).not.toBe("pinch");
});

test("つまみかけを 0〜1 で返す（画面の点が大きくなる）", () => {
  expect(pinchCloseness(Infinity)).toBe(0);
  expect(pinchCloseness(2)).toBe(0);
  expect(pinchCloseness(PINCH_ON)).toBe(1);
  const half = pinchCloseness((PINCH_ON + 0.95) / 2);
  expect(half).toBeGreaterThan(0.3);
  expect(half).toBeLessThan(0.7);
});

test("点が足りない・手のひらが潰れているときは、何もしない", () => {
  expect(classifyHand([]).pose).toBe("none");
  expect(classifyHand(Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }))).pose).toBe("none");
});

test("映像は鏡に見せるので、左右を入れ替えて画面に出す", () => {
  expect(toScreen({ x: 0.25, y: 0.3 }).x).toBeGreaterThan(0.9);
  expect(toScreen({ x: 0.75, y: 0.3 }).x).toBeLessThan(0.1);
  expect(toScreen({ x: -1, y: 2 })).toEqual({ x: 1, y: 1 });
});

test("速さ: 「はやい」ほど、少しの動きで大きく動く", () => {
  const w = (s: keyof typeof SPEEDS) => SPEEDS[s].region.x1 - SPEEDS[s].region.x0;
  expect(w("fast")).toBeLessThan(w("normal"));
  expect(w("normal")).toBeLessThan(w("slow"));
});

/** 33ms ごとに同じ手を n コマ流す。 */
function feed(ctl: GestureController, lm: Pt[] | null, n: number, clock: { t: number }, hover: Hover | null = null): Effect[] {
  const out: Effect[] = [];
  for (let i = 0; i < n; i++) { clock.t += 33; out.push(...ctl.step(lm, clock.t, hover)); }
  return out;
}
const kinds = <K extends Effect["kind"]>(e: Effect[], k: K) => e.filter((x) => x.kind === k) as Extract<Effect, { kind: K }>[];
const lastCursor = (e: Effect[]) => kinds(e, "cursor").pop()!;
/** 止めて押すを切ったコントローラ（つまむの数え方だけ見る）。 */
const pinchOnly = (o: Partial<ControllerOptions> = {}) => new GestureController({ clickMode: "pinch", ...o });

test("カーソルは、どの手の形でも付いてくる（人差し指を見分けられなくても）", () => {
  for (const make of [PALM, POINT, VICTORY, (at?: At) => hand({ index: "out", pinky: "out" }, at)]) {
    const ctl = new GestureController();
    const c = { t: 0 };
    const a = lastCursor(feed(ctl, make({ x: 0.4, y: 0.6 }), 15, c));
    const b = lastCursor(feed(ctl, make({ x: 0.6, y: 0.6 }), 15, c));
    expect(a.visible).toBe(true);
    // 手を右へ（画像の x が増える）→ 鏡なので画面では左へ
    expect(b.x).toBeLessThan(a.x - 0.2);
  }
});

test("つまむと1回だけ押す。つまんだまま待っても連打しない", () => {
  const ctl = pinchOnly();
  const c = { t: 0 };
  feed(ctl, POINT(), 6, c);
  const held = feed(ctl, PINCH(), 30, c);
  expect(kinds(held, "click")).toHaveLength(1);
  expect(kinds(held, "click")[0].how).toBe("pinch");
  feed(ctl, POINT(), 6, c);
  expect(kinds(feed(ctl, PINCH(), 4, c), "click")).toHaveLength(1);
});

test("つまんでも押す場所がずれない（指の付け根を追うので）", () => {
  const ctl = pinchOnly();
  const c = { t: 0 };
  const cur = lastCursor(feed(ctl, PALM({ x: 0.5, y: 0.6 }), 10, c));
  const click = kinds(feed(ctl, PINCH({ x: 0.5, y: 0.6 }), 3, c), "click")[0];
  expect(Math.abs(click.x - cur.x)).toBeLessThan(0.02);
  expect(Math.abs(click.y - cur.y)).toBeLessThan(0.02);
});

test("一度もカーソルが出ていないのに、つまんだだけでは押さない", () => {
  const ctl = pinchOnly({ stableFrames: 3 });
  // 最初のコマからつまんでいる手 → カーソルは止まったまま（出ていない）
  expect(kinds(feed(ctl, PINCH(), 10, { t: 0 }), "click")).toHaveLength(0);
});

test("止めて押す: 同じボタンの上で1秒止めると1回だけ押す。止め続けても押し直さない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  const btn: Hover = { key: 1 };
  const early = feed(ctl, PALM(), 20, c, btn); // 0.66秒
  expect(kinds(early, "click")).toHaveLength(0);
  expect(ctl.view.dwell).toBeGreaterThan(0.4);
  const done = feed(ctl, PALM(), 40, c, btn);  // さらに1.3秒
  expect(kinds(done, "click")).toHaveLength(1);
  expect(kinds(done, "click")[0].how).toBe("dwell");
  // 別のボタンに移れば、また1秒で押せる
  expect(kinds(feed(ctl, PALM(), 40, c, { key: 2 }), "click")).toHaveLength(1);
});

test("止めて押す: 押せる物の上でなければ数えない・承認ボタンは押さない", () => {
  const c = { t: 0 };
  const none = new GestureController();
  expect(kinds(feed(none, PALM(), 60, c, null), "click")).toHaveLength(0);
  const blocked = new GestureController();
  expect(kinds(feed(blocked, PALM(), 60, c, { key: 9, blocked: true }), "click")).toHaveLength(0);
  expect(blocked.view.dwell).toBe(0);
});

test("止めて押す: 通りがかり（大きく動いている間）は数え直す", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  const btn: Hover = { key: 1 };
  const out: Effect[] = [];
  // 同じ大きなボタンの上を、ゆっくり横切り続ける
  for (let i = 0; i < 60; i++) out.push(...feed(ctl, PALM({ x: 0.3 + i * 0.008, y: 0.5 }), 1, c, btn));
  expect(kinds(out, "click")).toHaveLength(0);
});

test("止めて押す: にぎっている間・ピースの間は押さない", () => {
  const c = { t: 0 };
  const btn: Hover = { key: 1 };
  const f = new GestureController();
  feed(f, PALM(), 4, c, btn);
  expect(kinds(feed(f, FIST(), 60, c, btn), "click")).toHaveLength(0);
  const v = new GestureController();
  expect(kinds(feed(v, VICTORY(), 60, c, btn), "click")).toHaveLength(0);
});

test("つまんで押した物を、止めて押し直さない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  const btn: Hover = { key: 1 };
  feed(ctl, PALM(), 6, c, btn);
  const pinched = feed(ctl, PINCH(), 4, c, btn);
  const after = feed(ctl, PALM(), 60, c, btn);
  expect(kinds([...pinched, ...after], "click")).toHaveLength(1);
});

test("押し方の設定: 「止めるだけ」ではつまんでも押さない／「つまむだけ」では止めても押さない", () => {
  const c = { t: 0 };
  const btn: Hover = { key: 1 };
  const dwellOnly = new GestureController({ clickMode: "dwell" });
  feed(dwellOnly, PALM(), 6, c);
  expect(kinds(feed(dwellOnly, PINCH(), 6, c), "click")).toHaveLength(0);
  const pinch = pinchOnly();
  expect(kinds(feed(pinch, PALM(), 60, c, btn), "click")).toHaveLength(0);
});

test("1コマだけ違う形に見えても、切り替えない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  const out: Effect[] = [];
  for (let i = 0; i < 40; i++) out.push(...feed(ctl, i % 5 === 0 ? VICTORY() : POINT(), 1, c));
  expect(kinds(out, "command")).toHaveLength(0);
  expect(ctl.state.pose).toBe("point");
});

test("ピースを止めると、1回だけ「閉じる」。止めている間は進み具合が見える", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  const short = feed(ctl, VICTORY(), 12, c); // 0.4秒: まだ
  expect(kinds(short, "command")).toHaveLength(0);
  expect(ctl.view.hold?.command).toBe("close");
  expect(ctl.view.hold!.progress).toBeGreaterThan(0.2);
  const long = feed(ctl, VICTORY(), 40, c);
  expect(kinds(long, "command")).toEqual([{ kind: "command", command: "close" }]);
  expect(ctl.view.hold).toBeNull();
});

test("👍 を止めると一時停止。止めている間は、押さない・閉じない・カーソルを出さない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, POINT(), 6, c);
  expect(kinds(feed(ctl, THUMBS_UP(), 45, c), "paused")).toEqual([{ kind: "paused", paused: true }]);
  expect(ctl.state.paused).toBe(true);

  const btn: Hover = { key: 1 };
  const during = [
    ...feed(ctl, POINT(), 6, c, btn), ...feed(ctl, PINCH(), 6, c, btn),
    ...feed(ctl, PALM(), 60, c, btn), ...feed(ctl, VICTORY(), 40, c),
  ];
  expect(kinds(during, "click")).toHaveLength(0);
  expect(kinds(during, "command")).toHaveLength(0);
  expect(kinds(during, "cursor").every((e) => !e.visible)).toBe(true);

  // 止めている間でも、再開の 👍 は効く（進み具合も見える）
  feed(ctl, THUMBS_UP(), 10, c);
  expect(ctl.view.hold?.command).toBe("pause");
  expect(kinds(feed(ctl, THUMBS_UP(), 40, c), "paused")).toEqual([{ kind: "paused", paused: false }]);
});

test("手を広げて休めても、一時停止にならない（広げた手はふつうの動かし方）", () => {
  const ctl = new GestureController();
  const out = feed(ctl, PALM(), 90, { t: 0 });
  expect(kinds(out, "paused")).toHaveLength(0);
});

test("にぎって上げると下へ読み進め、下げると戻る", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, FIST({ x: 0.5, y: 0.6 }), 4, c);
  let up = 0;
  for (let i = 1; i <= 10; i++) {
    up += kinds(feed(ctl, FIST({ x: 0.5, y: 0.6 - i * 0.01 }), 1, c), "scroll").reduce((s, e) => s + e.dy, 0);
  }
  expect(up).toBeGreaterThan(0);
  let down = 0;
  for (let i = 1; i <= 10; i++) {
    down += kinds(feed(ctl, FIST({ x: 0.5, y: 0.5 + i * 0.01 }), 1, c), "scroll").reduce((s, e) => s + e.dy, 0);
  }
  expect(down).toBeLessThan(0);
});

test("にぎった瞬間には、スクロールが飛ばない", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, POINT({ x: 0.5, y: 0.3 }), 6, c);
  expect(kinds(feed(ctl, FIST({ x: 0.5, y: 0.7 }), 6, c), "scroll")).toHaveLength(0);
});

test("手が見えなくなったら、カーソルを隠す", () => {
  const ctl = new GestureController();
  const c = { t: 0 };
  feed(ctl, POINT(), 6, c);
  expect(lastCursor(feed(ctl, null, 1, c)).visible).toBe(false);
});

test("手が遠い・近いを見分ける（小窓で「近づけて」と言う）", () => {
  const far = new GestureController();
  feed(far, hand({ index: "out" }, { x: 0.5, y: 0.6 }, false, 0.04), 5, { t: 0 });
  expect(far.view.framing).toBe("far");
  const near = new GestureController();
  feed(near, hand({ index: "out" }, { x: 0.5, y: 0.8 }, false, 0.45), 5, { t: 0 });
  expect(near.view.framing).toBe("near");
  const ok = new GestureController();
  feed(ok, POINT(), 5, { t: 0 });
  expect(ok.view.framing).toBe("ok");
});

test("止めると効く形には、全部説明がある（説明に無い動きをしない）", () => {
  const helped = new Set<string>(GESTURE_HELP.map((h) => h.pose));
  for (const pose of Object.keys(HOLDS)) expect(helped.has(pose), pose).toBe(true);
  for (const p of ["move", "dwell", "pinch", "fist"]) expect(helped.has(p), p).toBe(true);
  // 覚える形は少なく（止める形は2つまで）
  expect(Object.keys(HOLDS).length).toBeLessThanOrEqual(2);
});
