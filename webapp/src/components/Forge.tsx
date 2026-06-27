"use client";

/**
 * Forge — creation surface. Generate apps / images / slides / sheets / docs
 * via the backend, in the FORGE OS look. Loading states keep UI lag invisible.
 */

import { motion } from "framer-motion";
import { useState } from "react";
import VideoPanel from "@/components/VideoPanel";
import { addToArchive } from "@/components/AppArchive";
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
  const [editInstruction, setEditInstruction] = useState("");

  const isVideo = tab === "video";
  const kind: ForgeKind = isVideo ? "app" : tab;
  const active = KINDS.find((k) => k.key === kind)!;

  const generate = async (promptText: string) => {
    const p = promptText.trim();
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await forgeGenerate(kind, p);
      if (r.error) setError(r.error);
      else {
        setResult(r);
        // Auto-save generated apps to App Archive
        if (r.kind === "app" && r.code) {
          const name = prompt.trim().slice(0, 40) || p.slice(0, 40) || "Generated App";
          addToArchive(name, p, r.code, r.note);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setBusy(false);
    }
  };

  const run = () => generate(prompt);

  // Re-run with an edit instruction appended (修正 / regenerate).
  const regenerate = () => {
    if (!editInstruction.trim()) return;
    const base = prompt.trim() || "（前回の生成物）";
    generate(`${base}\n\n【前回の生成物への修正指示】\n${editInstruction.trim()}`);
    setEditInstruction("");
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

          {result && !busy && <ForgeResultView result={result} prompt={prompt} />}

          {/* Edit / regenerate (修正) */}
          {result && !busy && (
            <div className="panel p-3">
              <label className="mb-1.5 block text-[10px] tracking-[0.2em] text-muted label-mono">EDIT — 修正して再生成</label>
              <div className="flex gap-2">
                <input
                  value={editInstruction}
                  onChange={(e) => setEditInstruction(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && regenerate()}
                  placeholder="例：グラフを追加して / 色を青系に / 章を1つ増やして"
                  className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={regenerate}
                  disabled={!editInstruction.trim()}
                  className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-4 text-[10px] tracking-[0.14em] text-fg-strong disabled:opacity-40 label-mono"
                >
                  修正
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Download a set of files as a single .zip (folder export). */
async function downloadZip(files: Record<string, string>, zipName: string) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  Object.entries(files).forEach(([name, content]) => zip.file(name, content));
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = zipName;
  a.click();
  URL.revokeObjectURL(url);
}

function ForgeResultView({ result, prompt }: { result: ForgeResult; prompt: string }) {
  if (result.kind === "image" && result.image_url) {
    const saveImage = async () => {
      try {
        const res = await fetch(result.image_url!);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "forge_image.png";
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        window.open(result.image_url!, "_blank");
      }
    };
    return (
      <div className="panel overflow-hidden p-3">
        <Toolbar onDownload={saveImage} label="画像を保存" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={result.image_url} alt={result.image_prompt || "generated"} className="mt-2 w-full rounded-forge" />
        {result.image_prompt && (
          <p className="mt-2 text-[11px] text-muted">{result.image_prompt}</p>
        )}
      </div>
    );
  }

  if (result.kind === "app" && result.code) {
    const projectName = (prompt.trim().slice(0, 30) || "forge_app").replace(/[^\w가-힣ぁ-んァ-ヶ一-龠]+/g, "_");
    const readme = `# ${prompt.trim() || "Forge App"}\n\nTHE FORGE OS で生成した Streamlit アプリです。\n\n## 実行方法\n\n\`\`\`bash\npip install -r requirements.txt\nstreamlit run app.py\n\`\`\`\n${result.note ? `\n## メモ\n\n${result.note}\n` : ""}`;
    const exportFolder = () =>
      downloadZip(
        {
          "app.py": result.code!,
          "requirements.txt": "streamlit\npandas\nnumpy\n",
          "README.md": readme,
        },
        `${projectName}.zip`,
      );
    return (
      <div className="panel p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] tracking-[0.2em] text-muted label-mono">RESULT</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => download("app.py", result.code!, "text/x-python")}
              className="rounded-md border border-panel px-2.5 py-1 text-[10px] tracking-[0.15em] text-fg-strong transition hover:border-[var(--line)] label-mono"
            >
              ↓ .py
            </button>
            <button
              type="button"
              onClick={exportFolder}
              className="rounded-md border border-panel px-2.5 py-1 text-[10px] tracking-[0.15em] text-fg-strong transition hover:border-[var(--line)] label-mono"
            >
              ↓ フォルダ(.zip)
            </button>
          </div>
        </div>
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
