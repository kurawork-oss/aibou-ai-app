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

import { useCallback, useEffect, useRef, useState } from "react";
import * as memory from "@/lib/memory";
import { recall } from "@/lib/recall";
import {
  forgetSyncMark, lastSyncedAt, syncBlockedReason, syncMemory, type SyncOutcome,
} from "@/lib/memorySync";

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
  const [sync, setSync] = useState<SyncOutcome | null>(null);
  const [syncing, setSyncing] = useState(false);
  const blocked = syncBlockedReason();

  const load = useCallback(async () => {
    setItems((await memory.all()).sort((a, b) => b.updatedAt - a.updatedAt));
    setWhere(memory.storage());
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** サーバーと揃える。画面には**実際に動いた数**だけを出す。 */
  const runSync = useCallback(async (manual: boolean) => {
    if (blocked) { setSync({ ok: false, pushed: 0, applied: 0, more: false, reason: blocked }); return; }
    setSyncing(true);
    const out = await syncMemory();
    setSyncing(false);
    setSync(out);
    // 受け取った物があるときだけ読み直す（毎回だと一覧がちらつく）
    if (out.applied > 0) await load();
    if (manual && out.ok && out.pushed === 0 && out.applied === 0) {
      setNote("すでに揃っています。");
    }
  }, [blocked, load]);

  /* 開いたときに1回だけ揃える。押させないと揃わないと、
     「2台目が空のまま」に気づくのが遅れる。 */
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || blocked) return;
    auto.current = true;
    void runSync(false);
  }, [blocked, runSync]);

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
    /* 合流の目印も捨てる。残したままだと、次の合流で「前回より後に
       変わった物は無い」と判断して、サーバー側の記憶が降りてこない
       ——消したはずがサーバーに残り、この端末からは見えないという、
       いちばん分かりにくい状態になる。 */
    forgetSyncMark();
    await load();
    setNote(blocked
      ? "端末の記憶を消しました。"
      : "端末の記憶を消しました。次に揃えると、サーバー側の記憶が入り直します。");
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

      {/* サーバーとの合流。ここが無いと「2台目が空のまま」に気づけない。 */}
      <div className="mt-2 border-t border-panel pt-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] tracking-[0.2em] text-muted label-mono">サーバーとの合流</span>
          <button
            type="button"
            disabled={syncing || !!blocked}
            onClick={() => void runSync(true)}
            className="rounded-forge border px-2 py-1 text-[10px] disabled:opacity-40"
            style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}
          >
            {syncing ? "揃えています…" : "いま揃える"}
          </button>
        </div>

        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          {blocked ? (
            <span>{blocked}他の端末とは揃いません。</span>
          ) : sync && !sync.ok ? (
            <span style={{ color: "#ffd060" }}>{sync.reason}</span>
          ) : sync?.ok ? (
            <>
              {sync.pushed === 0 && sync.applied === 0
                ? "揃っています。"
                : `${sync.pushed}件を上げ、${sync.applied}件を受け取りました。`}
              {sync.more && "（まだ残りがあります。もう一度押すと続きを運びます）"}
              {lastSyncedAt() > 0 && (
                <span className="label-mono">
                  {" "}最後に揃えたのは {new Date(lastSyncedAt()).toLocaleString("ja-JP")}
                </span>
              )}
            </>
          ) : (
            "揃えると、ほかの端末や機種変のあとでも同じことを覚えています。"
          )}
        </p>

        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          運ぶのは、この一覧にある<b>覚えておいてほしいこと</b>だけです。会話の
          記録そのものはサーバーに置いたままで、端末へは降りてきません
          （降ろすと、この端末の枠が会話で埋まってしまうため）。
        </p>
      </div>
    </section>
  );
}
