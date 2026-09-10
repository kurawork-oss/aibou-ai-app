"use client";

/**
 * Vault — 資料から答える画面。
 *
 * 資料を入れておくと、その中身だけを見て答える。ネットの一般論ではなく、
 * 入れた資料に書いてあることだけを言うのがこの画面の値打ち。
 *
 * 点検で分かったこと: 他のモードは冒頭で「何をする画面か」を言っているのに、
 * ここだけ空の一覧が出るだけだった。初めて来た人は「ノートブック」が何なのか、
 * 作ると何が起きるのかが分からないまま止まる。説明書には書いてあったので、
 * 同じことを画面にも出す。
 *
 * バックエンド/Supabase が未設定でも落ちない（catch → 空）。
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
  vaultUpload,
  vaultDocs,
  vaultDocDelete,
  myDatabase,
  API_URL,
  type VaultNotebook,
  type VaultDoc,
  type VaultAnswer,
} from "@/lib/api";
import Markdown from "@/components/Markdown";
import { explain } from "@/lib/needs";

export default function Vault() {
  const [notebooks, setNotebooks] = useState<VaultNotebook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* 保存先が繋がっているか。"unknown" のうちは何も言わない——
     分からない状態で「残りません」と出すと、繋いである人にも
     嘘の警告を出すことになる。 */
  const [storage, setStorage] = useState<"unknown" | "ok" | "none">("unknown");
  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    myDatabase()
      .then((d) => {
        if (!alive) return;
        // 持ち主はサーバー既定のDBに保存される。そこで「無い」と言うと嘘になる。
        setStorage(d.connected || d.using_server_db ? "ok" : "none");
      })
      .catch(() => { /* 分からないままにする（憶測で警告しない） */ });
    return () => { alive = false; };
  }, []);

  // new notebook
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // add text
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  const [adding, setAdding] = useState(false);
  const [addedNote, setAddedNote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);   // 取り込み結果の通知
  const [docs, setDocs] = useState<VaultDoc[]>([]);        // 出典番号つきの資料一覧

  // query
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<VaultAnswer | null>(null);

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
      setError(explain(e, "ノートブックの作成"));
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
        await loadDocs(selectedId);
      } else {
        setError("資料の取り込みに失敗しました");
      }
    } catch (e) {
      setError(explain(e, "資料の取り込み"));
    } finally {
      setAdding(false);
    }
  };

  /** 資料一覧（出典番号つき）を読み込む。失敗しても画面は動かす。 */
  const loadDocs = useCallback(async (nbId: string | null) => {
    if (!nbId) { setDocs([]); return; }
    try { setDocs(await vaultDocs(nbId)); } catch { setDocs([]); }
  }, []);

  useEffect(() => { void loadDocs(selectedId); }, [selectedId, loadDocs]);

  /** 資料を1件消す（間違って入れた資料が根拠に混ざり続けないように）。 */
  const removeDoc = async (title: string) => {
    if (!selectedId) return;
    if (!window.confirm(`資料「${title}」を削除しますか？`)) return;
    if (await vaultDocDelete(selectedId, title)) {
      setNote(`✓ 「${title}」を削除しました`);
      // 削除すると出典番号が振り直されるので、表示中の回答の [1][2] は
      // もう別の資料を指してしまう。嘘の出典を残さないよう回答を消す。
      setAnswer(null);
      await loadDocs(selectedId);
      await refresh();
    } else {
      setError("資料の削除に失敗しました");
    }
  };

  const handleFileDrop = (e: React.DragEvent | React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = "dataTransfer" in e ? e.dataTransfer.files : (e.target as HTMLInputElement).files;
    if (!files?.length) return;
    void ingestFiles(Array.from(files));
  };

  /**
   * ファイルを資料として取り込む。
   *
   * PDF はブラウザで readAsText すると中身がバイナリのまま入って文字化けする
   * （以前はそうなっていた）。サーバーの /vault/upload に渡して pypdf で
   * 抽出させ、テキスト系だけローカル読みの速い経路に載せる。
   */
  const ingestFiles = async (list: File[]) => {
    if (!selectedId) { setError("先にノートブックを選んでください"); return; }
    const isTextLike = (f: File) =>
      /^text\//.test(f.type) || /\.(txt|md|markdown|csv|json|ya?ml|tsv|log|py|ts|tsx|js|jsx|html|css)$/i.test(f.name);

    const needServer = list.filter((f) => !isTextLike(f));
    const local = list.filter(isTextLike);

    // PDF等はサーバーで抽出して、そのまま資料として登録する
    if (needServer.length) {
      setAdding(true);
      setError(null);
      try {
        for (const f of needServer) {
          const r = await vaultUpload(selectedId, f);
          if (r.error) setError(r.error);
          else setNote(`✓ ${f.name} を取り込みました（${(r.chars ?? 0).toLocaleString()}字）`);
        }
        await refresh();
        await loadDocs(selectedId);
      } catch (err) {
        setError(explain(err, "取り込み"));
      } finally {
        setAdding(false);
      }
    }

    // テキスト系はフォームに読み込んで、内容を確認してから登録できるようにする
    if (local.length) {
      const docs = await Promise.all(local.map((file) => new Promise<{ name: string; text: string }>((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve({ name: file.name, text: String(ev.target?.result || "") });
        reader.onerror = () => resolve({ name: file.name, text: "" });
        reader.readAsText(file, "utf-8");
      })));
      if (docs.length === 1) {
        setDocTitle(docs[0].name.replace(/\.[^.]+$/, ""));
        setDocContent(docs[0].text);
      } else {
        setDocTitle(`${docs[0].name.replace(/\.[^.]+$/, "")} ほか${docs.length - 1}件`);
        setDocContent(docs.map((d) => `=== ${d.name} ===\n${d.text}`).join("\n\n"));
      }
    }
  };

  const ask = async () => {
    if (!selectedId || !question.trim() || asking) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await vaultQuery(selectedId, question.trim()));
    } catch (e) {
      setError(explain(e, "質問"));
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
      setError(explain(e, "資料の作成"));
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
      setError(explain(e, "図解の生成"));
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
      {/* この画面が何をするものかを最初に言う。他のモードと揃える */}
      <div className="panel p-3">
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">
          VAULT とは
        </div>
        <p className="text-[11px] leading-relaxed text-fg">
          <span className="text-fg-strong">入れた資料の中身だけを見て答える</span>画面です。
          ネットの一般論ではなく、その資料に書いてあることだけを言います。
        </p>
        <div className="mt-2 flex flex-col gap-1 border-t border-panel pt-2 text-[10px] leading-relaxed text-muted">
          <div>▸ 社内規程・マニュアル・議事録を入れておくと、聞くだけで引ける</div>
          <div>▸ 答えるときは、資料のどこに書いてあったかも一緒に出す</div>
          <div className="text-muted/70">
            ※ 文字として入っているPDFだけ読めます。スキャンした写真だけのPDFは読めません。
          </div>
        </div>
      </div>

      {/* Notebooks: list + create */}
      <div className="panel p-3">
        <label className="mb-2 block text-[10px] tracking-[0.2em] text-muted label-mono">
          NOTEBOOKS
        </label>

        {loading ? (
          <div className="text-center text-xs text-muted">読み込み中…</div>
        ) : notebooks.length === 0 ? (
          <div className="text-[11px] leading-relaxed">
            <p className="text-fg">
              まず<span className="text-fg-strong">入れ物</span>を1つ作ります。
              下の欄に名前を入れて「作成」を押してください。
            </p>
            <p className="mt-1 text-muted">
              例：「社内規程」「商品マニュアル」「議事録」。
              テーマごとに分けておくと、聞いたときに関係ない資料が混ざりません。
            </p>
            {/* 「決まっていないと残りません」だと、自分がどちらなのか
                分からないまま作ることになる。**いまどうなっているか**を
                言い切る。分かるまでは何も出さない（急かさない）。 */}
            {storage === "none" && (
              <p className="mt-1 text-[10px] leading-relaxed" style={{ color: "#ff9b9b" }}>
                ※ いま保存先が繋がっていないので、作っても残りません
                （拡張機能 → Supabase から繋いでください）。
              </p>
            )}
            {storage === "ok" && (
              <p className="mt-1 text-[10px] text-muted/70">
                ※ 保存先は繋がっています。作った入れ物はそのまま残ります。
              </p>
            )}
          </div>
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
                    <span className="ml-1.5 text-[11px] text-muted">{nb.doc_count}</span>
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
                PDF / TXT / MD / CSV をドロップ
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                PDFはサーバー側で本文を抽出してそのまま登録します
              </p>
              <label className="mt-1.5 block cursor-pointer text-[10px] text-[var(--accent)] hover:underline label-mono">
                またはファイルを選択
                <input
                  type="file"
                  accept=".pdf,.txt,.md,.markdown,.csv,.json,.tsv,.log"
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
            {note && (
              <p className="mt-2 text-[11px] label-mono" style={{ color: note.startsWith("✓") ? "#60d394" : "var(--muted)" }}>{note}</p>
            )}
            {addedNote && !adding && (
              <p className="mt-2 text-[11px] text-[var(--accent)] label-mono">◈ {addedNote}</p>
            )}
          </div>

          {/* 資料一覧 — 番号は回答の出典 [1][2] と一致する */}
          {docs.length > 0 && (
            <div className="panel p-3">
              <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">
                資料 — SOURCES（{docs.length}件）
              </div>
              <div className="flex flex-col gap-1">
                {docs.map((d) => (
                  <div key={d.title} className="flex items-center gap-2 rounded-forge border border-panel px-2 py-1.5">
                    <span className="shrink-0 text-[10px] text-[var(--accent)] label-mono">[{d.n}]</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={d.title}>{d.title}</span>
                    <span className="shrink-0 text-[9px] text-muted label-mono">{d.chars.toLocaleString()}字</span>
                    <button type="button" onClick={() => void removeDoc(d.title)}
                      aria-label={`資料「${d.title}」を削除`}
                      className="shrink-0 rounded-md border border-panel px-1.5 text-[10px] text-muted transition hover:text-[#ff9b9b]">✕</button>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                この番号が回答の出典 [1][2] と対応します。
              </p>
            </div>
          )}

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
                <Markdown text={answer.answer} />

                {/* 出典 — 回答が [1] のように引用した資料を明示する。
                    引用が無い場合も「どの資料を見たか」は示す（NotebookLM流）。 */}
                {answer.sources.length > 0 && (
                  <div className="mt-3 rounded-forge border border-panel p-2.5">
                    <div className="mb-1.5 text-[9px] tracking-[0.16em] text-muted label-mono">
                      出典{answer.cited.length ? `（${answer.cited.length}件を引用）` : "（引用なし）"}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {answer.sources.map((s) => {
                        const used = answer.cited.includes(s.n);
                        return (
                          <span key={s.n}
                            className="rounded-full border px-2 py-0.5 text-[10px]"
                            style={{
                              borderColor: used ? "var(--accent)" : "var(--panel-bd)",
                              color: used ? "var(--fg-strong)" : "var(--muted)",
                            }}>
                            [{s.n}] {s.title}
                          </span>
                        );
                      })}
                    </div>
                    {answer.partial && (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                        ※ 資料が多いため、質問に関係する箇所を選んで参照しました（全文ではありません）。
                      </p>
                    )}
                    {answer.cited.length === 0 && (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                        ※ 回答に出典番号が付いていません。資料に根拠が無い内容が含まれている可能性があります。
                      </p>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    try { void navigator.clipboard?.writeText(answer.answer); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
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
