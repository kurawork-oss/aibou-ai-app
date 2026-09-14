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
 * 画面を開かなくても分かる種類の間違いなので、ここで押さえる。
 */

import { test, expect } from "@playwright/test";
import { coreStateOf, coreStateLabel, type CoreState } from "../src/lib/coreState";

test("道具を動かしている間は、考えているとは別の顔になる", () => {
  /* ここが同じだと、10秒かかる画像生成のあいだ、ただ固まって見える。 */
  expect(coreStateOf({ streaming: true, acting: true })).toBe("working");
  expect(coreStateOf({ streaming: true })).toBe("thinking");
});

test("聞いているときは、何があっても聞いている", () => {
  // ここだけ利用者の番。こちらの都合で上書きすると、話しかけているのに
  // 反応が無いように見える。
  expect(coreStateOf({ listening: true, acting: true, speaking: true, streaming: true }))
    .toBe("listening");
});

test("何も起きていなければ待機", () => {
  expect(coreStateOf({})).toBe("idle");
  expect(coreStateOf({ listening: false, speaking: false, acting: false, streaming: false }))
    .toBe("idle");
});

test("喋りながら動かしているときは、動かしているほうを出す", () => {
  // 読み上げは耳で分かる。目で知りたいのは「手が動いているか」。
  expect(coreStateOf({ speaking: true, acting: true })).toBe("working");
});

test("どの状態にも、待機と違う呼び名がある", () => {
  /* 足し忘れると default に落ちて "ONLINE"（待機）になる。
     動いているのに「待機」と書いてあるのがいちばん困る。 */
  const all: CoreState[] = ["idle", "listening", "speaking", "thinking", "working"];
  const idle = coreStateLabel("idle");
  for (const s of all) {
    const label = coreStateLabel(s);
    expect(label, `${s} に呼び名が無い`).toBeTruthy();
    if (s !== "idle") {
      expect(label, `${s} が待機と同じ呼び名になっている`).not.toBe(idle);
    }
  }
});

test("呼び名が重なっていない", () => {
  const all: CoreState[] = ["idle", "listening", "speaking", "thinking", "working"];
  const labels = all.map(coreStateLabel);
  expect(new Set(labels).size, `重なり: ${labels.join(", ")}`).toBe(all.length);
});
