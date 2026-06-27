"use client";

/**
 * Dashboard — 視覚的プロジェクト設計 + ノーコード自動化（Miro / Zapier 風）.
 *
 * 「トリガー → ステップ → ステップ」のフローをカードで視覚的に組み立て、ノーコードで
 * 自動化を作成・実行する。各ステップの出力は {input} で次へ受け渡す。
 */

import { motion, AnimatePresence } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import {
  automationsList,
  automationsCreate,
  automationsDelete,
  automationsRun,
  type Automation,
  type AutomationStep,
  type StepType,
  type AutomationRunResult,
} from "@/lib/api";

const STEP_META: Record<StepType, { label: string; color: string; field: string; placeholder: string }> = {
  ai_generate: { label: "AI生成", color: "#00f3ff", field: "prompt", placeholder: "{input}を要約して…" },
  notify: { label: "通知", color: "#60d394", field: "message", placeholder: "完了しました: {input}" },
  create_task: { label: "タスク作成", color: "#ffd060", field: "title", placeholder: "タスク名…" },
};

export default function Dashboard() {
  const [flows, setFlows] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

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

  return (
    <div className="grid h-full min-h-0 gap-3 overflow-y-auto pb-2 lg:grid-cols-[26rem_1fr] lg:content-start">
      {/* ── Left: builder ── */}
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
        >
          {showForm ? "▲ CLOSE BUILDER" : "+ NEW AUTOMATION"}
        </button>

        <AnimatePresence>
          {showForm && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
              <FlowBuilder
                onCreated={(f) => { setFlows((p) => [f, ...p]); setShowForm(false); }}
                onError={setError}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}
      </div>

      {/* ── Right: automations ── */}
      <div className="flex min-h-0 flex-col gap-3">
        {loading ? (
          <motion.div className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
            ◈ LOADING BOARD…
          </motion.div>
        ) : flows.length === 0 ? (
          <div className="panel p-6 text-center text-[11px] tracking-[0.18em] text-muted label-mono">NO AUTOMATIONS YET</div>
        ) : (
          <div className="flex flex-col gap-3">
            {flows.map((f) => (
              <FlowCard key={f.id} flow={f} onDelete={async () => { await automationsDelete(f.id); setFlows((p) => p.filter((x) => x.id !== f.id)); }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FlowBuilder({ onCreated, onError }: { onCreated: (f: Automation) => void; onError: (e: string | null) => void }) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<AutomationStep[]>([{ type: "ai_generate", name: "AI生成", params: {} }]);
  const [saving, setSaving] = useState(false);

  const addStep = () => setSteps((p) => [...p, { type: "ai_generate", name: "AI生成", params: {} }]);
  const removeStep = (i: number) => setSteps((p) => p.filter((_, idx) => idx !== i));
  const updateType = (i: number, type: StepType) =>
    setSteps((p) => p.map((s, idx) => (idx === i ? { type, name: STEP_META[type].label, params: {} } : s)));
  const updateParam = (i: number, value: string) =>
    setSteps((p) => p.map((s, idx) => (idx === i ? { ...s, params: { [STEP_META[s.type].field]: value } } : s)));

  const create = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    onError(null);
    try {
      const f = await automationsCreate(name.trim(), steps);
      setName("");
      setSteps([{ type: "ai_generate", name: "AI生成", params: {} }]);
      onCreated(f);
    } catch (e) {
      onError(e instanceof Error ? e.message : "自動化の作成に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel p-3">
      <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">AUTOMATION NAME</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="例：毎朝のニュース要約 → LINE通知"
        className="mb-3 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
      />

      <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">STEPS</div>
      <div className="flex flex-col gap-1.5">
        {/* Trigger node (visual) */}
        <div className="rounded-forge border border-dashed border-panel px-3 py-1.5 text-center text-[10px] tracking-[0.16em] text-muted label-mono">
          ⚡ TRIGGER（手動 / cron）
        </div>
        {steps.map((s, i) => (
          <div key={i}>
            <Connector />
            <div className="rounded-forge border border-panel p-2" style={{ borderLeftColor: STEP_META[s.type].color, borderLeftWidth: 2 }}>
              <div className="mb-1.5 flex items-center gap-2">
                <select
                  value={s.type}
                  onChange={(e) => updateType(i, e.target.value as StepType)}
                  className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1 text-[11px] text-fg-strong focus:outline-none"
                >
                  {(Object.keys(STEP_META) as StepType[]).map((t) => (
                    <option key={t} value={t} className="bg-[#0a0e16]">{STEP_META[t].label}</option>
                  ))}
                </select>
                <span className="text-[9px] text-muted label-mono">STEP {i + 1}</span>
                {steps.length > 1 && (
                  <button type="button" onClick={() => removeStep(i)} className="ml-auto text-[11px] text-[#ff6b6b]">✕</button>
                )}
              </div>
              <input
                value={s.params?.[STEP_META[s.type].field] ?? ""}
                onChange={(e) => updateParam(i, e.target.value)}
                placeholder={STEP_META[s.type].placeholder}
                className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
              />
            </div>
          </div>
        ))}
      </div>

      <button type="button" onClick={addStep} className="mt-2 w-full rounded-forge border border-dashed border-panel py-1.5 text-[10px] tracking-[0.16em] text-muted hover:text-fg-strong label-mono">
        + ADD STEP
      </button>

      <button
        type="button"
        onClick={() => void create()}
        disabled={saving || !name.trim()}
        className="mt-2 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
      >
        {saving ? "SAVING…" : "CREATE AUTOMATION"}
      </button>
    </div>
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
            <div key={r.step} className="rounded-forge border border-panel p-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] label-mono" style={{ color: r.ok ? "#60d394" : "#ff6b6b" }}>{r.ok ? "✓" : "✕"}</span>
                <span className="text-[10px] tracking-[0.12em] text-muted label-mono">{r.name}</span>
              </div>
              {r.output && <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-fg">{r.output.slice(0, 600)}</p>}
              {r.error && <p className="mt-1 text-[10px] text-[#ff9b9b]">{r.error}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Connector() {
  return (
    <div className="flex justify-center" aria-hidden>
      <span className="h-3 w-px bg-[var(--accent)] opacity-40" />
    </div>
  );
}
