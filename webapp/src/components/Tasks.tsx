"use client";

/**
 * Tasks — Active Tasks management (アクティブタスク管理).
 * Mirrors the original Streamlit "Active Tasks" room:
 *  - View all tasks with status filters
 *  - Create new tasks
 *  - Update status / add response
 *  - Delete tasks
 */

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState, useCallback } from "react";
import { listTasks, createTask, updateTask, deleteTask, type Task } from "@/lib/api";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "PENDING", color: "#8b8f97" },
  in_progress: { label: "IN PROGRESS", color: "#00f3ff" },
  awaiting_approval: { label: "AWAITING APPROVAL", color: "#ffd060" },
  completed: { label: "COMPLETED", color: "#60d394" },
  cancelled: { label: "CANCELLED", color: "#ff6b6b" },
};

const FILTER_TABS = [
  { key: "", label: "ALL" },
  { key: "pending", label: "PENDING" },
  { key: "in_progress", label: "ACTIVE" },
  { key: "awaiting_approval", label: "AWAITING" },
  { key: "completed", label: "DONE" },
];

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [responseText, setResponseText] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await listTasks(filter || undefined);
      setTasks(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      await createTask(newTitle.trim(), newContent.trim());
      setNewTitle("");
      setNewContent("");
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

  const counts = tasks.reduce(
    (acc, t) => {
      const s = t.status || "pending";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="grid h-full min-h-0 gap-3 overflow-y-auto pb-2 lg:grid-cols-[22rem_1fr] lg:content-start">
      {/* ── Left column: KPI + new task + filters ── */}
      <div className="flex flex-col gap-3">
      {/* KPI row */}
      <div className="grid grid-cols-4 gap-2">
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
      <div className="panel p-3">
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">NEW TASK</div>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void handleCreate()}
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
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !newTitle.trim()}
          className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
        >
          {creating ? "CREATING…" : "+ ADD TASK"}
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        {FILTER_TABS.map((t) => (
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

      {/* ── Right column: task list ── */}
      <div className="flex min-h-0 flex-col gap-2">
      {loading ? (
        <motion.div
          className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.4, repeat: Infinity }}
        >
          ◈ LOADING TASKS…
        </motion.div>
      ) : tasks.length === 0 ? (
        <div className="panel p-6 text-center text-[11px] tracking-[0.18em] text-muted label-mono">
          NO TASKS FOUND
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <AnimatePresence>
            {tasks.map((task) => {
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
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[9px] tracking-[0.12em] label-mono"
                          style={{ background: `${st.color}22`, color: st.color, border: `1px solid ${st.color}44` }}
                        >
                          {st.label}
                        </span>
                        <span className="truncate text-[13px] text-fg-strong">{task.title}</span>
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
    </div>
  );
}
