/**
 * 「サーバーが断ったのに、画面が成功と言う」を塞いだことの検証。
 *
 * 見つかった形
 * ------------
 * サーバー（FastAPI）は失敗を `{"detail": "…"}` で返す。ところが画面の
 * 多くは `.error` だけを見て、無ければ成功として扱っていた。
 *
 *   POST /vault/upload → 409 {"detail": "保存先がつながっていないため…"}
 *   画面              → 「✓ a.txt を取り込みました（0字）」
 *
 * サーバーは正しく断り、理由まで書いているのに、画面が「入りました」と
 * 言っていた。本物のバックエンドで再現して確かめた。同じ形が9か所あった
 * （資料・LP・スライド修正・ナレーション・DB移行・HFモデル…）。
 *
 * 直し方を api.ts の1か所（failable）に寄せたので、ここではその1か所が
 * 「断りを断りとして返す」ことを固定する。呼ぶ側の作法を変えるより、
 * 返す形を正しくするほうが崩れない。
 */

import { test, expect } from "@playwright/test";
import "./apiUrlForTests";                 // api.ts より先に接続先を立てる
import { vaultUpload, lpGenerate, slideRevise, type Slide } from "../src/lib/api";

/** fetch を差し替えて、決まった応答を返す。 */
function reply(status: number, body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error("not json");
      return body;
    },
  } as Response)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const file = () => new File(["hello"], "a.txt", { type: "text/plain" });

test("detail で断られたら、その理由が error として返る", async () => {
  const detail = "保存先がつながっていないため、保存できませんでした。"
    + "拡張機能（EXTEND）→ Supabase から自分のデータベースを接続してください。";
  const restore = reply(409, { detail });
  try {
    const r = await vaultUpload("nb1", file());
    expect(r.error, "断られたのに error が無い＝画面は成功と読む").toBeTruthy();
    // 次に何をすればいいかが、そのまま残っている
    expect(r.error).toContain("データベースを接続");
  } finally {
    restore();
  }
});

test("ログインが切れたときも、成功に見せない", async () => {
  const restore = reply(401, { detail: "Not authenticated" });
  try {
    const r = await vaultUpload("nb1", file());
    expect(r.error).toBeTruthy();
  } finally {
    restore();
  }
});

test("理由が無い失敗でも、手がかりを残す", async () => {
  const restore = reply(500, {});
  try {
    const r = await lpGenerate({ brief: "x" });
    expect(r.error).toContain("500");       // せめて番号は出す
  } finally {
    restore();
  }
});

test("入力の形が違うときは、読める言葉にする", async () => {
  // FastAPI の入力検査は配列で返る。そのまま出しても読めない。
  const restore = reply(422, { detail: [{ loc: ["body", "topic"], msg: "field required" }] });
  try {
    const r = await lpGenerate({ brief: "" });
    expect(r.error).toBe("送った内容の形が正しくありません");
  } finally {
    restore();
  }
});

test("200 なのに中身が読めないときも、成功として通さない", async () => {
  // プロキシがHTMLを挟むことがある。JSONとして読めなければ壊れた応答。
  const restore = reply(200, undefined);
  try {
    const r = await slideRevise({ slide: { title: "見出し" } as Slide, instruction: "直して" });
    expect(r.error).toBeTruthy();
  } finally {
    restore();
  }
});

test("うまくいったときは、中身をそのまま通す", async () => {
  // 断りを見張るあまり、成功まで壊していないこと。
  const restore = reply(200, { ok: true, title: "a.txt", chars: 1234 });
  try {
    const r = await vaultUpload("nb1", file());
    expect(r.error).toBeFalsy();
    expect(r.chars).toBe(1234);
    expect(r.title).toBe("a.txt");
  } finally {
    restore();
  }
});

test("サーバーが error で返す口も、これまで通り読める", async () => {
  // /image/generate のように {"error": …} を返す口もある。両方拾う。
  const restore = reply(400, { error: "指示が空です" });
  try {
    const r = await lpGenerate({ brief: "" });
    expect(r.error).toBe("指示が空です");
  } finally {
    restore();
  }
});

/* ── 投げる側（throw）にも、同じ理由が残ること ────────────────────
 *
 * 一覧を取る口などは、失敗したら例外を投げる作りになっている。そちらも
 * `data.error` だけを見ていたので、FastAPI の detail が捨てられ、
 *
 *   409 {"detail": "保存先がつながっていないため…接続してください。"}
 *   → 「Create mission failed (409)」
 *
 * と、次の手が書いてある文が英字1行に化けていた。 */
test("投げるときも、サーバーの理由をそのまま載せる", async () => {
  const { autopilotCreate } = await import("../src/lib/api");
  const restore = reply(409, {
    detail: "保存先がつながっていないため、保存できませんでした。拡張機能（EXTEND）→ Supabase から接続してください。",
  });
  try {
    await expect(autopilotCreate("提案資料を仕上げる")).rejects.toThrow(/Supabase から接続/);
  } finally {
    restore();
  }
});

test("理由が無いときは、せめて何が失敗したかを残す", async () => {
  const { autopilotCreate } = await import("../src/lib/api");
  const restore = reply(500, {});
  try {
    await expect(autopilotCreate("x")).rejects.toThrow(/Create mission failed \(500\)/);
  } finally {
    restore();
  }
});

test("error で返す口も、これまで通り読める（投げる側）", async () => {
  const { autopilotCreate } = await import("../src/lib/api");
  const restore = reply(400, { error: "ゴールが空です" });
  try {
    await expect(autopilotCreate("")).rejects.toThrow("ゴールが空です");
  } finally {
    restore();
  }
});
