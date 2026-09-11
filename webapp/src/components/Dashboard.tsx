"use client";

/**
 * Dashboard — BOARD モード：Miro風ホワイトボード + ノーコード自動化（Zapier風）.
 *
 * タブ構成:
 *  - WHITEBOARD（既定）… 付箋・接続・パン/ズームの無限キャンバス（Whiteboard.tsx）
 *  - AUTOMATION … 「トリガー → ステップ」のフローをカードで組み立てるビルダー
 */

import { motion, AnimatePresence } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import {
  automationsList,
  automationsCreate,
  automationsDelete,
  automationsRun,
  evolvePropose,
  type Automation,
  type AutomationStep,
  type StepType,
  type AutomationRunResult,
} from "@/lib/api";
import Tilt3D from "@/components/Tilt3D";
import NeedsNotice from "@/components/NeedsNotice";
import PendingApprovals from "@/components/PendingApprovals";
import Whiteboard from "@/components/Whiteboard";
import FlowBuilder from "@/components/FlowBuilder";
import StepRunnersNote from "@/components/StepRunnersNote";
import { STEP_META } from "@/lib/flowSteps";


// Miro/Zapier-style template chips — quick-start automations.
const TEMPLATES = [
  "毎朝トレンドを要約してLINEに通知する",
  "問い合わせ内容を整理してタスク化する",
  "週次レポートを自動生成する",
  "テーマからSNS投稿案を作る",
  "アイデアを出して箇条書きに整理する",
];

export default function Dashboard() {
  const [tab, setTab] = useState<"board" | "auto">("board");

  // Restore the last tab (whiteboard is the default).
  useEffect(() => {
    try {
      if (localStorage.getItem("forge_board_tab") === "auto") setTab("auto");
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("forge_board_tab", tab); } catch { /* ignore */ }
  }, [tab]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Tab bar */}
      <div className="flex items-center gap-1.5">
        {([
          { key: "board", label: "⊞ WHITEBOARD" },
          { key: "auto", label: "⚡ AUTOMATION" },
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className="rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.16em] transition label-mono"
            style={{
              borderColor: tab === t.key ? "var(--accent)" : "var(--panel-bd)",
              color: tab === t.key ? "var(--fg-strong)" : "var(--muted)",
              background: tab === t.key ? "var(--btn-bg)" : "transparent",
              boxShadow: tab === t.key ? "0 0 10px var(--glow)" : "none",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 「先に設定が必要です」は、AIを使うこちらのタブにだけ出す。
          ホワイトボードは鍵が無くても最後まで使えるので、画面の頭に
          出していると、使える物を使えないと言うことになる。 */}
      {tab === "auto" && <NeedsNotice mode="board_auto" />}
      {/* 通知は届かないことがある（切っている・許可していない・圏外）。
          そのとき通知だけが窓口だと「止まっていることが誰にも伝わらない」
          に戻るので、開けば必ず見える所にも出す。 */}
      {tab === "auto" && <PendingApprovals />}

      <div className="min-h-0 flex-1">
        {tab === "board" ? <Whiteboard /> : <AutomationBoard />}
      </div>
    </div>
  );
}

function AutomationBoard() {
  const [flows, setFlows] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Zapier-copilot style natural-language creation
  const [nl, setNl] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [nlNote, setNlNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFlows(await automationsList());
      setError(null);
    } catch {
      setError("バックエンド未接続です。自動化はバックエンド接続後に利用できます。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Natural language → automation (via the evolve engine, with a safe fallback).
  const createFromNL = async (text: string) => {
    const wish = text.trim();
    if (!wish || nlBusy) return;
    setNlBusy(true);
    setNlNote(null);
    setError(null);
    try {
      let name = wish.slice(0, 32);
      let steps: AutomationStep[] = [{ type: "ai_generate", name: "AI生成", params: { prompt: wish + "\n\n対象: {input}" } }];
      try {
        const p = await evolvePropose(wish);
        if (p.type === "automation" && Array.isArray((p.params as { steps?: unknown }).steps)) {
          steps = (p.params as { steps: AutomationStep[] }).steps;
          name = String((p.params as { name?: string }).name || name);
        }
      } catch {
        /* evolve unavailable → keep the single-step fallback */
      }
      const f = await automationsCreate(name, steps);
      setFlows((prev) => [f, ...prev]);
      setNl("");
      setNlNote(`「${f.name}」を作成しました（${f.steps.length} ステップ）。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "自動化の作成に失敗しました（バックエンド未接続の可能性）");
    } finally {
      setNlBusy(false);
    }
  };

  return (
    <div className="relative h-full min-h-0 overflow-y-auto pb-4">
      <StepRunnersNote current="automation" />
      {/* Miro-style canvas backdrop */}
      <div aria-hidden className="forge-grid pointer-events-none absolute inset-0 opacity-50" />

      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col gap-4 pt-1">
        {/* Zapier-copilot style creation hero (subtle 3D tilt) */}
        <Tilt3D className="mx-auto w-full max-w-3xl" max={3}>
        <div className="glass-silver w-full p-5 text-center">
          <div className="mb-1 flex items-center justify-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-full border border-[var(--line)] text-[var(--accent)]"><SparkIcon /></span>
            <span className="text-[10px] tracking-[0.24em] text-muted label-mono">AUTOMATION COPILOT</span>
          </div>
          <h2 className="label-mono text-glow text-sm text-fg-strong">何を自動化しますか？</h2>

          <div className="mt-3 flex items-end gap-2 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] p-2 text-left focus-within:border-[var(--line)]">
            <textarea
              value={nl}
              onChange={(e) => setNl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.shiftKey) { e.preventDefault(); void createFromNL(nl); } }}
              rows={2}
              placeholder="やりたいことを自然言語で…（例：毎朝ニュースを要約してLINEに送る）"
              className="min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void createFromNL(nl)}
              disabled={nlBusy || !nl.trim()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[var(--btn-bg)] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40"
              aria-label="Create automation"
            >
              {nlBusy ? "…" : "↑"}
            </button>
          </div>

          {/* Template chips (Miro-style quick starts) */}
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {TEMPLATES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setNl(t)}
                className="rounded-full border border-panel px-3 py-1.5 text-[11px] text-muted transition hover:border-[var(--line)] hover:text-fg-strong"
              >
                {t}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={() => setShowForm((s) => !s)}
              className="text-[10px] tracking-[0.16em] text-[var(--accent)] hover:underline label-mono"
            >
              {showForm ? "▲ ビルダーを閉じる" : "⊞ 手動ビルダーで細かく作る"}
            </button>
          </div>

          {nlNote && <p className="mt-2 text-[11px] text-[var(--accent)] label-mono">◈ {nlNote}</p>}
          {error && <p className="mt-2 text-[11px] text-[#ff9b9b]">⚠️ {error}</p>}
        </div>
        </Tilt3D>

        {/* Manual builder (Zapier step editor) */}
        <AnimatePresence>
          {showForm && (
            <motion.div
              className="mx-auto w-full max-w-3xl"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
            >
              <FlowBuilder
                target="automation"
                onCreated={(f) => { setFlows((p) => [f as Automation, ...p]); setShowForm(false); }}
                onError={setError}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Created automations — cards on the canvas */}
        {loading ? (
          <motion.div className="mx-auto max-w-3xl panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
            ◈ LOADING BOARD…
          </motion.div>
        ) : flows.length === 0 ? (
          <div className="mx-auto max-w-3xl rounded-forge border border-dashed border-panel p-6 text-center text-[11px] tracking-[0.18em] text-muted/70 label-mono">
            まだ自動化はありません。上で作成すると、ここにカードで並びます。
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {flows.map((f) => (
              <FlowCard key={f.id} flow={f} onDelete={async () => {
                if (!window.confirm(`自動化「${f.name}」を削除しますか？`)) return;
                try { await automationsDelete(f.id); setFlows((p) => p.filter((x) => x.id !== f.id)); }
                catch { setError("削除に失敗しました（バックエンド未接続の可能性）"); }
              }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    </svg>
  );
}

function FlowCard({ flow, onDelete }: { flow: Automation; onDelete: () => void }) {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AutomationRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await automationsRun(flow.id, input));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "実行に失敗しました");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Tilt3D max={5}>
    <div className="panel p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-fg-strong">{flow.name}</span>
        <button type="button" onClick={() => void onDelete()} className="text-[10px] text-[#ff8888] label-mono">✕</button>
      </div>

      {/* Visual flow: trigger → steps */}
      <div className="mt-2 flex flex-col gap-1">
        <div className="rounded-forge border border-dashed border-panel px-2 py-1 text-center text-[9px] tracking-[0.16em] text-muted label-mono">⚡ TRIGGER</div>
        {(flow.steps || []).map((s) => (
          <div key={s.id ?? s.n}>
            <Connector />
            <div className="rounded-forge border border-panel px-2 py-1.5 text-[11px] text-fg" style={{ borderLeftColor: STEP_META[s.type]?.color ?? "var(--accent)", borderLeftWidth: 2 }}>
              <span className="text-[9px] tracking-[0.14em] text-muted label-mono">{STEP_META[s.type]?.label ?? s.type}</span>
              <div className="truncate text-[11px] text-fg">{s.params?.[STEP_META[s.type]?.field] ?? ""}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Run */}
      <div className="mt-2 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="入力（{input}に入る値）…"
          className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
        <button type="button" onClick={() => void run()} disabled={running} className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-4 text-[10px] tracking-[0.14em] text-fg-strong disabled:opacity-40 label-mono">
          {running ? "…" : "▶ RUN"}
        </button>
      </div>

      {err && <p className="mt-2 text-[11px] text-[#ff9b9b]">⚠️ {err}</p>}

      {result && (
        <div className="mt-2 flex flex-col gap-1">
          {result.results.map((r) => (
            <div key={r.step} className="rounded-forge border border-panel p-2" style={{ opacity: r.skipped ? 0.55 : 1 }}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[9px] label-mono" style={{ color: r.skipped ? "var(--muted)" : r.ok ? "#60d394" : "#ff6b6b" }}>
                  {r.skipped ? "–" : r.ok ? "✓" : "✕"}
                </span>
                <span className="text-[10px] tracking-[0.12em] text-muted label-mono">{r.name}</span>
                {/* 担当AI・根拠資料・分岐は AI STUDIO のワークフローと共通の機能 */}
                {r.ai && <span className="rounded-full border border-panel px-1.5 text-[9px] text-muted label-mono">◇ {r.ai}</span>}
                {r.knowledge && <span className="rounded-full border border-panel px-1.5 text-[9px] text-muted label-mono">▤ 資料あり</span>}
                {r.skipped && <span className="rounded-full border border-panel px-1.5 text-[9px] text-muted label-mono">スキップ</span>}
              </div>
              {r.reason && <p className="mt-1 text-[10px] text-muted">{r.reason}</p>}
              {r.warning && <p className="mt-1 text-[10px] text-[#ffcf8b]">⚠ {r.warning}</p>}
              {!r.skipped && r.output && <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-fg">{r.output.slice(0, 600)}</p>}
              {r.error && <p className="mt-1 text-[10px] text-[#ff9b9b]">{r.error}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
    </Tilt3D>
  );
}

function Connector() {
  return (
    <div className="flex justify-center" aria-hidden>
      <span className="h-3 w-px bg-[var(--accent)] opacity-40" />
    </div>
  );
}
