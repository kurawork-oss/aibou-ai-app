"use client";

/**
 * Tasks — プロジェクト管理（Active Tasks）.
 *  - LIST / KANBAN の2ビュー（カンバンはドラッグ&ドロップでステータス変更）
 *  - 優先度（high/mid/low）・期限（due）・プロジェクト（グループ）
 *  - プロジェクトフィルタ / ステータスフィルタ
 *  - ワンタップ完了 ⇄ 5秒アンドゥ
 */

import { motion, AnimatePresence } from "framer-motion";
import { useRef, useEffect, useState, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { listTasks, createTask, updateTask, deleteTask, type Task } from "@/lib/api";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "PENDING", color: "#8b8f97" },
  in_progress: { label: "IN PROGRESS", color: "#00f3ff" },
  awaiting_approval: { label: "AWAITING APPROVAL", color: "#ffd060" },
  completed: { label: "COMPLETED", color: "#60d394" },
  cancelled: { label: "CANCELLED", color: "#ff6b6b" },
};

const KANBAN_COLS: { key: Task["status"]; label: string }[] = [
  { key: "pending", label: "PENDING" },
  { key: "in_progress", label: "IN PROGRESS" },
  { key: "awaiting_approval", label: "AWAITING" },
  { key: "completed", label: "DONE" },
];

const PRIORITY_META: Record<string, { label: string; color: string }> = {
  high: { label: "高", color: "#ff6b6b" },
  mid: { label: "中", color: "#ffd060" },
  low: { label: "低", color: "#60d394" },
};

const FILTER_TABS = [
  { key: "", label: "ALL" },
  { key: "pending", label: "PENDING" },
  { key: "in_progress", label: "ACTIVE" },
  { key: "awaiting_approval", label: "AWAITING" },
  { key: "completed", label: "DONE" },
];

function isOverdue(due?: string): boolean {
  if (!due) return false;
  try { return due < new Date().toISOString().slice(0, 10); } catch { return false; }
}

/** Small badges: priority dot / due date / project tag (shared by both views). */
function TaskBadges({ task }: { task: Task }) {
  const pr = PRIORITY_META[task.priority || "mid"];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[9px] label-mono" style={{ color: pr.color }} title={`優先度: ${pr.label}`}>
        ● {pr.label}
      </span>
      {task.due && (
        <span
          className="rounded px-1 py-0.5 text-[9px] label-mono"
          style={{
            color: isOverdue(task.due) && task.status !== "completed" ? "#ff6b6b" : "var(--muted)",
            border: `1px solid ${isOverdue(task.due) && task.status !== "completed" ? "#ff6b6b66" : "var(--panel-bd)"}`,
          }}
          title="期限"
        >
          ⏱ {task.due.slice(5)}
        </span>
      )}
      {task.project && (
        <span className="rounded px-1 py-0.5 text-[9px] text-[var(--accent)] label-mono" style={{ border: "1px solid rgba(0,243,255,0.3)" }}>
          {task.project}
        </span>
      )}
    </span>
  );
}

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [view, setView] = useState<"list" | "kanban">("list");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newPriority, setNewPriority] = useState("mid");
  const [newDue, setNewDue] = useState("");
  const [newProject, setNewProject] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [responseText, setResponseText] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Restore the preferred view (list is the default).
  useEffect(() => {
    try {
      const v = localStorage.getItem("forge_tasks_view");
      if (v === "kanban") setView("kanban");
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("forge_tasks_view", view); } catch { /* ignore */ }
  }, [view]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await listTasks(view === "kanban" ? undefined : filter || undefined);
      setTasks(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, [filter, view]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      await createTask(newTitle.trim(), newContent.trim(), "pending", {
        priority: newPriority,
        due: newDue,
        project: newProject.trim(),
      });
      setNewTitle("");
      setNewContent("");
      setNewDue("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setCreating(false);
    }
  };

  const handleStatusChange = async (id: string, status: string) => {
    setUpdatingId(id);
    try {
      await updateTask(id, { status });
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: status as Task["status"] } : t)));
    } catch {
      /* ignore */
    } finally {
      setUpdatingId(null);
    }
  };

  // ワンタップ完了 ⇄ 未完了。誤タップは5秒間の「元に戻す」で救済。
  const [undo, setUndo] = useState<{ id: string; prev: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickToggle = async (task: Task) => {
    const next = task.status === "completed" ? "pending" : "completed";
    await handleStatusChange(task.id, next);
    if (next === "completed") {
      setUndo({ id: task.id, prev: task.status });
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), 5000);
    } else {
      setUndo(null);
    }
  };
  const doUndo = async () => {
    if (!undo) return;
    await handleStatusChange(undo.id, undo.prev);
    setUndo(null);
  };

  const handleResponse = async (id: string) => {
    if (!responseText.trim()) return;
    setUpdatingId(id);
    try {
      await updateTask(id, { response: responseText.trim(), status: "in_progress" });
      setResponseText("");
      setExpanded(null);
      await load();
    } catch {
      /* ignore */
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("このタスクを削除しますか？（元に戻せません）")) return;
    setUpdatingId(id);
    try {
      await deleteTask(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch {
      /* ignore */
    } finally {
      setUpdatingId(null);
    }
  };

  const projects = Array.from(new Set(tasks.map((t) => t.project).filter(Boolean))) as string[];
  const visible = projectFilter ? tasks.filter((t) => t.project === projectFilter) : tasks;

  const counts = tasks.reduce(
    (acc, t) => {
      const s = t.status || "pending";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className={`grid h-full min-h-0 gap-3 overflow-y-auto pb-2 lg:content-start ${view === "list" ? "lg:grid-cols-[22rem_1fr]" : ""}`}>
      {/* ── Left column: KPI + new task + filters ── */}
      <div className={`flex flex-col gap-3 ${view === "kanban" ? "lg:flex-row lg:flex-wrap lg:items-start" : ""}`}>
      {/* KPI row */}
      <div className={`grid grid-cols-4 gap-2 ${view === "kanban" ? "lg:w-80" : ""}`}>
        {[
          { key: "pending", label: "PENDING" },
          { key: "in_progress", label: "ACTIVE" },
          { key: "awaiting_approval", label: "AWAITING" },
          { key: "completed", label: "DONE" },
        ].map((s) => (
          <div key={s.key} className="panel p-2 text-center">
            <div className="text-[18px] font-bold text-fg-strong">{counts[s.key] ?? 0}</div>
            <div className="text-[9px] tracking-[0.15em] text-muted label-mono">{s.label}</div>
          </div>
        ))}
      </div>

      {/* New Task Form */}
      <div className={`panel p-3 ${view === "kanban" ? "lg:min-w-[24rem] lg:flex-1" : ""}`}>
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">NEW TASK</div>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && !e.shiftKey && void handleCreate()}
          placeholder="タスクのタイトル…"
          className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          rows={2}
          placeholder="詳細（任意）…"
          className="mb-2 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
        {/* Priority / due / project */}
        <div className="mb-2 flex gap-2">
          <select
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value)}
            aria-label="優先度"
            className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-fg-strong focus:outline-none"
          >
            <option value="high" className="bg-[#0a0e16]">優先度 高</option>
            <option value="mid" className="bg-[#0a0e16]">優先度 中</option>
            <option value="low" className="bg-[#0a0e16]">優先度 低</option>
          </select>
          <input
            type="date"
            value={newDue}
            onChange={(e) => setNewDue(e.target.value)}
            aria-label="期限"
            className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-fg-strong focus:outline-none"
          />
          <input
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            placeholder="プロジェクト"
            aria-label="プロジェクト"
            className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-fg-strong placeholder:text-muted focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !newTitle.trim()}
          className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
        >
          {creating ? "CREATING…" : "+ ADD TASK"}
        </button>
      </div>

      {/* View toggle + filter tabs */}
      <div className={`flex flex-wrap items-center gap-1.5 ${view === "kanban" ? "lg:w-full" : ""}`}>
        <div className="flex overflow-hidden rounded-forge border border-panel" role="tablist" aria-label="表示切替">
          {(["list", "kanban"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className="px-3 py-1 text-[10px] tracking-[0.14em] transition label-mono"
              style={{
                color: view === v ? "var(--fg-strong)" : "var(--muted)",
                background: view === v ? "var(--btn-bg)" : "transparent",
              }}
            >
              {v === "list" ? "☰ LIST" : "⊞ KANBAN"}
            </button>
          ))}
        </div>

        {view === "list" && FILTER_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setFilter(t.key)}
            className="rounded-forge border px-2.5 py-1 text-[10px] tracking-[0.16em] transition label-mono"
            style={{
              borderColor: filter === t.key ? "var(--accent)" : "var(--panel-bd)",
              color: filter === t.key ? "var(--fg-strong)" : "var(--muted)",
              boxShadow: filter === t.key ? "0 0 10px var(--glow)" : "none",
            }}
          >
            {t.label}
          </button>
        ))}

        {/* Project filter chips */}
        {projects.length > 0 && (
          <>
            <span className="ml-1 text-[9px] tracking-[0.14em] text-muted/60 label-mono">PROJECT:</span>
            <button
              type="button"
              onClick={() => setProjectFilter("")}
              className="rounded-full border px-2 py-0.5 text-[9px] label-mono"
              style={{ borderColor: !projectFilter ? "var(--accent)" : "var(--panel-bd)", color: !projectFilter ? "var(--fg-strong)" : "var(--muted)" }}
            >
              全て
            </button>
            {projects.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProjectFilter(projectFilter === p ? "" : p)}
                className="rounded-full border px-2 py-0.5 text-[9px] label-mono"
                style={{ borderColor: projectFilter === p ? "var(--accent)" : "var(--panel-bd)", color: projectFilter === p ? "var(--fg-strong)" : "var(--muted)" }}
              >
                {p}
              </button>
            ))}
          </>
        )}

        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded-forge border border-panel px-2.5 py-1 text-[10px] text-muted transition hover:text-fg-strong label-mono"
        >
          ↻
        </button>
      </div>

      {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}
      </div>

      {/* ── Right area: list or kanban ── */}
      {view === "kanban" ? (
        <KanbanBoard
          tasks={visible}
          loading={loading}
          onMove={(id, status) => void handleStatusChange(id, status)}
          onDelete={(id) => void handleDelete(id)}
        />
      ) : (
      <div className="flex min-h-0 flex-col gap-2">
      {loading ? (
        <motion.div
          className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.4, repeat: Infinity }}
        >
          ◈ LOADING TASKS…
        </motion.div>
      ) : visible.length === 0 ? (
        <div className="panel p-6 text-center text-[11px] tracking-[0.18em] text-muted label-mono">
          NO TASKS FOUND
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <AnimatePresence>
            {visible.map((task) => {
              const st = STATUS_LABELS[task.status] ?? STATUS_LABELS.pending;
              const isExpanded = expanded === task.id;
              return (
                <motion.div
                  key={task.id}
                  className="panel p-3"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.2 }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => void quickToggle(task)}
                      disabled={updatingId === task.id}
                      aria-label={task.status === "completed" ? "未完了に戻す" : "完了にする"}
                      className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition disabled:opacity-40"
                      style={{
                        borderColor: task.status === "completed" ? "#60d394" : "var(--input-bd)",
                        background: task.status === "completed" ? "rgba(96,211,148,0.18)" : "transparent",
                        color: "#60d394",
                      }}
                    >
                      {task.status === "completed" ? "✓" : ""}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[9px] tracking-[0.12em] label-mono"
                          style={{ background: `${st.color}22`, color: st.color, border: `1px solid ${st.color}44` }}
                        >
                          {st.label}
                        </span>
                        <span className={`truncate text-[13px] ${task.status === "completed" ? "text-muted line-through" : "text-fg-strong"}`}>{task.title}</span>
                        <TaskBadges task={task} />
                      </div>
                      {task.content && (
                        <p className="mt-1 text-[11px] leading-relaxed text-muted line-clamp-2">{task.content}</p>
                      )}
                      {task.response && (
                        <p className="mt-1 text-[11px] text-[#9fe7ff]">↳ {task.response}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => setExpanded(isExpanded ? null : task.id)}
                        className="rounded px-2 py-1 text-[10px] text-muted transition hover:text-fg-strong label-mono"
                      >
                        {isExpanded ? "▲" : "▼"}
                      </button>
                    </div>
                  </div>

                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-3 border-t border-panel pt-3">
                          {/* Status buttons */}
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {Object.entries(STATUS_LABELS).map(([key, { label, color }]) => (
                              <button
                                key={key}
                                type="button"
                                disabled={updatingId === task.id}
                                onClick={() => void handleStatusChange(task.id, key)}
                                className="rounded-forge px-2 py-0.5 text-[9px] tracking-[0.1em] transition label-mono"
                                style={{
                                  border: `1px solid ${task.status === key ? color : "rgba(197,198,199,0.2)"}`,
                                  color: task.status === key ? color : "var(--muted)",
                                  background: task.status === key ? `${color}18` : "transparent",
                                }}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          {/* Priority / due / project editors */}
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {Object.entries(PRIORITY_META).map(([key, meta]) => (
                              <button
                                key={key}
                                type="button"
                                onClick={() => { void updateTask(task.id, { priority: key }).then(load); }}
                                className="rounded-forge px-2 py-0.5 text-[9px] label-mono"
                                style={{
                                  border: `1px solid ${(task.priority || "mid") === key ? meta.color : "rgba(197,198,199,0.2)"}`,
                                  color: (task.priority || "mid") === key ? meta.color : "var(--muted)",
                                }}
                              >
                                優先度{meta.label}
                              </button>
                            ))}
                            <input
                              type="date"
                              defaultValue={task.due || ""}
                              onChange={(e) => { void updateTask(task.id, { due: e.target.value }).then(load); }}
                              aria-label="期限を変更"
                              className="rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-0.5 text-[10px] text-fg-strong focus:outline-none"
                            />
                          </div>
                          {/* Response input */}
                          <textarea
                            value={responseText}
                            onChange={(e) => setResponseText(e.target.value)}
                            rows={2}
                            placeholder="返答・メモを入力…"
                            className="mb-2 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => void handleResponse(task.id)}
                              disabled={!responseText.trim() || updatingId === task.id}
                              className="flex-1 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-1.5 text-[10px] tracking-[0.18em] text-fg-strong transition disabled:opacity-40 label-mono"
                            >
                              RESPOND
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDelete(task.id)}
                              disabled={updatingId === task.id}
                              className="rounded-forge border border-[#ff6b6b44] px-3 py-1.5 text-[10px] text-[#ff6b6b] transition hover:border-[#ff6b6b] label-mono"
                            >
                              DEL
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
      </div>
      )}

      {/* Undo toast — 5秒だけ表示 */}
      <AnimatePresence>
        {undo && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2"
          >
            <div className="flex items-center gap-3 rounded-full border border-panel bg-[rgba(16,20,28,0.92)] px-4 py-2 shadow-glow backdrop-blur">
              <span className="text-[11px] text-fg">タスクを完了にしました</span>
              <button type="button" onClick={() => void doUndo()} className="text-[10px] tracking-[0.14em] text-[var(--accent)] label-mono">元に戻す</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Kanban board (pointer-drag between status columns) ───────────── */
function KanbanBoard({
  tasks, loading, onMove, onDelete,
}: {
  tasks: Task[];
  loading: boolean;
  onMove: (id: string, status: string) => void;
  onDelete: (id: string) => void;
}) {
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; w: number } | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const dragTask = drag ? tasks.find((t) => t.id === drag.id) : null;

  const colFromPoint = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    return (el?.closest("[data-col]") as HTMLElement | null)?.dataset.col ?? null;
  };

  const onCardPointerDown = (e: ReactPointerEvent<HTMLDivElement>, task: Task) => {
    // 左ボタン/タッチのみ。✕ボタン等のクリックはドラッグにしない。
    if ((e.target as HTMLElement).closest("button")) return;
    const card = e.currentTarget;
    card.setPointerCapture(e.pointerId);
    const rect = card.getBoundingClientRect();
    setDrag({ id: task.id, x: e.clientX, y: e.clientY, w: rect.width });
  };

  const onCardPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    setOverCol(colFromPoint(e.clientX, e.clientY));
  };

  const onCardPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const col = colFromPoint(e.clientX, e.clientY);
    const t = tasks.find((x) => x.id === drag.id);
    if (col && t && col !== t.status) onMove(drag.id, col);
    setDrag(null);
    setOverCol(null);
  };

  if (loading) {
    return (
      <motion.div className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
        ◈ LOADING TASKS…
      </motion.div>
    );
  }

  return (
    <div className="relative grid min-h-0 grid-cols-2 items-start gap-2 lg:grid-cols-4">
      {KANBAN_COLS.map((col) => {
        const colTasks = tasks.filter((t) => t.status === col.key);
        const st = STATUS_LABELS[col.key];
        return (
          <div
            key={col.key}
            data-col={col.key}
            className="flex min-h-[14rem] flex-col gap-1.5 rounded-forge border p-2 transition"
            style={{
              borderColor: overCol === col.key && drag ? st.color : "var(--panel-bd)",
              background: overCol === col.key && drag ? `${st.color}0d` : "rgba(255,255,255,0.015)",
            }}
          >
            <div className="flex items-center justify-between px-1">
              <span className="text-[9px] tracking-[0.16em] label-mono" style={{ color: st.color }}>{col.label}</span>
              <span className="text-[9px] text-muted label-mono">{colTasks.length}</span>
            </div>
            {colTasks.length === 0 && (
              <div className="rounded-forge border border-dashed border-panel py-4 text-center text-[9px] tracking-[0.12em] text-muted/50 label-mono">
                ここにドラッグ
              </div>
            )}
            {colTasks.map((task) => (
              <div
                key={task.id}
                onPointerDown={(e) => onCardPointerDown(e, task)}
                onPointerMove={onCardPointerMove}
                onPointerUp={onCardPointerUp}
                className="cursor-grab touch-none select-none rounded-forge border border-panel bg-[rgba(10,14,22,0.75)] p-2 transition hover:border-[var(--line)]"
                style={{ opacity: drag?.id === task.id ? 0.35 : 1 }}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className={`min-w-0 flex-1 break-words text-[12px] leading-snug ${task.status === "completed" ? "text-muted line-through" : "text-fg"}`}>
                    {task.title}
                  </span>
                  <button type="button" onClick={() => onDelete(task.id)} aria-label="削除" className="shrink-0 text-[10px] text-[#ff8888]">✕</button>
                </div>
                <div className="mt-1">
                  <TaskBadges task={task} />
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {/* Drag ghost (follows the pointer) */}
      {drag && dragTask && (
        <div
          className="pointer-events-none fixed z-[60] rounded-forge border border-[var(--accent)] bg-[rgba(10,14,22,0.95)] p-2 shadow-glow"
          style={{ left: drag.x + 8, top: drag.y + 8, width: Math.min(drag.w, 240) }}
        >
          <span className="text-[12px] text-fg-strong">{dragTask.title}</span>
        </div>
      )}
    </div>
  );
}
