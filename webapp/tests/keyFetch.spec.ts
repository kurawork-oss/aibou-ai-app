/**
 * 鍵の一覧を、何度も聞かないことの検証。
 *
 * 同じ画面の別々の部品（設定の案内・初回の案内・連携）が、それぞれ自分の
 * ために /keys を取る。作りとしては正しいが、全画面を1周した実測で
 * **11回**飛んでいた。無料のバックエンドは寝ているので、1往復の無駄が
 * そのまま体感の遅さになる。
 *
 * はじめは「同じ瞬間に飛んでいる物だけ束ねる」にしていた。溜め込むと
 * 「鍵を入れた直後に未設定と出る」に逆戻りする、という理由で。
 * ただしそれでは画面をまたぐぶんが1つも減らず、11回のままだった
 * （束ねられるのは同時に立ち上がる部品だけなので）。
 *
 * いまは**少しのあいだ（15秒）だけ**覚えておく。そのうえで、逆戻りを
 * 起こす道を全部塞ぐ——鍵を入れた・消した・救い出した・会話の設定から
 * 戻ってきた、のどれでも、その場で捨てる。ここで固定するのはその2つ:
 *
 *   ・少しのあいだは使い回す（往復が減る）
 *   ・入れ替えたら必ず捨てる（古い一覧を見せない）
 */

import { test, expect } from "@playwright/test";
import "./apiUrlForTests";                 // api.ts より先に接続先を立てる
import { listKeys, forgetKeys, KEYS_TTL } from "../src/lib/api";

test.beforeEach(() => { forgetKeys(); });

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

test("少しのあいだは使い回す（画面をまたぐ往復を減らす）", async () => {
  const first = stubKeys([{ name: "GEMINI_API_KEY", set: false }]);
  try {
    const p = listKeys();
    first.release();
    await p;
  } finally {
    first.restore();
  }

  const second = stubKeys([{ name: "GEMINI_API_KEY", set: true }]);
  try {
    const p = listKeys();
    second.release();
    await p;
    expect(second.calls, "覚えているのに聞き直している").toBe(0);
  } finally {
    second.restore();
  }
});

test("入れ替えたら、その場で捨てる（入れたのに未設定に戻らない）", async () => {
  /* ここがこの仕組みの生命線。覚えておくこと自体は速さのためで、
     「鍵を入れた直後に未設定と出る」を1回でも起こしたら割に合わない。 */
  const first = stubKeys([{ name: "GEMINI_API_KEY", set: false }]);
  try {
    const p = listKeys();
    first.release();
    expect((await p)[0].set).toBeFalsy();
  } finally {
    first.restore();
  }

  forgetKeys();                       // setKey / deleteKey / 救出 / 設定の再開が呼ぶ

  const second = stubKeys([{ name: "GEMINI_API_KEY", set: true }]);
  try {
    const p = listKeys();
    second.release();
    expect(second.calls, "捨てたのに聞き直していない").toBe(1);
    expect((await p)[0].set).toBeTruthy();
  } finally {
    second.restore();
  }
});

test("覚えておく時間は、目で見て分かるほど長くない", () => {
  // 長くすると、サーバー側で鍵が変わったことに気づけない時間が延びる。
  expect(KEYS_TTL).toBeLessThanOrEqual(20_000);
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
