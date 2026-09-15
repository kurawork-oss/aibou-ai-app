"use client";

/**
 * ArtifactViewer — 生成物（ドキュメント/スライド/表）を「デザインされた形」で表示する.
 *
 *  - document   → Markdown をリッチ表示
 *  - slides     → テーマ配色 × 7レイアウトのビジュアルスライド ＋「▶ 発表」全画面
 *  - spreadsheet→ CSV を表として表示
 *  - PDFで保存（テーマ配色つき）／スライドは Googleスライド化 も。
 *  - スライドはテーマ（配色）をその場で切替でき、サーバー/端末に保存される。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "@/components/Markdown";
import SlideEditor from "@/components/SlideEditor";
import SlideView, {
  THEMES, THEME_ORDER, getTheme, slidePrintHtml, PRINT_BASE_CSS, esc, type Theme,
} from "@/components/SlideView";
import {
  artifactGet, artifactDownload, artifactUpdate, slidesToGoogle, API_URL,
  type ArtifactMeta, type ArtifactFull, type SlideDeck, type Slide,
} from "@/lib/api";

/* ── CSV parse ──────────────────────────────────────────────────── */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  const s = text || "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cur); cur = ""; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function safeDeck(content: string): SlideDeck | null {
  try {
    const d = JSON.parse(content) as SlideDeck;
    if (d && Array.isArray(d.slides)) return { title: d.title || "スライド", theme: d.theme || "midnight", slides: d.slides };
  } catch { /* ignore */ }
  return null;
}


export default function ArtifactViewer({ meta, onClose }: { meta: ArtifactMeta; onClose: () => void }) {
  const [full, setFull] = useState<ArtifactFull | null>(null);
  const [deck, setDeck] = useState<SlideDeck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [present, setPresent] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cursor, setCursor] = useState(0);           // 編集中のスライド番号
  const docRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    artifactGet(meta.id).then((f) => {
      setFull(f);
      if (meta.kind === "slides") setDeck(safeDeck(f.content));
    }).catch(() => setErr("読み込みに失敗しました"));
  }, [meta.id, meta.kind]);

  /** 編集は打つたびに保存すると重いのでまとめて保存する（離脱時は即保存）。 */
  const saveDeck = (next: SlideDeck) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      artifactUpdate(meta.id, { content: JSON.stringify(next) })
        .then((ok) => { setNote(ok ? "✓ 保存しました" : "⚠ 保存に失敗しました"); })
        .catch(() => setNote("⚠ 保存に失敗しました"))
        .finally(() => setTimeout(() => setNote(null), 1500));
    }, 700);
  };

  // 閉じる/アンマウント時に保留中の保存を流す（編集が消えないように）。
  // deck を依存に入れると打鍵ごとに cleanup が走って古い内容を保存してしまうので、
  // 最新の deck は ref で持ち、この effect は寿命の間1回だけにする。
  const latestDeck = useRef<SlideDeck | null>(null);
  latestDeck.current = deck;
  useEffect(() => {
    const id = meta.id;
    const timer = saveTimer;
    const latest = latestDeck;
    return () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      if (latest.current) void artifactUpdate(id, { content: JSON.stringify(latest.current) });
    };
  }, [meta.id]);

  const editDeck = (next: SlideDeck) => { setDeck(next); saveDeck(next); };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && present === null) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, present]);

  const rows = useMemo(() => (meta.kind === "spreadsheet" && full ? parseCsv(full.content) : null), [meta.kind, full]);
  const theme = getTheme(deck?.theme);

  const setTheme = async (name: string) => {
    if (!deck) return;
    const next = { ...deck, theme: name };
    setDeck(next);
    try { await artifactUpdate(meta.id, { content: JSON.stringify(next) }); setNote("✓ テーマを保存"); }
    catch { /* ignore */ }
    setTimeout(() => setNote(null), 1500);
  };

  const exportPdf = () => {
    let body = "";
    if (deck) body = deck.slides.map((s, i) => slidePrintHtml(s, theme, i + 1, deck.slides.length)).join("");
    else if (rows) body = `<table class="sheet">${rows.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("")}</table>`;
    else body = `<div class="doc">${docRef.current?.innerHTML ?? esc(full?.content ?? "")}</div>`;
    const w = window.open("", "_blank", "width=1000,height=720");
    if (!w) { setNote("⚠ ポップアップがブロックされました"); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>${PRINT_BASE_CSS}</style></head><body>${body}</body></html>`);
    w.document.close(); w.focus();
    setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 500);
  };

  const toGoogleSlides = async () => {
    if (!deck) return;
    setBusy(true); setNote("Googleスライドを作成中…");
    try {
      const r = await slidesToGoogle(deck.title, deck.slides, deck.theme || "");
      if (r.ok && r.url) { window.open(r.url, "_blank", "noopener"); setNote("✓ 作成しました（新しいタブ）"); }
      else setNote(`⚠ ${r.error || "作成に失敗（Google未接続かも）"}`);
    } catch { setNote("⚠ 失敗しました"); } finally { setBusy(false); }
  };

  const kindLabel = meta.kind === "slides" ? "SLIDES" : meta.kind === "spreadsheet" ? "SPREADSHEET" : "DOCUMENT";

  return createPortal(
    <>
      <motion.div role="dialog" aria-label={meta.title}
        className="fixed inset-0 z-[75] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
        <motion.div className="panel flex max-h-[92vh] w-full max-w-4xl flex-col"
          initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0, transition: { duration: 0.12, ease: "easeOut" } }}
          transition={{ type: "spring", stiffness: 320, damping: 30 }} onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-panel p-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-fg-strong">{meta.title}</div>
              <div className="text-[9px] tracking-[0.16em] text-muted label-mono">{kindLabel}{deck ? ` · ${deck.slides.length} SLIDES` : ""}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {deck && (
                <button type="button" onClick={() => setEditing((v) => !v)} aria-pressed={editing}
                  className="rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.12em] label-mono"
                  style={{
                    borderColor: editing ? "var(--accent)" : "var(--panel-bd)",
                    color: editing ? "var(--fg-strong)" : "var(--muted)",
                    background: editing ? "var(--btn-bg)" : "transparent",
                  }}>
                  ✎ 編集
                </button>
              )}
              <button type="button" onClick={onClose} aria-label="閉じる" className="grid h-8 w-8 place-items-center rounded-lg border border-panel text-muted transition hover:text-fg-strong">✕</button>
            </div>
          </div>

          {/* Theme picker (slides only) */}
          {deck && (
            <div className="flex items-center gap-2 border-b border-panel px-3 py-2">
              <span className="text-[9px] tracking-[0.16em] text-muted label-mono">THEME</span>
              {THEME_ORDER.map((name) => {
                const th = THEMES[name];
                const on = (deck.theme || "midnight") === name;
                return (
                  <button key={name} type="button" onClick={() => void setTheme(name)} title={name} aria-label={`テーマ: ${name}`}
                    className="h-6 w-6 rounded-full border transition"
                    style={{ background: th.bg, borderColor: on ? "var(--accent)" : "var(--panel-bd)", outline: on ? "2px solid var(--accent)" : "none", outlineOffset: 1 }}>
                    <span className="block h-1.5 w-1.5 rounded-full" style={{ background: th.accent, margin: "0 auto" }} />
                  </button>
                );
              })}
            </div>
          )}

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {err ? (
              <p className="py-8 text-center text-[12px] text-[#ff9b9b]">{err}</p>
            ) : !full ? (
              <p className="py-8 text-center text-[11px] tracking-[0.2em] text-muted label-mono">◈ 読み込み中…</p>
            ) : deck && editing ? (
              <SlideEditor deck={deck} index={cursor} onChange={editDeck} onSelect={setCursor} />
            ) : deck ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {deck.slides.map((s, i) => (
                  <button key={i} type="button" onClick={() => setPresent(i)}
                    className="group relative overflow-hidden rounded-lg border border-panel transition hover:border-[var(--line)] hover:shadow-glow"
                    style={{ aspectRatio: "16 / 9" }} title="クリックで発表表示">
                    <SlideView slide={s} theme={theme} />
                    <span className="absolute right-2 top-1.5 text-[9px] text-white/70 label-mono">{i + 1}</span>
                  </button>
                ))}
              </div>
            ) : rows ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <tbody>
                    {rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, ci) => (ri === 0
                          ? <th key={ci} className="border border-panel bg-[rgba(255,255,255,0.04)] px-2.5 py-1.5 text-left text-fg-strong">{c}</th>
                          : <td key={ci} className="border border-panel px-2.5 py-1.5 text-fg">{c}</td>))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div ref={docRef}><Markdown text={full.content} /></div>
            )}
          </div>

          {/* Footer */}
          <div className="flex flex-wrap items-center gap-2 border-t border-panel p-3">
            {deck && <button type="button" onClick={() => setPresent(0)} className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong shadow-glow label-mono">▶ 発表</button>}
            <button type="button" onClick={exportPdf} className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong label-mono">⎙ PDFで保存</button>
            {deck && API_URL && <button type="button" onClick={() => void toGoogleSlides()} disabled={busy} className="rounded-forge border border-panel px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong disabled:opacity-40 label-mono">{busy ? "…" : "Googleスライド ↗"}</button>}
            <button type="button" onClick={() => void artifactDownload(meta)} className="rounded-forge border border-panel px-3 py-1.5 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong label-mono">⭳ ダウンロード</button>
            {note && <span className="ml-auto text-[10px]" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</span>}
          </div>
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {deck && present !== null && (
          <PresentMode deck={deck} theme={theme} index={present} setIndex={setPresent} onExit={() => setPresent(null)} />
        )}
      </AnimatePresence>
    </>,
    document.body,
  );
}

function PresentMode({ deck, theme, index, setIndex, onExit }: { deck: SlideDeck; theme: Theme; index: number; setIndex: (n: number) => void; onExit: () => void }) {
  const s = deck.slides[index];
  const prev = () => setIndex((index - 1 + deck.slides.length) % deck.slides.length);
  const next = () => setIndex((index + 1) % deck.slides.length);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onExit();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); next(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!s) return null;
  return (
    <motion.div className="fixed inset-0 z-[90] flex flex-col bg-black" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="flex items-center justify-between px-5 py-3">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">{deck.title}</span>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted label-mono">{index + 1} / {deck.slides.length}</span>
          <button type="button" onClick={onExit} aria-label="発表を終了" className="grid h-8 w-8 place-items-center rounded-lg border border-panel text-muted hover:text-fg-strong">✕</button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-6 pb-10" onClick={next}>
        <button type="button" onClick={(e) => { e.stopPropagation(); prev(); }} aria-label="前へ" className="absolute left-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-panel bg-black/40 text-xl text-muted hover:text-fg-strong">‹</button>
        <motion.div key={index} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="mx-auto w-full max-w-5xl overflow-hidden rounded-xl" style={{ aspectRatio: "16 / 9", boxShadow: "0 0 60px rgba(0,0,0,0.6)" }} onClick={(e) => e.stopPropagation()}>
          <SlideView slide={s} theme={theme} />
        </motion.div>
        <button type="button" onClick={(e) => { e.stopPropagation(); next(); }} aria-label="次へ" className="absolute right-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-panel bg-black/40 text-xl text-muted hover:text-fg-strong">›</button>
      </div>
    </motion.div>
  );
}
