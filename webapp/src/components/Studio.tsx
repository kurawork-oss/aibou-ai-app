"use client";

/**
 * Studio — AI Studio (カスタムAI + ワークフロービルダー).
 * Mirrors the original Streamlit "AI Studio" room:
 *  - Create custom AI personas with name, persona, model, rules
 *  - Build multi-step workflows (chained prompts)
 *  - Execute workflows with input text
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { addToArchive } from "@/components/AppArchive";
import {
  studioListAIs,
  studioCreateAI,
  studioDeleteAI,
  studioListWorkflows,
  studioCreateWorkflow,
  studioDeleteWorkflow,
  studioRunWorkflow,
  evolvePropose,
  forgeGenerate,
  automationsCreate,
  type StudioAI,
  type StudioWorkflow,
  type WorkflowStep,
  type WorkflowResult,
  type EvolveProposal,
  type AutomationStep,
} from "@/lib/api";

type StudioTab = "ais" | "workflows" | "evolve";

const TAB_LABEL: Record<StudioTab, string> = {
  ais: "CUSTOM AI",
  workflows: "WORKFLOWS",
  evolve: "EVOLVE",
};

const MODELS = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
];

export default function Studio() {
  const [tab, setTab] = useState<StudioTab>("ais");

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-2">
      {/* Tab selector */}
      <div className="flex gap-2">
        {(["ais", "workflows", "evolve"] as StudioTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.18em] transition label-mono"
            style={{
              borderColor: tab === t ? "var(--accent)" : "var(--panel-bd)",
              color: tab === t ? "var(--fg-strong)" : "var(--muted)",
              boxShadow: tab === t ? "0 0 12px var(--glow)" : "none",
            }}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === "ais" && <AIsPanel />}
      {tab === "workflows" && <WorkflowsPanel />}
      {tab === "evolve" && <EvolvePanel />}
    </div>
  );
}

/* ─── Custom AIs Panel ─────────────────────────────────────────────── */

function AIsPanel() {
  const [ais, setAIs] = useState<StudioAI[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Form
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState("gemini-2.5-flash");
  const [rules, setRules] = useState("");
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAIs(await studioListAIs());
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await studioCreateAI({ name: name.trim(), persona, model, rules });
      setName(""); setPersona(""); setModel("gemini-2.5-flash"); setRules("");
      setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await studioDeleteAI(id);
      setAIs((prev) => prev.filter((a) => a.id !== id));
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setShowForm((v) => !v)}
        className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
      >
        {showForm ? "▲ COLLAPSE" : "+ NEW CUSTOM AI"}
      </button>

      <AnimatePresence>
        {showForm && (
          <motion.div
            className="panel p-3"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">AI NAME</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: Finance Advisor"
              className="mb-3 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
            />

            <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">MODEL</div>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mb-3 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong focus:outline-none"
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>

            <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">PERSONA</div>
            <textarea
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={2}
              placeholder="例: あなたは財務アドバイザーです。投資リスクを常に考慮してください。"
              className="mb-3 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
            />

            <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">RULES (任意)</div>
            <textarea
              value={rules}
              onChange={(e) => setRules(e.target.value)}
              rows={2}
              placeholder="例: 必ず箇条書きで回答する。数値は必ず出典を示す。"
              className="mb-3 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
            />

            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating || !name.trim()}
              className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition disabled:opacity-40 label-mono"
            >
              {creating ? "CREATING…" : "CREATE AI"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}

      {loading ? (
        <LoadingShimmer label="LOADING AIs…" />
      ) : ais.length === 0 ? (
        <EmptyState label="NO CUSTOM AIs YET" />
      ) : (
        <div className="flex flex-col gap-2">
          {ais.map((ai) => (
            <div key={ai.id} className="panel p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[13px] text-fg-strong">{ai.name}</div>
                  <div className="mt-0.5 text-[10px] tracking-[0.12em] text-muted label-mono">
                    {ai.model ?? "gemini-2.5-flash"}
                  </div>
                  {ai.persona && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-fg line-clamp-2">{ai.persona}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(ai.id)}
                  className="shrink-0 rounded px-2 py-1 text-[10px] text-[#ff6b6b] transition hover:text-[#ff9b9b] label-mono"
                >
                  DEL
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ─── Workflows Panel ──────────────────────────────────────────────── */

function WorkflowsPanel() {
  const [workflows, setWorkflows] = useState<StudioWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // Form
  const [wfName, setWfName] = useState("");
  const [steps, setSteps] = useState<WorkflowStep[]>([{ name: "Step 1", prompt: "" }]);

  // Run state
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runInput, setRunInput] = useState("");
  const [runResult, setRunResult] = useState<WorkflowResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setWorkflows(await studioListWorkflows());
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addStep = () => setSteps((prev) => [...prev, { name: `Step ${prev.length + 1}`, prompt: "" }]);
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, idx) => idx !== i));
  const updateStep = (i: number, field: keyof WorkflowStep, val: string) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: val } : s)));

  const handleCreate = async () => {
    if (!wfName.trim() || steps.some((s) => !s.prompt.trim())) return;
    setCreating(true);
    try {
      await studioCreateWorkflow(wfName.trim(), steps);
      setWfName(""); setSteps([{ name: "Step 1", prompt: "" }]); setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await studioDeleteWorkflow(id);
      setWorkflows((prev) => prev.filter((w) => w.id !== id));
    } catch { /* ignore */ }
  };

  const handleRun = async (wf: StudioWorkflow) => {
    setRunningId(wf.id);
    setRunResult(null);
    setRunError(null);
    try {
      const result = await studioRunWorkflow(wf.id, runInput);
      setRunResult(result);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "run failed");
    } finally {
      setRunningId(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setShowForm((v) => !v)}
        className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition label-mono"
      >
        {showForm ? "▲ COLLAPSE" : "+ NEW WORKFLOW"}
      </button>

      <AnimatePresence>
        {showForm && (
          <motion.div
            className="panel p-3"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">WORKFLOW NAME</div>
            <input
              value={wfName}
              onChange={(e) => setWfName(e.target.value)}
              placeholder="例: コンテンツ生成パイプライン"
              className="mb-3 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
            />

            <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">STEPS</div>
            {steps.map((step, i) => (
              <div key={i} className="mb-2 rounded-forge border border-panel p-2.5">
                <div className="mb-1 flex items-center gap-2">
                  <input
                    value={step.name ?? `Step ${i + 1}`}
                    onChange={(e) => updateStep(i, "name", e.target.value)}
                    className="flex-1 rounded border border-transparent bg-transparent text-[11px] text-fg-strong focus:outline-none"
                    placeholder={`Step ${i + 1}`}
                  />
                  {steps.length > 1 && (
                    <button type="button" onClick={() => removeStep(i)} className="text-[#ff6b6b] text-xs">✕</button>
                  )}
                </div>
                <textarea
                  value={step.prompt}
                  onChange={(e) => updateStep(i, "prompt", e.target.value)}
                  rows={2}
                  placeholder={i === 0 ? "プロンプト (例: {input}を要約してください)" : "プロンプト (前ステップの出力は{input}で参照可)"}
                  className="w-full resize-none rounded bg-black/20 px-2 py-1.5 text-[11px] text-fg-strong placeholder:text-muted focus:outline-none"
                />
              </div>
            ))}
            <div className="mb-3 flex gap-2">
              <button type="button" onClick={addStep} className="text-[10px] text-muted transition hover:text-fg-strong label-mono">
                + ADD STEP
              </button>
            </div>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating || !wfName.trim() || steps.some((s) => !s.prompt.trim())}
              className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition disabled:opacity-40 label-mono"
            >
              {creating ? "CREATING…" : "CREATE WORKFLOW"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}

      {/* Run input */}
      <div className="panel p-3">
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">WORKFLOW INPUT</div>
        <input
          value={runInput}
          onChange={(e) => setRunInput(e.target.value)}
          placeholder="ワークフローの入力テキスト（{input}で参照）…"
          className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
        />
      </div>

      {runError && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {runError}</div>}

      {runResult && (
        <div className="panel p-3">
          <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">RESULT: {runResult.workflow_name}</div>
          {runResult.results.map((r) => (
            <div key={r.step} className="mb-2 rounded-forge border border-panel p-2">
              <div className="mb-1 text-[9px] tracking-[0.15em] text-muted label-mono">STEP {r.step}: {r.name}</div>
              <p className="whitespace-pre-wrap text-[11px] text-fg">{r.output}</p>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <LoadingShimmer label="LOADING WORKFLOWS…" />
      ) : workflows.length === 0 ? (
        <EmptyState label="NO WORKFLOWS YET" />
      ) : (
        <div className="flex flex-col gap-2">
          {workflows.map((wf) => (
            <div key={wf.id} className="panel p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] text-fg-strong">{wf.name}</div>
                  <div className="text-[10px] text-muted">{wf.steps.length} step{wf.steps.length !== 1 ? "s" : ""}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleRun(wf)}
                    disabled={runningId === wf.id}
                    className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.15em] text-fg-strong transition disabled:opacity-40 label-mono"
                  >
                    {runningId === wf.id ? "▶ RUNNING…" : "▶ RUN"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(wf.id)}
                    className="rounded-forge border border-[#ff6b6b44] px-2.5 py-1.5 text-[10px] text-[#ff6b6b] transition hover:border-[#ff6b6b] label-mono"
                  >
                    DEL
                  </button>
                </div>
              </div>
              <div className="mt-2 flex gap-1.5 flex-wrap">
                {wf.steps.map((s, i) => (
                  <span key={i} className="rounded px-1.5 py-0.5 text-[9px] text-muted label-mono"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(197,198,199,0.15)" }}>
                    {s.name ?? `Step ${i + 1}`}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ─── Evolve Panel (self-evolution: chat → no-code build) ───────────── */

const EVOLVE_TYPE_LABEL: Record<string, string> = {
  app: "アプリ生成",
  custom_ai: "カスタムAI",
  automation: "自動化フロー",
  answer: "回答",
};

function EvolvePanel() {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<EvolveProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  const propose = async () => {
    if (!instruction.trim() || busy) return;
    setBusy(true);
    setError(null);
    setProposal(null);
    setApplied(null);
    try {
      setProposal(await evolvePropose(instruction.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "提案の生成に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!proposal || applying) return;
    setApplying(true);
    setError(null);
    try {
      const p = proposal.params as Record<string, unknown>;
      if (proposal.type === "app") {
        const r = await forgeGenerate("app", String(p.prompt ?? instruction));
        if (r.error) throw new Error(r.error);
        if (r.code) addToArchive(String(p.prompt ?? "Evolved App").slice(0, 40), String(p.prompt ?? ""), r.code, r.note);
        setApplied("アプリを生成し、ARCHIVE に保存しました。");
      } else if (proposal.type === "custom_ai") {
        await studioCreateAI({
          name: String(p.name ?? "Evolved AI"),
          persona: String(p.persona ?? ""),
          model: String(p.model ?? "gemini-2.5-flash"),
          rules: String(p.rules ?? ""),
        });
        setApplied("カスタムAIを作成しました。CUSTOM AI タブで確認できます。");
      } else if (proposal.type === "automation") {
        const steps = Array.isArray(p.steps) ? (p.steps as AutomationStep[]) : [];
        await automationsCreate(String(p.name ?? "Evolved Automation"), steps);
        setApplied("自動化フローを作成しました。BOARD タブで確認できます。");
      } else {
        setApplied("この要望は新規作成不要です（上の回答をご確認ください）。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "適用に失敗しました");
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <div className="panel p-3">
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">
          SELF-EVOLVE — チャットで指示 → ノーコードで自己拡張
        </div>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          placeholder="例：毎朝トレンドを要約してLINEに送る仕組みが欲しい / 経理担当の専用AIを作って / 在庫管理アプリが欲しい"
          className="mb-2 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void propose()}
          disabled={busy || !instruction.trim()}
          className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
        >
          {busy ? "THINKING…" : "✦ PROPOSE EVOLUTION"}
        </button>
      </div>

      {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}

      {proposal && (
        <div className="panel p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded px-2 py-0.5 text-[9px] tracking-[0.14em] label-mono" style={{ background: "rgba(0,243,255,0.12)", color: "var(--accent)" }}>
              {EVOLVE_TYPE_LABEL[proposal.type] ?? proposal.type}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-fg">{proposal.summary}</p>

          {proposal.type === "answer" ? (
            <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
              {String((proposal.params as Record<string, unknown>).text ?? "")}
            </p>
          ) : (
            <>
              <pre className="mt-2 max-h-48 overflow-auto rounded-forge bg-black/30 p-2 text-[10px] leading-relaxed text-muted">
                {JSON.stringify(proposal.params, null, 2)}
              </pre>
              <button
                type="button"
                onClick={() => void apply()}
                disabled={applying}
                className="mt-2 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
              >
                {applying ? "APPLYING…" : "⚡ APPLY — 適用して実体化"}
              </button>
            </>
          )}

          {applied && <p className="mt-2 text-[11px] text-[var(--accent)] label-mono">◈ {applied}</p>}
        </div>
      )}
    </>
  );
}

function LoadingShimmer({ label }: { label: string }) {
  return (
    <motion.div
      className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono"
      animate={{ opacity: [0.4, 1, 0.4] }}
      transition={{ duration: 1.4, repeat: Infinity }}
    >
      ◈ {label}
    </motion.div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="panel p-6 text-center text-[11px] tracking-[0.18em] text-muted label-mono">
      {label}
    </div>
  );
}
