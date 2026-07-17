"use client";

/**
 * ArtifactViewer — 生成物（ドキュメント/スライド/表）を「見える形」で表示する.
 *
 *  - document   → Markdown をリッチ表示
 *  - slides     → ビジュアルなスライド一覧 ＋「▶ 発表」全画面プレゼン
 *  - spreadsheet→ CSV を表として表示
 *  - どれも「PDFで保存」（ブラウザ印刷→PDF）に対応。スライドは「Googleスライド」化も。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "@/components/Markdown";
import {
  artifactGet, artifactDownload, slidesToGoogle, API_URL,
  type ArtifactMeta, type ArtifactFull, type SlideDeck,
} from "@/lib/api";

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** CSV → 2D array（引用符・カンマ・改行に対応した軽量パーサ）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  const s = text || "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cur); cur = ""; rows.push(row); row = [];
    } else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function safeDeck(content: string): SlideDeck | null {
  try {
    const d = JSON.parse(content) as SlideDeck;
    if (d && Array.isArray(d.slides)) return { title: d.title || "スライド", slides: d.slides };
  } catch { /* ignore */ }
  return null;
}

const PRINT_CSS = `
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; color:#111; margin:0; }
  .doc { max-width: 760px; margin: 32px auto; padding: 0 24px; line-height: 1.7; }
  .doc h1 { font-size: 26px; border-bottom: 2px solid #eee; padding-bottom: 8px; }
  .doc h2 { font-size: 20px; margin-top: 26px; }
  .doc h3 { font-size: 16px; }
  .doc pre { background:#f5f5f7; padding:12px; border-radius:8px; overflow:auto; }
  .doc code { background:#f0f0f2; padding:1px 5px; border-radius:4px; font-size:.9em; }
  .doc table { border-collapse: collapse; width:100%; }
  .doc th, .doc td { border:1px solid #ddd; padding:6px 10px; text-align:left; }
  table.sheet { border-collapse: collapse; width: calc(100% - 48px); margin: 24px; }
  table.sheet th, table.sheet td { border:1px solid #ccc; padding:6px 10px; font-size: 13px; }
  table.sheet th { background:#f3f4f6; }
  .slide { position: relative; width: 100%; height: 100vh; padding: 8% 9%;
    display: flex; flex-direction: column; page-break-after: always;
    background: linear-gradient(135deg, #0e1526 0%, #1b2540 100%); color: #fff; }
  .slide:last-child { page-break-after: auto; }
  .slide::before { content:""; position:absolute; left:0; top:0; bottom:0; width:8px; background: linear-gradient(#00c8ff,#7b2ff7); }
  .slide h2 { font-size: 40px; margin: 0 0 28px; line-height: 1.2; }
  .slide ul { font-size: 24px; line-height: 1.9; padding-left: 1.2em; }
  .slide .pageno { position:absolute; right: 6%; bottom: 5%; font-size: 14px; opacity:.5; }
  @page { size: landscape; margin: 0; }
`;

export default function ArtifactViewer({ meta, onClose }: { meta: ArtifactMeta; onClose: () => void }) {
  const [full, setFull] = useState<ArtifactFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [present, setPresent] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const docRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    artifactGet(meta.id).then(setFull).catch(() => setErr("読み込みに失敗しました"));
  }, [meta.id]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && present === null) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, present]);

  const deck = useMemo(() => (meta.kind === "slides" && full ? safeDeck(full.content) : null), [meta.kind, full]);
  const rows = useMemo(() => (meta.kind === "spreadsheet" && full ? parseCsv(full.content) : null), [meta.kind, full]);

  const exportPdf = () => {
    let body = "";
    if (deck) {
      body = deck.slides.map((s, i) =>
        `<section class="slide"><h2>${esc(s.title)}</h2><ul>${(s.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul><div class="pageno">${i + 1} / ${deck.slides.length}</div></section>`).join("");
    } else if (rows) {
      body = `<table class="sheet">${rows.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("")}</table>`;
    } else {
      body = `<div class="doc">${docRef.current?.innerHTML ?? esc(full?.content ?? "")}</div>`;
    }
    const w = window.open("", "_blank", "width=1000,height=720");
    if (!w) { setNote("⚠ ポップアップがブロックされました"); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 400);
  };

  const toGoogleSlides = async () => {
    if (!deck) return;
    setBusy(true);
    setNote("Googleスライドを作成中…");
    try {
      const r = await slidesToGoogle(deck.title, deck.slides);
      if (r.ok && r.url) { window.open(r.url, "_blank", "noopener"); setNote("✓ 作成しました（新しいタブで開きました）"); }
      else setNote(`⚠ ${r.error || "作成に失敗しました（Google未接続かもしれません）"}`);
    } catch { setNote("⚠ 失敗しました"); } finally { setBusy(false); }
  };

  const kindLabel = meta.kind === "slides" ? "SLIDES" : meta.kind === "spreadsheet" ? "SPREADSHEET" : "DOCUMENT";

  return createPortal(
    <>
      <motion.div
        role="dialog" aria-label={meta.title}
        className="fixed inset-0 z-[75] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="panel flex max-h-[90vh] w-full max-w-4xl flex-col"
          initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 30 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-panel p-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-fg-strong">{meta.title}</div>
              <div className="text-[9px] tracking-[0.16em] text-muted label-mono">{kindLabel}{deck ? ` · ${deck.slides.length} SLIDES` : ""}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="閉じる" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-panel text-muted transition hover:text-fg-strong">✕</button>
          </div>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {err ? (
              <p className="py-8 text-center text-[12px] text-[#ff9b9b]">{err}</p>
            ) : !full ? (
              <p className="py-8 text-center text-[11px] tracking-[0.2em] text-muted label-mono">◈ 読み込み中…</p>
            ) : deck ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {deck.slides.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setPresent(i)}
                    className="group relative overflow-hidden rounded-lg border border-panel p-4 text-left transition hover:border-[var(--line)] hover:shadow-glow"
                    style={{ background: "linear-gradient(135deg, rgba(14,21,38,0.9), rgba(27,37,64,0.9))", minHeight: "9rem" }}
                  >
                    <span className="absolute left-0 top-0 h-full w-1.5" style={{ background: "linear-gradient(#00c8ff,#7b2ff7)" }} />
                    <div className="mb-1 text-[9px] text-muted label-mono">{i + 1}</div>
                    <div className="mb-2 line-clamp-2 text-[14px] font-bold text-fg-strong">{s.title || "（無題）"}</div>
                    <ul className="space-y-0.5">
                      {(s.bullets || []).slice(0, 4).map((b, bi) => (
                        <li key={bi} className="line-clamp-1 text-[11px] text-fg">• {b}</li>
                      ))}
                    </ul>
                    <span className="absolute bottom-2 right-3 text-[10px] text-muted opacity-0 transition group-hover:opacity-100 label-mono">▶ 発表</span>
                  </button>
                ))}
              </div>
            ) : rows ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <tbody>
                    {rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, ci) => (
                          ri === 0
                            ? <th key={ci} className="border border-panel bg-[rgba(255,255,255,0.04)] px-2.5 py-1.5 text-left text-fg-strong">{c}</th>
                            : <td key={ci} className="border border-panel px-2.5 py-1.5 text-fg">{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div ref={docRef}><Markdown text={full.content} /></div>
            )}
          </div>

          {/* Footer actions */}
          <div className="flex flex-wrap items-center gap-2 border-t border-panel p-3">
            {deck && (
              <button type="button" onClick={() => setPresent(0)}
                className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong shadow-glow label-mono">▶ 発表</button>
            )}
            <button type="button" onClick={exportPdf}
              className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong label-mono">⎙ PDFで保存</button>
            {deck && API_URL && (
              <button type="button" onClick={() => void toGoogleSlides()} disabled={busy}
                className="rounded-forge border border-panel px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong disabled:opacity-40 label-mono">
                {busy ? "…" : "Googleスライド ↗"}
              </button>
            )}
            <button type="button" onClick={() => void artifactDownload(meta)}
              className="rounded-forge border border-panel px-3 py-1.5 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong label-mono">⭳ ダウンロード</button>
            {note && <span className="ml-auto text-[10px]" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</span>}
          </div>
        </motion.div>
      </motion.div>

      {/* Present mode (fullscreen one slide) */}
      <AnimatePresence>
        {deck && present !== null && (
          <PresentMode deck={deck} index={present} setIndex={setPresent} onExit={() => setPresent(null)} />
        )}
      </AnimatePresence>
    </>,
    document.body,
  );
}

function PresentMode({
  deck, index, setIndex, onExit,
}: {
  deck: SlideDeck;
  index: number;
  setIndex: (n: number) => void;
  onExit: () => void;
}) {
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
    <motion.div
      className="fixed inset-0 z-[90] flex flex-col bg-black"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    >
      <div className="flex items-center justify-between px-5 py-3">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">{deck.title}</span>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted label-mono">{index + 1} / {deck.slides.length}</span>
          <button type="button" onClick={onExit} aria-label="発表を終了" className="grid h-8 w-8 place-items-center rounded-lg border border-panel text-muted hover:text-fg-strong">✕</button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-6 pb-10" onClick={next}>
        <button type="button" onClick={(e) => { e.stopPropagation(); prev(); }} aria-label="前へ"
          className="absolute left-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-panel bg-black/40 text-xl text-muted hover:text-fg-strong">‹</button>

        <motion.div
          key={index}
          initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="relative mx-auto flex aspect-video w-full max-w-5xl flex-col justify-center overflow-hidden rounded-xl p-[7%]"
          style={{ background: "linear-gradient(135deg, #0e1526 0%, #1b2540 100%)", boxShadow: "0 0 60px rgba(0,0,0,0.6)" }}
        >
          <span className="absolute left-0 top-0 h-full w-2" style={{ background: "linear-gradient(#00c8ff,#7b2ff7)" }} />
          <h2 className="mb-6 text-[clamp(22px,4vw,44px)] font-bold leading-tight text-fg-strong">{s.title}</h2>
          <ul className="space-y-3">
            {(s.bullets || []).map((b, bi) => (
              <li key={bi} className="flex gap-3 text-[clamp(13px,2vw,24px)] leading-snug text-fg">
                <span className="text-[var(--accent)]">▸</span><span>{b}</span>
              </li>
            ))}
          </ul>
        </motion.div>

        <button type="button" onClick={(e) => { e.stopPropagation(); next(); }} aria-label="次へ"
          className="absolute right-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-panel bg-black/40 text-xl text-muted hover:text-fg-strong">›</button>
      </div>
    </motion.div>
  );
}
