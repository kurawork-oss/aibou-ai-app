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
  const [actingId, setActingId] = useState<string | null>(null);
  // Remember the guide's open/closed state across visits (default open until dismissed once).
  const [guideOpen, setGuideOpen] = useState(true);
  useEffect(() => {
    try { setGuideOpen(localStorage.getItem("forge_income_guide") !== "closed"); } catch { /* ignore */ }
  }, []);
  const toggleGuide = () => {
    setGuideOpen((v) => {
      try { localStorage.setItem("forge_income_guide", v ? "closed" : "open"); } catch { /* ignore */ }
      return !v;
    });
  };

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
    if (actingId) return; // ignore double-taps while one is in flight
    setActingId(id);
    try {
      const ok = await incomeSetStatus(id, action);
      if (ok) await refresh();
      else setError("更新に失敗しました（バックエンド接続を確認してください）");
    } catch {
      setError("更新に失敗しました（バックエンド接続を確認してください）");
    } finally {
      setActingId(null);
    }
  };

  const counts = ["pending", "approved", "rejected", "completed", "failed"] as const;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-2">
      {/* Setup guide — what YOU need to do to make the income pipeline run */}
      <IncomeSetupGuide open={guideOpen} onToggle={toggleGuide} />

      <div className="grid gap-3 lg:grid-cols-[24rem_1fr] lg:content-start">
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
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && enqueue()}
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
        <div className="flex items-center justify-between">
          <span className="text-[10px] tracking-[0.2em] text-muted label-mono">承認キュー</span>
          <button
            type="button"
            onClick={() => { setLoading(true); void refresh(); }}
            className="rounded-forge border border-panel px-2.5 py-1 text-[10px] tracking-[0.14em] text-muted transition hover:border-[var(--line)] hover:text-fg-strong label-mono"
            aria-label="Refresh jobs"
          >
            ↻ 更新
          </button>
        </div>
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
    </div>
  );
}

/* ── Income setup guide — "what you need to do" ─────────────────────── */
function IncomeSetupGuide({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="glass-silver p-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
      >
        <span className="text-[11px] tracking-[0.18em] text-fg-strong label-mono">
          ◈ 副業自動化セットアップ — あなたがやること
        </span>
        <span className="text-muted">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3 text-[12px] leading-relaxed text-fg">
          <p className="text-[11px] text-muted">
            このアプリは「生成→承認→各媒体へ配信」を半自動化します。実際に収益化を回すには、
            以下をあなたの環境で設定してください（上から順に。下に行くほど任意/段階的）。
          </p>

          <GuideStep n="1" title="基盤をつなぐ（必須）" color="#00f3ff">
            <li><b>Gemini APIキー</b>を取得 → <b>Settings → KEYCHAIN</b> に <code>GEMINI_API_KEY</code> を保存（記事・メタデータ生成の頭脳）</li>
            <li><b>Supabase</b> プロジェクトを作成し、SQLエディタで <code>supabase_schema.sql</code> を実行（ジョブの保存先）</li>
            <li><b>バックエンド(FastAPI)</b> を Cloud Run 等にデプロイし、<code>SUPABASE_URL</code> / <code>SUPABASE_SERVICE_KEY</code> を設定</li>
            <li>Vercel に <code>NEXT_PUBLIC_API_URL</code>（バックエンドURL）を設定 → アプリが「LINK ACTIVE」になります</li>
          </GuideStep>

          <GuideStep n="2" title="スマホ通知を設定（推奨）" color="#60d394">
            <li><b>LINE Notify</b> / Discord / Slack のトークン・Webhookを取得 → KEYCHAIN に
              <code>LINE_NOTIFY_TOKEN</code> / <code>DISCORD_WEBHOOK</code> / <code>SLACK_WEBHOOK</code></li>
            <li>夜間ジョブの「✅成功 / ❌失敗」がスマホに届き、朝の承認だけで回せます</li>
          </GuideStep>

          <GuideStep n="3" title="配信先アカウントを連携（段階的に）" color="#ffd060">
            <li><b>画像生成</b>: Leonardo.ai 等のAPIキー → KEYCHAIN <code>LEONARDO_API_KEY</code></li>
            <li><b>Shutterstock</b>: コントリビューター登録 → FTP情報を <code>SHUTTERSTOCK_FTP</code></li>
            <li><b>YouTube</b>: Google Cloud で <i>YouTube Data API v3</i> を有効化 → OAuth同意・リフレッシュトークン取得 → <code>YOUTUBE_API_KEY</code></li>
            <li><b>note</b>: ログイントークン → <code>NOTE_TOKEN</code></li>
            <li>※ 連携できた媒体から順に有効化されます。最初は1媒体だけでもOK</li>
          </GuideStep>

          <GuideStep n="4" title="無人で回す（自動実行）" color="#9fa3ab">
            <li><b>GitHub Actions の cron</b> で、テーマ投入〜生成を定期実行（例：毎晩）。<code>POST /income/enqueue</code> を叩く</li>
            <li>BAN対策として処理間隔を空ける（指数バックオフ・ランダムsleepは実装済み）</li>
            <li>各プラットフォームの<b>利用規約</b>と<b>無料枠</b>の範囲で運用してください</li>
          </GuideStep>

          <GuideStep n="5" title="毎日の運用（1日1分）" color="#c5c6c7">
            <li>朝、この <b>INCOME</b> 画面で「承認待ち」を確認 → <b>✓ 承認</b> / <b>✕ 却下</b></li>
            <li>上部のKPIで収益・進捗をチェック。これだけで全体が回ります</li>
          </GuideStep>

          <p className="rounded-forge border border-panel p-2 text-[11px] text-muted">
            🔐 すべてのAPIキー／トークンは <b>Settings → KEYCHAIN</b> に保管され、画面ではマスク表示されます
            （フルの値は表示されません）。手順の詳細はリポジトリの <code>SETUP.md</code> も参照してください。
          </p>
        </div>
      )}
    </div>
  );
}

function GuideStep({ n, title, color, children }: { n: string; title: string; color: string; children: React.ReactNode }) {
  return (
    <div className="rounded-forge border border-panel p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold" style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>{n}</span>
        <span className="text-[11px] tracking-[0.1em] text-fg-strong label-mono">{title}</span>
      </div>
      <ul className="ml-1 list-disc space-y-1 pl-4 text-[11.5px] text-fg marker:text-muted">
        {children}
      </ul>
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
