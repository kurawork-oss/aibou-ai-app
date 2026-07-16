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
  type GoogleStatus,
  type DbStatus,
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
      <DbPanel />
    </>
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
