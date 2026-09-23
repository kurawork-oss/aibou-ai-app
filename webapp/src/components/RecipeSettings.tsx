"use client";

/**
 * 決まった手順（api/recipes.py）の一覧・流す・消す。
 *
 * なぜ要るか
 * ----------
 * 「毎朝、社内ポータルで今日のケースを開いて、担当で絞って読む」は、毎回
 * AIに画面を見せて判断させる仕事ではない。一度うまくいった手順に名前を
 * 付けて残し、次からはその通りに流す（役割分担の、Playwright 側）。
 *
 * 会話からも流せる（「朝のケース確認を流して」）。ここは、何が残っていて、
 * 最後にうまく流れたかを見て、要らない物を消す所。
 *
 * 流す前に必ず中身を見せる
 * ------------------------
 * ここで「流す」を押すと、**流す手順そのもの**（値を入れた形）を出してから
 * もう一度押してもらう。名前だけで流すと、中身が書き換えられていても
 * 気づけない。流すのは確認の門を通る口（/agent/execute）で、ここに
 * 専用の「押せば流れる口」は作っていない。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  API_URL, agentExecute, deleteRecipe, listRecipes,
  type Recipe, type RecipeStep,
} from "@/lib/api";

/** 1手を人の言葉で（サーバーの recipes.preview と同じ言い方）。 */
function say(s: RecipeStep): string {
  const t = s.target ?? "";
  const v = s.value ?? "";
  switch (s.do) {
    case "goto": return `${v || t} へ移る`;
    case "click": return `「${t}」を押す`;
    case "fill": return `「${t}」に「${v}」と入力`;
    case "select": return `「${t}」で「${v}」を選ぶ`;
    case "press": return `${t || "Enter"} キーを押す`;
    case "wait": return `${v || "1000"}ミリ秒待つ`;
    default: return s.do;
  }
}

/** 空け所に値を入れた形（見せる用。URLに入る所も、読める形のまま見せる）。 */
function fill(text: string | undefined, values: Record<string, string>): string {
  return (text ?? "").replace(/\{([^{}\s]{1,24})\}/g, (m, k: string) =>
    (values[k] ?? "").trim() ? values[k] : m);
}

export default function RecipeSettings() {
  const [items, setItems] = useState<Recipe[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string>("");        // 中身を見ている手順
  const [running, setRunning] = useState<string>("");  // 流す前の確認中
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; text: string } | null>(null);

  /* 追い越しを捨てる（消した直後の読み込みが、消す前の一覧で上書きしないように） */
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const got = await listRecipes();
    if (mine !== seq.current) return;
    if (got) { setItems(got); setFailed(false); } else { setFailed(true); }
  }, []);

  useEffect(() => { if (API_URL) void load(); }, [load]);

  const remove = useCallback(async (r: Recipe) => {
    if (!window.confirm(`手順「${r.name}」を消します。`)) return;
    setBusy(true);
    await deleteRecipe(r.id);
    setBusy(false);
    void load();
  }, [load]);

  const start = useCallback((r: Recipe) => {
    setRunning(r.id);
    setOpen("");
    setResult(null);
    setValues(Object.fromEntries((r.params ?? []).map((p) => [p, ""])));
  }, []);

  const run = useCallback(async (r: Recipe) => {
    setBusy(true);
    try {
      // 確認は、いま見せた手順で済んでいる。見せた重さの上限（3）を添える
      const { result: text } = await agentExecute("recipe_run", { name: r.name, values }, 3);
      setResult({ id: r.id, text });
    } catch {
      setResult({ id: r.id, text: "流せませんでした（通信に失敗しました）" });
    } finally {
      setBusy(false);
      setRunning("");
      void load();                   // 最後に流した結果を一覧に出し直す
    }
  }, [values, load]);

  if (!API_URL) return null;
  const list = items ?? [];

  return (
    <section className="mb-4 rounded-forge border border-panel p-3" aria-label="決まった手順">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">決まった手順</span>
        <span className="text-[10px] text-muted label-mono">
          {failed ? "一覧を取得できませんでした" : items ? `${list.length}個` : "…"}
        </span>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        一度うまくいったブラウザ操作に名前を付けて残し、次からは
        <b className="text-fg-strong">その通りに流します</b>（手元の専用ブラウザで）。
        1手でも失敗したら、そこで止めて続きは押しません。
        <b className="text-fg-strong">パスワードは手順に入れられません</b>
        ——ログインは手元で一度だけ通します。
      </p>

      {items && !list.length && (
        <p className="text-[11px] leading-relaxed text-muted">
          まだありません。ブラウザの操作を承認して押したあとに出る
          「この手順を保存」か、会話で「この手順を『朝のケース確認』として保存して」で残せます。
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {list.map((r) => (
          <div key={r.id} className="rounded-forge border border-panel p-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-fg-strong">{r.name}</div>
                <div className="text-[10px] text-muted">
                  {r.steps.length}手 · {r.touches ? "押す手順あり（流す前に確認）" : "読むだけ"}
                  {r.params?.length ? ` · 入れる値: ${r.params.join("、")}` : ""}
                </div>
                {r.last_result && (
                  <div className="text-[10px]"
                       style={{ color: r.last_result.startsWith("✓") ? "var(--accent)" : "#ffb4b4" }}>
                    最後: {r.last_result}
                  </div>
                )}
              </div>
              <button type="button" onClick={() => setOpen(open === r.id ? "" : r.id)}
                aria-label={`${r.name} の中身を見る`}
                className="shrink-0 text-[10px] text-muted underline label-mono">
                中身
              </button>
              <button type="button" disabled={busy} onClick={() => start(r)}
                aria-label={`${r.name} を流す`}
                className="shrink-0 text-[10px] text-muted underline label-mono disabled:opacity-40">
                流す
              </button>
              <button type="button" disabled={busy} onClick={() => void remove(r)}
                aria-label={`${r.name} を消す`}
                className="shrink-0 text-[10px] text-muted underline label-mono disabled:opacity-40">
                消す
              </button>
            </div>

            {open === r.id && (
              <ol className="mt-1.5 list-decimal pl-5 text-[11px] leading-relaxed text-fg">
                <li className="list-none -ml-5 text-muted">開く: {r.url}</li>
                {r.steps.map((s, i) => <li key={i}>{say(s)}</li>)}
              </ol>
            )}

            {/* 流す前に、値を入れた形の手順を見せてから、もう一度押してもらう */}
            {running === r.id && (
              <div className="mt-2 rounded-forge border border-[#ffd06055] bg-[rgba(255,208,96,0.06)] p-2">
                {(r.params ?? []).map((p) => (
                  <label key={p} className="mb-1 flex items-center gap-2 text-[11px] text-fg">
                    <span className="shrink-0 text-muted">{p}</span>
                    <input value={values[p] ?? ""} aria-label={p}
                      onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))}
                      className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1 text-[12px] text-fg-strong focus:border-[var(--line)] focus:outline-none" />
                  </label>
                ))}
                <div className="text-[10px] text-[#ffd060] label-mono">流す手順</div>
                <ol aria-label="流す手順" className="list-decimal pl-5 text-[11px] leading-relaxed text-fg">
                  <li className="list-none -ml-5 text-muted">開く: {fill(r.url, values)}</li>
                  {r.steps.map((s, i) => (
                    <li key={i}>{say({ ...s, target: fill(s.target, values), value: fill(s.value, values) })}</li>
                  ))}
                </ol>
                {r.touches && (
                  <p className="mt-1 text-[11px] leading-relaxed text-[#ffd060]">
                    手元の専用ブラウザで、<b>あなたとして</b>押します。送信や購入なら取り消せません。
                  </p>
                )}
                <div className="mt-1.5 flex gap-1.5">
                  <button type="button" disabled={busy
                    || (r.params ?? []).some((p) => !(values[p] ?? "").trim())}
                    onClick={() => void run(r)}
                    className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1 text-[10px] text-fg-strong label-mono disabled:opacity-40">
                    {busy ? "流しています…" : "この手順で流す"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setRunning("")}
                    className="rounded-forge border border-panel px-3 py-1 text-[10px] text-muted label-mono">
                    やめる
                  </button>
                </div>
              </div>
            )}

            {result?.id === r.id && (
              <pre aria-label="流した結果"
                className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-forge bg-[var(--input-bg)] p-2 text-[10px] text-muted">
                {result.text}
              </pre>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
