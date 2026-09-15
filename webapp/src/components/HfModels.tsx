"use client";

/**
 * HfModels — Settings の「HF MODELS」タブ。
 *
 * HuggingFace には会話用モデルだけでなく、音声認識・画像生成・翻訳・分類など
 * 多種のモデルがある。ここで
 *   ① 探す（Hub検索）→ ② 台帳に登録 → ③ 実際に叩いて確認 → ④ 役割に割り当て
 * という流れで、アプリの各機能に差し込めるようにする。
 *
 * 正直さのための決まり
 *   ・タスクが機能に組み込まれていない場合は「お試し実行のみ」と明記する
 *     （登録したのに何も変わらない、を防ぐ）。
 *   ・「登録済み」と「実際に動いた（動作確認済み）」を別に表示する。
 *   ・エラーはHFの英語を丸投げせず、日本語の理由をそのまま出す。
 */

import { useCallback, useEffect, useState } from "react";

import {
  API_URL, hfAssign, hfModelAdd, hfModelDelete, hfModels, hfModelTest, hfRun, hfSearch,
  hfStatus, hfTest, type HfModel, type HfRunResult, type HfStatus,
} from "@/lib/api";

type SearchHit = { id: string; downloads: number; likes: number; task: string };

const SHORT = (model: string) => {
  const tail = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return tail.length > 22 ? `${tail.slice(0, 21)}…` : tail;
};

const fmtCount = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M`
  : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

export default function HfModels() {
  const [st, setSt] = useState<HfStatus | null>(null);
  const [models, setModels] = useState<HfModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>("");            // 実行中の操作キー

  // 追加フォーム
  const [openAdd, setOpenAdd] = useState(false);
  const [task, setTask] = useState("image");
  const [modelId, setModelId] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  // お試し実行
  const [openTry, setOpenTry] = useState(false);
  const [tryId, setTryId] = useState("");
  const [tryText, setTryText] = useState("");
  const [tryOut, setTryOut] = useState<HfRunResult | null>(null);

  const reload = useCallback(async () => {
    const [s, m] = await Promise.all([hfStatus(), hfModels()]);
    setSt(s);
    setModels(m);
  }, []);

  useEffect(() => {
    if (!API_URL) { setLoading(false); return; }
    reload().catch(() => setNote("⚠ HF設定を取得できませんでした")).finally(() => setLoading(false));
  }, [reload]);

  if (!API_URL) {
    return (
      <div className="rounded-forge border border-panel p-3 text-[11px] leading-relaxed text-muted">
        HuggingFaceのモデル登録は、バックエンド接続後に使えます（設定 →「しらべる」）。
      </div>
    );
  }
  if (loading) {
    return <div className="rounded-forge border border-panel p-3 text-center text-[10px] tracking-[0.2em] text-muted label-mono">◈ LOADING HF…</div>;
  }
  if (!st) {
    return <div className="rounded-forge border border-panel p-3 text-[11px] text-[#ff9b9b]">{note ?? "HF設定を取得できませんでした"}</div>;
  }

  const taskMeta = (key: string) => st.tasks.find((t) => t.key === key);
  const forTask = (key: string) => models.filter((m) => m.task === key);

  const doAssign = async (role: string, model: string) => {
    setBusy(`assign:${role}`);
    setNote(null);
    const res = await hfAssign(role, model);
    if (res.error) setNote(`⚠ ${res.error}`);
    else {
      setNote(model ? "✓ 割り当てました（次の実行から反映）" : "✓ 割り当てを外しました");
      await reload();
    }
    setBusy("");
  };

  const doSearch = async () => {
    setBusy("search");
    setHits(null);
    const res = await hfSearch(query, task, 10);
    if (res.error) {
      setNote(`⚠ ${res.error}`);
      // 検索できない環境でも選べるよう、内蔵の候補を出す
      setHits((st.suggested[task] ?? []).map((id) => ({ id, downloads: 0, likes: 0, task })));
    } else {
      setHits(res.models ?? []);
    }
    setBusy("");
  };

  const doTestDraft = async () => {
    if (!modelId.trim()) return;
    setBusy("testdraft");
    setTestResult(null);
    const res = await hfTest(modelId.trim(), task);
    setTestResult(res.ok ? `✓ 動きました：${res.sample || "OK"}` : `⚠ ${res.error ?? "失敗しました"}`);
    setBusy("");
  };

  const doAdd = async () => {
    if (!modelId.trim()) return;
    setBusy("add");
    setNote(null);
    const res = await hfModelAdd({ model: modelId.trim(), task });
    if (res.error) setNote(`⚠ ${res.error}`);
    else {
      setNote("✓ 台帳に登録しました");
      setModelId("");
      setTestResult(null);
      setHits(null);
      await reload();
    }
    setBusy("");
  };

  const doTest = async (m: HfModel) => {
    setBusy(`test:${m.id}`);
    setNote(null);
    const res = await hfModelTest(m.id);
    setNote(res.ok ? `✓ ${m.label}：動きました（${res.sample || "OK"}）`
      : `⚠ ${m.label}：${res.error ?? "失敗しました"}`);
    await reload();
    setBusy("");
  };

  const doDelete = async (m: HfModel) => {
    setBusy(`del:${m.id}`);
    const res = await hfModelDelete(m.id);
    const cleared = res.cleared_roles?.length ? `（${res.cleared_roles.join("・")}の割り当ても外しました）` : "";
    setNote(`✓ ${m.label} を削除しました${cleared}`);
    await reload();
    setBusy("");
  };

  const doRun = async () => {
    const m = models.find((x) => x.id === tryId);
    if (!m) return;
    setBusy("run");
    setTryOut(null);
    const labels = m.task === "classify"
      ? ["ポジティブ", "ネガティブ", "質問", "苦情"] : undefined;
    const res = await hfRun({ model: m.model, task: m.task, text: tryText, labels });
    setTryOut(res);
    setBusy("");
  };

  const tryModel = models.find((x) => x.id === tryId);

  return (
    <div className="min-w-0">
      {/* トークンの状態 */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">HF MODELS</span>
        <span className="text-[9px] tracking-[0.1em] label-mono"
              style={{ color: st.token_ready ? "#60d394" : "#ffd060" }}>
          ● {st.token_ready ? "TOKEN OK" : "TOKEN 未設定"}
        </span>
      </div>

      {!st.token_ready && (
        <div className="mb-3 rounded-forge border border-panel p-2.5 text-[10px] leading-relaxed text-[#ffd060]">
          KEYCHAIN の <span className="label-mono">HUGGINGFACE_TOKEN</span> を設定すると使えます。
          huggingface.co → Settings → Access Tokens で作れます（読み取り権限でOK）。
        </div>
      )}

      {/* ① 役割の割り当て */}
      <div className="mb-3 rounded-forge border border-panel p-3">
        <div className="mb-2 text-[9px] tracking-[0.16em] text-muted label-mono">役割への割り当て</div>
        <div className="grid gap-2">
          {st.roles.map((r) => {
            const list = forTask(r.task);
            const cur = st.assignments[r.key] ?? "";
            const curRow = models.find((m) => m.model === cur && m.task === r.task);
            return (
              <div key={r.key} className="min-w-0">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-[11px] text-fg-strong">{r.label}</span>
                  <span className="shrink-0 text-[9px] text-muted label-mono">{r.where}</span>
                </div>
                <select
                  aria-label={`${r.label}に使うモデル`}
                  value={cur}
                  onChange={(e) => void doAssign(r.key, e.target.value)}
                  disabled={busy !== "" || !st.token_ready}
                  className="w-full min-w-0 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong focus:outline-none disabled:opacity-40"
                >
                  <option value="" className="bg-[#0a0e16]">
                    {r.task === "text" ? "既定（自動）" : "使わない"}
                  </option>
                  {list.map((m) => (
                    <option key={m.id} value={m.model} className="bg-[#0a0e16]">
                      {SHORT(m.model)}{m.verified ? " ✓" : ""}
                    </option>
                  ))}
                  {cur && !curRow && (
                    <option value={cur} className="bg-[#0a0e16]">{SHORT(cur)}（台帳外）</option>
                  )}
                </select>
                {list.length === 0 && (
                  <p className="mt-0.5 text-[11px] text-muted">
                    {taskMeta(r.task)?.label}のモデルが未登録です（下の「＋ モデルを追加」から）
                  </p>
                )}
                {cur && curRow && !curRow.verified && (
                  <p className="mt-0.5 text-[11px] text-[#ffd060]">動作未確認のモデルです（テストで確認できます）</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ② 台帳 */}
      <div className="mb-3 rounded-forge border border-panel p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[9px] tracking-[0.16em] text-muted label-mono">登録モデル {models.length}</span>
          <button
            type="button"
            onClick={() => setOpenAdd((v) => !v)}
            className="rounded-forge border border-panel px-2 py-1 text-[9px] tracking-[0.08em] text-fg-strong label-mono"
          >
            {openAdd ? "閉じる" : "＋ モデルを追加"}
          </button>
        </div>

        {models.length === 0 && !openAdd && (
          <p className="text-[10px] leading-relaxed text-muted">
            まだ登録がありません。画像生成（FLUX等）や文字起こし（Whisper等）を追加すると、
            IMAGE STUDIO や CAPTURE でそのまま使えます。
          </p>
        )}

        <div className="grid gap-1.5">
          {models.map((m) => {
            const meta = taskMeta(m.task);
            return (
              <div key={m.id} className="min-w-0 rounded-forge border border-panel p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-forge border border-panel px-1.5 py-0.5 text-[8px] tracking-[0.08em] text-muted label-mono">
                    {meta?.label ?? m.task}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg-strong" title={m.model}>{m.model}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[11px]"
                        style={{ color: m.verified ? "#60d394" : m.last_error ? "#ff9b9b" : "var(--muted)" }}>
                    {m.verified ? "✓ 動作確認済み" : m.last_error ? `⚠ ${m.last_error}` : "動作未確認"}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => void doTest(m)}
                      disabled={busy !== "" || !st.token_ready}
                      className="rounded-forge border border-panel px-2 py-0.5 text-[9px] text-fg-strong label-mono disabled:opacity-30"
                    >
                      {busy === `test:${m.id}` ? "…" : "テスト"}
                    </button>
                    <button
                      type="button"
                      aria-label={`${m.label} を削除`}
                      onClick={() => void doDelete(m)}
                      disabled={busy !== ""}
                      className="rounded-forge border border-panel px-2 py-0.5 text-[9px] text-[#ff9b9b] label-mono disabled:opacity-30"
                    >
                      削除
                    </button>
                  </span>
                </div>
                {meta && !meta.wired && (
                  <p className="mt-1 text-[11px] text-muted">※ このタスクはお試し実行のみ（機能には未組み込み）</p>
                )}
              </div>
            );
          })}
        </div>

        {/* 追加フォーム */}
        {openAdd && (
          <div className="mt-3 min-w-0 border-t border-panel pt-3">
            <label className="mb-1 block text-[9px] tracking-[0.16em] text-muted label-mono">タスク</label>
            <select
              aria-label="追加するモデルのタスク"
              value={task}
              onChange={(e) => { setTask(e.target.value); setHits(null); setTestResult(null); }}
              className="mb-1 w-full min-w-0 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong focus:outline-none"
            >
              {st.tasks.map((t) => (
                <option key={t.key} value={t.key} className="bg-[#0a0e16]">{t.label}</option>
              ))}
            </select>
            <p className="mb-2 text-[11px] leading-relaxed text-muted">
              {taskMeta(task)?.note}
              {taskMeta(task)?.wired
                ? ` → ${taskMeta(task)?.wired} で使われます`
                : " → お試し実行のみ（まだ機能には組み込まれていません）"}
            </p>

            <label className="mb-1 block text-[9px] tracking-[0.16em] text-muted label-mono">モデルID</label>
            <input
              aria-label="モデルID"
              value={modelId}
              onChange={(e) => { setModelId(e.target.value); setTestResult(null); }}
              placeholder="例: black-forest-labs/FLUX.1-schnell"
              className="mb-1.5 w-full min-w-0 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong placeholder:text-muted focus:outline-none"
            />

            {/* Hub検索 */}
            <div className="mb-1.5 flex min-w-0 gap-1.5">
              <input
                aria-label="Hubでモデルを検索"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Hubを検索（例: whisper 日本語）"
                className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong placeholder:text-muted focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void doSearch()}
                disabled={busy !== ""}
                className="shrink-0 rounded-forge border border-panel px-2.5 py-1.5 text-[9px] text-fg-strong label-mono disabled:opacity-30"
              >
                {busy === "search" ? "…" : "検索"}
              </button>
            </div>

            {hits && (
              <div className="mb-2 grid max-h-40 gap-1 overflow-y-auto">
                {hits.length === 0 && <p className="text-[11px] text-muted">見つかりませんでした</p>}
                {hits.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => { setModelId(h.id); setTestResult(null); }}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-forge border border-panel px-2 py-1 text-left"
                  >
                    <span className="min-w-0 truncate text-[10px] text-fg-strong">{h.id}</span>
                    {h.downloads > 0 && (
                      <span className="shrink-0 text-[8px] text-muted label-mono">↓{fmtCount(h.downloads)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void doTestDraft()}
                disabled={busy !== "" || !modelId.trim() || !st.token_ready}
                title={!st.token_ready ? "HUGGINGFACE_TOKEN が未設定です" : "実際に1回叩いて確かめます"}
                className="flex-1 rounded-forge border border-panel px-2 py-1.5 text-[9px] text-fg-strong label-mono disabled:opacity-30"
              >
                {busy === "testdraft" ? "確認中…" : "動作テスト"}
              </button>
              <button
                type="button"
                onClick={() => void doAdd()}
                disabled={busy !== "" || !modelId.trim()}
                className="flex-1 rounded-forge border px-2 py-1.5 text-[9px] label-mono disabled:opacity-30"
                style={{ borderColor: "var(--accent)", color: "var(--fg-strong)", background: "var(--btn-bg)" }}
              >
                {busy === "add" ? "登録中…" : "台帳に登録"}
              </button>
            </div>
            {testResult && (
              <p className="mt-1.5 text-[10px] leading-relaxed"
                 style={{ color: testResult.startsWith("✓") ? "#60d394" : "#ff9b9b" }}>{testResult}</p>
            )}
          </div>
        )}
      </div>

      {/* ③ お試し実行 */}
      <div className="mb-2 rounded-forge border border-panel p-3">
        <div className="flex items-center justify-between">
          <span className="text-[9px] tracking-[0.16em] text-muted label-mono">お試し実行</span>
          <button
            type="button"
            onClick={() => setOpenTry((v) => !v)}
            className="rounded-forge border border-panel px-2 py-1 text-[9px] text-fg-strong label-mono"
          >
            {openTry ? "閉じる" : "開く"}
          </button>
        </div>

        {openTry && (
          <div className="mt-2 min-w-0">
            <select
              aria-label="お試しするモデル"
              value={tryId}
              onChange={(e) => { setTryId(e.target.value); setTryOut(null); }}
              className="mb-1.5 w-full min-w-0 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong focus:outline-none"
            >
              <option value="" className="bg-[#0a0e16]">モデルを選ぶ</option>
              {models.filter((m) => m.task !== "asr").map((m) => (
                <option key={m.id} value={m.id} className="bg-[#0a0e16]">
                  {SHORT(m.model)}（{taskMeta(m.task)?.label}）
                </option>
              ))}
            </select>
            {models.some((m) => m.task === "asr") && (
              <p className="mb-1.5 text-[11px] text-muted">
                ※ 文字起こしは音声が必要なので、CAPTUREモードで試してください
              </p>
            )}
            <textarea
              aria-label="お試しの入力"
              value={tryText}
              onChange={(e) => setTryText(e.target.value)}
              rows={2}
              placeholder={tryModel?.task === "image" ? "作りたい画像の説明（英語が得意なモデルもあります）" : "入力する文章"}
              className="mb-1.5 w-full min-w-0 resize-y rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong placeholder:text-muted focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void doRun()}
              disabled={busy !== "" || !tryId || !tryText.trim() || !st.token_ready}
              className="w-full rounded-forge border px-2 py-1.5 text-[9px] label-mono disabled:opacity-30"
              style={{ borderColor: "var(--accent)", color: "var(--fg-strong)", background: "var(--btn-bg)" }}
            >
              {busy === "run" ? "実行中…" : "実行"}
            </button>

            {tryOut && (
              <div className="mt-2 min-w-0 rounded-forge border border-panel p-2">
                {tryOut.error && <p className="text-[10px] leading-relaxed text-[#ff9b9b]">⚠ {tryOut.error}</p>}
                {tryOut.kind === "text" && (
                  <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg-strong">{tryOut.text}</p>
                )}
                {tryOut.kind === "image" && tryOut.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={tryOut.url} alt="生成結果" className="w-full rounded-forge" />
                )}
                {tryOut.kind === "labels" && (
                  <div className="grid gap-0.5">
                    {tryOut.labels?.map((l) => (
                      <div key={l.label} className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="min-w-0 truncate text-fg-strong">{l.label}</span>
                        <span className="shrink-0 text-muted label-mono">{Math.round(l.score * 100)}%</span>
                      </div>
                    ))}
                  </div>
                )}
                {tryOut.kind === "vector" && (
                  <p className="break-words text-[10px] text-muted">
                    {tryOut.dim}次元のベクトル：[{tryOut.head?.join(", ")} …]
                  </p>
                )}
                {tryOut.kind === "audio" && tryOut.audio_base64 && (
                  <audio controls className="w-full" src={`data:${tryOut.mime ?? "audio/flac"};base64,${tryOut.audio_base64}`} />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {note && (
        <p className="text-[10px] leading-relaxed"
           style={{ color: note.startsWith("⚠") ? "#ff9b9b" : "#60d394" }}>{note}</p>
      )}
    </div>
  );
}
