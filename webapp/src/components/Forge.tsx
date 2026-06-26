"use client";

/**
 * Forge — creation surface. Generate apps / images / slides / sheets / docs
 * via the backend, in the FORGE OS look. Loading states keep UI lag invisible.
 */

import { motion } from "framer-motion";
import { useState } from "react";
import VideoPanel from "@/components/VideoPanel";
import { forgeGenerate, type ForgeKind, type ForgeResult } from "@/lib/api";

const KINDS: { key: ForgeKind; label: string; hint: string; placeholder: string }[] = [
  { key: "app", label: "APP", hint: "Streamlitアプリ", placeholder: "例：シンプルな家計簿アプリ" },
  { key: "image", label: "IMAGE", hint: "画像生成", placeholder: "例：サイバーパンクな都市の夜景" },
  { key: "slides", label: "SLIDES", hint: "プレゼン", placeholder: "例：新規事業の提案を7枚で" },
  { key: "sheet", label: "SHEET", hint: "表データ", placeholder: "例：月別の売上表（商品別）" },
  { key: "doc", label: "DOC", hint: "文書", placeholder: "例：サービスの企画書" },
];

function download(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Forge() {
  const [tab, setTab] = useState<ForgeKind | "video">("app");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ForgeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isVideo = tab === "video";
  const kind: ForgeKind = isVideo ? "app" : tab;
  const active = KINDS.find((k) => k.key === kind)!;

  const run = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await forgeGenerate(kind, prompt.trim());
      if (r.error) setError(r.error);
      else setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-2">
      {/* Kind selector (＋ VIDEO) */}
      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k.key}
            type="button"
            onClick={() => setTab(k.key)}
            className="rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.18em] label-mono transition"
            style={{
              borderColor: tab === k.key ? "var(--accent)" : "var(--panel-bd)",
              color: tab === k.key ? "var(--fg-strong)" : "var(--muted)",
              boxShadow: tab === k.key ? "0 0 12px var(--glow)" : "none",
            }}
          >
            {k.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setTab("video")}
          className="rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.18em] label-mono transition"
          style={{
            borderColor: isVideo ? "var(--accent)" : "var(--panel-bd)",
            color: isVideo ? "var(--fg-strong)" : "var(--muted)",
            boxShadow: isVideo ? "0 0 12px var(--glow)" : "none",
          }}
        >
          VIDEO
        </button>
      </div>

      {isVideo ? (
        <VideoPanel />
      ) : (
        <>
          {/* Prompt */}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder={active.placeholder}
            className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
          />
          <button
            type="button"
            onClick={run}
            disabled={busy || !prompt.trim()}
            className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
          >
            {busy ? "GENERATING…" : `GENERATE ${active.label}`}
          </button>

          {/* Loading shimmer (keeps the wait branded, never a raw lag) */}
          {busy && (
            <motion.div
              className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono"
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.4, repeat: Infinity }}
            >
              ◈ FORGING {active.label}…
            </motion.div>
          )}

          {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}

          {result && !busy && <ForgeResultView result={result} />}
        </>
      )}
    </div>
  );
}

function ForgeResultView({ result }: { result: ForgeResult }) {
  if (result.kind === "image" && result.image_url) {
    return (
      <div className="panel overflow-hidden p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={result.image_url} alt={result.image_prompt || "generated"} className="w-full rounded-forge" />
        {result.image_prompt && (
          <p className="mt-2 text-[11px] text-muted">{result.image_prompt}</p>
        )}
      </div>
    );
  }

  if (result.kind === "app" && result.code) {
    return (
      <div className="panel p-3">
        <Toolbar onDownload={() => download("forge_app.py", result.code!, "text/x-python")} label=".py" />
        <pre className="mt-2 max-h-80 overflow-auto rounded-forge bg-black/40 p-3 text-[11px] leading-relaxed text-fg">
          <code>{result.code}</code>
        </pre>
        {result.note && <p className="mt-2 whitespace-pre-wrap text-[11px] text-muted">{result.note}</p>}
      </div>
    );
  }

  if (result.kind === "sheet" && result.csv) {
    return (
      <div className="panel p-3">
        <Toolbar onDownload={() => download("forge_sheet.csv", result.csv!, "text/csv")} label=".csv" />
        <div className="mt-2 max-h-80 overflow-auto">
          <CsvTable csv={result.csv} />
        </div>
      </div>
    );
  }

  // slides / doc → markdown
  if (result.markdown) {
    const isSlides = result.kind === "slides";
    return (
      <div className="panel p-3">
        <Toolbar
          onDownload={() => download(isSlides ? "forge_slides.md" : "forge_doc.md", result.markdown!, "text/markdown")}
          label=".md"
        />
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-forge bg-black/30 p-3 text-[12px] leading-relaxed text-fg">
          {result.markdown}
        </pre>
      </div>
    );
  }

  return <div className="panel p-3 text-xs text-muted">（結果なし）</div>;
}

function Toolbar({ onDownload, label }: { onDownload: () => void; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] tracking-[0.2em] text-muted label-mono">RESULT</span>
      <button
        type="button"
        onClick={onDownload}
        className="rounded-md border border-panel px-2.5 py-1 text-[10px] tracking-[0.15em] text-fg-strong transition hover:border-[var(--line)] label-mono"
      >
        ↓ {label}
      </button>
    </div>
  );
}

function CsvTable({ csv }: { csv: string }) {
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(",").map((c) => c.trim()));
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <table className="w-full border-collapse text-[11px]">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i} className="border border-panel px-2 py-1 text-left text-fg-strong">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, ri) => (
          <tr key={ri}>
            {r.map((c, ci) => (
              <td key={ci} className="border border-panel px-2 py-1 text-fg">{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
