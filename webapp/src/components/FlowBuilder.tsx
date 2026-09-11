"use client";

/**
 * FlowBuilder — 「手順を並べる」ための唯一の編集画面.
 *
 * 以前は BOARD の自動化と AI STUDIO のワークフローで別々のフォームがあり、
 * 片方にだけ機能が付く状態だった（実行エンジンは flow_engine に統一済み）。
 * ここに1つだけ置いて、保存先を target で切り替える。
 *
 *   target="automation" … BOARD の自動化（トリガーで時刻実行もできる）
 *   target="workflow"   … AI STUDIO のワークフロー（手で回して結果を見る）
 *
 * ステップの形は共通（type / 内容 / 担当AI / 根拠資料 / 実行条件）。
 */

import { useEffect, useState } from "react";
import {
  automationsCreate, studioCreateWorkflow, scheduleAdd, studioListAIs, vaultList,
  type Automation, type AutomationStep, type StepType, type StudioWorkflow,
  type StudioAI, type VaultNotebook,
} from "@/lib/api";
import { STEP_META } from "@/lib/flowSteps";


function Connector() {
  return (
    <div className="flex justify-center" aria-hidden>
      <span className="h-3 w-px bg-[var(--accent)] opacity-40" />
    </div>
  );
}

export default function FlowBuilder({ target, onCreated, onError }: {
  /** 保存先。UIは同じで、作られる実体だけが変わる。 */
  target: "automation" | "workflow";
  onCreated: (f: Automation | StudioWorkflow) => void;
  onError: (e: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<AutomationStep[]>([{ type: "ai_generate", name: "AI生成", params: {} }]);
  const [saving, setSaving] = useState(false);
  // トリガー：手動 or 毎日この時刻（scheduler経由で実際に発火する）
  const [trigger, setTrigger] = useState<"manual" | "schedule">("manual");
  const [atTime, setAtTime] = useState("08:00");
  // ステップに割り当てる候補（AI STUDIO のカスタムAI / VAULT のノートブック）
  const [ais, setAis] = useState<StudioAI[]>([]);
  const [notebooks, setNotebooks] = useState<VaultNotebook[]>([]);

  useEffect(() => {
    let alive = true;
    studioListAIs().then((v) => { if (alive) setAis(v); }).catch(() => { /* 任意項目 */ });
    vaultList().then((v) => { if (alive) setNotebooks(v); }).catch(() => { /* 任意項目 */ });
    return () => { alive = false; };
  }, []);

  const addStep = () => setSteps((p) => [...p, { type: "ai_generate", name: "AI生成", params: {} }]);
  const removeStep = (i: number) => setSteps((p) => p.filter((_, idx) => idx !== i));
  const updateType = (i: number, type: StepType) =>
    setSteps((p) => p.map((s, idx) => (idx === i ? { type, name: STEP_META[type].label, params: {} } : s)));
  const updateParam = (i: number, value: string) =>
    setSteps((p) => p.map((s, idx) => (idx === i ? { ...s, params: { [STEP_META[s.type].field]: value } } : s)));
  /** 担当AI・根拠資料・条件（AI STUDIO のワークフローと共通の拡張）。 */
  const updateExtra = (i: number, key: "ai_id" | "notebook_id" | "when", value: string) =>
    setSteps((p) => p.map((s, idx) => (idx === i ? { ...s, [key]: value } : s)));

  const create = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    onError(null);
    try {
      let f: Automation | StudioWorkflow;
      if (target === "workflow") {
        // ワークフローは手で回して結果を見るもの。トリガーは持たせない。
        f = await studioCreateWorkflow(name.trim(), steps);
      } else {
        f = await automationsCreate(name.trim(), steps,
          trigger === "schedule" ? { type: "schedule" } : { type: "manual" });
        // 毎日実行は scheduler に登録して初めて発火する。
        // ここを繋いでいなかったので、これまで「毎朝〜」は動かなかった。
        if (trigger === "schedule") {
          try {
            await scheduleAdd("", atTime, "daily", f.id);
          } catch {
            onError("自動化は作成しましたが、定期実行の登録に失敗しました");
          }
        }
      }
      setName("");
      setSteps([{ type: "ai_generate", name: "AI生成", params: {} }]);
      setTrigger("manual");
      onCreated(f);
    } catch (e) {
      onError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel p-3">
      <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">{target === "workflow" ? "WORKFLOW NAME" : "AUTOMATION NAME"}</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={target === "workflow" ? "例：問い合わせ対応フロー" : "例：毎朝のニュース要約 → LINE通知"}
        className="mb-3 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
      />

      <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">STEPS</div>
      <div className="flex flex-col gap-1.5">
        {/* Trigger node (visual) */}
        {/* トリガー — 手動 / 毎日この時刻（自動化のみ） */}
        {target === "automation" && (
        <div className="rounded-forge border border-dashed border-panel px-3 py-2">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <span className="text-[10px] tracking-[0.16em] text-muted label-mono">⚡ TRIGGER</span>
            {([["manual", "手動で実行"], ["schedule", "毎日この時刻"]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTrigger(k)} aria-pressed={trigger === k}
                className="rounded-full border px-2.5 py-0.5 text-[10px] label-mono"
                style={{
                  borderColor: trigger === k ? "var(--accent)" : "var(--panel-bd)",
                  color: trigger === k ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {label}
              </button>
            ))}
            {trigger === "schedule" && (
              <input type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)}
                aria-label="実行時刻"
                className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-0.5 text-[11px] text-fg-strong focus:outline-none" />
            )}
          </div>
          {trigger === "schedule" && (
            <p className="mt-1 text-center text-[11px] leading-relaxed text-muted">
              バックエンドが動いている間、毎日この時刻に自動で実行して結果を通知します
            </p>
          )}
        </div>
        )}
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
                aria-label={`ステップ${i + 1}の内容`}
                inputMode={s.type === "fetch" ? "url" : undefined}
                className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
              />
              {STEP_META[s.type].hint && (
                <p className="mt-1 text-[10px] leading-relaxed text-muted">{STEP_META[s.type].hint}</p>
              )}

              {/* AI STUDIO のワークフローと共通の拡張。AI生成のステップだけ
                  担当AIと根拠資料が意味を持つので、そこだけ出す。 */}
              {s.type === "ai_generate" && (
                <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] tracking-[0.14em] text-muted label-mono">担当AI</span>
                    <select value={s.ai_id ?? ""} onChange={(e) => updateExtra(i, "ai_id", e.target.value)}
                      aria-label={`ステップ${i + 1}の担当AI`}
                      className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1 text-[11px] text-fg-strong focus:outline-none">
                      <option value="" className="bg-[#0a0e16]">指定なし</option>
                      {ais.map((a) => <option key={a.id} value={a.id} className="bg-[#0a0e16]">{a.name}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] tracking-[0.14em] text-muted label-mono">根拠資料（VAULT）</span>
                    <select value={s.notebook_id ?? ""} onChange={(e) => updateExtra(i, "notebook_id", e.target.value)}
                      aria-label={`ステップ${i + 1}の根拠資料`}
                      className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1 text-[11px] text-fg-strong focus:outline-none">
                      <option value="" className="bg-[#0a0e16]">使わない</option>
                      {notebooks.map((n) => <option key={n.id} value={n.id} className="bg-[#0a0e16]">{n.name}</option>)}
                    </select>
                  </label>
                </div>
              )}
              <label className="mt-1.5 flex flex-col gap-0.5">
                <span className="text-[9px] tracking-[0.14em] text-muted label-mono">実行する条件（空なら必ず実行）</span>
                <input value={s.when ?? ""} onChange={(e) => updateExtra(i, "when", e.target.value)}
                  aria-label={`ステップ${i + 1}の条件`}
                  placeholder="例：要約が3行を超えるとき"
                  className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1 text-[11px] text-fg-strong placeholder:text-muted focus:outline-none" />
              </label>
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
        {saving ? "SAVING…" : target === "workflow" ? "CREATE WORKFLOW" : "CREATE AUTOMATION"}
      </button>
    </div>
  );
}

