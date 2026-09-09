/**
 * 「使う機能」の入り切りの検証。
 *
 * 機能が多いのは、AIに任せられる幅が広いということで、それ自体は強み。
 * ただし全員が全部を使うわけではないので、束ねて入り切りできるようにした。
 *
 * ここで守りたいのは1つ。**保存できていないのに、切り替わったふりをしない。**
 *
 * 自分のデータベースを繋いでいない人には、サーバーが 409 と理由を返す。
 * その理由を握りつぶすと、画面は切り替わったように描き、次に開いたら
 * 元に戻っている——利用者には原因が分からない。
 * しかも「通信を確かめてください」と出すと、直しようのない案内になる。
 */

import { test, expect } from "@playwright/test";
import "./apiUrlForTests";                 // api.ts より先に接続先を立てる
import { setPacks } from "../src/lib/api";

type Reply = { status: number; body: unknown };

/** fetch を差し替えて、送られた中身を覗く。 */
function stubFetch(reply: Reply) {
  const seen: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test("保存できたときは、そのまま通す", async () => {
  const f = stubFetch({ status: 200, body: { ok: true, packs: ["core", "make"] } });
  try {
    const res = await setPacks(["core", "make"]);
    expect(res.ok).toBeTruthy();
    expect(res.error).toBeUndefined();
    expect(f.seen[0].url).toContain("/capabilities/packs");
    expect(f.seen[0].body).toEqual({ packs: ["core", "make"] });
  } finally {
    f.restore();
  }
});

test("断られたら、サーバーの理由をそのまま返す", async () => {
  // 保存先が無い人に返る本物の形（detail に理由が入る）
  const f = stubFetch({
    status: 409,
    body: { detail: "保存先がつながっていないため、保存できませんでした。拡張機能（EXTEND）→ Supabase から自分のデータベースを接続してください。" },
  });
  try {
    const res = await setPacks(["core", "dev"]);
    expect(res.ok).toBeFalsy();
    // 次に何をすればいいかが残っていること
    expect(res.error).toContain("データベースを接続");
    // 通信のせいにしない（直しようがない案内になる）
    expect(res.error).not.toContain("通信");
  } finally {
    f.restore();
  }
});

test("理由が無い失敗でも、成功に見せない", async () => {
  const f = stubFetch({ status: 500, body: {} });
  try {
    const res = await setPacks(["core"]);
    expect(res.ok).toBeFalsy();
    expect(res.error).toContain("500");     // せめて手がかりを残す
  } finally {
    f.restore();
  }
});

test("error でも detail でも、どちらの形でも読める", async () => {
  // サーバーは場所によって error / detail のどちらかで返す
  const f = stubFetch({ status: 409, body: { error: "こちらの形" } });
  try {
    expect((await setPacks([])).error).toBe("こちらの形");
  } finally {
    f.restore();
  }
});
