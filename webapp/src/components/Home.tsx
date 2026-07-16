"use client";

/**
 * Home — パーソナル・コックピット（ホーム）.
 *
 * ただカードを縦積みするのではなく、計器盤（instrument cockpit）風の独自レイアウト:
 *  - コックピット・ヘッダー（挨拶＋ライブ時計＋エージェント状態）
 *  - AGENT CONSOLE（ヒーロー）: 手足となって動く自律エージェント。指示すると
 *    plan→act→observe を実況しながら、タスク追加・予定登録・通知などを実際に行う。
 *  - INSTRUMENT CLUSTER: 6つのKPIをリング・ダイヤルで表示（各モードへ導線）。
 *  - AGENDA / NOTIFICATIONS / CONNECT を左右非対称のベントーで配置。
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  homeSummary,
  agendaList,
  agendaParse,
  agendaDelete,
  notificationsList,
  notificationsMarkRead,
  agentActStream,
  agentExecute,
  artifactsList,
  artifactDownload,
  artifactDelete,
  API_URL,
  type HomeSummary,
  type AgendaEvent,
  type AppNotification,
  type AgentEvent,
  type ArtifactMeta,
} from "@/lib/api";
import type { ChatSettings } from "@/components/Chat";

type View = "chat" | "me" | "forge" | "code" | "vault" | "income" | "tasks" | "studio" | "autopilot" | "board" | "archive" | "home";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "おやすみなさい";
  if (h < 11) return "おはようございます";
  if (h < 18) return "こんにちは";
  return "こんばんは";
}

export default function Home({
  settings,
  onNavigate,
}: {
  settings: ChatSettings;
  onNavigate: (v: View) => void;
}) {
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [events, setEvents] = useState<AgendaEvent[]>([]);
  const [notes, setNotes] = useState<AppNotification[]>([]);
  const [arts, setArts] = useState<ArtifactMeta[]>([]);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    if (!API_URL) { setOffline(true); return; }
    try {
      const [s, ev, n] = await Promise.all([homeSummary(), agendaList(), notificationsList()]);
      setSummary(s);
      setEvents(ev);
      setNotes(n.items);
      setOffline(false);
    } catch {
      setOffline(true);
      return;
    }
    // Artifacts are optional (older backends may not have the endpoint yet).
    try { setArts(await artifactsList()); } catch { /* ignore */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const dials: { label: string; value: number; onClick: () => void }[] = summary
    ? [
        { label: "タスク", value: summary.tasks.open, onClick: () => onNavigate("tasks") },
        { label: "ミッション", value: summary.missions.active, onClick: () => onNavigate("autopilot") },
        { label: "自動化", value: summary.automations.total, onClick: () => onNavigate("board") },
        { label: "副業", value: summary.income.pending, onClick: () => onNavigate("income") },
        { label: "予定", value: summary.events.total, onClick: () => scrollTo("home-agenda") },
        { label: "通知", value: summary.notifications.unread, onClick: () => scrollTo("home-notifications") },
      ]
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-2">
      <CockpitHeader name={settings.name} />

      {offline && (
        <div className="glass-silver p-3 text-[11px] leading-relaxed text-muted">
          バックエンド未接続です。接続すると、エージェントが実際にタスク・予定・通知を動かせるようになります。
          <button onClick={() => onNavigate("chat")} className="ml-1 text-[var(--accent)] underline">CHATへ</button>
        </div>
      )}

      {/* Hero: agent console (wide) + instrument cluster */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AgentConsole settings={settings} offline={offline} onDidAct={refresh} onNavigate={onNavigate} />
        </div>
        <InstrumentCluster dials={dials} loading={!summary && !offline} />
      </div>

      {/* Bento: agenda (wide) + notifications / connect */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AgendaPanel events={events} offline={offline} onChange={refresh} setEvents={setEvents} />
        </div>
        <div className="flex flex-col gap-3">
          <NotificationsPanel notes={notes} offline={offline} onRead={async () => { await notificationsMarkRead(); await refresh(); }} />
          {!offline && <ArtifactsPanel arts={arts} onChange={refresh} />}
          <ConnectCard onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  );
}

/* ── Cockpit header (greeting + live clock) ──────────────────────── */
function CockpitHeader({ name }: { name: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hhmmss = now
    ? `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
    : "--:--:--";
  const dateLabel = now
    ? now.toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" })
    : "";

  return (
    <div className="glass-silver relative overflow-hidden p-4">
      <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 85% 20%, var(--accent), transparent 45%)" }} aria-hidden />
      <div className="relative flex items-end justify-between gap-3">
        <div>
          <div className="text-base text-fg-strong sm:text-lg">{greeting()}、{name} です。</div>
          <div className="mt-0.5 text-[10px] tracking-[0.16em] text-muted label-mono">PERSONAL COCKPIT · 本日の状況</div>
        </div>
        <div className="text-right">
          <div className="text-glow text-xl font-bold tabular-nums text-fg-strong sm:text-2xl label-mono">{hhmmss}</div>
          <div className="text-[9px] tracking-[0.16em] text-muted label-mono">{dateLabel}</div>
        </div>
      </div>
    </div>
  );
}

/* ── Instrument cluster (ring-dial KPIs) ─────────────────────────── */
function InstrumentCluster({
  dials, loading,
}: {
  dials: { label: string; value: number; onClick: () => void }[];
  loading: boolean;
}) {
  return (
    <div className="glass-silver p-3">
      <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">INSTRUMENT CLUSTER</div>
      {loading ? (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-forge border border-panel" />
          ))}
        </div>
      ) : dials.length === 0 ? (
        <p className="py-6 text-center text-[11px] text-muted">— オフライン —</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {dials.map((d) => (
            <RingDial key={d.label} label={d.label} value={d.value} onClick={d.onClick} />
          ))}
        </div>
      )}
    </div>
  );
}

function RingDial({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  const active = value > 0;
  const r = 24;
  const circ = 2 * Math.PI * r;
  // Decorative fill: grows with the value but softly capped so it always reads
  // like a gauge (never a full ring unless there's a lot going on).
  const frac = active ? Math.min(0.9, 0.28 + value * 0.1) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center rounded-forge border border-panel p-2 transition hover:border-[var(--line)] hover:shadow-glow"
      title={`${label}: ${value}`}
    >
      <span className="relative grid place-items-center">
        <svg width="58" height="58" viewBox="0 0 58 58" className="-rotate-90">
          <circle cx="29" cy="29" r={r} fill="none" stroke="var(--panel-bd)" strokeWidth="4" />
          <circle
            cx="29" cy="29" r={r} fill="none"
            stroke={active ? "var(--accent)" : "transparent"}
            strokeWidth="4" strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - frac)}
            style={{ filter: active ? "drop-shadow(0 0 4px var(--glow))" : "none", transition: "stroke-dashoffset .6s ease" }}
          />
        </svg>
        <span className="absolute text-[18px] font-bold text-fg-strong tabular-nums">{value}</span>
      </span>
      <span className="mt-1 text-[9px] tracking-[0.1em] text-muted label-mono group-hover:text-fg-strong">{label}</span>
    </button>
  );
}

/* ── Agent console (手足となって動く自律エージェント) ─────────────── */
const TOOL_LABELS: Record<string, string> = {
  add_task: "タスクを追加",
  add_agenda: "予定を追加",
  list_state: "現在の状況を確認",
  create_document: "ドキュメントを作成",
  create_spreadsheet: "スプレッドシートを作成",
  google_sheet: "Googleスプレッドシート作成",
  google_doc: "Googleドキュメント作成",
  notion_add: "Notionに追記",
  create_automation: "自動化フローを作成",
  run_automation: "自動化を実行",
  create_mission: "ミッションを作成",
  calendar_add: "カレンダーに追加",
  calendar_list: "カレンダーを確認",
  send_email: "メールを送信",
  email_inbox: "受信メールを確認",
  web_search: "Webを検索",
  web_read: "ページを読む",
  remember: "記憶する",
  recall: "記憶を思い出す",
  enqueue_income: "副業ジョブを投入",
  income_status: "副業の状況を確認",
  notify: "通知を送信",
  save_note: "ノートに保存",
};

type Pending = { tool: string; params: Record<string, unknown>; note?: string };

type Step =
  | { kind: "thinking" }
  | { kind: "tool"; tool: string; note?: string }
  | { kind: "observation"; result: string }
  | { kind: "error"; detail: string };

const SUGGESTIONS = [
  "今日のおすすめの動き方を教えて",
  "AIの最新ニュースを検索して要約して",
  "明日15時に歯医者の予定を入れて",
  "今の状況を整理して報告して",
];

function summarizeParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ")
    .slice(0, 220);
}

function AgentConsole({
  settings, offline, onDidAct, onNavigate,
}: {
  settings: ChatSettings;
  offline: boolean;
  onDidAct: () => void;
  onNavigate: (v: View) => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [answer, setAnswer] = useState("");
  const [ran, setRan] = useState(false);
  const [approval, setApproval] = useState(true);   // 実行前に確認（機微な操作）
  const [pending, setPending] = useState<Pending | null>(null);
  const [approving, setApproving] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const actedRef = useRef(false);

  useEffect(() => () => cancelRef.current?.(), []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [steps, answer, pending]);

  const run = (msg: string) => {
    const text = msg.trim();
    if (!text || busy || offline) return;
    setBusy(true);
    setRan(true);
    setSteps([]);
    setAnswer("");
    setPending(null);
    setInput("");
    actedRef.current = false;

    cancelRef.current = agentActStream(
      text,
      [],
      settings.name,
      approval,
      (ev: AgentEvent) => {
        switch (ev.phase) {
          case "thinking":
            setSteps((s) => [...s.filter((x) => x.kind !== "thinking"), { kind: "thinking" }]);
            break;
          case "tool":
            actedRef.current = true;
            setSteps((s) => [...s.filter((x) => x.kind !== "thinking"), { kind: "tool", tool: ev.tool || "", note: ev.note }]);
            break;
          case "observation":
            setSteps((s) => [...s, { kind: "observation", result: ev.result || "" }]);
            break;
          case "approval":
            setSteps((s) => s.filter((x) => x.kind !== "thinking"));
            setPending({ tool: ev.tool || "", params: ev.params || {}, note: ev.note });
            break;
          case "error":
            setSteps((s) => [...s.filter((x) => x.kind !== "thinking"), { kind: "error", detail: ev.detail || "エラー" }]);
            break;
          case "final":
            setSteps((s) => s.filter((x) => x.kind !== "thinking"));
            setAnswer(ev.text || "");
            break;
        }
      },
      () => {
        setBusy(false);
        if (actedRef.current) onDidAct(); // refresh KPIs / agenda / notifications
      },
    ).cancel;
  };

  const approve = async () => {
    if (!pending) return;
    const p = pending;
    setApproving(true);
    setSteps((s) => [...s, { kind: "tool", tool: p.tool, note: p.note }]);
    try {
      const result = await agentExecute(p.tool, p.params);
      setSteps((s) => [...s, { kind: "observation", result }]);
      actedRef.current = true;
      onDidAct();
    } catch {
      setSteps((s) => [...s, { kind: "error", detail: "実行に失敗しました" }]);
    } finally {
      setApproving(false);
      setPending(null);
    }
  };

  const reject = () => {
    if (!pending) return;
    setSteps((s) => [...s, { kind: "observation", result: `（${TOOL_LABELS[pending.tool] || pending.tool} をキャンセルしました）` }]);
    setPending(null);
  };

  const stop = () => { cancelRef.current?.(); setBusy(false); };

  return (
    <div className="glass-silver relative flex h-full min-h-[16rem] flex-col overflow-hidden p-0">
      {/* animated scan line — signals the live agent */}
      <motion.div
        className="h-[2px] w-full"
        style={{ background: "linear-gradient(90deg, transparent, var(--accent), transparent)" }}
        animate={busy ? { opacity: [0.3, 1, 0.3], backgroundPositionX: ["-100%", "100%"] } : { opacity: 0.5 }}
        transition={{ duration: 1.6, repeat: busy ? Infinity : 0, ease: "linear" }}
      />
      <div className="flex flex-1 flex-col p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] tracking-[0.2em] text-muted label-mono">AGENT CONSOLE · 手足となって動く</span>
          <span className="flex items-center gap-1 text-[9px] tracking-[0.14em] label-mono" style={{ color: busy ? "var(--accent)" : "#60d394" }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: busy ? "var(--accent)" : "#60d394", boxShadow: busy ? "0 0 6px var(--glow)" : "none" }} />
            {busy ? "WORKING" : "READY"}
          </span>
        </div>

        {/* live action stream + answer */}
        <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto">
          {!ran ? (
            <div className="py-2">
              <p className="text-[11px] leading-relaxed text-muted">
                指示すると、エージェントが<b className="text-fg">計画→実行→確認</b>を繰り返して実際に手を動かします
                （タスク追加・予定登録・通知・記憶など）。
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={offline}
                    onClick={() => run(s)}
                    className="rounded-full border border-panel px-2.5 py-1 text-[10px] text-muted transition hover:border-[var(--line)] hover:text-fg-strong disabled:opacity-40"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 py-1">
              <AnimatePresence initial={false}>
                {steps.map((step, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="text-[11px] leading-relaxed"
                  >
                    {step.kind === "thinking" && (
                      <span className="flex items-center gap-1.5 text-[var(--accent)]">
                        <motion.span animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, repeat: Infinity }}>◈</motion.span>
                        <span className="text-muted">考えています…</span>
                      </span>
                    )}
                    {step.kind === "tool" && (
                      <span className="text-fg">
                        <span className="text-[var(--accent)]">→</span> {TOOL_LABELS[step.tool] || step.tool}
                        {step.note ? <span className="text-muted"> — {step.note}</span> : null}
                      </span>
                    )}
                    {step.kind === "observation" && (
                      <span className="block pl-4 text-[10px] text-muted">✓ {step.result}</span>
                    )}
                    {step.kind === "error" && (
                      <span className="text-[#ff9b9b]">⚠ {step.detail}</span>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
              {answer && (
                <div className="mt-1 whitespace-pre-wrap rounded-forge border border-panel bg-[rgba(255,255,255,0.02)] p-2.5 text-[12px] leading-relaxed text-fg">
                  {answer}
                </div>
              )}
              {pending && (
                <div className="mt-2 rounded-forge border p-2.5" style={{ borderColor: "#ffd06066", background: "rgba(255,208,96,0.06)" }}>
                  <div className="mb-1 text-[10px] tracking-[0.14em] label-mono" style={{ color: "#ffd060" }}>🛡 実行の確認</div>
                  <p className="text-[12px] text-fg">
                    <b>{TOOL_LABELS[pending.tool] || pending.tool}</b> を実行してよろしいですか？
                  </p>
                  {summarizeParams(pending.params) && (
                    <p className="mt-0.5 break-all text-[10px] text-muted">{summarizeParams(pending.params)}</p>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => void approve()} disabled={approving}
                      className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">
                      {approving ? "実行中…" : "✓ 承認して実行"}
                    </button>
                    <button type="button" onClick={reject} disabled={approving}
                      className="rounded-forge border border-[#ff6b6b44] px-3 py-1.5 text-[10px] tracking-[0.12em] text-[#ff8888] label-mono">却下</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* approval toggle */}
        {!offline && (
          <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[10px] text-muted">
            <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} className="accent-[var(--accent)]" />
            🛡 実行前に確認（メール送信など機微な操作を承認制に）
          </label>
        )}

        {/* input */}
        <div className="mt-2 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && run(input)}
            placeholder={offline ? "バックエンド接続後に使えます" : "例：明日15時に歯医者、牛乳を買うタスクも追加して"}
            disabled={offline || busy}
            className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none disabled:opacity-50"
          />
          {busy ? (
            <button type="button" onClick={stop}
              className="shrink-0 rounded-forge border border-[#ff6b6b55] bg-[var(--btn-bg)] px-4 text-[13px] text-[#ff8888]">■</button>
          ) : (
            <button type="button" onClick={() => run(input)} disabled={offline || !input.trim()}
              className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-4 text-[10px] tracking-[0.14em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">実行</button>
          )}
        </div>
        {offline && (
          <button type="button" onClick={() => onNavigate("chat")} className="mt-1 self-start text-[10px] text-[var(--accent)] hover:underline label-mono">
            → 接続方法（DIAGNOSTICS）
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Agenda panel ────────────────────────────────────────────────── */
function AgendaPanel({
  events, offline, onChange, setEvents,
}: {
  events: AgendaEvent[];
  offline: boolean;
  onChange: () => void;
  setEvents: (e: AgendaEvent[]) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await agendaParse(text.trim(), today);
      setText("");
      onChange();
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("この予定を削除しますか？")) return;
    await agendaDelete(id);
    setEvents(events.filter((e) => e.id !== id));
  };

  return (
    <div id="home-agenda" className="glass-silver p-3">
      <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">予定 — AGENDA</div>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()}
          placeholder="例：明日15時に歯医者 / 金曜10時 定例MTG"
          disabled={offline}
          className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy || offline || !text.trim()}
          className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 text-[10px] tracking-[0.14em] text-fg-strong disabled:opacity-40 label-mono"
        >
          {busy ? "…" : "+ 追加"}
        </button>
      </div>

      {events.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted">予定はまだありません。エージェントに「明日15時に歯医者」と頼むこともできます。</p>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {events.slice(0, 8).map((ev) => (
            <div key={ev.id} className="flex items-center gap-2 rounded-forge border border-panel p-2">
              <div className="min-w-[64px] text-[10px] tracking-[0.08em] text-[var(--accent)] label-mono">
                {ev.date || "—"}{ev.time ? ` ${ev.time}` : ""}
              </div>
              <div className="min-w-0 flex-1 truncate text-[12px] text-fg">{ev.title}</div>
              <button type="button" onClick={() => void remove(ev.id)} className="text-[10px] text-[#ff8888]">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Notifications panel ─────────────────────────────────────────── */
function NotificationsPanel({
  notes, offline, onRead,
}: {
  notes: AppNotification[];
  offline: boolean;
  onRead: () => void;
}) {
  return (
    <div id="home-notifications" className="glass-silver p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">通知 — NOTIFICATIONS</span>
        {!offline && notes.some((n) => !n.read) && (
          <button type="button" onClick={onRead} className="text-[9px] tracking-[0.12em] text-[var(--accent)] hover:underline label-mono">
            すべて既読
          </button>
        )}
      </div>
      {notes.length === 0 ? (
        <p className="text-[11px] text-muted">通知はありません。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {notes.slice(0, 6).map((n) => (
            <div key={n.id} className="flex items-start gap-2 rounded-forge border border-panel p-2">
              <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: n.read ? "#4a4f57" : "var(--accent)" }} />
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-fg">{n.message}</p>
                {n.channel && <span className="text-[9px] text-muted label-mono">{n.channel}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Artifacts panel (agent-generated documents / spreadsheets) ──── */
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ArtifactsPanel({ arts, onChange }: { arts: ArtifactMeta[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (a: ArtifactMeta) => {
    setBusy(a.id);
    try { await artifactDownload(a); } catch { /* ignore */ } finally { setBusy(null); }
  };
  const remove = async (a: ArtifactMeta) => {
    if (!window.confirm(`「${a.title}」を削除しますか？`)) return;
    setBusy(a.id);
    try { await artifactDelete(a.id); await onChange(); } catch { /* ignore */ } finally { setBusy(null); }
  };

  return (
    <div className="glass-silver p-3">
      <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">生成物 — ARTIFACTS</div>
      {arts.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted">
          エージェントに「◯◯の表を作って」「◯◯をドキュメントにまとめて」と頼むと、資料がここに生成されダウンロードできます。
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {arts.slice(0, 6).map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-forge border border-panel p-2">
              <span className="text-[14px] leading-none text-[var(--accent)]">{a.kind === "spreadsheet" ? "▦" : "▤"}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-fg">{a.title}</div>
                <div className="text-[9px] tracking-[0.08em] text-muted label-mono">
                  {a.kind === "spreadsheet" ? "CSV" : "MARKDOWN"} · {fmtSize(a.size)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void download(a)}
                disabled={busy === a.id}
                title="ダウンロード"
                className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-2 py-1 text-[11px] text-fg-strong disabled:opacity-40"
              >
                ⭳
              </button>
              <button type="button" onClick={() => void remove(a)} disabled={busy === a.id} className="shrink-0 text-[10px] text-[#ff8888]">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── External connect card ───────────────────────────────────────── */
function ConnectCard({ onNavigate }: { onNavigate: (v: View) => void }) {
  return (
    <div className="glass-silver p-3">
      <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">外部連携 — CONNECT</div>
      <p className="text-[11px] leading-relaxed text-muted">
        LINE / Discord / Slack への通知や各種APIは、KEYCHAIN にキーを入れると有効になります（各キーに発行手順あり）。
      </p>
      <button
        type="button"
        onClick={() => onNavigate("chat")}
        className="mt-2 text-[10px] tracking-[0.14em] text-[var(--accent)] hover:underline label-mono"
      >
        → Settings → KEYCHAIN でキーを設定
      </button>
    </div>
  );
}
