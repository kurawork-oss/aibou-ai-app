"use client";

/**
 * 覚えていることを、見て・直して・消す画面。
 *
 * なぜ覚える機能と同時に要るのか
 * ------------------------------
 * 「覚える」だけ作って「見る・消す」を後回しにすると、**覚えてほしく
 * ないことを覚えたまま消せない期間**ができる。住所でも、体調でも、
 * 人の名前でも、一度入ると本人には手が出せない。
 *
 * それは機能が足りないのではなく、不誠実な状態だと思う。だから
 * 同じ回で作る。
 *
 * ここで扱うのは**端末の中の記憶だけ**。サーバー側（Supabase）の記憶は
 * 別の場所にあるので、それも消したい人のために「どこにあるか」を出す。
 */

import { useCallback, useEffect, useState } from "react";
import * as memory from "@/lib/memory";
import { recall } from "@/lib/recall";

const IMPORTANCE = [
  { v: 0, label: "ふつう" },
  { v: 1, label: "大事" },
  { v: 2, label: "とても大事" },
];

export default function MemorySettings() {
  const [items, setItems] = useState<memory.MemoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [where, setWhere] = useState<string>("device");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setItems((await memory.all()).sort((a, b) => b.updatedAt - a.updatedAt));
    setWhere(memory.storage());
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addOne = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    await memory.add(text, { source: "me", kind: "fact", importance: 1 });
    setDraft("");
    await load();
    setBusy(false);
  };

  const setImportance = async (id: string, v: number) => {
    await memory.update(id, { importance: v });
    await load();
  };

  const drop = async (id: string) => {
    await memory.remove(id);
    await load();
  };

  const dropAll = async () => {
    if (!window.confirm("この端末が覚えていることを全部消します。元に戻せません。")) return;
    setBusy(true);
    await memory.clearAll();
    await load();
    setNote("端末の記憶を消しました。");
    setBusy(false);
  };

  /* 探すのは、会話のときと**同じ引き方**（lib/recall.ts）。
     ここだけ単純な部分一致にすると、「画面では出るのに会話では
     思い出さない」というずれが起きて、原因が分からなくなる。 */
  const shown = query.trim()
    ? recall(items, query, { limit: 50 }).map((h) => h.item)
    : items;

  return (
    <section className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">覚えていること</span>
        <span className="text-[10px] text-muted label-mono">
          {items.length}件 / {where === "session" ? "この画面を閉じるまで" : "この端末の中"}
        </span>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        ここにある記憶は<b>この端末の中だけ</b>にあります。通信が無くても思い出せます。
        {where === "session" && (
          <span style={{ color: "#ffd060" }}>
            {" "}いまの設定では保存できないため、画面を閉じると消えます（プライベートモードなど）。
          </span>
        )}
      </p>

      {/* 足す */}
      <div className="mb-2 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void addOne(); }}
          placeholder="覚えておいてほしいこと（例：甲殻類アレルギー）"
          aria-label="覚えておいてほしいこと"
          className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
        <button
          type="button" disabled={busy || !draft.trim()} onClick={() => void addOne()}
          className="shrink-0 rounded-forge border px-3 py-2 text-[11px] disabled:opacity-40"
          style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}
        >
          覚える
        </button>
      </div>

      {/* 探す */}
      {items.length > 4 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="覚えていることを探す"
          aria-label="覚えていることを探す"
          className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[12px] text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
      )}

      {/* 一覧 */}
      {shown.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-muted">
          {query.trim() ? "見つかりませんでした。" : "まだ何も覚えていません。"}
        </p>
      ) : (
        <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          {shown.map((it) => (
            <div key={it.id} className="rounded-forge border border-panel p-2">
              <div className="text-[12px] leading-relaxed text-fg-strong">{it.text}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <select
                  value={it.importance}
                  onChange={(e) => void setImportance(it.id, Number(e.target.value))}
                  aria-label={`${it.text.slice(0, 12)} の大事さ`}
                  className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-1.5 py-0.5 text-[10px] text-fg-strong focus:outline-none"
                >
                  {IMPORTANCE.map((o) => (
                    <option key={o.v} value={o.v} className="bg-[#0a0e16]">{o.label}</option>
                  ))}
                </select>
                <span className="text-[10px] text-muted label-mono">
                  {new Date(it.updatedAt).toLocaleDateString("ja-JP")}
                  {it.source === "me" ? " · 自分" : it.source === "agent" ? " · AI" : " · 同期"}
                </span>
                <button
                  type="button" onClick={() => void drop(it.id)}
                  aria-label={`${it.text.slice(0, 12)} を忘れる`}
                  className="ml-auto text-[10px] text-muted underline label-mono"
                >
                  忘れる
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <button
          type="button" disabled={busy} onClick={() => void dropAll()}
          className="mt-2 w-full rounded-forge border border-panel px-3 py-2 text-[11px] text-muted disabled:opacity-50"
        >
          この端末の記憶を全部消す
        </button>
      )}
      {note && <p className="mt-1.5 text-[11px] text-muted">{note}</p>}

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        ※ Supabase を繋いでいる場合、サーバー側にも記憶があります。そちらは
        この一覧には出ません（消すには Supabase の <code>agent_memory</code> を消します）。
      </p>
    </section>
  );
}
