"use client";

/**
 * CodeMode — CODE（Claude Code / Codex 風のAIコーディングエージェント）.
 *
 * 左＝エージェントとの対話（指示→計画/説明が返る）、右＝ワークスペース
 * （ファイルツリー＋エディタ＋HTMLの即時プレビュー）。エージェントの変更は
 * ワークスペースに適用され、NEW/UPD チップで差分が分かる。直前の適用は
 * ↩ で丸ごと戻せる。ワークスペースは localStorage に保存（複数管理）。
 * バックエンド未接続でも、スターター作成・手動編集・プレビュー・ZIP出力は動く。
 */

import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { codeGenerateStream, ghRepos, ghImport, ghPush, API_URL, type CodeFile, type ChatTurn, type GhRepo, type CodeGenerateResult } from "@/lib/api";
import Markdown from "@/components/Markdown";

const LS_WORKSPACES = "forge_code_workspaces";
const WS_LIMIT = 12;
const LOG_LIMIT = 30;

interface LogTurn {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

interface Workspace {
  id: string;
  name: string;
  files: CodeFile[];
  log: LogTurn[];
  updatedAt: number;
  /** GitHubから読み込んだ場合の連携情報（PUSH先）。 */
  repo?: string;
  baseRef?: string;
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(LS_WORKSPACES);
    return raw ? (JSON.parse(raw) as Workspace[]) : [];
  } catch {
    return [];
  }
}

function saveWorkspaces(list: Workspace[]): void {
  try {
    localStorage.setItem(LS_WORKSPACES, JSON.stringify(list.slice(0, WS_LIMIT)));
  } catch { /* quota — ignore */ }
}

/* ── スターター（オフラインでも使えるようフロントに内蔵） ──────────── */
const WEB_STARTER = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My App</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0a0e14; color:#e8eef5; font-family:system-ui,sans-serif; }
  .card { text-align:center; padding:2.5rem 3rem; border:1px solid #223;
          border-radius:16px; background:#101722; box-shadow:0 0 40px #0af2; }
  button { margin-top:1.2rem; padding:.6rem 1.4rem; border-radius:10px;
           border:1px solid #345; background:#16202e; color:#cde; cursor:pointer; }
</style>
</head>
<body>
  <div class="card">
    <h1>⚡ My App</h1>
    <p>ここから作り始めましょう。</p>
    <button onclick="this.textContent='clicked!'">Click</button>
  </div>
</body>
</html>
`;

const TEMPLATES: { key: string; label: string; files: CodeFile[] }[] = [
  { key: "web", label: "WEBアプリ (index.html)", files: [{ path: "index.html", content: WEB_STARTER }] },
  {
    key: "python",
    label: "Python スクリプト",
    files: [
      { path: "main.py", content: '"""main.py — スターター。"""\n\n\ndef main() -> None:\n    print("Hello from CODE mode!")\n\n\nif __name__ == "__main__":\n    main()\n' },
      { path: "README.md", content: "# My Project\n\nCODEモードで生成したプロジェクト。\n" },
    ],
  },
  { key: "empty", label: "空のワークスペース", files: [] },
];

export default function CodeMode() {
  const [wsList, setWsList] = useState<Workspace[]>([]);
  const [wsId, setWsId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);  // Claude Code風の実況
  const [deep, setDeep] = useState(false);                        // 深く考えるモード
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [undoSnap, setUndoSnap] = useState<CodeFile[] | null>(null);
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  // GitHub連携（一覧→インポート / プッシュ+PR）
  const [ghList, setGhList] = useState<GhRepo[] | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [ghFilter, setGhFilter] = useState("");
  const [ghPath, setGhPath] = useState("");
  const [pushBusy, setPushBusy] = useState(false);

  const loadRepos = async () => {
    setGhBusy(true);
    setGhError(null);
    try {
      setGhList(await ghRepos());
    } catch (e) {
      setGhError(e instanceof Error ? e.message : "リポジトリ一覧の取得に失敗しました");
    } finally {
      setGhBusy(false);
    }
  };

  const importFromGithub = async (r: GhRepo) => {
    if (ghBusy) return;
    setGhBusy(true);
    setGhError(null);
    try {
      const res = await ghImport(r.full_name, "", ghPath.trim());
      const w: Workspace = {
        id: uid(),
        name: `${r.full_name.split("/")[1]}@${res.ref}`,
        files: res.files,
        log: [{
          role: "assistant" as const,
          content: `📥 **${r.full_name}** (${res.ref}) を読み込みました — ${res.files.length} ファイル${res.skipped ? `（${res.skipped}件はサイズ/形式でスキップ）` : ""}。
指示をどうぞ（例：「READMEを整えて」「このバグを直して: …」）`,
        }],
        updatedAt: Date.now(),
        repo: r.full_name,
        baseRef: res.ref,
      };
      setWsList((prev) => { const next = [w, ...prev]; saveWorkspaces(next); return next; });
      setWsId(w.id);
      setSelected(res.files[0]?.path ?? null);
      setChanged(new Set());
      setUndoSnap(null);
      setPreview(false);
    } catch (e) {
      setGhError(e instanceof Error ? e.message : "インポートに失敗しました");
    } finally {
      setGhBusy(false);
    }
  };

  const pushToGithub = async () => {
    if (!ws?.repo || pushBusy) return;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const defBranch = `forge/edit-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const branch = window.prompt("プッシュ先の新ブランチ名", defBranch);
    if (!branch?.trim()) return;
    const lastAsk = [...ws.log].reverse().find((t) => t.role === "user")?.content ?? "";
    const message = window.prompt("コミットメッセージ", lastAsk.slice(0, 72) || "Update via THE FORGE OS / CODE mode");
    if (message === null) return;
    setPushBusy(true);
    try {
      const r = await ghPush({
        repo: ws.repo,
        base: ws.baseRef || "main",
        branch: branch.trim(),
        message: message.trim() || "Update via THE FORGE OS / CODE mode",
        files: ws.files,
      });
      const pr = r.pr_url ? `
🔗 [PRを開く](${r.pr_url})` : (r.note ? `
（${r.note}）` : "");
      patchWs(ws.id, { log: [...ws.log, { role: "assistant" as const, content: `✅ **${r.branch}** にプッシュしました（${r.commit}）${pr}` }] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "プッシュに失敗しました";
      patchWs(ws.id, { log: [...ws.log, { role: "assistant" as const, content: `⚠ ${msg}`, error: true }] });
    } finally {
      setPushBusy(false);
    }
  };

  // 起動時にワークスペースを復元（無ければ空リストで開始画面）
  useEffect(() => {
    const list = loadWorkspaces();
    setWsList(list);
    if (list.length > 0) {
      setWsId(list[0].id);
      setSelected(list[0].files[0]?.path ?? null);
    }
  }, []);

  const ws = useMemo(() => wsList.find((w) => w.id === wsId) ?? null, [wsList, wsId]);
  const selectedFile = useMemo(
    () => ws?.files.find((f) => f.path === selected) ?? null,
    [ws, selected],
  );
  const isHtml = !!selectedFile && /\.html?$/i.test(selectedFile.path);

  // ログは常に最新へ
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ws?.log]);

  /** ワークスペースの部分更新＋保存。 */
  const patchWs = useCallback((id: string, patch: Partial<Workspace>) => {
    setWsList((prev) => {
      const next = prev.map((w) => (w.id === id ? { ...w, ...patch, updatedAt: Date.now() } : w));
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      saveWorkspaces(next);
      return next;
    });
  }, []);

  const createWs = (tplKey: string) => {
    const tpl = TEMPLATES.find((t) => t.key === tplKey) ?? TEMPLATES[2];
    const w: Workspace = {
      id: uid(),
      name: `${tpl.key === "empty" ? "PROJECT" : tpl.key.toUpperCase()}-${new Date().getMonth() + 1}${new Date().getDate()}`,
      files: tpl.files.map((f) => ({ ...f })),
      log: [],
      updatedAt: Date.now(),
    };
    setWsList((prev) => {
      const next = [w, ...prev];
      saveWorkspaces(next);
      return next;
    });
    setWsId(w.id);
    setSelected(w.files[0]?.path ?? null);
    setChanged(new Set());
    setUndoSnap(null);
    setPreview(tpl.key === "web");
  };

  const renameWs = () => {
    if (!ws) return;
    const name = window.prompt("ワークスペース名", ws.name);
    if (name?.trim()) patchWs(ws.id, { name: name.trim() });
  };

  const deleteWs = () => {
    if (!ws) return;
    if (!window.confirm(`ワークスペース「${ws.name}」を削除しますか？（元に戻せません）`)) return;
    setWsList((prev) => {
      const next = prev.filter((w) => w.id !== ws.id);
      saveWorkspaces(next);
      return next;
    });
    setWsId(null);
    setSelected(null);
  };

  /** 生成結果をワークスペースへ適用（Undoスナップは呼び出し側で保持済み）。 */
  const applyResult = (wsId: string, log: LogTurn[], baseFiles: CodeFile[], r: CodeGenerateResult) => {
    let files = [...baseFiles];
    const touched = new Set<string>();
    for (const f of r.files ?? []) {
      touched.add(f.path);
      if (f.action === "delete") {
        files = files.filter((x) => x.path !== f.path);
      } else {
        const i = files.findIndex((x) => x.path === f.path);
        if (i >= 0) files[i] = { path: f.path, content: f.content };
        else files.push({ path: f.path, content: f.content });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const changeList = (r.files ?? []).map((f) => `${f.action === "delete" ? "✕" : "✎"} ${f.path}`).join(" · ") || "（なし）";
    const summary = `${r.explanation ?? ""}\n\n変更: ${changeList}`;
    patchWs(wsId, { files, log: [...log, { role: "assistant" as const, content: summary.trim() }] });
    setChanged(touched);
    const first = (r.files ?? []).find((f) => f.action !== "delete");
    if (first) {
      setSelected(first.path);
      setPreview(/\.html?$/i.test(first.path));
    }
  };

  /** エージェント実行（SSE）→ 進捗を実況しつつ、完了時に適用。 */
  const send = () => {
    const text = instruction.trim();
    if (!text || busy || !ws) return;
    const wsId = ws.id;
    const baseFiles = ws.files.map((f) => ({ ...f }));
    setBusy(true);
    setInstruction("");
    setProgress(deep ? "🧭 計画中…" : "🚀 開始…");
    const log: LogTurn[] = [...ws.log, { role: "user" as const, content: text }].slice(-LOG_LIMIT);
    patchWs(wsId, { log });
    const history: ChatTurn[] = log
      .filter((t) => !t.error)
      .slice(-6)
      .map((t) => ({ role: t.role, content: t.content }));

    cancelRef.current = codeGenerateStream(
      text,
      baseFiles,
      history,
      deep ? "deep" : "normal",
      (p) => setProgress(p.detail || p.phase),
      (r) => {
        cancelRef.current = null;
        setProgress(null);
        setBusy(false);
        if (r.error) {
          patchWs(wsId, { log: [...log, { role: "assistant" as const, content: `⚠ ${r.error}`, error: true }] });
          return;
        }
        setUndoSnap(baseFiles);
        applyResult(wsId, log, baseFiles, r);
      },
    ).cancel;
  };

  const undo = () => {
    if (!ws || !undoSnap) return;
    patchWs(ws.id, { files: undoSnap });
    setUndoSnap(null);
    setChanged(new Set());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  /* ── ファイル操作 ── */
  const editSelected = (content: string) => {
    if (!ws || !selected) return;
    patchWs(ws.id, { files: ws.files.map((f) => (f.path === selected ? { ...f, content } : f)) });
  };

  const addFile = () => {
    if (!ws) return;
    const path = window.prompt("ファイル名（例: style.css / src/app.js）");
    const clean = path?.trim();
    if (!clean) return;
    if (ws.files.some((f) => f.path === clean)) { setSelected(clean); return; }
    patchWs(ws.id, { files: [...ws.files, { path: clean, content: "" }].sort((a, b) => a.path.localeCompare(b.path)) });
    setSelected(clean);
    setPreview(false);
  };

  const deleteFile = (path: string) => {
    if (!ws) return;
    if (!window.confirm(`${path} を削除しますか？`)) return;
    patchWs(ws.id, { files: ws.files.filter((f) => f.path !== path) });
    if (selected === path) setSelected(ws.files.find((f) => f.path !== path)?.path ?? null);
  };

  const downloadZip = async () => {
    if (!ws || ws.files.length === 0) return;
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const f of ws.files) zip.file(f.path, f.content);
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${ws.name.replace(/[\\/:*?"<>|\s]+/g, "_")}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyFile = () => {
    if (!selectedFile) return;
    try {
      void navigator.clipboard?.writeText(selectedFile.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* ignore */ }
  };

  /* ── 開始画面（ワークスペース未選択） ── */
  if (!ws) {
    return (
      <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 pb-8">
        <div className="text-center">
          <h2 className="label-mono text-glow text-sm tracking-[0.24em] text-fg-strong">AI CODING AGENT</h2>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            Claude Code のように、日本語の指示でコードを書き・直し・育てるモードです。<br />
            テンプレートを選んで始めてください（バックエンド未接続でも編集・プレビュー・ZIP出力は使えます）。
          </p>
        </div>
        <div className="grid w-full gap-2 sm:grid-cols-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => createWs(t.key)}
              className="glass-silver p-4 text-center transition hover:shadow-glow"
            >
              <div className="text-xl">{t.key === "web" ? "🌐" : t.key === "python" ? "🐍" : "📄"}</div>
              <div className="mt-1 text-[11px] tracking-[0.08em] text-fg-strong label-mono">{t.label}</div>
            </button>
          ))}
        </div>
        {/* GitHubから開く（Claude Code スタイル） */}
        <div className="w-full rounded-forge border border-panel p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] tracking-[0.2em] text-muted label-mono">⌥ GITHUBから開く</span>
            <button
              type="button"
              onClick={() => void loadRepos()}
              disabled={ghBusy}
              className="rounded-forge border border-[var(--line)] px-3 py-1 text-[10px] tracking-[0.14em] text-[var(--accent)] disabled:opacity-40 label-mono"
            >
              {ghBusy && !ghList ? "取得中…" : "リポジトリ一覧を取得"}
            </button>
          </div>
          {!ghList && !ghError && (
            <p className="text-[10px] leading-relaxed text-muted">
              KEYCHAIN に <code className="text-fg">GITHUB_TOKEN</code>（Fine-grained PAT・Contents/Pull requests権限）を保存すると、
              リポジトリを選んでそのままAIコーディング → 新ブランチへプッシュ＋PR作成までできます。
            </p>
          )}
          {ghError && <p className="text-[10px] leading-relaxed text-[#ff9b9b]">⚠ {ghError}</p>}
          {ghList && (
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="flex gap-1.5">
                <input
                  value={ghFilter}
                  onChange={(e) => setGhFilter(e.target.value)}
                  placeholder="絞り込み…"
                  className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[11px] text-fg-strong placeholder:text-muted focus:outline-none"
                />
                <input
                  value={ghPath}
                  onChange={(e) => setGhPath(e.target.value)}
                  placeholder="フォルダ指定（任意 例: src）"
                  className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[11px] text-fg-strong placeholder:text-muted focus:outline-none"
                />
              </div>
              <div className="max-h-52 overflow-y-auto rounded-forge border border-panel">
                {ghList
                  .filter((r) => !ghFilter.trim() || r.full_name.toLowerCase().includes(ghFilter.toLowerCase()))
                  .map((r) => (
                    <button
                      key={r.full_name}
                      type="button"
                      onClick={() => void importFromGithub(r)}
                      disabled={ghBusy}
                      className="flex w-full items-center gap-2 border-b border-panel px-3 py-2 text-left transition last:border-b-0 hover:bg-white/5 disabled:opacity-40"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-fg-strong">{r.full_name}</span>
                      {r.private && <span className="shrink-0 rounded border border-panel px-1.5 text-[8px] tracking-[0.1em] text-muted label-mono">PRIVATE</span>}
                      <span className="shrink-0 text-[9px] text-muted label-mono">{r.default_branch}</span>
                    </button>
                  ))}
                {ghList.length === 0 && <p className="p-3 text-[10px] text-muted">アクセスできるリポジトリがありません（PATの対象リポジトリ設定を確認）</p>}
              </div>
              {ghBusy && <p className="text-[10px] tracking-[0.14em] text-muted label-mono">◈ IMPORTING…</p>}
            </div>
          )}
        </div>

        {wsList.length > 0 && (
          <div className="w-full">
            <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">最近のワークスペース</div>
            <div className="flex flex-col gap-1">
              {wsList.slice(0, 5).map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => { setWsId(w.id); setSelected(w.files[0]?.path ?? null); }}
                  className="rounded-forge border border-panel px-3 py-2 text-left text-[12px] text-fg transition hover:border-[var(--line)]"
                >
                  {w.name} <span className="text-[10px] text-muted">· {w.files.length} files</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ── メイン（左: エージェント / 右: ワークスペース） ── */
  return (
    <div className="grid h-full min-h-0 gap-3 pb-2 lg:grid-cols-[minmax(20rem,26rem)_1fr]">
      {/* LEFT — agent conversation */}
      <div className="flex min-h-0 flex-col gap-2">
        {/* Workspace bar */}
        <div className="flex items-center gap-1.5 rounded-forge border border-panel p-2">
          <button type="button" onClick={() => setWsId(null)} className="shrink-0 rounded-md px-2 py-1 text-[10px] text-muted transition hover:text-fg-strong label-mono" title="ワークスペース一覧へ">←</button>
          <button type="button" onClick={renameWs} className="min-w-0 flex-1 truncate text-left text-[12px] text-fg-strong" title="名前を変更">
            {ws.name}
          </button>
          {ws.repo && (
            <button
              type="button"
              onClick={() => void pushToGithub()}
              disabled={pushBusy}
              className="shrink-0 rounded-forge border border-[var(--line)] px-2.5 py-1 text-[10px] tracking-[0.1em] text-[var(--accent)] disabled:opacity-40 label-mono"
              title={`${ws.repo} へ新ブランチでプッシュ＋PR作成`}
            >
              {pushBusy ? "PUSHING…" : "⬆ PUSH"}
            </button>
          )}
          <button type="button" onClick={deleteWs} className="shrink-0 text-[10px] text-[#ff8888] label-mono" aria-label="Delete workspace">✕</button>
        </div>

        {/* Log */}
        <div ref={logRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-forge border border-panel bg-black/15 p-2" aria-live="polite">
          {ws.log.length === 0 && (
            <p className="p-3 text-[11px] leading-relaxed text-muted">
              例：「タイマーアプリにして」「ダークテーマのポートフォリオページを作って」「バグを直して: ボタンが動かない」
            </p>
          )}
          {ws.log.map((t, i) => (
            <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={[
                  "max-w-[92%] whitespace-pre-wrap rounded-forge border px-3 py-2 text-[12px] leading-relaxed",
                  t.role === "user"
                    ? "border-panel-strong bg-[rgba(255,255,255,0.07)] text-fg-strong"
                    : "border-panel bg-[rgba(150,200,255,0.06)] text-fg",
                  t.error ? "border-[rgba(255,120,120,0.45)] text-[#ffb4b4]" : "",
                ].join(" ")}
              >
                {t.role === "assistant" && !t.error ? <Markdown text={t.content} /> : t.content}
              </div>
            </div>
          ))}
          {busy && (
            <motion.p className="flex items-center gap-2 px-2 text-[11px] text-[var(--accent)] label-mono" animate={{ opacity: [0.55, 1, 0.55] }} transition={{ duration: 1.2, repeat: Infinity }}>
              <span>◈</span>
              <span className="tracking-[0.06em]">{progress || "AGENT WORKING…"}</span>
            </motion.p>
          )}
        </div>

        {/* Composer */}
        <div className="mb-1.5 flex items-center gap-2 px-1">
          <button
            type="button"
            onClick={() => setDeep((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] tracking-[0.12em] label-mono"
            style={{ color: deep ? "var(--accent)" : "var(--muted)" }}
            title="計画→実装→自己レビューの多段思考（高品質・少し遅い）"
          >
            <span className="grid h-3.5 w-3.5 place-items-center rounded-full border text-[8px]"
              style={{ borderColor: deep ? "var(--accent)" : "var(--panel-bd)", background: deep ? "var(--accent)" : "transparent", color: deep ? "#05171a" : "transparent" }}>
              ✓
            </span>
            🧠 深く考える
          </button>
          <span className="text-[9px] text-muted">{deep ? "計画→実装→自己レビュー" : "通常（高速）"}</span>
        </div>
        <div className="panel flex items-end gap-1.5 p-2">
          <textarea
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="エージェントへの指示…（Enterで実行）"
            className="max-h-30 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
            style={{ scrollbarWidth: "none" }}
          />
          <button
            type="button"
            onClick={() => (busy ? cancelRef.current?.() : send())}
            disabled={!busy && !instruction.trim()}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--btn-bg)] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40"
            aria-label={busy ? "Stop agent" : "Run agent"}
          >
            {busy ? "■" : "▶"}
          </button>
        </div>
        {!API_URL && (
          <p className="text-[10px] leading-relaxed text-muted">
            ⚠ バックエンド未接続のため、エージェント実行は接続後に使えます（編集・プレビュー・ZIPは可）。
          </p>
        )}
      </div>

      {/* RIGHT — workspace */}
      <div className="flex min-h-0 flex-col gap-2">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5">
          {isHtml && (
            <div className="flex overflow-hidden rounded-forge border border-panel">
              {(["preview", "code"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPreview(m === "preview")}
                  className="px-3 py-1.5 text-[10px] tracking-[0.14em] label-mono transition"
                  style={{
                    background: (m === "preview") === preview ? "var(--btn-bg)" : "transparent",
                    color: (m === "preview") === preview ? "var(--fg-strong)" : "var(--muted)",
                  }}
                >
                  {m === "preview" ? "▶ PREVIEW" : "⌨ CODE"}
                </button>
              ))}
            </div>
          )}
          <div className="flex-1" />
          {undoSnap && (
            <button type="button" onClick={undo} className="rounded-forge border border-[#ffd06044] px-2.5 py-1.5 text-[10px] tracking-[0.12em] text-[#ffd060] label-mono">
              ↩ 元に戻す
            </button>
          )}
          <button type="button" onClick={copyFile} disabled={!selectedFile} className="rounded-forge border border-panel px-2.5 py-1.5 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">
            {copied ? "✓" : "⧉"}
          </button>
          <button type="button" onClick={() => void downloadZip()} disabled={ws.files.length === 0} className="rounded-forge border border-panel px-2.5 py-1.5 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">
            ↓ ZIP
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[10rem_1fr] gap-2 sm:grid-cols-[12rem_1fr]">
          {/* File tree */}
          <div className="flex min-h-0 flex-col overflow-y-auto rounded-forge border border-panel bg-black/15 p-1.5">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[9px] tracking-[0.2em] text-muted label-mono">FILES</span>
              <button type="button" onClick={addFile} className="text-[11px] text-muted transition hover:text-fg-strong" aria-label="Add file">＋</button>
            </div>
            {ws.files.length === 0 && <p className="px-1 text-[10px] text-muted">まだファイルがありません</p>}
            {ws.files.map((f) => (
              <div key={f.path} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { setSelected(f.path); setPreview(/\.html?$/i.test(f.path) && preview); }}
                  className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-[11px] transition"
                  style={{
                    background: selected === f.path ? "rgba(255,255,255,0.06)" : "transparent",
                    color: selected === f.path ? "var(--fg-strong)" : "var(--fg)",
                  }}
                  title={f.path}
                >
                  {f.path}
                  {changed.has(f.path) && <span className="ml-1 text-[8px] text-[var(--accent)] label-mono">●</span>}
                </button>
                <button type="button" onClick={() => deleteFile(f.path)} className="shrink-0 px-1 text-[10px] text-muted opacity-60 transition hover:text-[#ff8888] sm:opacity-0 sm:group-hover:opacity-100" aria-label={`Delete ${f.path}`}>✕</button>
              </div>
            ))}
          </div>

          {/* Editor / preview */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-forge border border-panel bg-black/25">
            {!selectedFile ? (
              <div className="grid flex-1 place-items-center p-6 text-center text-[11px] leading-relaxed text-muted">
                左の指示ボックスから作りたいものを伝えるか、＋でファイルを追加してください。
              </div>
            ) : preview && isHtml ? (
              <iframe
                title="preview"
                sandbox="allow-scripts"
                srcDoc={selectedFile.content}
                className="h-full w-full flex-1 border-0 bg-white"
              />
            ) : (
              <textarea
                value={selectedFile.content}
                onChange={(e) => editSelected(e.target.value)}
                spellCheck={false}
                className="h-full flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-relaxed text-fg focus:outline-none"
                style={{ tabSize: 2 }}
                aria-label={`Edit ${selectedFile.path}`}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
