/**
 * コアが「いま何をしているか」の決め方。
 *
 * なぜテストが要るか
 * ------------------
 * この判定は、式が Chat.tsx、呼び名が page.tsx、見た目が CoreOrb.tsx と
 * 3か所に散っていた。状態を1つ足したとき、**足し忘れた所だけ静かに
 * おかしくなる**——実際、呼び名の表が古いままで、新しい状態のときだけ
 * HUDが "ONLINE"（待機）と出ていた。動いているのに待機と書いてある。
 *
 * とくに重いのは「止まっているのに、止まっていると分からない」形。
 * 承認待ちと設定待ちは、こちらが答えるまで一歩も進まないのに、コアは
 * 待機の顔をしていた。画面から目を離していた人には、終わったように見える。
 */

import { test, expect } from "@playwright/test";
import {
  coreStateOf, coreStateLabel, CORE_STATES, COMPLETED_MS, TUNES, type CoreState,
} from "../src/lib/coreState";

test("道具を動かしている間は、考えているとは別の顔になる", () => {
  /* ここが同じだと、10秒かかる画像生成のあいだ、ただ固まって見える。 */
  expect(coreStateOf({ streaming: true, acting: true })).toBe("working");
  expect(coreStateOf({ streaming: true })).toBe("thinking");
});

test("準備中と、考え中を分ける", () => {
  // 準備（記憶やルールの読み込み）は返事が始まる前に終わらせる必要があり、
  // 重くなるとそのまま待ち時間になる。どちらが重いのか見えるようにする。
  expect(coreStateOf({ planning: true, streaming: true })).toBe("planning");
});

test("聞いているときは、何があっても聞いている", () => {
  // ここだけ利用者の番。こちらの都合で上書きすると、話しかけているのに
  // 反応が無いように見える。
  expect(coreStateOf({
    listening: true, acting: true, speaking: true, streaming: true,
    awaiting: true, setup: true, failed: true,
  })).toBe("listening");
});

test("承認待ちは、待機に見えない", () => {
  /* いちばん困る形。押すまで一歩も進まないのに、待機の顔をしていると
     「終わったのかな」と画面を閉じられてしまう。 */
  expect(coreStateOf({ awaiting: true })).toBe("waiting_user");
  expect(coreStateOf({ awaiting: true, streaming: true })).toBe("waiting_user");
});

test("繋がないと進めないときも、待機に見えない", () => {
  expect(coreStateOf({ setup: true })).toBe("setup_required");
});

test("失敗は、動いているように見せない", () => {
  expect(coreStateOf({ failed: true })).toBe("error");
  // 新しいやり取りが始まれば、失敗の顔は残さない（呼ぶ側が降ろす）
  expect(coreStateOf({ streaming: true })).toBe("thinking");
});

test("何も起きていなければ待機", () => {
  expect(coreStateOf({})).toBe("idle");
  expect(coreStateOf({
    listening: false, speaking: false, acting: false, streaming: false,
    planning: false, awaiting: false, setup: false, failed: false, done: false,
  })).toBe("idle");
});

test("喋りながら動かしているときは、動かしているほうを出す", () => {
  // 読み上げは耳で分かる。目で知りたいのは「手が動いているか」。
  expect(coreStateOf({ speaking: true, acting: true })).toBe("working");
});

test("終わったことは、いちばん弱い", () => {
  // 次のやり取りが始まっていたら、そちらを出す。
  expect(coreStateOf({ done: true })).toBe("completed");
  expect(coreStateOf({ done: true, streaming: true })).toBe("thinking");
});

test("「終わった」は出しっぱなしにしない", () => {
  // 消えないと待機と区別が付かなくなり、短すぎると見逃す。
  expect(COMPLETED_MS).toBeGreaterThan(800);
  expect(COMPLETED_MS).toBeLessThan(5000);
});

test("仕様に挙がっている状態が、全部ある", () => {
  /* 仕様§37 の AgentState。ここが欠けていると、その状況で
     コアは「待機」の顔をしたままになる。 */
  for (const want of ["idle", "listening", "thinking", "planning", "working",
    "waiting_user", "setup_required", "completed", "error"]) {
    expect(CORE_STATES, `${want} が無い`).toContain(want as CoreState);
  }
});

test("どの状態にも、待機と違う呼び名がある", () => {
  /* 足し忘れると default に落ちて "ONLINE"（待機）になる。
     動いているのに「待機」と書いてあるのがいちばん困る。 */
  const idle = coreStateLabel("idle");
  for (const s of CORE_STATES) {
    const label = coreStateLabel(s);
    expect(label, `${s} に呼び名が無い`).toBeTruthy();
    if (s !== "idle") {
      expect(label, `${s} が待機と同じ呼び名になっている`).not.toBe(idle);
    }
  }
});

test("呼び名が重なっていない", () => {
  const labels = CORE_STATES.map(coreStateLabel);
  expect(new Set(labels).size, `重なり: ${labels.join(", ")}`).toBe(CORE_STATES.length);
});

/* ── 見た目 ─────────────────────────────────────────────────────────
 *
 * 状態を足しても、見た目が前の状態と同じなら、見ている側には何も
 * 変わっていない。文字（HUD）だけ変わっても、コアを見ている人には
 * 届かない。数字が実際に離れているかを見る。 */

/** 2つの調整値が、どれくらい違うか（各項目の相対差の合計）。 */
function distance(a: Record<string, number>, b: Record<string, number>): number {
  return Object.keys(a).reduce((sum, k) => {
    const big = Math.max(Math.abs(a[k]), Math.abs(b[k]), 1e-6);
    return sum + Math.abs(a[k] - b[k]) / big;
  }, 0);
}

test("どの2つの状態も、見た目が同じではない", () => {
  const same: string[] = [];
  for (let i = 0; i < CORE_STATES.length; i++) {
    for (let j = i + 1; j < CORE_STATES.length; j++) {
      const a = CORE_STATES[i], b = CORE_STATES[j];
      const d = distance(TUNES[a] as unknown as Record<string, number>,
                         TUNES[b] as unknown as Record<string, number>);
      if (d < 0.5) same.push(`${a} と ${b}（差 ${d.toFixed(2)}）`);
    }
  }
  expect(same, `見分けの付かない組み合わせ:\n${same.join("\n")}`).toEqual([]);
});

test("待っている状態は、動いている状態よりはっきり静か", () => {
  /* 回っていると「裏で進んでいる」ように見えて、待たれていることに
     気づけない。承認待ちでいちばん困るのがこれ。 */
  expect(TUNES.waiting_user.spin).toBeLessThan(TUNES.working.spin / 3);
  expect(TUNES.setup_required.spin).toBeLessThan(TUNES.working.spin / 3);
  // ただし呼びかけてはいる（脈は大きい）
  expect(TUNES.waiting_user.pulseAmp).toBeGreaterThan(TUNES.idle.pulseAmp);
});

test("失敗は、まだ何かやっているようには見せない", () => {
  expect(TUNES.error.spin).toBeLessThan(TUNES.idle.spin);
  expect(TUNES.error.glow).toBeLessThan(TUNES.idle.glow);
});
