/**
 * 手順の種類の表が、画面とサーバーでずれていないか。
 *
 * ここが崩れると何が起きるか
 * --------------------------
 * この表は FlowBuilder と Dashboard に**まったく同じ形で2つ**あった。
 * 手順を1つ足したとき、片方だけ直る。実際 fetch を足した時点で
 * Dashboard 側が取り残されていた（型エラーで気づけたが、型が無ければ
 * 「作った手順が一覧に出ない」という形で黙って出ていた）。
 *
 * いまは lib/flowSteps.ts に1つだけ。その1つが
 *   ・欠けなくサーバーの種類を網羅しているか
 *   ・人が見て意味の分かる形になっているか
 * をここで押さえる。
 */

import { test, expect } from "@playwright/test";
import { STEP_META, STEP_TYPES } from "../src/lib/flowSteps";

/** サーバー側の api/flow_engine.py の STEP_TYPES と同じ並び。 */
const SERVER_STEP_TYPES = ["ai_generate", "fetch", "notify", "create_task"];

test("サーバーが動かせる手順は、全部画面から選べる", async () => {
  for (const t of SERVER_STEP_TYPES) {
    expect(STEP_TYPES, `${t} が画面の一覧に無い`).toContain(t);
  }
  // 逆に、画面にあってサーバーが知らない種類を出さない
  for (const t of STEP_TYPES) {
    expect(SERVER_STEP_TYPES, `${t} はサーバーが知らない`).toContain(t);
  }
});

test("どの手順にも、ラベル・色・入力先・例文がある", async () => {
  for (const t of STEP_TYPES) {
    const m = STEP_META[t];
    expect(m.label, t).toBeTruthy();
    expect(m.color, t).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.field, t).toBeTruthy();
    expect(m.placeholder, t).toBeTruthy();
  }
});

test("手順ごとに色が違う（左端の帯で見分ける）", async () => {
  const colors = STEP_TYPES.map((t) => STEP_META[t].color.toLowerCase());
  expect(new Set(colors).size, `同じ色の手順がある: ${colors.join(", ")}`).toBe(colors.length);
});

test("外から読む手順は、入れる先が url で、読めない所があると書いてある", async () => {
  const m = STEP_META.fetch;
  // params.url に入らないと、サーバーは「URLが空」として飛ばす
  expect(m.field).toBe("url");
  // 「なんでも読める」と思わせない
  expect(m.hint, "読めない先があることを書いていない").toBeTruthy();
  expect(m.hint).toContain("読めません");
});
