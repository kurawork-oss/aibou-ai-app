"use client";

/**
 * LifeMode — ME（あなたを知るパートナーAI）.
 *
 * 通常CHATが「業務エージェント」なのに対し、MEはプライベート込みの相談相手。
 * 右の「経験の箱」（経歴/お金/人間関係/健康/価値観/出来事）に保存した内容を
 * バックエンドが system prompt へ常に注入するため、過去の経緯と現状を理解した
 * 上で人生・お金の相談に乗ってくれる。
 *  - 相談スレッドは1本の継続した関係として localStorage に保持
 *  - 「✦ この会話から経験を保存」で会話から箱の候補をAI抽出 → 確認して保存
 *  - 箱の中身はSupabase（life_entries）に永続化。バックエンド未接続でも閲覧UIは出る
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "@/components/Markdown";
import {
  streamLifeChat,
  lifeEntries,
  lifeAdd,
  lifeDelete,
  lifeExtract,
  API_URL,
  type ChatTurn,
  type LifeEntry,
  type LifeCategory,
} from "@/lib/api";
import type { ChatSettings } from "@/components/Chat";

const LS_MSGS = "forge_life_msgs";
const MSG_LIMIT = 60;
const HISTORY_LIMIT = 14;

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  error?: boolean;
}

const CAT_COLORS: Record<string, string> = {
  career: "#59a7ff",
  money: "#ffd060",
  relationships: "#ff8cc6",
  health: "#60d394",
  values: "#b18cff",
  events: "#4de3c2",
  other: "#9fa8b5",
};

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadMsgs(): Msg[] {
  try {
    const raw = localStorage.getItem(LS_MSGS);
    return raw ? (JSON.parse(raw) as Msg[]) : [];
  } catch {
    return [];
  }
}

function saveMsgs(msgs: Msg[]): void {
  try {
    localStorage.setItem(LS_MSGS, JSON.stringify(msgs.slice(-MSG_LIMIT)));
  } catch { /* quota */ }
}

export default function LifeMode({ settings }: { settings: ChatSettings }) {
  /* ── 相談チャット ── */
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /* ── 経験の箱 ── */
  const [entries, setEntries] = useState<LifeEntry[]>([]);
  const [categories, setCategories] = useState<LifeCategory[]>([]);
  const [catFilter, setCatFilter] = useState("");
  const [boxOffline, setBoxOffline] = useState(false);
  const [newCat, setNewCat] = useState("career");
  const [newDate, setNewDate] = useState("");
  const [newContent, setNewContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /* ── 会話→箱 抽出 ── */
  const [proposals, setProposals] = useState<{ category: string; content: string }[] | null>(null);
  const [extracting, setExtracting] = useState(false);

  useEffect(() => { setMsgs(loadMsgs()); }, []);
  useEffect(() => () => cancelRef.current?.(), []);

  const refreshBox = useCallback(async () => {
    if (!API_URL) { setBoxOffline(true); return; }
    try {
      const r = await lifeEntries();
      setEntries(r.items);
      setCategories(r.categories);
      setBoxOffline(false);
    } catch {
      setBoxOffline(true);
    }
  }, []);
  useEffect(() => { void refreshBox(); }, [refreshBox]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const persist = (next: Msg[]) => { setMsgs(next); saveMsgs(next); };

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setProposals(null);
    const userMsg: Msg = { id: uid(), role: "user", content: text };
    const aiMsg: Msg = { id: uid(), role: "assistant", content: "", pending: true };
    const base = [...msgs, userMsg, aiMsg];
    persist(base);
    setStreaming(true);

    const history: ChatTurn[] = base
      .filter((m) => !m.pending && !m.error && m.content.trim())
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));

    let acc = "";
    cancelRef.current = streamLifeChat(
      { message: text, history, name: settings.name },
      (tok) => {
        acc += tok;
        setMsgs((prev) => prev.map((m) => (m.id === aiMsg.id ? { ...m, content: acc, pending: false } : m)));
      },
      (err) => {
        setStreaming(false);
        cancelRef.current = null;
        setMsgs((prev) => {
          const next = err && !acc
            ? prev.map((m) => (m.id === aiMsg.id ? { ...m, content: `⚠ ${err}`, pending: false, error: true } : m))
            : prev.map((m) => (m.id === aiMsg.id ? { ...m, pending: false } : m));
          saveMsgs(next);
          return next;
        });
      },
    ).cancel;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const clearThread = () => {
    if (!window.confirm("相談スレッドをクリアしますか？（経験の箱は消えません）")) return;
    cancelRef.current?.();
    persist([]);
  };

  /* ── 箱の操作 ── */
  const addEntry = async (category: string, content: string, date = "") => {
    const c = content.trim();
    if (!c) return false;
    try {
      await lifeAdd(category, c, date);
      await refreshBox();
      return true;
    } catch (e) {
      setNote(`⚠ ${e instanceof Error ? e.message : "保存に失敗しました"}`);
      return false;
    }
  };

  const saveNew = async () => {
    if (saving || !newContent.trim()) return;
    setSaving(true);
    setNote(null);
    const ok = await addEntry(newCat, newContent, newDate);
    if (ok) {
      setNewContent("");
      setNewDate("");
      setNote("✓ 経験の箱に保存しました（次の相談から反映されます）");
    }
    setSaving(false);
  };

  const removeEntry = async (e: LifeEntry) => {
    if (!window.confirm("この経験を削除しますか？")) return;
    await lifeDelete(e.id);
    await refreshBox();
  };

  const extract = async () => {
    if (extracting) return;
    setExtracting(true);
    setProposals(null);
    try {
      const turns: ChatTurn[] = msgs
        .filter((m) => !m.pending && !m.error && m.content.trim())
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));
      const items = await lifeExtract(turns);
      setProposals(items);
      if (items.length === 0) setNote("この会話からは新しく保存すべき経験は見つかりませんでした。");
    } catch (e) {
      setNote(`⚠ ${e instanceof Error ? e.message : "抽出に失敗しました"}`);
    } finally {
      setExtracting(false);
    }
  };

  const catLabel = (key: string) =>
    categories.find((c) => c.key === key)?.label ?? key;

  const filtered = catFilter ? entries.filter((e) => e.category === catFilter) : entries;
  const canExtract = msgs.filter((m) => m.role === "user").length > 0 && !streaming;

  return (
    <div className="grid h-full min-h-0 gap-3 pb-2 lg:grid-cols-[1fr_minmax(20rem,24rem)]">
      {/* ── LEFT: 相談チャット ── */}
      <div className="flex min-h-0 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-2" aria-live="polite">
          {msgs.length === 0 && (
            <div className="mx-auto max-w-md pt-8 text-center">
              <h2 className="label-mono text-glow text-sm tracking-[0.22em] text-fg-strong">LIFE PARTNER</h2>
              <p className="mt-3 text-[12px] leading-relaxed text-muted">
                ここは<b className="text-fg">あなたを知っているAI</b>との相談室です。
                右の「経験の箱」に経歴・お金・人間関係・価値観などを入れておくと、
                過去の経緯と現状を踏まえて人生やお金の相談に乗ります。
                <br /><br />
                例：「今の貯金ペースで大丈夫かな」「転職するか迷ってる」「最近ちょっと疲れた」
              </p>
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={[
                  "max-w-[88%] rounded-forge border px-3.5 py-2.5 text-sm leading-relaxed backdrop-blur-md",
                  m.role === "user"
                    ? "border-panel-strong bg-[rgba(255,255,255,0.07)] text-fg-strong"
                    : "border-panel bg-[rgba(255,170,190,0.05)] text-fg shadow-glow",
                  m.error ? "border-[rgba(255,120,120,0.45)] text-[#ffb4b4]" : "",
                ].join(" ")}
              >
                {m.pending && !m.content ? (
                  <motion.span className="label-mono text-[10px] tracking-[0.2em] text-muted" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.2, repeat: Infinity }}>
                    ◈ …
                  </motion.span>
                ) : m.role === "assistant" && !m.error ? (
                  <Markdown text={m.content} />
                ) : (
                  <span className="whitespace-pre-wrap">{m.content}</span>
                )}
              </div>
            </div>
          ))}

          {/* 会話→箱 提案チップ */}
          {proposals && proposals.length > 0 && (
            <div className="rounded-forge border border-dashed border-panel p-3">
              <div className="mb-2 text-[10px] tracking-[0.18em] text-muted label-mono">✦ この会話から見つかった経験 — 保存しますか？</div>
              <div className="flex flex-col gap-1.5">
                {proposals.map((p, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[8px] tracking-[0.1em] label-mono" style={{ color: CAT_COLORS[p.category] ?? "#9fa8b5", border: `1px solid ${CAT_COLORS[p.category] ?? "#9fa8b5"}44` }}>
                      {catLabel(p.category)}
                    </span>
                    <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-fg">{p.content}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        if (await addEntry(p.category, p.content)) {
                          setProposals((prev) => prev?.filter((_, j) => j !== i) ?? null);
                        }
                      }}
                      className="shrink-0 rounded-forge border border-[var(--line)] px-2 py-0.5 text-[10px] text-[var(--accent)] label-mono"
                    >
                      ✓ 保存
                    </button>
                    <button type="button" onClick={() => setProposals((prev) => prev?.filter((_, j) => j !== i) ?? null)} className="shrink-0 px-1 text-[10px] text-muted">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="mt-2 shrink-0">
          <div className="mb-1.5 flex items-center gap-3 px-1">
            {canExtract && (
              <button type="button" onClick={() => void extract()} disabled={extracting} className="text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">
                {extracting ? "◈ 抽出中…" : "✦ この会話から経験を保存"}
              </button>
            )}
            {msgs.length > 0 && (
              <button type="button" onClick={clearThread} className="ml-auto text-[10px] tracking-[0.12em] text-muted transition hover:text-[#ff8888] label-mono">
                スレッドをクリア
              </button>
            )}
          </div>
          <div className="panel flex items-end gap-1.5 p-2">
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
              }}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="人生でも、お金でも、なんでも相談してください…"
              className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
              style={{ scrollbarWidth: "none" }}
            />
            <button
              type="button"
              onClick={send}
              disabled={streaming || !input.trim()}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--btn-bg)] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40"
              aria-label="Send consultation"
            >
              {streaming ? "…" : "♥"}
            </button>
          </div>
        </div>
      </div>

      {/* ── RIGHT: 経験の箱 ── */}
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <div className="glass-silver p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] tracking-[0.2em] text-fg-strong label-mono">📦 経験の箱</span>
            <span className="text-[9px] tracking-[0.12em] text-muted label-mono">{entries.length} 件</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted">
            ここに入れた内容を、MEは相談のたびに思い出します。増えるほど理解が深まります。
          </p>

          {boxOffline ? (
            <p className="mt-2 rounded-forge border border-panel p-2 text-[10px] leading-relaxed text-muted">
              ⚠ バックエンド未接続のため箱は使えません。接続後（DIAGNOSTICS参照）に保存・閲覧できます。
            </p>
          ) : (
            <>
              {/* 追加フォーム */}
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="flex gap-1.5">
                  <select
                    value={newCat}
                    onChange={(e) => setNewCat(e.target.value)}
                    aria-label="カテゴリ"
                    className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong focus:outline-none"
                  >
                    {(categories.length ? categories : [{ key: "other", label: "その他" }]).map((c) => (
                      <option key={c.key} value={c.key} className="bg-[#10141c]">{c.label}</option>
                    ))}
                  </select>
                  <input
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    placeholder="時期（任意 例: 2024-04）"
                    className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[11px] text-fg-strong placeholder:text-muted focus:outline-none"
                  />
                </div>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  rows={2}
                  placeholder="例：2020年にIT企業へ転職。現在は副業でデザインも。"
                  className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-2 text-[12px] text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void saveNew()}
                  disabled={saving || !newContent.trim()}
                  className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-1.5 text-[10px] tracking-[0.18em] text-fg-strong disabled:opacity-40 label-mono"
                >
                  {saving ? "…" : "＋ 箱に保存"}
                </button>
              </div>
              {note && <p className="mt-1.5 text-[10px] leading-relaxed" style={{ color: note.startsWith("⚠") ? "#ff9b9b" : "#60d394" }}>{note}</p>}
            </>
          )}
        </div>

        {/* カテゴリフィルタ + 一覧 */}
        {!boxOffline && (
          <>
            <div className="flex flex-wrap gap-1">
              <button type="button" onClick={() => setCatFilter("")}
                className="rounded-full border px-2.5 py-1 text-[9px] tracking-[0.1em] label-mono"
                style={{ borderColor: !catFilter ? "var(--accent)" : "var(--panel-bd)", color: !catFilter ? "var(--fg-strong)" : "var(--muted)" }}>
                ALL
              </button>
              {categories.map((c) => (
                <button key={c.key} type="button" onClick={() => setCatFilter(c.key)}
                  className="rounded-full border px-2.5 py-1 text-[9px] tracking-[0.08em] label-mono"
                  style={{ borderColor: catFilter === c.key ? (CAT_COLORS[c.key] ?? "var(--accent)") : "var(--panel-bd)", color: catFilter === c.key ? "var(--fg-strong)" : "var(--muted)" }}>
                  {c.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <AnimatePresence initial={false}>
                {filtered.map((e) => (
                  <motion.div key={e.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
                    className="group rounded-forge border border-panel p-2.5">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[8px] tracking-[0.1em] label-mono"
                        style={{ color: CAT_COLORS[e.category] ?? "#9fa8b5", border: `1px solid ${CAT_COLORS[e.category] ?? "#9fa8b5"}44` }}>
                        {catLabel(e.category)}
                      </span>
                      <div className="min-w-0 flex-1">
                        {e.entry_date && <div className="text-[9px] text-muted label-mono">{e.entry_date}</div>}
                        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{e.content}</p>
                      </div>
                      <button type="button" onClick={() => void removeEntry(e)}
                        className="shrink-0 px-1 text-[10px] text-muted opacity-60 transition hover:text-[#ff8888] sm:opacity-0 sm:group-hover:opacity-100"
                        aria-label="Delete entry">
                        ✕
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {filtered.length === 0 && (
                <p className="rounded-forge border border-dashed border-panel p-4 text-center text-[10px] leading-relaxed text-muted">
                  まだ空です。上のフォームか、相談後の「✦ この会話から経験を保存」で貯めていきましょう。
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
