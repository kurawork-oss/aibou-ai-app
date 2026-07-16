"use client";

/**
 * IntegrationsSettings — Settings 内の「Google連携」と「DB永続化（自動テーブル作成）」。
 * どちらもバックエンド接続時のみ動作。未接続時は案内のみ。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  API_URL,
  googleStatus,
  googleAuthStartUrl,
  googleDisconnect,
  dbStatus,
  dbMigrate,
  schedulesList,
  scheduleAdd,
  scheduleDelete,
  type GoogleStatus,
  type DbStatus,
  type ScheduleItem,
} from "@/lib/api";

export default function IntegrationsSettings() {
  if (!API_URL) {
    return (
      <div className="mb-4 rounded-forge border border-panel p-3 text-[11px] leading-relaxed text-muted">
        Google連携・DB永続化は、バックエンド接続後に使えます（DIAGNOSTICS参照）。
      </div>
    );
  }
  return (
    <>
      <GooglePanel />
      <SchedulerPanel />
      <DbPanel />
    </>
  );
}

/* ── Scheduler (recurring agent runs) ───────────────────────────── */
const DAY_CHIPS: { key: string; label: string }[] = [
  { key: "mon", label: "月" }, { key: "tue", label: "火" }, { key: "wed", label: "水" },
  { key: "thu", label: "木" }, { key: "fri", label: "金" }, { key: "sat", label: "土" }, { key: "sun", label: "日" },
];

/** "daily" → 毎日 / "mon,fri" → 毎週月・金 */
function daysLabel(days?: string): string {
  const d = (days || "daily").toLowerCase();
  if (d === "daily") return "毎日";
  const jp = new Map(DAY_CHIPS.map((c) => [c.key, c.label]));
  return "週" + d.split(",").map((k) => jp.get(k.trim()) || "").filter(Boolean).join("・");
}

function SchedulerPanel() {
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [instruction, setInstruction] = useState("");
  const [time, setTime] = useState("07:00");
  const [days, setDays] = useState<string[]>([]);  // 空 = 毎日
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setItems(await schedulesList()); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggleDay = (key: string) =>
    setDays((p) => (p.includes(key) ? p.filter((d) => d !== key) : [...p, key]));

  const add = async () => {
    if (!instruction.trim() || busy) return;
    setBusy(true);
    try {
      await scheduleAdd(instruction.trim(), time, days.length ? days.join(",") : "daily");
      setInstruction("");
      setDays([]);
      await load();
    } catch { /* ignore */ } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!window.confirm("この定期実行を削除しますか？")) return;
    await scheduleDelete(id);
    await load();
  };

  return (
    <div className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">定期実行 — SCHEDULER</div>
      <div className="flex gap-2">
        <input
          type="time" value={time} onChange={(e) => setTime(e.target.value)}
          className="shrink-0 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-fg-strong focus:outline-none"
        />
        <input
          value={instruction} onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()}
          placeholder="例：AIニュースを検索してメールで送る"
          className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-fg-strong placeholder:text-muted focus:outline-none"
        />
        <button type="button" onClick={() => void add()} disabled={busy || !instruction.trim()}
          className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 text-[10px] tracking-[0.12em] text-fg-strong disabled:opacity-40 label-mono">+ 追加</button>
      </div>

      {/* 曜日チップ（未選択=毎日） */}
      <div className="mt-2 flex items-center gap-1">
        {DAY_CHIPS.map((c) => {
          const on = days.includes(c.key);
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => toggleDay(c.key)}
              aria-pressed={on}
              className="h-7 w-7 rounded-full border text-[10px] transition"
              style={{
                borderColor: on ? "var(--accent)" : "var(--panel-bd)",
                color: on ? "var(--fg-strong)" : "var(--muted)",
                background: on ? "var(--btn-bg)" : "transparent",
              }}
            >
              {c.label}
            </button>
          );
        })}
        <span className="ml-1 text-[9px] text-muted label-mono">{days.length ? daysLabel(days.join(",")) : "毎日"}</span>
      </div>

      {items.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {items.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-forge border border-panel p-2">
              <span className="shrink-0 text-[11px] tracking-[0.08em] text-[var(--accent)] label-mono">{s.time}</span>
              <span className="shrink-0 rounded-full border border-panel px-1.5 py-0.5 text-[8px] tracking-[0.06em] text-muted label-mono">{daysLabel(s.days)}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{s.instruction}</span>
              <button type="button" onClick={() => void remove(s.id)} className="shrink-0 text-[10px] text-[#ff8888]">✕</button>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-[9px] leading-relaxed text-muted">
        ※ 曜日を選ばなければ毎日実行。サーバーが起きている間は自動で実行します。無料プランでスリープする場合は、
        <code className="text-fg">/scheduler/tick</code> を無料の外部cron（cron-job.org等）から定期的に叩くと確実です。定期実行は承認なしで実行されます。
      </p>
    </div>
  );
}

/* ── Google (Sheets / Docs) ─────────────────────────────────────── */
function GooglePanel() {
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try { setSt(await googleStatus()); } catch { setSt(null); }
  }, []);

  useEffect(() => {
    void load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const connect = () => {
    window.open(googleAuthStartUrl(), "_blank", "noopener,noreferrer");
    setNote("別タブでGoogleにログイン→許可してください。完了後この画面は自動更新されます。");
    // Poll for connection for ~90s.
    let n = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      n += 1;
      try {
        const s = await googleStatus();
        setSt(s);
        if (s.connected || n > 36) {
          if (pollRef.current) clearInterval(pollRef.current);
          if (s.connected) setNote("✓ Google連携が完了しました");
        }
      } catch { /* keep polling */ }
    }, 2500);
  };

  const disconnect = async () => {
    if (!window.confirm("Google連携を解除しますか？")) return;
    await googleDisconnect();
    setNote(null);
    void load();
  };

  const connected = st?.connected;
  const configured = st?.configured;

  return (
    <div className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">GOOGLE 連携（スプレッドシート / ドキュメント）</span>
        <span className="text-[9px] tracking-[0.1em] label-mono" style={{ color: connected ? "#60d394" : "#ffd060" }}>
          ● {connected ? "接続済み" : configured ? "未接続" : "未設定"}
        </span>
      </div>

      {!configured ? (
        <p className="text-[10px] leading-relaxed text-muted">
          先に KEYCHAIN で <b className="text-fg">GOOGLE_CLIENT_ID</b> と <b className="text-fg">GOOGLE_CLIENT_SECRET</b> を設定してください（各欄の「?」に手順）。
        </p>
      ) : connected ? (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[11px] leading-relaxed text-fg">
            エージェントが Google スプレッドシート / ドキュメントを作成できます。
          </p>
          <button type="button" onClick={() => void disconnect()}
            className="shrink-0 rounded-forge border border-[#ff6b6b44] px-3 py-1.5 text-[10px] tracking-[0.12em] text-[#ff8888] label-mono">解除</button>
        </div>
      ) : (
        <button type="button" onClick={connect}
          className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono">
          Googleに接続する ↗
        </button>
      )}
      {note && <p className="mt-2 text-[10px] leading-relaxed" style={{ color: note.startsWith("✓") ? "#60d394" : "var(--muted)" }}>{note}</p>}
    </div>
  );
}

/* ── DB persistence (auto table creation) ───────────────────────── */
function DbPanel() {
  const [st, setSt] = useState<DbStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSt(await dbStatus()); } catch { setSt(null); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const migrate = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await dbMigrate();
      if (res.ok) setNote("✓ テーブルを作成しました（永続化が有効になりました）");
      else setNote(`⚠ ${res.reason || res.error || "作成できませんでした"}`);
      await load();
    } catch {
      setNote("⚠ 実行に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const total = st ? st.present.length + st.missing.length : 0;
  const allPresent = st ? st.missing.length === 0 && st.present.length > 0 : false;

  return (
    <div className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">DB 永続化（自動テーブル作成）</span>
        {st && (
          <span className="text-[9px] tracking-[0.1em] label-mono" style={{ color: allPresent ? "#60d394" : "#ffd060" }}>
            ● {allPresent ? "永続化 有効" : `${st.present.length}/${total} テーブル`}
          </span>
        )}
      </div>

      {!st ? (
        <p className="text-[10px] text-muted">状態を取得できませんでした。</p>
      ) : allPresent ? (
        <p className="text-[11px] leading-relaxed text-fg">
          必要なテーブルが揃っています。タスク・予定・生成物などが Supabase に保存されます。
        </p>
      ) : st.db_url_set ? (
        <>
          <p className="mb-2 text-[10px] leading-relaxed text-muted">
            未作成のテーブルがあります（{st.missing.slice(0, 4).join(", ")}{st.missing.length > 4 ? " …" : ""}）。
            ボタンひとつで自動作成できます。
          </p>
          <button type="button" onClick={() => void migrate()} disabled={busy}
            className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.16em] text-fg-strong disabled:opacity-40 label-mono">
            {busy ? "作成中…" : "テーブルを自動作成"}
          </button>
        </>
      ) : (
        <p className="text-[10px] leading-relaxed text-muted">
          KEYCHAIN に <b className="text-fg">SUPABASE_DB_URL</b>（postgresql://… 接続文字列）を設定すると、
          ここからワンクリックでテーブルを自動作成できます（各欄の「?」に手順）。未設定でもメモリ動作します。
        </p>
      )}
      {note && <p className="mt-2 text-[10px] leading-relaxed" style={{ color: note.startsWith("✓") ? "#60d394" : "#ff9b9b" }}>{note}</p>}
    </div>
  );
}
