"use client";

/**
 * IntegrationsSettings — Settings 内の「Google連携」と「DB永続化（自動テーブル作成）」。
 * どちらもバックエンド接続時のみ動作。未接続時は案内のみ。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import FreeOps from "@/components/FreeOps";
import {
  API_URL,
  googleStatus,
  googleAuthStartUrl,
  googleDisconnect,
  dbStatus,
  dbMigrate,
  schedulesWithHealth,
  schedulerLooksAsleep,
  scheduleAdd,
  scheduleDelete,
  keepaliveStatus,
  keepalivePing,
  type GoogleStatus,
  type DbStatus,
  type ScheduleItem,
  type KeepaliveStatus,
} from "@/lib/api";

export default function IntegrationsSettings() {
  if (!API_URL) {
    return (
      <div className="mb-4 rounded-forge border border-panel p-3 text-[11px] leading-relaxed text-muted">
        Google連携・DB永続化は、バックエンド接続後に使えます（設定 →「しらべる」）。
      </div>
    );
  }
  return (
    <>
      <GooglePanel />
      <SchedulerPanel />
      <DbPanel />
      <KeepalivePanel />
    </>
  );
}

/* ── Keep-alive (Supabase の自動一時停止を防ぐ) ──────────────────── */
function KeepalivePanel() {
  const [st, setSt] = useState<KeepaliveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSt(await keepaliveStatus()); } catch { setSt(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const runNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await keepalivePing();
      setNote(r.ok ? `✓ 実行しました（${r.detail ?? ""}）` : `⚠ ${r.detail ?? "実行できませんでした"}`);
      await load();
    } catch {
      setNote("⚠ 実行に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso: string) => {
    if (!iso) return "未実行";
    try { return new Date(iso).toLocaleString("ja-JP"); } catch { return iso; }
  };

  return (
    <div className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">DB停止防止 — KEEP-ALIVE</span>
        {st && (
          <span className="text-[9px] tracking-[0.1em] label-mono" style={{ color: st.supabase_configured ? "#60d394" : "#ffd060" }}>
            ● {st.supabase_configured ? "有効" : "Supabase未設定"}
          </span>
        )}
      </div>

      <p className="text-[10px] leading-relaxed text-muted">
        無料のSupabaseは<b className="text-fg">7日間アクセスが無いと自動で一時停止</b>します。
        毎日DBに軽く触って停止を防ぎます（アプリ稼働中は自動・確実にするには下のcron設定）。
      </p>

      {st && (
        <div className="mt-2 rounded-forge border border-panel p-2 text-[10px] leading-relaxed">
          <div className="flex justify-between gap-2">
            <span className="text-muted label-mono">最終実行</span>
            <span style={{ color: st.last_ok ? "#60d394" : "var(--muted)" }}>{fmt(st.last_at)}</span>
          </div>
          {st.last_detail && <p className="mt-0.5 break-all text-muted/80">{st.last_detail}</p>}
        </div>
      )}

      <button type="button" onClick={() => void runNow()} disabled={busy}
        className="mt-2 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.16em] text-fg-strong disabled:opacity-40 label-mono">
        {busy ? "実行中…" : "今すぐ実行（DBを起こす）"}
      </button>

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        ※ 確実に止めないためには、GitHubリポジトリの <b className="text-fg">Settings → Secrets and variables → Actions</b> に
        <code className="text-fg"> BACKEND_URL</code>（例 https://xxx.onrender.com）を追加してください。
        毎日 <code className="text-fg">/keepalive</code> を自動で叩きます（同梱の Supabase Keep-Alive ワークフロー）。
        無料の外部cron（cron-job.org等）から <code className="text-fg">{"{API_URL}"}/keepalive</code> を叩く方法でもOKです。
      </p>
      {note && <p className="mt-1 text-[10px] leading-relaxed" style={{ color: note.startsWith("✓") ? "#60d394" : "#ff9b9b" }}>{note}</p>}
    </div>
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

  // 見回りが生きているか。無料プランのサーバーは無操作で寝るので、
  // 登録できたのに朝になっても何も来ない、が起こりうる。
  // 注意書きを読ませるより、いまの状態を出すほうが早い。
  const [asleep, setAsleep] = useState(false);
  const [lastAt, setLastAt] = useState("");

  const load = useCallback(async () => {
    try {
      const { items: list, health } = await schedulesWithHealth();
      setItems(list);
      setAsleep(schedulerLooksAsleep(health));
      setLastAt(health?.at ?? "");
    } catch { /* ignore */ }
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

      {/* 登録できたのに何も来ない、を起こさないために状態を出す */}
      {items.length > 0 && (
        <div className="mb-2 rounded-forge border p-2 text-[11px] leading-relaxed"
             style={{ borderColor: asleep ? "#ffd07f55" : "#60d39455",
                      color: asleep ? "#ffd07f" : "#60d394" }}>
          {asleep ? (
            <>
              見回りが止まっています。このままだと時刻になっても実行されません。
              <span className="mt-1 block text-muted">
                無料プランのサーバーは、しばらく使われないと寝ます。時刻どおりに動かすには、
                有料プランにするか、下の外部cronの方法を使ってください。
                {lastAt && <span className="ml-1">（最終確認 {lastAt.slice(11, 16)}）</span>}
              </span>
            </>
          ) : (
            <>✓ 見回りは動いています（1分ごとに確認しています）</>
          )}
        </div>
      )}

      {/* 止まっているときだけ手順を開いて出す。動いているのに並べても雑音になる */}
      {items.length > 0 && asleep && (
        <div className="mb-2"><FreeOps /></div>
      )}
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
      <p className="mt-2 text-[11px] leading-relaxed text-muted">
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
      if (res.ok) setNote("✓ 流しました（足りない表と、守りの設定が入りました）");
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
  /* 守りの入っていない表の数。接続文字列が無いと数えられないので、
     そのときは 0（分からないことを「危ない」とも「安全」とも言わない）。 */
  const unguarded = st?.unguarded?.length ?? 0;

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
        <>
          <p className="text-[11px] leading-relaxed text-fg">
            必要なテーブルが揃っています。タスク・予定・生成物などが Supabase に保存されます。
          </p>
          {unguarded > 0 && (
            <p className="mt-2 rounded-forge border p-2 text-[11px] leading-relaxed"
               style={{ borderColor: "#ffd06055", color: "#ffd060" }}>
              ただし <b>{unguarded}件</b>の表に、<b>守り（RLS）が入っていません</b>。
              ログイン用の鍵はブラウザに配られるので、このままだとURLを知っている人が
              中身を直接読めます。下の「もう一度流す」で入ります。
            </p>
          )}
          {/* 揃ったあとも、必ず流し直せるようにしておく。
              ここを隠していたせいで、**あとから足した安全設定が、
              先に設定を済ませた人には一生届かない**状態だった。 */}
          <button type="button" onClick={() => void migrate()} disabled={busy || !st.db_url_set}
            className="mt-2 w-full rounded-forge border border-panel py-2 text-[11px] tracking-[0.16em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">
            {busy ? "実行中…" : "もう一度流す（あとから足した分を入れる）"}
          </button>
        </>
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
