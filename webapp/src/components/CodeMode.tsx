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
import { explain } from "@/lib/needs";
import Markdown from "@/components/Markdown";
import {
  buildRunDoc, buildTestDoc, testFiles, RUN_SANDBOX, RUN_CHANNEL,
  type ConsoleLine, type TestSummary,
} from "@/lib/runner";
import { diffLines, collapseDiff, changedFiles, type FileChange } from "@/lib/diff";
import { codeShellStatus, codeShellRun, type ShellStatus, type ShellResult } from "@/lib/api";

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
  // チェックポイント（適用前の状態を積む）。1段だけの undo では実用に足りない。
  const [checkpoints, setCheckpoints] = useState<{ id: string; label: string; at: number; files: CodeFile[] }[]>([]);
  // 直前の適用の差分レビュー（受け入れる前に何が変わったか見る）
  const [review, setReview] = useState<{ before: CodeFile[]; changes: FileChange[] } | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");        // ファイル横断検索
  // エージェントに渡すファイルを絞る（Claude Code の @file 指定に相当）。空＝全部。
  const [ctx, setCtx] = useState<Set<string>>(new Set());
  // テストが通るまで自動で直す（回数上限つき）
  const [autoFix, setAutoFix] = useState<{ round: number; max: number } | null>(null);
  const autoRef2 = useRef(false);
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  // 実行（CONSOLE / TESTS）— サンドボックスiframe内で本当に動かす
  const [runTab, setRunTab] = useState<"console" | "tests" | "term" | null>(null);
  // サーバー実行（既定は無効。有効な環境だけターミナルが使える）
  const [shell, setShell] = useState<ShellStatus | null>(null);
  const [cmd, setCmd] = useState("");
  const [termLog, setTermLog] = useState<{ cmd: string; res: ShellResult }[]>([]);
  const [termBusy, setTermBusy] = useState(false);
  const [logs, setLogs] = useState<ConsoleLine[]>([]);
  const [tests, setTests] = useState<TestSummary | null>(null);
  const [running, setRunning] = useState(false);
  // プレビュー用とテスト用で別のiframeを持つ（1つのrefを共有すると、
  // 後にマウントされた方だけが有効になり、もう片方のログを取り落とす）
  const previewFrame = useRef<HTMLIFrameElement | null>(null);
  const testFrame = useRef<HTMLIFrameElement | null>(null);
  const [runNonce, setRunNonce] = useState(0);
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
      setGhError(explain(e, "リポジトリ一覧の取得"));
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
      setGhError(explain(e, "取り込み"));
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
    const message = window.prompt("コミットメッセージ", lastAsk.slice(0, 72) || "Update via AIbou / CODE mode");
    if (message === null) return;
    setPushBusy(true);
    try {
      const r = await ghPush({
        repo: ws.repo,
        base: ws.baseRef || "main",
        branch: branch.trim(),
        message: message.trim() || "Update via AIbou / CODE mode",
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
  const hasTests = useMemo(() => testFiles(ws?.files ?? []).length > 0, [ws?.files]);
  const htmlEntry = useMemo(
    () => (selectedFile && isHtml ? selectedFile.path
      : ws?.files.find((f) => /(^|\/)index\.html?$/i.test(f.path))?.path
        ?? ws?.files.find((f) => /\.html?$/i.test(f.path))?.path ?? null),
    [selectedFile, isHtml, ws?.files],
  );

  /* ── 実行（サンドボックスiframe） ──────────────────────────────
     サーバーで他人のコードを走らせるのは危険なので、実行はブラウザ内で行う。
     allow-scripts のみ・allow-same-origin なしなので、親のDOMや
     localStorage（＝APIキー）には触れられない。 */
  useEffect(() => {
    const onMsg = (e: globalThis.MessageEvent) => {
      const m = e.data as { channel?: string; type?: string; level?: ConsoleLine["level"]; text?: string; summary?: TestSummary };
      if (!m || m.channel !== RUN_CHANNEL) return;
      // 自分が作った実行用iframeからのメッセージだけを受け取る
      const mine = [previewFrame.current?.contentWindow, testFrame.current?.contentWindow];
      if (!mine.some((w) => w && e.source === w)) return;
      if (m.type === "log") {
        setLogs((prev) => [...prev, { level: m.level ?? "log", text: m.text ?? "" }].slice(-200));
      } else if (m.type === "tests" && m.summary) {
        setTests(m.summary);
        setRunning(false);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  /** プレビュー（HTML）を実行し直す。同一ワークスペースのCSS/JSも埋め込む。 */
  const runPreview = () => {
    if (!ws || !htmlEntry) return;
    setLogs([]);
    setRunTab("console");
    setPreview(true);
    setSelected(htmlEntry);
    // srcDoc の差し替えは iframe の key を変えて確実に再実行させる
    setRunNonce((n) => n + 1);
  };

  /** *.test.js を実行する。 */
  const runTests = () => {
    if (!ws || !hasTests) return;
    setLogs([]);
    setTests(null);
    setRunning(true);
    setRunTab("tests");
    setRunNonce((n) => n + 1);
    // 応答が来ない場合に押しっぱなしにならないよう保険をかける
    window.setTimeout(() => setRunning(false), 15_000);
  };

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
    // 「見てから受け入れる」ための差分。適用は済んでいるが、
    // 何が変わったかを一覧＋行単位で確認し、ファイル単位で戻せる。
    const chs = changedFiles(baseFiles, files);
    setReview(chs.length ? { before: baseFiles, changes: chs } : null);
    setDiffPath(chs[0]?.path ?? null);
    const first = (r.files ?? []).find((f) => f.action !== "delete");
    if (first) setSelected(first.path);
    // 変更があるときは差分を最初に見せる（プレビューは ▶ PREVIEW で1クリック）。
    // ここで先にプレビューを出すと「見てから受け入れる」が成立しない。
    setPreview(chs.length === 0 && !!first && /\.html?$/i.test(first.path));
  };

  /** エージェント実行（SSE）→ 進捗を実況しつつ、完了時に適用。
   *  text を渡すと指示欄ではなくその内容で実行する（自動修正ループ用）。 */
  const sendText = (raw?: string) => {
    const text = (raw ?? instruction).trim();
    if (!text || busy || !ws) return;
    const wsId = ws.id;
    // 対象ファイルを絞っているときは、その分だけを渡す（大きなワークスペースで
    // 関係ないファイルに引きずられないように）。未選択なら全部。
    const all = ws.files.map((f) => ({ ...f }));
    const baseFiles = ctx.size ? all.filter((f) => ctx.has(f.path)) : all;
    setBusy(true);
    if (raw === undefined) setInstruction("");
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
        // 差分・undo・履歴は「送った分」ではなくワークスペース全体を基準にする
        // （絞り込み送信でも、他のファイルが消えたように見えないように）
        setUndoSnap(all);
        setCheckpoints((prev) => [
          { id: uid(), label: text.slice(0, 40), at: Date.now(), files: all },
          ...prev,
        ].slice(0, 10));
        applyResult(wsId, log, all, r);
        // 自動修正中なら、適用直後にテストを回して結果を見る
        if (autoRef2.current) window.setTimeout(() => runTests(), 300);
      },
    ).cancel;
  };

  const send = () => sendText();

  const undo = () => {
    if (!ws || !undoSnap) return;
    patchWs(ws.id, { files: undoSnap });
    setUndoSnap(null);
    setChanged(new Set());
    setReview(null);
  };

  /** チェックポイントまで戻す（何段でも遡れる）。 */
  const restore = (id: string) => {
    const cp = checkpoints.find((c) => c.id === id);
    if (!ws || !cp) return;
    if (!window.confirm(`「${cp.label}」の直前に戻しますか？（それ以降の変更は失われます）`)) return;
    patchWs(ws.id, { files: cp.files });
    setCheckpoints((prev) => prev.slice(prev.findIndex((c) => c.id === id) + 1));
    setChanged(new Set());
    setUndoSnap(null);
    setReview(null);
  };

  /** 差分レビューから1ファイルだけ元に戻す。 */
  const revertFile = (path: string) => {
    if (!ws || !review) return;
    const was = review.before.find((f) => f.path === path);
    let files = ws.files.filter((f) => f.path !== path);
    if (was) files = [...files, { ...was }];
    files.sort((a, b) => a.path.localeCompare(b.path));
    patchWs(ws.id, { files });
    const rest = review.changes.filter((c) => c.path !== path);
    setReview(rest.length ? { ...review, changes: rest } : null);
    setDiffPath(rest[0]?.path ?? null);
    setChanged((prev) => { const n = new Set(prev); n.delete(path); return n; });
  };

  /** 失敗したテストをそのまま修正指示にする（書く→試す→直すの往復）。 */
  const fixTests = () => {
    if (!tests || !tests.failed) return;
    setInstruction(fixInstruction(tests));
  };

  /** コンソールのエラーをそのまま修正指示にする。 */
  const fixErrors = () => {
    const errs = logs.filter((l) => l.level === "error").map((l) => `- ${l.text}`).join("\n");
    if (!errs) return;
    setInstruction(`実行時にエラーが出ています。原因を直してください。\n\n【エラー】\n${errs}`);
  };

  // サーバー実行が使えるかを一度だけ確認する（未接続・無効でも画面は動く）
  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    codeShellStatus().then((v) => { if (alive) setShell(v); }).catch(() => { /* 任意機能 */ });
    return () => { alive = false; };
  }, []);

  /** サーバーで1コマンド実行する（ワークスペースを一時ディレクトリに展開）。 */
  const runCommand = async (raw?: string) => {
    const c = (raw ?? cmd).trim();
    if (!c || termBusy || !ws) return;
    setTermBusy(true);
    setRunTab("term");
    try {
      const res = await codeShellRun(c, ws.files, 120);
      setTermLog((prev) => [...prev, { cmd: c, res }].slice(-20));
      if (raw === undefined) setCmd("");
    } catch {
      setTermLog((prev) => [...prev, { cmd: c, res: { error: "通信に失敗しました" } }]);
    } finally {
      setTermBusy(false);
    }
  };

  /** 失敗内容から修正指示文を組み立てる（手動ボタンと自動ループで共用）。 */
  const fixInstruction = (t: TestSummary) => {
    const failed = t.cases.filter((c) => !c.ok)
      .map((c) => `- ${c.name}: ${c.error ?? "失敗"}`).join("\n");
    return `テストが ${t.failed} 件失敗しています。原因を直してください。\n`
      + `テストファイル自体は変更せず、実装側を修正してください。\n\n【失敗したテスト】\n${failed}`;
  };

  useEffect(() => { autoRef2.current = !!autoFix; }, [autoFix]);

  /** 自動修正ループ：テスト結果が届くたびに、通っていなければもう一度直す。
   *  上限回数を必ず設ける（際限なくAPIを消費しないため）。 */
  useEffect(() => {
    if (!autoFix || !tests || running || busy) return;
    if (tests.failed === 0) {
      setAutoFix(null);
      setProgress(`✓ 自動修正: ${tests.total}件すべて成功しました`);
      window.setTimeout(() => setProgress(null), 4000);
      return;
    }
    if (autoFix.round >= autoFix.max) {
      setAutoFix(null);
      setProgress(`自動修正を${autoFix.max}回試しましたが、まだ${tests.failed}件失敗しています`);
      window.setTimeout(() => setProgress(null), 6000);
      return;
    }
    const next = autoFix.round + 1;
    setAutoFix({ ...autoFix, round: next });
    setProgress(`⟳ 自動修正 ${next}/${autoFix.max} 回目…`);
    sendText(fixInstruction(tests));
    // sendText / fixInstruction は毎レンダーで作られるため依存に入れない
    // （入れるとループが止まらなくなる）。tests の更新だけを起点にする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tests, autoFix, running, busy]);

  const startAutoFix = () => {
    if (!tests || !tests.failed) return;
    setAutoFix({ round: 0, max: 3 });
  };

  const stopAutoFix = () => {
    setAutoFix(null);
    setProgress(null);
  };

  /** ワークスペース横断の検索（該当ファイルと行を返す）。 */
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !ws) return [];
    const out: { path: string; line: number; text: string }[] = [];
    for (const f of ws.files) {
      const lines = (f.content || "").split("\n");
      for (let i = 0; i < lines.length && out.length < 60; i += 1) {
        if (lines[i].toLowerCase().includes(q)) out.push({ path: f.path, line: i + 1, text: lines[i].trim().slice(0, 120) });
      }
    }
    return out;
  }, [query, ws]);

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
            プログラムを書いて、その場で動かして確かめる画面です。
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
              「連携」で GitHub（<code className="text-fg">GITHUB_TOKEN</code>（Fine-grained PAT・Contents/Pull requests権限）を保存すると、
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
                    : "border-panel bg-[var(--tint)] text-fg",
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
            <span className="grid h-3.5 w-3.5 place-items-center rounded-full border text-[11px]"
              style={{ borderColor: deep ? "var(--accent)" : "var(--panel-bd)", background: deep ? "var(--accent)" : "transparent", color: deep ? "#05171a" : "transparent" }}>
              ✓
            </span>
            🧠 深く考える
          </button>
          <span className="text-[11px] text-muted">{deep ? "計画→実装→自己レビュー" : "通常（高速）"}</span>
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
        {/* 対象を絞っているときは、それが見えていないと事故になる */}
        {ctx.size > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
            <span className="text-[var(--accent)] label-mono">対象 {ctx.size}件のみ送信</span>
            <span className="min-w-0 flex-1 truncate">{Array.from(ctx).join(" · ")}</span>
            <button type="button" onClick={() => setCtx(new Set())}
              className="rounded border border-panel px-1.5 text-[9px] transition hover:text-fg-strong label-mono">
              全部に戻す
            </button>
          </p>
        )}
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
          {/* 実行 — ブラウザのサンドボックス内で本当に動かす */}
          <button type="button" onClick={runPreview} disabled={!htmlEntry}
            title={htmlEntry ? `${htmlEntry} を実行` : "HTMLファイルがありません"}
            className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-2.5 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong disabled:opacity-40 label-mono">
            ▶ 実行
          </button>
          {shell?.enabled && (
            <button type="button" onClick={() => setRunTab("term")}
              title="サーバーでコマンドを実行する（npm / pytest など）"
              className="rounded-forge border border-panel px-2.5 py-1.5 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong label-mono">
              ⌨ ターミナル
            </button>
          )}
          <button type="button" onClick={runTests} disabled={!hasTests || running}
            title={hasTests ? "*.test.js を実行" : "テストファイル（*.test.js）がありません"}
            className="rounded-forge border border-panel px-2.5 py-1.5 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">
            {running ? "…" : "✓ テスト"}
          </button>
          <div className="flex-1" />
          {review && (
            <button type="button" onClick={() => setPreview(false)}
              className="rounded-forge border border-[var(--accent)] px-2.5 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong label-mono"
              title="変更内容を確認する">
              ± 差分 {review.changes.length}
            </button>
          )}
          {checkpoints.length > 0 && (
            <select
              aria-label="チェックポイントに戻す"
              value=""
              onChange={(e) => { if (e.target.value) restore(e.target.value); }}
              /* select は最長のoptionに合わせて広がるため、幅を明示しないと
                 長い指示ラベルでスマホ幅を突き抜ける */
              className="max-w-[8.5rem] shrink-0 truncate rounded-forge border border-panel bg-transparent px-2 py-1.5 text-[10px] text-muted label-mono"
            >
              <option value="">↩ 履歴 ({checkpoints.length})</option>
              {checkpoints.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.label || "変更").replace(/\s+/g, " ").slice(0, 16)} の直前
                </option>
              ))}
            </select>
          )}
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
            {/* 横断検索 — 大きくなったワークスペースで目的の行に飛ぶため */}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="検索"
              aria-label="ファイルを検索"
              className="mb-1 w-full rounded-md border border-[var(--input-bd)] bg-[var(--input-bg)] px-1.5 py-1 text-[10px] text-fg-strong placeholder:text-muted focus:outline-none"
            />
            {query.trim() && (
              <div className="mb-1 flex flex-col gap-0.5 border-b border-panel pb-1">
                {hits.length === 0 && <p className="px-1 text-[10px] text-muted">見つかりません</p>}
                {hits.map((h, i) => (
                  <button key={i} type="button"
                    onClick={() => { setSelected(h.path); setPreview(false); }}
                    className="rounded px-1 py-0.5 text-left text-[11px] leading-tight text-muted transition hover:text-fg-strong"
                    title={`${h.path}:${h.line}`}>
                    <span className="text-[var(--accent)]">{h.path}:{h.line}</span> {h.text}
                  </button>
                ))}
              </div>
            )}
            {ws.files.length === 0 && <p className="px-1 text-[10px] text-muted">まだファイルがありません</p>}
            {ws.files.map((f) => (
              <div key={f.path} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setSelected(f.path);
                    setPreview(/\.html?$/i.test(f.path) && preview);
                    // 差分レビュー中は、選んだファイルの差分に合わせる。
                    // 変更が無いファイルを選んだら差分表示から抜けて編集に戻る。
                    if (review) {
                      if (review.changes.some((c) => c.path === f.path)) setDiffPath(f.path);
                      else setReview(null);
                    }
                  }}
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
                {/* エージェントに渡す対象の指定（◉=含める）。未選択なら全部渡す。 */}
                <button type="button"
                  onClick={() => setCtx((prev) => {
                    const n = new Set(prev);
                    if (n.has(f.path)) n.delete(f.path); else n.add(f.path);
                    return n;
                  })}
                  aria-label={`${f.path} を対象に${ctx.has(f.path) ? "しない" : "する"}`}
                  title="エージェントに渡す対象にする"
                  className="shrink-0 px-1 text-[10px] transition"
                  style={{ color: ctx.has(f.path) ? "var(--accent)" : "var(--muted)" }}>
                  {ctx.has(f.path) ? "◉" : "○"}
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
            ) : review && !preview ? (
              <DiffPane review={review} path={diffPath} onPick={setDiffPath}
                onRevert={revertFile} onClose={() => setReview(null)}
                onEdit={() => { setReview(null); }} />
            ) : preview && isHtml ? (
              <iframe
                key={`prev-${htmlEntry}-${runNonce}`}
                ref={previewFrame}
                title="preview"
                /* allow-same-origin は付けない（親のデータを守るため） */
                sandbox={RUN_SANDBOX}
                srcDoc={buildRunDoc(ws.files, selectedFile.path)}
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

        {/* 実行結果 — CONSOLE / TESTS */}
        {runTab && (
          <div className="flex max-h-56 min-h-0 flex-col overflow-hidden rounded-forge border border-panel bg-black/30">
            <div className="flex items-center gap-1.5 border-b border-panel px-2 py-1">
              {(["console", "tests", "term"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setRunTab(t)}
                  className="rounded px-2 py-0.5 text-[9px] tracking-[0.14em] label-mono"
                  style={{
                    background: runTab === t ? "var(--btn-bg)" : "transparent",
                    color: runTab === t ? "var(--fg-strong)" : "var(--muted)",
                  }}>
                  {t === "console" ? `⌗ CONSOLE${logs.length ? ` (${logs.length})` : ""}`
                    : t === "tests" ? "✓ TESTS" : "⌨ TERMINAL"}
                </button>
              ))}
              {tests && (
                <span className="text-[9px] label-mono"
                  style={{ color: tests.failed ? "#ff9b9b" : "#60d394" }}>
                  {tests.passed}/{tests.total} 成功{tests.failed ? ` · ${tests.failed} 失敗` : ""}
                </span>
              )}
              <div className="flex-1" />
              {/* 失敗・エラーをそのまま指示にする（書く→試す→直すの往復） */}
              {runTab === "tests" && tests && tests.failed > 0 && !autoFix && (
                <>
                  <button type="button" onClick={fixTests}
                    className="rounded border border-[var(--line)] px-2 py-0.5 text-[9px] text-fg-strong label-mono">
                    ✎ 失敗を直す
                  </button>
                  {/* 通るまで自動で回す。上限3回で必ず止まる。 */}
                  <button type="button" onClick={startAutoFix} disabled={busy}
                    title="テストが通るまで、最大3回まで自動で修正を試みます"
                    className="rounded border border-[var(--line)] bg-[var(--btn-bg)] px-2 py-0.5 text-[9px] text-fg-strong disabled:opacity-40 label-mono">
                    ⟳ 通るまで直す
                  </button>
                </>
              )}
              {autoFix && (
                <button type="button" onClick={stopAutoFix}
                  className="rounded border border-[#ffd06044] px-2 py-0.5 text-[9px] text-[#ffd060] label-mono">
                  ■ 自動修正を止める（{autoFix.round}/{autoFix.max}）
                </button>
              )}
              {runTab === "console" && logs.some((l) => l.level === "error") && (
                <button type="button" onClick={fixErrors}
                  className="rounded border border-[var(--line)] px-2 py-0.5 text-[9px] text-fg-strong label-mono">
                  ✎ エラーを直す
                </button>
              )}
              <button type="button" onClick={() => { setLogs([]); setTests(null); }}
                className="text-[9px] text-muted transition hover:text-fg-strong label-mono">クリア</button>
              <button type="button" onClick={() => setRunTab(null)} aria-label="実行結果を閉じる"
                className="px-1 text-[10px] text-muted transition hover:text-fg-strong">✕</button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
              {runTab === "term" ? (
                !shell?.enabled ? (
                  <div className="text-[10px] leading-relaxed text-muted">
                    サーバーでのコマンド実行は無効です。
                    <br />
                    有効にするには、バックエンドの環境変数に
                    <span className="mx-1 text-[var(--accent)]">ENABLE_SHELL=1</span>
                    を設定してください。
                    <br />
                    ※ 生成したコードをサーバー上で実行することになります。
                    自分専用／自ホスト運用でのみ有効にしてください。
                  </div>
                ) : (
                  <>
                    {termLog.length === 0 && (
                      <p className="text-[10px] leading-relaxed text-muted">
                        npm test / python3 -m pytest -q / node app.js などを実行できます。
                        <br />
                        ワークスペースのファイルを毎回一時ディレクトリに展開して走らせます
                        （許可コマンド: {shell.allowed.slice(0, 10).join(", ")} …）。
                      </p>
                    )}
                    {termLog.map((t, i) => (
                      <div key={i} className="mb-2">
                        <div className="text-[var(--accent)]">$ {t.cmd}</div>
                        {t.res.error ? (
                          <div className="text-[#ff9b9b]">⚠ {t.res.error}</div>
                        ) : (
                          <>
                            {t.res.stdout && <pre className="whitespace-pre-wrap text-fg">{t.res.stdout}</pre>}
                            {t.res.stderr && <pre className="whitespace-pre-wrap text-[#ffcf8b]">{t.res.stderr}</pre>}
                            <div className="text-[9px] text-muted label-mono">
                              exit {t.res.code} · {t.res.seconds}s
                              {t.res.truncated ? " · 出力を打ち切りました" : ""}
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                    {termBusy && <p className="text-[10px] text-muted">実行中…</p>}
                  </>
                )
              ) : runTab === "console" ? (
                logs.length === 0 ? (
                  <p className="text-[10px] text-muted">
                    console.log / エラーがここに出ます（▶ 実行 で開始）
                  </p>
                ) : logs.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap"
                    style={{ color: l.level === "error" ? "#ff9b9b" : l.level === "warn" ? "#ffcf8b" : "var(--fg)" }}>
                    <span className="mr-1.5 text-muted">{l.level === "error" ? "✕" : l.level === "warn" ? "!" : "›"}</span>
                    {l.text}
                  </div>
                ))
              ) : running ? (
                <p className="text-[10px] text-muted">実行中…</p>
              ) : !tests ? (
                <p className="text-[10px] text-muted">
                  {hasTests ? "「✓ テスト」を押すと実行します" : "*.test.js を作るとテストを実行できます"}
                </p>
              ) : tests.total === 0 ? (
                <p className="text-[10px] text-muted">テストが見つかりませんでした</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {tests.cases.map((c, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <span style={{ color: c.ok ? "#60d394" : "#ff9b9b" }}>{c.ok ? "✓" : "✕"}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-fg">{c.name} <span className="text-muted">{c.ms}ms</span></div>
                        {c.error && <div className="whitespace-pre-wrap text-[10px] text-[#ff9b9b]">{c.error}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* コマンド入力（ターミナルのときだけ） */}
            {runTab === "term" && shell?.enabled && (
              <div className="flex items-center gap-1.5 border-t border-panel p-1.5">
                <span className="text-[11px] text-[var(--accent)] label-mono">$</span>
                <input
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void runCommand(); }}
                  placeholder="npm test / python3 -m pytest -q"
                  aria-label="実行するコマンド"
                  className="min-w-0 flex-1 rounded border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1 font-mono text-[11px] text-fg-strong placeholder:text-muted focus:outline-none"
                />
                <button type="button" onClick={() => void runCommand()} disabled={termBusy || !cmd.trim()}
                  className="shrink-0 rounded border border-[var(--line)] bg-[var(--btn-bg)] px-2.5 py-1 text-[10px] text-fg-strong disabled:opacity-40 label-mono">
                  {termBusy ? "…" : "実行"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* テスト実行用の隠しiframe（画面には出さない） */}
        {runTab === "tests" && ws && (
          <iframe
            key={`tests-${runNonce}`}
            ref={testFrame}
            title="tests"
            sandbox={RUN_SANDBOX}
            srcDoc={buildTestDoc(ws.files)}
            className="hidden"
          />
        )}
      </div>
    </div>
  );
}

/* ── 差分レビュー ──────────────────────────────────────────────────
   エージェントの変更を行単位で確認し、納得できないファイルだけ戻す。
   生成AIに任せるうえで「何が変わったか分からない」のが一番危ないので、
   適用後すぐこの画面に切り替わる。 */
function DiffPane({
  review, path, onPick, onRevert, onClose, onEdit,
}: {
  review: { before: CodeFile[]; changes: FileChange[] };
  path: string | null;
  onPick: (p: string) => void;
  onRevert: (p: string) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const cur = review.changes.find((c) => c.path === path) ?? review.changes[0];
  const d = useMemo(
    () => (cur ? diffLines(cur.before ?? "", cur.after ?? "") : null),
    [cur],
  );
  const rows = useMemo(() => (d ? collapseDiff(d.lines, 3) : []), [d]);
  if (!cur || !d) return null;

  const kind = cur.before === null ? "新規" : cur.after === null ? "削除" : "変更";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 変更ファイルの一覧 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-panel p-1.5">
        <span className="text-[9px] tracking-[0.16em] text-muted label-mono">変更 {review.changes.length}件</span>
        {review.changes.map((c) => (
          <button key={c.path} type="button" onClick={() => onPick(c.path)}
            className="rounded-full border px-2 py-0.5 text-[9px] label-mono"
            style={{
              borderColor: c.path === cur.path ? "var(--accent)" : "var(--panel-bd)",
              color: c.path === cur.path ? "var(--fg-strong)" : "var(--muted)",
            }}
            title={`${c.path} +${c.added} -${c.removed}`}>
            {c.path} <span style={{ color: "#60d394" }}>+{c.added}</span>{" "}
            <span style={{ color: "#ff9b9b" }}>-{c.removed}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button type="button" onClick={() => onRevert(cur.path)}
          className="rounded border border-[#ffd06044] px-2 py-0.5 text-[9px] text-[#ffd060] label-mono"
          title="このファイルだけ変更前に戻す">↩ この1件を戻す</button>
        <button type="button" onClick={onEdit}
          className="rounded border border-panel px-2 py-0.5 text-[9px] text-muted transition hover:text-fg-strong label-mono">
          ✓ 受け入れて編集へ
        </button>
        <button type="button" onClick={onClose} aria-label="差分を閉じる"
          className="px-1 text-[10px] text-muted transition hover:text-fg-strong">✕</button>
      </div>

      <div className="flex items-center gap-2 border-b border-panel px-2 py-1">
        <span className="truncate text-[10px] text-fg-strong">{cur.path}</span>
        <span className="text-[9px] text-muted label-mono">{kind}</span>
        {d.truncated && (
          <span className="text-[9px] text-[#ffcf8b] label-mono">※ 大きすぎるため全置換として表示</span>
        )}
      </div>

      {/* 行差分 */}
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-relaxed">
        {rows.map((r, i) => r.kind === "gap" ? (
          <div key={i} className="px-2 py-0.5 text-[11px] text-muted"
            style={{ background: "rgba(255,255,255,0.02)" }}>
            ⋯ {r.count}行省略
          </div>
        ) : (
          <div key={i} className="flex gap-2 px-2"
            style={{
              background: r.line.op === "add" ? "rgba(96,211,148,0.10)"
                : r.line.op === "del" ? "rgba(255,155,155,0.10)" : "transparent",
            }}>
            <span className="w-8 shrink-0 select-none text-right text-[11px] text-muted">{r.line.a ?? ""}</span>
            <span className="w-8 shrink-0 select-none text-right text-[11px] text-muted">{r.line.b ?? ""}</span>
            <span className="w-3 shrink-0 select-none"
              style={{ color: r.line.op === "add" ? "#60d394" : r.line.op === "del" ? "#ff9b9b" : "var(--muted)" }}>
              {r.line.op === "add" ? "+" : r.line.op === "del" ? "-" : ""}
            </span>
            <span className="whitespace-pre-wrap break-all text-fg">{r.line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
