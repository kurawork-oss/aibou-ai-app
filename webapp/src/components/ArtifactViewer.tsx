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
import {
  artifactGet, artifactDownload, artifactUpdate, slidesToGoogle, API_URL,
  type ArtifactMeta, type ArtifactFull, type SlideDeck, type Slide,
} from "@/lib/api";

/* ── themes ─────────────────────────────────────────────────────── */
interface Theme { bg: string; accent: string; accent2: string; title: string; text: string; sub: string; light?: boolean }
const THEMES: Record<string, Theme> = {
  midnight: { bg: "linear-gradient(135deg,#0e1526,#1b2540)", accent: "#00c8ff", accent2: "#7b2ff7", title: "#ffffff", text: "#dfe6f2", sub: "#9fb2cc" },
  aurora: { bg: "linear-gradient(135deg,#06231f,#0d4a40)", accent: "#34e0a1", accent2: "#00c8ff", title: "#eafff8", text: "#cdeee3", sub: "#8fc7b6" },
  sunset: { bg: "linear-gradient(135deg,#2a1020,#4a1e2e)", accent: "#ff8a3d", accent2: "#ff3d77", title: "#fff0ea", text: "#f3ddd4", sub: "#d8a99c" },
  forge: { bg: "linear-gradient(135deg,#080b12,#12233a)", accent: "#00f3ff", accent2: "#00f3ff", title: "#eafcff", text: "#cfe6ec", sub: "#8fb3bd" },
  mono: { bg: "linear-gradient(135deg,#f6f6f8,#e8e8ee)", accent: "#1f2937", accent2: "#6b7280", title: "#0b0f19", text: "#20242e", sub: "#5b6270", light: true },
};
const THEME_ORDER = ["midnight", "aurora", "sunset", "forge", "mono"];
const getTheme = (name?: string): Theme => THEMES[(name || "midnight")] ?? THEMES.midnight;

const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

/* ── one slide (themed, per-layout). Scales via container query units. ── */
function SlideView({ slide, theme }: { slide: Slide; theme: Theme }) {
  const layout = slide.layout || "bullets";
  const hasImg = !!slide.image;
  const t = theme;

  const Bar = () => <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "1.6cqw", background: `linear-gradient(${t.accent},${t.accent2})` }} />;
  const bulletList = (items: string[], cols = 1) => (
    <ul style={{ display: "grid", gridTemplateColumns: cols === 2 ? "1fr 1fr" : "1fr", gap: "1.6cqw 4cqw", listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((b, i) => (
        <li key={i} style={{ display: "flex", gap: "1.5cqw", color: t.text, fontSize: "3cqw", lineHeight: 1.35 }}>
          <span style={{ color: t.accent, flexShrink: 0 }}>▸</span><span>{b}</span>
        </li>
      ))}
    </ul>
  );

  const base: React.CSSProperties = {
    position: "relative", width: "100%", height: "100%", overflow: "hidden",
    background: t.bg, borderRadius: 12, padding: "7cqw 8cqw",
    display: "flex", flexDirection: "column", justifyContent: "center",
    containerType: "inline-size" as unknown as undefined,
  };

  // image background layouts (title/image/section with an image)
  if (hasImg && (layout === "title" || layout === "image" || layout === "section")) {
    return (
      <div style={{ ...base, padding: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={slide.image} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, rgba(0,0,0,0.82) 30%, rgba(0,0,0,0.25))" }} />
        <div style={{ position: "relative", padding: "7cqw 8cqw", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {layout === "section" && <div style={{ color: t.accent, fontSize: "2.4cqw", letterSpacing: "0.3em", marginBottom: "2cqw" }}>SECTION</div>}
          <h2 style={{ color: "#fff", fontSize: layout === "title" ? "7cqw" : "5.5cqw", fontWeight: 800, lineHeight: 1.1, margin: 0, textShadow: "0 2px 20px rgba(0,0,0,0.6)" }}>{slide.title}</h2>
          {slide.subtitle && <p style={{ color: "#e6edf7", fontSize: "3.2cqw", marginTop: "2.5cqw" }}>{slide.subtitle}</p>}
          {slide.bullets && slide.bullets.length > 0 && <div style={{ marginTop: "3cqw" }}>{bulletList(slide.bullets)}</div>}
          <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "1.6cqw", background: `linear-gradient(${t.accent},${t.accent2})` }} />
        </div>
      </div>
    );
  }

  if (layout === "title") {
    return (
      <div style={{ ...base, justifyContent: "center" }}>
        <Bar />
        <h1 style={{ color: t.title, fontSize: "7.5cqw", fontWeight: 800, lineHeight: 1.08, margin: 0 }}>{slide.title}</h1>
        {slide.subtitle && <p style={{ color: t.sub, fontSize: "3.4cqw", marginTop: "3cqw" }}>{slide.subtitle}</p>}
        <span style={{ marginTop: "4cqw", width: "18cqw", height: "0.8cqw", borderRadius: 4, background: `linear-gradient(90deg,${t.accent},${t.accent2})` }} />
      </div>
    );
  }
  if (layout === "section") {
    return (
      <div style={{ ...base, justifyContent: "center", alignItems: "flex-start" }}>
        <Bar />
        <div style={{ color: t.accent, fontSize: "2.6cqw", letterSpacing: "0.32em", marginBottom: "2.5cqw" }}>SECTION</div>
        <h2 style={{ color: t.title, fontSize: "6.5cqw", fontWeight: 800, lineHeight: 1.12, margin: 0 }}>{slide.title}</h2>
      </div>
    );
  }
  if (layout === "stat") {
    return (
      <div style={{ ...base, alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div style={{ fontSize: "18cqw", fontWeight: 900, lineHeight: 1, background: `linear-gradient(90deg,${t.accent},${t.accent2})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>{slide.stat || slide.title}</div>
        {slide.title && slide.stat && <p style={{ color: t.text, fontSize: "3.6cqw", marginTop: "3cqw" }}>{slide.title}</p>}
        {slide.bullets && slide.bullets.length > 0 && <p style={{ color: t.sub, fontSize: "2.8cqw", marginTop: "1.5cqw" }}>{slide.bullets.join(" ・ ")}</p>}
      </div>
    );
  }
  if (layout === "quote") {
    return (
      <div style={{ ...base, justifyContent: "center" }}>
        <span style={{ position: "absolute", left: "5cqw", top: "1cqw", fontSize: "22cqw", color: t.accent, opacity: 0.25, lineHeight: 1 }}>“</span>
        <p style={{ color: t.title, fontSize: "5cqw", fontWeight: 700, lineHeight: 1.35, margin: 0, position: "relative" }}>{slide.quote || slide.title}</p>
        {slide.author && <p style={{ color: t.accent, fontSize: "3cqw", marginTop: "3cqw" }}>— {slide.author}</p>}
      </div>
    );
  }
  if (layout === "image" && hasImg) {
    return (
      <div style={{ ...base, padding: 0, flexDirection: "row" }}>
        <div style={{ flex: 1, padding: "7cqw", display: "flex", flexDirection: "column", justifyContent: "center", position: "relative" }}>
          <Bar />
          <h2 style={{ color: t.title, fontSize: "5cqw", fontWeight: 800, lineHeight: 1.15, margin: "0 0 2.5cqw" }}>{slide.title}</h2>
          {slide.bullets && bulletList(slide.bullets)}
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={slide.image} alt="" style={{ width: "42%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }

  // bullets / two_col (default)
  const cols = layout === "two_col" ? 2 : 1;
  return (
    <div style={{ ...base }}>
      <Bar />
      <h2 style={{ color: t.title, fontSize: "5cqw", fontWeight: 800, lineHeight: 1.15, margin: "0 0 3.5cqw" }}>{slide.title}</h2>
      {slide.bullets && slide.bullets.length > 0 ? bulletList(slide.bullets, cols) : <p style={{ color: t.sub, fontSize: "3cqw" }}>{slide.subtitle || ""}</p>}
    </div>
  );
}

/* ── PDF (print) HTML per layout, themed ─────────────────────────── */
function slidePrintHtml(s: Slide, t: Theme, idx: number, total: number): string {
  const layout = s.layout || "bullets";
  const bar = `<span class="bar" style="background:linear-gradient(${t.accent},${t.accent2})"></span>`;
  const bullets = (items: string[], cols = 1) =>
    `<ul class="bl" style="columns:${cols}">${items.map((b) => `<li style="color:${t.text}"><span style="color:${t.accent}">▸</span> ${esc(b)}</li>`).join("")}</ul>`;
  let inner = "";
  if (s.image && (layout === "title" || layout === "image" || layout === "section")) {
    inner = `<div class="imgbg" style="background-image:url('${s.image}')"></div><div class="imgov"></div><div class="pad">${bar}<h2 style="color:#fff;font-size:44px">${esc(s.title || "")}</h2>${s.subtitle ? `<p style="color:#e6edf7;font-size:22px">${esc(s.subtitle)}</p>` : ""}${s.bullets?.length ? bullets(s.bullets) : ""}</div>`;
    return `<section class="slide" style="background:${t.bg}"><div class="pageno" style="color:${t.sub}">${idx}/${total}</div>${inner}</section>`;
  }
  if (layout === "title") inner = `${bar}<h1 style="color:${t.title};font-size:52px">${esc(s.title || "")}</h1>${s.subtitle ? `<p style="color:${t.sub};font-size:24px">${esc(s.subtitle)}</p>` : ""}`;
  else if (layout === "section") inner = `${bar}<div style="color:${t.accent};letter-spacing:.3em;font-size:16px">SECTION</div><h2 style="color:${t.title};font-size:46px">${esc(s.title || "")}</h2>`;
  else if (layout === "stat") inner = `<div class="stat" style="background:linear-gradient(90deg,${t.accent},${t.accent2});-webkit-background-clip:text;background-clip:text;color:transparent">${esc(s.stat || s.title || "")}</div>${s.stat && s.title ? `<p style="color:${t.text};font-size:24px;text-align:center">${esc(s.title)}</p>` : ""}`;
  else if (layout === "quote") inner = `<p style="color:${t.title};font-size:34px;font-weight:700;line-height:1.4">“${esc(s.quote || s.title || "")}”</p>${s.author ? `<p style="color:${t.accent};font-size:20px">— ${esc(s.author)}</p>` : ""}`;
  else inner = `${bar}<h2 style="color:${t.title};font-size:40px">${esc(s.title || "")}</h2>${s.bullets?.length ? bullets(s.bullets, layout === "two_col" ? 2 : 1) : ""}`;
  return `<section class="slide ${layout}" style="background:${t.bg}"><div class="pageno" style="color:${t.sub}">${idx}/${total}</div>${inner}</section>`;
}

const PRINT_BASE_CSS = `
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;margin:0}
  body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
  .doc{max-width:760px;margin:32px auto;padding:0 24px;line-height:1.7;color:#111}
  .doc h1{font-size:26px;border-bottom:2px solid #eee;padding-bottom:8px}
  .doc h2{font-size:20px;margin-top:26px}.doc pre{background:#f5f5f7;padding:12px;border-radius:8px}
  .doc table{border-collapse:collapse;width:100%}.doc th,.doc td{border:1px solid #ddd;padding:6px 10px}
  table.sheet{border-collapse:collapse;width:calc(100% - 48px);margin:24px}
  table.sheet th,table.sheet td{border:1px solid #ccc;padding:6px 10px;font-size:13px}table.sheet th{background:#f3f4f6}
  .slide{position:relative;width:100%;height:100vh;padding:8% 9%;display:flex;flex-direction:column;justify-content:center;page-break-after:always;overflow:hidden}
  .slide:last-child{page-break-after:auto}
  .slide.stat{align-items:center;text-align:center}.slide.quote{justify-content:center}
  .slide .bar{position:absolute;left:0;top:0;bottom:0;width:10px}
  .slide h1,.slide h2{font-weight:800;line-height:1.12;margin-bottom:20px}
  .slide .stat{font-size:150px;font-weight:900;line-height:1}
  .slide .bl{list-style:none;padding:0;font-size:24px;line-height:1.9}.slide .bl li{margin-bottom:6px}
  .slide .imgbg{position:absolute;inset:0;background-size:cover;background-position:center}
  .slide .imgov{position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.82) 30%,rgba(0,0,0,.25))}
  .slide .pad{position:relative;z-index:2}.slide .pad h2{color:#fff}
  .slide .pageno{position:absolute;right:6%;bottom:5%;font-size:14px;opacity:.6}
  @page{size:landscape;margin:0}
`;

/* ── component ──────────────────────────────────────────────────── */
export default function ArtifactViewer({ meta, onClose }: { meta: ArtifactMeta; onClose: () => void }) {
  const [full, setFull] = useState<ArtifactFull | null>(null);
  const [deck, setDeck] = useState<SlideDeck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [present, setPresent] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const docRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    artifactGet(meta.id).then((f) => {
      setFull(f);
      if (meta.kind === "slides") setDeck(safeDeck(f.content));
    }).catch(() => setErr("読み込みに失敗しました"));
  }, [meta.id, meta.kind]);

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
          initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 30 }} onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-panel p-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-fg-strong">{meta.title}</div>
              <div className="text-[9px] tracking-[0.16em] text-muted label-mono">{kindLabel}{deck ? ` · ${deck.slides.length} SLIDES` : ""}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="閉じる" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-panel text-muted transition hover:text-fg-strong">✕</button>
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
