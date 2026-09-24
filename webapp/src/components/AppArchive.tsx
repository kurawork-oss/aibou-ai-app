"use client";

/**
 * AppArchive — 作ったものの保管庫。
 *
 * 点検で分かったこと: ここは Streamlit のコードしか入っていなかった。
 * 「アプリ」タブで作った、ブラウザでそのまま動くHTMLは保存されず、
 * ダウンロードしないと消えていた。名前が「保管庫」なのに片方しか入らないのは
 * 誤解を招く（作ったものが消えたように見える）。
 *
 * kind で種類を分けて、どちらも入るようにした。
 *   html   … ブラウザで動く1ファイルアプリ／ページ。開いて確認できる
 *   python … Streamlit のコード。手元で streamlit run が要る（古い生成物）
 *
 * 保存先:
 *   ・自分のDBの artifacts（「生成物」と同じ場所）。端末を変えても残る。
 *   ・localStorage は手元の控え。オフラインでも見られる。
 *
 * 「作ったもの」の置き場を2つ持つと、どちらを見ればいいか分からなくなるので、
 * すでにある artifacts に寄せた（新しい表は作らない）。
 * 以前は localStorage だけだったので、端末を変えると作ったアプリが消えていた。
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { API_URL, artifactCreate, artifactGet, artifactsList, artifactDelete } from "@/lib/api";

interface ArchiveApp {
  id: string;
  name: string;
  prompt: string;
  code: string;
  note?: string;
  createdAt: string;
  /** 省略時は python（kind を持たない古い保存物との互換） */
  kind?: "html" | "python";
  /** 他の端末で作られ、本文はまだ手元に無い */
  remote?: boolean;
}

/** 古い保存物には kind が無い。無ければ Streamlit だったとみなす。 */
function kindOf(a: ArchiveApp): "html" | "python" {
  return a.kind === "html" ? "html" : "python";
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

export function addToArchive(
  name: string, prompt: string, code: string, note?: string,
  kind: "html" | "python" = "python",
) {
  const apps = loadArchive();
  const exists = apps.some((a) => a.prompt === prompt && a.code === code);
  if (exists) return;
  const app: ArchiveApp = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    prompt,
    code,
    note,
    kind,
    createdAt: new Date().toISOString(),
  };
  saveArchive([app, ...apps]);

  // 自分のDBにも残す。端末を変えても、作ったものが消えないように。
  // 失敗しても手元には残っているので、ここでは黙って諦める。
  if (API_URL) {
    void artifactCreate(
      kind === "html" ? "webapp" : "app",
      name,
      code,
      kind === "html" ? "text/html" : "text/x-python",
    ).catch(() => {});
  }
}

/** HTMLを別タブで開いて、そのまま動かす。 */
function openHtml(code: string) {
  const url = URL.createObjectURL(new Blob([code], { type: "text/html;charset=utf-8" }));
  window.open(url, "_blank", "noopener");
  // すぐ revoke すると開く前に消える。読み込む余裕をとってから捨てる
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

  // 他の端末で作ったものを取り込む。書くだけだと片道で、
  // 「保存されているのに、この端末では見えない」ことになる。
  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    artifactsList()
      .then((items) => {
        if (!alive) return;
        const mine = items.filter((a) => a.kind === "webapp" || a.kind === "app");
        if (mine.length === 0) return;
        setApps((prev) => {
          const known = new Set(prev.map((a) => a.name + a.createdAt.slice(0, 10)));
          const extra: ArchiveApp[] = mine
            .filter((a) => !known.has(a.title + (a.created_at ?? "").slice(0, 10)))
            .map((a) => ({
              id: a.id,
              name: a.title,
              prompt: "",
              code: "",                       // 本文は開いたときに取りに行く
              kind: a.kind === "webapp" ? "html" : "python",
              createdAt: a.created_at ?? new Date().toISOString(),
              remote: true,
            }));
          if (extra.length === 0) return prev;
          const next = [...prev, ...extra]
            .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
          saveArchive(next);
          return next;
        });
      })
      .catch(() => { /* 取れなくても手元の分は見られる */ });
    return () => { alive = false; };
  }, []);

  /** 本文が手元に無いもの（他の端末で作った）を取りに行く。 */
  const fetchCode = useCallback(async (app: ArchiveApp): Promise<string> => {
    if (app.code) return app.code;
    if (!API_URL) return "";
    try {
      const body = await artifactGet(app.id);
      const code = body?.content ?? "";
      if (code) {
        setApps((prev) => {
          const next = prev.map((a) => (a.id === app.id ? { ...a, code } : a));
          saveArchive(next);
          return next;
        });
      }
      return code;
    } catch {
      return "";
    }
  }, []);

  const handleDelete = (id: string) => {
    if (!window.confirm("このアプリのコードを削除しますか？（元に戻せません）")) return;
    const next = apps.filter((a) => a.id !== id);
    setApps(next);
    saveArchive(next);
    if (API_URL) void artifactDelete(id).catch(() => {});
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
          ここまでに作ったアプリが残ります。<span className="text-fg">HTML</span> のものは
          「開く」でそのまま動かせます。
          <span className="text-muted/70"> Python（Streamlit）の古い生成物は、
          ダウンロードして手元で <code className="text-[#9fe7ff]">streamlit run</code> が必要です。</span>
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
          <p className="text-[12px] text-fg-strong">保存されたアプリはまだありません</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            「つくる」の「アプリ」タブで作ると、自動的にここに保存されます。
          </p>
        </div>
      ) : filtered.length === 0 ? (
        /* 検索して0件のときは「無い」だけでなく、直し方（消す・別の語）を出す。 */
        <div className="panel p-6 text-center">
          <p className="text-[12px] text-fg-strong">「{search}」に一致するアプリはありません</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            検索欄を空にすると、保存済みの {apps.length} 件がすべて表示されます。
          </p>
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
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg-strong">{app.name}</span>
                  <span className="shrink-0 rounded border px-1 text-[9px] label-mono"
                        style={kindOf(app) === "html"
                          ? { borderColor: "#60d39455", color: "#60d394" }
                          : { borderColor: "var(--panel-bd)", color: "var(--muted)" }}>
                    {kindOf(app) === "html" ? "HTML" : "PYTHON"}
                  </span>
                </div>
                <p className="mb-2 text-[11px] text-muted line-clamp-2">{app.prompt}</p>
                <div className="text-[11px] text-muted/60">
                  {new Date(app.createdAt).toLocaleDateString("ja-JP")}
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {/* HTMLはその場で動かせる。押せば確認できるのに、コードしか
                      見せないのが一番もったいない */}
                  {kindOf(app) === "html" && (
                    <button
                      type="button"
                      onClick={() => void fetchCode(app).then((c) => c && openHtml(c))}
                      className="rounded-forge border px-2 py-1 text-[10px] tracking-[0.12em] label-mono"
                      style={{ borderColor: "var(--accent)", color: "var(--fg-strong)", background: "var(--btn-bg)" }}
                    >
                      ▶ 開く
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (app.id === viewingId) { setViewingId(null); return; }
                      void fetchCode(app).then(() => setViewingId(app.id));
                    }}
                    className="flex-1 rounded-forge border border-panel px-2 py-1 text-[10px] tracking-[0.12em] text-muted transition hover:border-[var(--line)] hover:text-fg-strong label-mono"
                  >
                    {viewingId === app.id ? "COLLAPSE" : "VIEW CODE"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void fetchCode(app).then((c) => {
                      if (!c) return;
                      kindOf(app) === "html"
                        ? download(`${app.name.replace(/\s+/g, "_")}.html`, c, "text/html;charset=utf-8")
                        : download(`${app.name.replace(/\s+/g, "_")}.py`, c, "text/x-python");
                    })}
                    className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-2 py-1 text-[10px] tracking-[0.12em] text-fg-strong transition hover:shadow-glow label-mono"
                  >
                    {kindOf(app) === "html" ? "↓ .html" : "↓ .py"}
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
