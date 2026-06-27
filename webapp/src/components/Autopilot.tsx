"use client";

/**
 * Autopilot — ゴール自動実行（オートパイロット）.
 *
 * ゴールを与えると Gemini がステップに分解し、1ステップずつ自動実行する。
 * 「自動実行」を押すとタブを開いている間ステップを連続実行し、完了/失敗時には
 * バックエンドの notify 経由でスマホ（LINE/Discord/Slack）へ通知する。
 */

import { motion, AnimatePresence } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  autopilotList,
  autopilotCreate,
  autopilotStep,
  autopilotDelete,
  type Mission,
} from "@/lib/api";

const STATUS_COLOR: Record<string, string> = {
  active: "#00f3ff",
  completed: "#60d394",
  failed: "#ff6b6b",
  paused: "#ffd060",
};

export default function Autopilot() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [goal, setGoal] = useState("");
  const [notify, setNotify] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const autoRef = useRef<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      setMissions(await autopilotList());
      setError(null);
    } catch {
      setError("バックエンド未接続です。オートパイロットはバックエンド接続後に利用できます。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!goal.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const m = await autopilotCreate(goal.trim(), notify);
      setGoal("");
      setMissions((prev) => [m, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ゴールの作成に失敗しました");
    } finally {
      setCreating(false);
    }
  };

  const updateMission = (m: Mission) =>
    setMissions((prev) => prev.map((x) => (x.id === m.id ? m : x)));

  const runOne = async (id: string) => {
    setRunningId(id);
    try {
      const r = await autopilotStep(id);
      if (r.mission) updateMission(r.mission);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : "ステップ実行に失敗しました");
      return null;
    } finally {
      setRunningId(null);
    }
  };

  // Auto-run: keep stepping until the mission completes/fails (while tab open).
  const autoRun = async (id: string) => {
    autoRef.current[id] = true;
    for (let i = 0; i < 12; i++) {
      if (!autoRef.current[id]) break;
      const r = await runOne(id);
      if (!r || r.done || r.error || r.mission?.status !== "active") break;
    }
    autoRef.current[id] = false;
  };

  const stopAuto = (id: string) => { autoRef.current[id] = false; };

  const remove = async (id: string) => {
    try {
      await autopilotDelete(id);
      setMissions((prev) => prev.filter((m) => m.id !== id));
    } catch { /* ignore */ }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-2">
      {/* Create mission */}
      <div className="panel p-3">
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">NEW MISSION — ゴールを設定</div>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
          placeholder="例：来週の新商品ローンチに向けたSNS投稿プランを作成して実行する"
          className="mb-2 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
        <label className="mb-2 flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="accent-[var(--accent)]" />
          <span className="text-[10px] tracking-[0.16em] text-muted label-mono">完了・失敗時にスマホへ通知（LINE/Discord/Slack）</span>
        </label>
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating || !goal.trim()}
          className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
        >
          {creating ? "DECOMPOSING…" : "+ SET GOAL & DECOMPOSE"}
        </button>
      </div>

      {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}

      {loading ? (
        <motion.div className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
          ◈ LOADING MISSIONS…
        </motion.div>
      ) : missions.length === 0 ? (
        <div className="panel p-6 text-center text-[11px] tracking-[0.18em] text-muted label-mono">NO MISSIONS YET</div>
      ) : (
        <div className="flex flex-col gap-2">
          {missions.map((m) => {
            const total = m.steps?.length || 0;
            const done = m.steps?.filter((s) => s.status === "done").length || 0;
            const isAuto = autoRef.current[m.id];
            return (
              <div key={m.id} className="panel p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-fg-strong">{m.goal}</div>
                    <div className="mt-0.5 text-[9px] tracking-[0.14em] label-mono" style={{ color: STATUS_COLOR[m.status] || "#8b8f97" }}>
                      {m.status.toUpperCase()} · {done}/{total} STEPS
                    </div>
                  </div>
                  <button type="button" onClick={() => void remove(m.id)} className="shrink-0 text-[10px] text-[#ff8888] label-mono">✕</button>
                </div>

                {/* Progress bar */}
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full transition-all" style={{ width: total ? `${(done / total) * 100}%` : "0%", background: STATUS_COLOR[m.status] || "var(--accent)" }} />
                </div>

                {/* Steps */}
                <div className="mt-2 flex flex-col gap-1.5">
                  {(m.steps || []).map((s) => (
                    <div key={s.n} className="rounded-forge border border-panel p-2">
                      <div className="flex items-center gap-2">
                        <StepDot status={s.status} />
                        <span className="text-[11px] text-fg-strong">{s.n}. {s.title}</span>
                      </div>
                      <AnimatePresence>
                        {s.result && (
                          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="mt-1.5 whitespace-pre-wrap pl-4 text-[11px] leading-relaxed text-muted">
                            {s.result}
                          </motion.p>
                        )}
                      </AnimatePresence>
                    </div>
                  ))}
                </div>

                {/* Controls */}
                {m.status === "active" && (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void runOne(m.id)}
                      disabled={runningId === m.id || isAuto}
                      className="flex-1 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-1.5 text-[10px] tracking-[0.16em] text-fg-strong disabled:opacity-40 label-mono"
                    >
                      {runningId === m.id ? "RUNNING…" : "▶ NEXT STEP"}
                    </button>
                    {isAuto ? (
                      <button type="button" onClick={() => stopAuto(m.id)} className="flex-1 rounded-forge border border-[#ffd06044] py-1.5 text-[10px] tracking-[0.16em] text-[#ffd060] label-mono">⏸ STOP AUTO</button>
                    ) : (
                      <button type="button" onClick={() => void autoRun(m.id)} className="flex-1 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-1.5 text-[10px] tracking-[0.16em] text-fg-strong label-mono">⏩ AUTO-RUN</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StepDot({ status }: { status: string }) {
  const color = status === "done" ? "#60d394" : status === "failed" ? "#ff6b6b" : "#6a6f77";
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color, boxShadow: status === "done" ? "0 0 6px #60d394" : "none" }} />;
}
