"use client";

/**
 * Home — パーソナル・コックピット（ホーム）.
 *
 * コアと対話しつつ、各機能の進捗を一望できるダッシュボード:
 *  - サマリーKPI（タスク / ミッション / 自動化 / 副業 / 予定 / 通知）
 *  - 予定（組み込みカレンダー：自然言語で追加「明日15時に歯医者」）
 *  - 通知（アプリ内通知ログ：オートパイロット等の結果）
 *  - クイック・アシスタント（その場でコアにチャット）
 *  - 外部連携（カレンダー / LINE / メール）の接続状況とKEYCHAINへの導線
 */

import { motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  homeSummary,
  agendaList,
  agendaParse,
  agendaDelete,
  notificationsList,
  notificationsMarkRead,
  streamChat,
  API_URL,
  type HomeSummary,
  type AgendaEvent,
  type AppNotification,
} from "@/lib/api";
import type { ChatSettings } from "@/components/Chat";
import Tilt3D from "@/components/Tilt3D";

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
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // tasks/missions/automations/income jump to their mode; 予定/通知 scroll to
  // their on-page panels (they live on HOME, so navigating to "home" is a no-op).
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const cards: { label: string; value: number; onClick: () => void }[] = summary
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
    <div className="grid h-full min-h-0 grid-cols-1 content-start gap-3 overflow-y-auto pb-2 lg:grid-cols-3">
      {/* Greeting — full width */}
      <div className="glass-silver p-4 lg:col-span-3">
        <div className="text-base text-fg-strong">{greeting()}、{settings.name} です。</div>
        <div className="text-[10px] tracking-[0.16em] text-muted label-mono">PERSONAL COCKPIT · 本日の状況</div>
      </div>

      {offline && (
        <div className="glass-silver p-3 text-[11px] leading-relaxed text-muted lg:col-span-3">
          バックエンド未接続です。接続すると各機能の進捗・予定・通知がここに集約されます。
          <button onClick={() => onNavigate("chat")} className="ml-1 text-[var(--accent)] underline">CHATへ</button>
        </div>
      )}

      {/* KPI summary — full width */}
      {summary && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:col-span-3">
          {cards.map((c) => (
            <Tilt3D key={c.label} max={9}>
              <button
                type="button"
                onClick={c.onClick}
                className="glass-silver w-full p-2 text-center transition hover:shadow-glow"
              >
                <div className="text-[22px] font-bold text-fg-strong">{c.value}</div>
                <div className="text-[9px] tracking-[0.14em] text-muted label-mono">{c.label}</div>
              </button>
            </Tilt3D>
          ))}
        </div>
      )}

      {/* Left column (wider): quick assistant + agenda */}
      <div className="flex flex-col gap-3 lg:col-span-2">
        <QuickAssistant settings={settings} />
        <AgendaPanel events={events} offline={offline} onChange={refresh} setEvents={setEvents} />
      </div>

      {/* Right column: notifications + external */}
      <div className="flex flex-col gap-3">
        <NotificationsPanel notes={notes} offline={offline} onRead={async () => { await notificationsMarkRead(); await refresh(); }} />
        <div className="glass-silver p-3">
          <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">外部連携</div>
          <p className="text-[11px] leading-relaxed text-muted">
            カレンダー同期 / LINE / メールの受信・返信は、各APIキーを設定すると有効化されます。
          </p>
          <button
            type="button"
            onClick={() => onNavigate("chat")}
            className="mt-2 text-[10px] tracking-[0.14em] text-[var(--accent)] hover:underline label-mono"
          >
            → Settings → KEYCHAIN でキーを設定
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Quick assistant (mini chat) ─────────────────────────────────── */
function QuickAssistant({ settings }: { settings: ChatSettings }) {
  const [input, setInput] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  // Cancel any in-flight stream when this panel unmounts (e.g. navigating away).
  useEffect(() => () => cancelRef.current?.(), []);

  const send = () => {
    const msg = input.trim();
    if (!msg || busy) return;
    setBusy(true);
    setReply("");
    setInput("");
    let acc = "";
    cancelRef.current = streamChat(
      { message: msg, persona: settings.persona, name: settings.name },
      (tok) => { acc += tok; setReply(acc); },
      (err) => { if (err) setReply(`⚠ ${err}`); setBusy(false); },
    ).cancel;
  };

  return (
    <div className="glass-silver p-3">
      <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">QUICK ASSISTANT — コアに指示</div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send()}
          placeholder="例：今日のおすすめの動き方を教えて"
          className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || !input.trim()}
          className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-4 text-[10px] tracking-[0.14em] text-fg-strong disabled:opacity-40 label-mono"
        >
          {busy ? "…" : "送信"}
        </button>
      </div>
      {reply && <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{reply}</p>}
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
        <p className="mt-2 text-[11px] text-muted">予定はまだありません。</p>
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
