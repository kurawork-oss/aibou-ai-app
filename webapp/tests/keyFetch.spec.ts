/**
 * 鍵の一覧を、同じ瞬間に何回も聞かないことの検証。
 *
 * 同じ画面の別々の部品（設定の案内・初回の案内・拡張機能）が、それぞれ
 * 自分のために /keys を取る。作りとしては正しいが、実測すると管理タブを
 * 開くたびに同じ物を2回聞いていた。無料のバックエンドは寝ているので、
 * 1往復の無駄がそのまま体感の遅さになる。
 *
 * ただし**溜め込みはしない**のが肝。少しでも溜めると、鍵を保存した直後に
 * 古い一覧を見せることになり、「入れたのに未設定に戻る」に逆戻りする。
 * だから「同じ瞬間に飛んでいる物だけ束ねる」を、ここで固定する。
 */

import { test, expect } from "@playwright/test";
import "./apiUrlForTests";                 // api.ts より先に接続先を立てる
import { listKeys } from "../src/lib/api";

/** fetch を差し替えて、呼ばれた回数を数える。応答は待たせられる。 */
function stubKeys(items: unknown[], opts: { fail?: boolean } = {}) {
  let calls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    await gate;
    if (opts.fail) return { ok: false, status: 503, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => ({ items }) } as Response;
  }) as typeof fetch;
  return {
    get calls() { return calls; },
    release: () => release?.(),
    restore: () => { globalThis.fetch = original; },
  };
}

test("同じ瞬間に3つの部品が聞いても、往復は1回", async () => {
  const f = stubKeys([{ name: "GEMINI_API_KEY", set: true }]);
  try {
    const all = Promise.all([listKeys(), listKeys(), listKeys()]);
    f.release();
    const [a, b, c] = await all;
    expect(f.calls).toBe(1);
    // 3つとも同じ答えを受け取っていること（1つだけ空、では困る）
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a[0].name).toBe("GEMINI_API_KEY");
  } finally {
    f.restore();
  }
});

test("終わったあとに聞いたら、ちゃんと聞き直す（溜め込まない）", async () => {
  // 鍵を保存した直後に古い一覧を見せないための線。
  const first = stubKeys([{ name: "GEMINI_API_KEY", set: false }]);
  try {
    const p = listKeys();
    first.release();
    expect((await p)[0].set).toBeFalsy();
  } finally {
    first.restore();
  }

  const second = stubKeys([{ name: "GEMINI_API_KEY", set: true }]);
  try {
    const p = listKeys();
    second.release();
    expect(second.calls, "前の答えを使い回している").toBe(1);
    expect((await p)[0].set).toBeTruthy();
  } finally {
    second.restore();
  }
});

test("失敗を握ったままにしない", async () => {
  // 失敗した約束を持ち続けると、次に聞いた人にも同じ失敗を返し続ける。
  // 一度失敗したら二度と鍵が読めない画面になるので、そこを塞ぐ。
  const bad = stubKeys([], { fail: true });
  try {
    const p = listKeys();
    bad.release();
    await expect(p).rejects.toThrow(/503/);
  } finally {
    bad.restore();
  }

  const good = stubKeys([{ name: "GEMINI_API_KEY", set: true }]);
  try {
    const p = listKeys();
    good.release();
    expect(good.calls).toBe(1);
    expect((await p)[0].set).toBeTruthy();
  } finally {
    good.restore();
  }
});
