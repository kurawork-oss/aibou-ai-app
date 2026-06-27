"use client";

/**
 * Income — Mission Control. Enqueue a theme (AI generates multi-platform
 * metadata), then approve / reject the pending queue. FORGE OS look.
 */

import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import {
  incomeEnqueue,
  incomeJobs,
  incomeSetStatus,
  incomeSummary,
  type IncomeJob,
  type IncomeSummary,
} from "@/lib/api";

const STATUS_LABEL: Record<string, string> = {
  pending: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  completed: "完了",
  failed: "失敗",
};

export default function Income() {
  const [theme, setTheme] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<IncomeJob[]>([]);
  const [summary, setSummary] = useState<IncomeSummary>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [j, s] = await Promise.all([incomeJobs(undefined, 50), incomeSummary()]);
      setJobs(j);
      setSummary(s);
    } catch {
      /* offline / unconfigured → leave empty */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enqueue = async () => {
    if (!theme.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const job = await incomeEnqueue(theme.trim());
      if ((job as { error?: string }).error) setError((job as { error?: string }).error!);
      else {
        setTheme("");
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "enqueue failed");
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: "approve" | "reject") => {
    const ok = await incomeSetStatus(id, action);
    if (ok) await refresh();
  };

  const counts = ["pending", "approved", "rejected", "completed", "failed"] as const;

  return (
    <div className="grid h-full min-h-0 gap-3 overflow-y-auto pb-2 lg:grid-cols-[24rem_1fr] lg:content-start">
      {/* ── Left: KPI + enqueue ── */}
      <div className="flex flex-col gap-3">
      {/* KPI row */}
      <div className="grid grid-cols-5 gap-2">
        {counts.map((c) => (
          <div key={c} className="panel px-1 py-2 text-center">
            <div className="text-base font-semibold text-fg-strong">{(summary as Record<string, number>)[c] ?? 0}</div>
            <div className="text-[8px] tracking-[0.12em] text-muted label-mono">{STATUS_LABEL[c]}</div>
          </div>
        ))}
      </div>

      {/* Enqueue */}
      <div className="panel p-3">
        <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">NEW THEME</label>
        <div className="flex gap-2">
          <input
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && enqueue()}
            placeholder="例：在宅ワークの集中BGM"
            className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
          />
          <button
            type="button"
            onClick={enqueue}
            disabled={busy || !theme.trim()}
            className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-4 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
          >
            {busy ? "…" : "投入"}
          </button>
        </div>
        {busy && (
          <motion.p
            className="mt-2 text-[11px] tracking-[0.18em] text-muted label-mono"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.4, repeat: Infinity }}
          >
            ◈ 各媒体メタデータを生成中…
          </motion.p>
        )}
        {error && <p className="mt-2 text-xs text-[#ff9b9b]">⚠️ {error}</p>}
      </div>
      </div>

      {/* ── Right: approval queue ── */}
      <div className="flex min-h-0 flex-col gap-2">
        {loading && <div className="panel p-3 text-center text-xs text-muted">読み込み中…</div>}
        {!loading && jobs.length === 0 && (
          <div className="panel p-4 text-center text-xs text-muted">
            ジョブはまだありません。上でテーマを投入すると、承認待ちに積まれます。
            <br />
            <span className="text-[10px] text-muted/70">（Supabase未接続の場合はここに表示されません）</span>
          </div>
        )}
        {jobs.map((job, i) => (
          <JobCard key={job.id || i} job={job} onAct={act} />
        ))}
      </div>
    </div>
  );
}

function JobCard({
  job,
  onAct,
}: {
  job: IncomeJob;
  onAct: (id: string, action: "approve" | "reject") => void;
}) {
  const [open, setOpen] = useState(false);
  const status = (job.status || "").toLowerCase();
  const payload = (job.payload || {}) as Record<string, { title_en?: string; title?: string; markdown?: string }>;

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-fg-strong">{job.theme || "(no theme)"}</div>
          <div className="text-[10px] tracking-[0.14em] text-muted label-mono">{STATUS_LABEL[status] || status}</div>
        </div>
        {status === "pending" && job.id && (
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => onAct(job.id!, "approve")}
              className="rounded-md border border-[var(--line)] px-2.5 py-1 text-[10px] text-fg-strong transition hover:shadow-glow label-mono"
            >
              ✓ 承認
            </button>
            <button
              type="button"
              onClick={() => onAct(job.id!, "reject")}
              className="rounded-md border border-panel px-2.5 py-1 text-[10px] text-muted transition hover:text-fg-strong label-mono"
            >
              ✕ 却下
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 text-[10px] tracking-[0.14em] text-muted transition hover:text-fg-strong label-mono"
      >
        {open ? "▲ 閉じる" : "▼ 生成内容を見る"}
      </button>

      {open && (
        <div className="mt-2 space-y-2 text-[11px] text-fg">
          {payload.shutterstock && (
            <div className="rounded-forge bg-black/30 p-2">
              <span className="text-muted">Shutterstock:</span> {payload.shutterstock.title_en}
            </div>
          )}
          {payload.youtube && (
            <div className="rounded-forge bg-black/30 p-2">
              <span className="text-muted">YouTube:</span> {payload.youtube.title}
            </div>
          )}
          {payload.note?.markdown && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-forge bg-black/30 p-2">
              {payload.note.markdown}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
