"use client";

/**
 * AppArchive — Forge App Archive (アプリアーカイブ).
 * Store and browse previously generated Streamlit apps from the Forge.
 * Since Next.js cannot run Streamlit apps directly, we store and display
 * the generated code with download functionality.
 *
 * Persisted to localStorage (key: forge_app_archive).
 */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

interface ArchiveApp {
  id: string;
  name: string;
  prompt: string;
  code: string;
  note?: string;
  createdAt: string;
}

const LS_KEY = "forge_app_archive";

function loadArchive(): ArchiveApp[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ArchiveApp[];
  } catch {
    return [];
  }
}

function saveArchive(apps: ArchiveApp[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(apps.slice(0, 50)));
  } catch {
    /* ignore */
  }
}

export function addToArchive(name: string, prompt: string, code: string, note?: string) {
  const apps = loadArchive();
  const exists = apps.some((a) => a.prompt === prompt && a.code === code);
  if (exists) return;
  const app: ArchiveApp = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    prompt,
    code,
    note,
    createdAt: new Date().toISOString(),
  };
  saveArchive([app, ...apps]);
}

function download(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AppArchive() {
  const [apps, setApps] = useState<ArchiveApp[]>([]);
  const [search, setSearch] = useState("");
  const [viewingId, setViewingId] = useState<string | null>(null);

  useEffect(() => {
    setApps(loadArchive());
  }, []);

  const handleDelete = (id: string) => {
    const next = apps.filter((a) => a.id !== id);
    setApps(next);
    saveArchive(next);
    if (viewingId === id) setViewingId(null);
  };

  const filtered = search.trim()
    ? apps.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.prompt.toLowerCase().includes(search.toLowerCase()),
      )
    : apps;

  const viewingApp = apps.find((a) => a.id === viewingId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-2">
      <div className="panel p-3">
        <p className="text-[11px] leading-relaxed text-muted">
          Forge で生成したアプリのコードを保管・ダウンロードできます。
          コードをローカルに保存してから <code className="text-[#9fe7ff]">streamlit run</code> で実行してください。
        </p>
      </div>

      {apps.length > 0 && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="アプリを検索…"
          className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
      )}

      {apps.length === 0 ? (
        <div className="panel p-8 text-center">
          <p className="text-[11px] tracking-[0.2em] text-muted label-mono">NO APPS ARCHIVED</p>
          <p className="mt-2 text-[11px] text-muted">
            FORGE タブで APP を生成すると自動的にここに保存されます。
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="panel p-6 text-center text-[11px] tracking-[0.18em] text-muted label-mono">
          NO RESULTS
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence>
            {filtered.map((app) => (
              <motion.div
                key={app.id}
                className="panel p-3"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.15 }}
              >
                <div className="mb-1.5 truncate text-[13px] text-fg-strong">{app.name}</div>
                <p className="mb-2 text-[11px] text-muted line-clamp-2">{app.prompt}</p>
                <div className="text-[9px] text-muted/60">
                  {new Date(app.createdAt).toLocaleDateString("ja-JP")}
                </div>
                <div className="mt-2.5 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setViewingId(app.id === viewingId ? null : app.id)}
                    className="flex-1 rounded-forge border border-panel px-2 py-1 text-[10px] tracking-[0.12em] text-muted transition hover:border-[var(--line)] hover:text-fg-strong label-mono"
                  >
                    {viewingId === app.id ? "COLLAPSE" : "VIEW CODE"}
                  </button>
                  <button
                    type="button"
                    onClick={() => download(`${app.name.replace(/\s+/g, "_")}.py`, app.code, "text/x-python")}
                    className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-2 py-1 text-[10px] tracking-[0.12em] text-fg-strong transition hover:shadow-glow label-mono"
                  >
                    ↓ .py
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(app.id)}
                    className="rounded-forge border border-[#ff6b6b44] px-2 py-1 text-[10px] text-[#ff6b6b] transition hover:border-[#ff6b6b] label-mono"
                  >
                    DEL
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Code viewer */}
      <AnimatePresence>
        {viewingApp && (
          <motion.div
            className="panel p-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] tracking-[0.2em] text-muted label-mono">{viewingApp.name}</span>
              <button
                type="button"
                onClick={() => setViewingId(null)}
                className="text-muted hover:text-fg-strong"
              >
                ✕
              </button>
            </div>
            <pre className="max-h-80 overflow-auto rounded-forge bg-black/40 p-3 text-[11px] leading-relaxed text-fg">
              <code>{viewingApp.code}</code>
            </pre>
            {viewingApp.note && (
              <p className="mt-2 whitespace-pre-wrap text-[11px] text-muted">{viewingApp.note}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
