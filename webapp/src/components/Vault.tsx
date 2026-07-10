"use client";

/**
 * Vault — Document Vault（知識）. Manage notebooks of text knowledge, then
 * ask questions answered from the selected notebook. FORGE OS look.
 * Stays alive when the backend / Supabase is unconfigured (catch → empty).
 */

import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import {
  vaultList,
  vaultCreate,
  vaultAddText,
  vaultQuery,
  vaultGenerateDoc,
  vaultGenerateDiagram,
  type VaultNotebook,
} from "@/lib/api";

export default function Vault() {
  const [notebooks, setNotebooks] = useState<VaultNotebook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // new notebook
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // add text
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  const [adding, setAdding] = useState(false);
  const [addedNote, setAddedNote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // query
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  // create doc / diagram from the notebook
  const [genInstruction, setGenInstruction] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genDoc, setGenDoc] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagCode, setDiagCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await vaultList();
      setNotebooks(list);
      setSelectedId((prev) =>
        prev && list.some((n) => n.id === prev) ? prev : list[0]?.id ?? null
      );
    } catch {
      /* offline / unconfigured → leave empty */
      setNotebooks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = notebooks.find((n) => n.id === selectedId) ?? null;

  const create = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const nb = await vaultCreate(newName.trim());
      setNewName("");
      setNotebooks((prev) => [...prev, nb]);
      setSelectedId(nb.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ノートブックの作成に失敗しました");
    } finally {
      setCreating(false);
    }
  };

  const addText = async () => {
    if (!selectedId || !docTitle.trim() || !docContent.trim() || adding) return;
    setAdding(true);
    setError(null);
    setAddedNote(null);
    try {
      const r = await vaultAddText(selectedId, docTitle.trim(), docContent.trim());
      if (r.ok) {
        setDocTitle("");
        setDocContent("");
        setAddedNote("資料を取り込みました。");
        await refresh();
      } else {
        setError("資料の取り込みに失敗しました");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "資料の取り込みに失敗しました");
    } finally {
      setAdding(false);
    }
  };

  const handleFileDrop = (e: React.DragEvent | React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = "dataTransfer" in e ? e.dataTransfer.files : (e.target as HTMLInputElement).files;
    if (!files?.length) return;
    const list = Array.from(files);
    // Read ALL files; a multi-drop merges into one source with per-file
    // headers (previously only the last file survived, silently).
    void Promise.all(
      list.map(
        (file) =>
          new Promise<{ name: string; text: string }>((resolve) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve({ name: file.name, text: String(ev.target?.result || "") });
            reader.onerror = () => resolve({ name: file.name, text: "" });
            reader.readAsText(file, "utf-8");
          }),
      ),
    ).then((docs) => {
      if (docs.length === 1) {
        setDocTitle(docs[0].name.replace(/\.[^.]+$/, ""));
        setDocContent(docs[0].text);
      } else {
        setDocTitle(`${docs[0].name.replace(/\.[^.]+$/, "")} ほか${docs.length - 1}件`);
        setDocContent(docs.map((d) => `=== ${d.name} ===\n${d.text}`).join("\n\n"));
      }
    });
  };

  const ask = async () => {
    if (!selectedId || !question.trim() || asking) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      const r = await vaultQuery(selectedId, question.trim());
      setAnswer(r.answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "質問の処理に失敗しました");
    } finally {
      setAsking(false);
    }
  };

  const generateDoc = async () => {
    if (!selectedId || genBusy) return;
    setGenBusy(true);
    setError(null);
    setGenDoc(null);
    try {
      const r = await vaultGenerateDoc(selectedId, genInstruction.trim());
      setGenDoc(r.markdown);
    } catch (e) {
      setError(e instanceof Error ? e.message : "資料の作成に失敗しました");
    } finally {
      setGenBusy(false);
    }
  };

  const generateDiagram = async (kind: string) => {
    if (!selectedId || diagBusy) return;
    setDiagBusy(true);
    setError(null);
    setDiagCode(null);
    try {
      const r = await vaultGenerateDiagram(selectedId, kind);
      setDiagCode(r.mermaid);
    } catch (e) {
      setError(e instanceof Error ? e.message : "図解の生成に失敗しました");
    } finally {
      setDiagBusy(false);
    }
  };

  const downloadText = (filename: string, text: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-3 overflow-y-auto pb-2">
      {/* Notebooks: list + create */}
      <div className="panel p-3">
        <label className="mb-2 block text-[10px] tracking-[0.2em] text-muted label-mono">
          NOTEBOOKS
        </label>

        {loading ? (
          <div className="text-center text-xs text-muted">読み込み中…</div>
        ) : notebooks.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted">
            ノートブックがまだありません。下の入力欄から最初の知識ノートを作成してください。
            <br />
            <span className="text-[10px] text-muted/70">
              （Supabase未接続の場合はここに表示されません）
            </span>
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {notebooks.map((nb) => {
              const active = nb.id === selectedId;
              return (
                <button
                  key={nb.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(nb.id);
                    setAnswer(null);
                    setAddedNote(null);
                  }}
                  className="rounded-forge border px-3 py-1.5 text-[11px] tracking-[0.06em] transition label-mono"
                  style={{
                    borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                    color: active ? "var(--fg-strong)" : "var(--muted)",
                    boxShadow: active ? "0 0 12px var(--glow)" : "none",
                  }}
                >
                  {nb.name}
                  {typeof nb.doc_count === "number" && (
                    <span className="ml-1.5 text-[9px] text-muted">{nb.doc_count}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Create notebook */}
        <div className="mt-3 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && create()}
            placeholder="新しいノートブック名"
            className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
          />
          <button
            type="button"
            onClick={create}
            disabled={creating || !newName.trim()}
            className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-4 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
          >
            {creating ? "…" : "作成"}
          </button>
        </div>
      </div>

      {/* When a notebook is selected: add text + ask */}
      {selected && (
        <>
          {/* Add text document */}
          <div className="panel p-3">
            <label className="mb-2 block text-[10px] tracking-[0.2em] text-muted label-mono">
              ADD TEXT — {selected.name}
            </label>

            {/* File drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              className="mb-3 rounded-forge border border-dashed px-3 py-3 text-center transition"
              style={{
                borderColor: dragOver ? "var(--accent)" : "rgba(197,198,199,0.3)",
                background: dragOver ? "rgba(0,243,255,0.04)" : "transparent",
              }}
            >
              <p className="text-[10px] tracking-[0.16em] text-muted label-mono">
                TXT / MD ファイルをドロップ
              </p>
              <label className="mt-1.5 block cursor-pointer text-[10px] text-[var(--accent)] hover:underline label-mono">
                またはファイルを選択
                <input
                  type="file"
                  accept=".txt,.md,.csv"
                  multiple
                  className="sr-only"
                  onChange={handleFileDrop}
                />
              </label>
            </div>

            <input
              value={docTitle}
              onChange={(e) => setDocTitle(e.target.value)}
              placeholder="資料タイトル"
              className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
            />
            <textarea
              value={docContent}
              onChange={(e) => setDocContent(e.target.value)}
              rows={4}
              placeholder="本文をここに貼り付け…"
              className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
            />
            <button
              type="button"
              onClick={addText}
              disabled={adding || !docTitle.trim() || !docContent.trim()}
              className="mt-2 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
            >
              {adding ? "INGESTING…" : "資料を取り込む"}
            </button>
            {adding && (
              <motion.p
                className="mt-2 text-[11px] tracking-[0.18em] text-muted label-mono"
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              >
                ◈ 知識として取り込み中…
              </motion.p>
            )}
            {addedNote && !adding && (
              <p className="mt-2 text-[11px] text-[var(--accent)] label-mono">◈ {addedNote}</p>
            )}
          </div>

          {/* Ask a question */}
          <div className="panel p-3">
            <label className="mb-2 block text-[10px] tracking-[0.2em] text-muted label-mono">
              ASK
            </label>
            <div className="flex gap-2">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && ask()}
                placeholder="このノートブックに質問する…"
                className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
              />
              <button
                type="button"
                onClick={ask}
                disabled={asking || !question.trim()}
                className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-4 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
              >
                {asking ? "…" : "質問"}
              </button>
            </div>

            {asking && (
              <motion.div
                className="mt-3 panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono"
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              >
                ◈ 知識を照会中…
              </motion.div>
            )}

            {answer && !asking && (
              <div className="mt-3">
                <div className="divider mb-3" />
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{answer}</p>
                <button
                  type="button"
                  onClick={() => {
                    try { void navigator.clipboard?.writeText(answer); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
                  }}
                  className="mt-2 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong label-mono"
                >
                  {copied ? "✓ コピー済み" : "⧉ 回答をコピー"}
                </button>
              </div>
            )}
          </div>

          {/* Create document / diagram from the notebook */}
          <div className="panel p-3">
            <label className="mb-2 block text-[10px] tracking-[0.2em] text-muted label-mono">
              CREATE — 資料作成・図解
            </label>
            <input
              value={genInstruction}
              onChange={(e) => setGenInstruction(e.target.value)}
              placeholder="作成指示（例：要点を3章にまとめた企画書）"
              className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={generateDoc}
                disabled={genBusy}
                className="flex-1 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
              >
                {genBusy ? "CREATING…" : "📄 資料を作成"}
              </button>
              <button
                type="button"
                onClick={() => generateDiagram("tree")}
                disabled={diagBusy}
                className="flex-1 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
              >
                {diagBusy ? "DRAWING…" : "🌳 ロジックツリー"}
              </button>
              <button
                type="button"
                onClick={() => generateDiagram("flow")}
                disabled={diagBusy}
                className="flex-1 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
              >
                {diagBusy ? "DRAWING…" : "🔀 フロー図"}
              </button>
            </div>

            {genDoc && (
              <div className="mt-3">
                <div className="divider mb-2" />
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{genDoc}</p>
                <button
                  type="button"
                  onClick={() => downloadText(`${selected.name}.md`, genDoc)}
                  className="mt-2 rounded-forge border border-panel px-3 py-1 text-[10px] tracking-[0.14em] text-muted hover:text-fg-strong label-mono"
                >
                  ↓ .md でダウンロード
                </button>
              </div>
            )}

            {diagCode && (
              <div className="mt-3">
                <div className="divider mb-2" />
                <p className="mb-1 text-[9px] tracking-[0.16em] text-muted label-mono">
                  MERMAID（mermaid.live 等に貼り付けで図表示）
                </p>
                <pre className="max-h-56 overflow-auto rounded-forge border border-panel bg-black/30 p-2 text-[11px] leading-relaxed text-fg">
                  {diagCode}
                </pre>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      try { void navigator.clipboard?.writeText(diagCode); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
                    }}
                    className="rounded-forge border border-[var(--line)] px-3 py-1 text-[10px] tracking-[0.14em] text-[var(--accent)] label-mono"
                  >
                    {copied ? "✓ コピー済み" : "⧉ コードをコピー"}
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadText(`${selected.name}.mmd`, diagCode)}
                    className="rounded-forge border border-panel px-3 py-1 text-[10px] tracking-[0.14em] text-muted hover:text-fg-strong label-mono"
                  >
                    ↓ .mmd でダウンロード
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}
    </div>
  );
}
