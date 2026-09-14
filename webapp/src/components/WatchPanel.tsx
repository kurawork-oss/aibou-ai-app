"use client";

/**
 * WatchPanel — 見張り（監視して、変わったときだけ報せる）。
 *
 * この画面で一番大事なのは、次の2つを見た目で混ぜないこと。
 *   「新着なし」        … 見に行けて、無かった
 *   「見に行けていない」 … そもそも確認できていない
 * 混ぜると、メールが読めていないのに「異常なし」に見える。それが一番困る。
 *
 * だから対象ごとに、読めているかどうかを必ず出す。
 * 未設定（まだ繋いでいない）は失敗ではないので、灰色で別に扱う。
 */

import { useCallback, useEffect, useState } from "react";

import {
  API_URL,
  watchCheck,
  watchInbox,
  watchReport,
  watchSetSource,
  type WatchReport,
  type WatchSource,
} from "@/lib/api";

/** 対象の状態を一目で分かる印にする。 */
function stateOf(s: WatchSource): { text: string; color: string; tone: "ok" | "bad" | "off" } {
  if (!s.enabled) return { text: "止めています", color: "#6b7280", tone: "off" };
  if (s.setup_needed) return { text: "未設定", color: "#6b7280", tone: "off" };
  if (!s.ok) return { text: "読めません", color: "#ff9b9b", tone: "bad" };
  return { text: "読めています", color: "var(--accent)", tone: "ok" };
}

function hhmm(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function WatchPanel({ offline }: { offline: boolean }) {
  const [data, setData] = useState<WatchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [hook, setHook] = useState<{ path: string; secret_set: boolean } | null>(null);

  // 画面を開いただけのときは、外へ繋ぎに行かせない（前回の中身を出す）。
  // 「今すぐ確認」を押したときだけ本当に見に行く。
  const load = useCallback(async (force = false) => {
    if (!API_URL) return;
    // 2つを直列で待つと、そのぶん表示が遅れる。同時に投げる。
    const [report, hookInfo] = await Promise.allSettled([watchReport(false, force), watchInbox()]);
    if (report.status === "fulfilled") setData(report.value);
    if (hookInfo.status === "fulfilled") {
      setHook({ path: hookInfo.value.path, secret_set: hookInfo.value.secret_set });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const checkNow = async () => {
    setBusy(true);
    setNote("");
    try {
      const res = await watchCheck();
      setNote(
        res.notified
          ? `新しい動きが ${res.new} 件ありました（通知を送りました）`
          : "変わったことはありませんでした",
      );
      await load();
    } catch {
      setNote("確認できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: WatchSource) => {
    if (!(await watchSetSource(s.key, !s.enabled))) {
      setNote("この設定は保存できませんでした（保存先がつながっていない可能性があります）");
      return;
    }
    await load();
  };

  if (offline) {
    return (
      <div className="glass-silver p-3 text-[11px] leading-relaxed text-muted">
        見張りはバックエンド接続後に表示されます。
      </div>
    );
  }

  const sources = data?.sources ?? [];
  const broken = sources.filter((s) => s.enabled && !s.setup_needed && !s.ok);
  const live = sources.filter((s) => s.enabled && s.ok);
  const newCount = live.reduce((n, s) => n + (s.new?.length ?? 0), 0);
  const lineOff = sources.find((s) => s.key === "line")?.setup_needed;

  return (
    <div id="home-watch" className="glass-silver p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">見張り — WATCH</span>
        <div className="flex items-center gap-2">
          {data?.checked_at && (
            <span className="text-[9px] text-muted label-mono">{hhmm(data.checked_at)} 確認</span>
          )}
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={busy}
            className="text-[9px] tracking-[0.12em] text-[var(--accent)] hover:underline disabled:opacity-40 label-mono"
          >
            {busy ? "確認中…" : "今すぐ確認"}
          </button>
        </div>
      </div>

      {/* 対象ごとの状態。ここを省くと「異常なし」が嘘になる */}
      <div className="mb-2 flex flex-wrap gap-1">
        {sources.map((s) => {
          const st = stateOf(s);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => void toggle(s)}
              title={s.error || s.hint || `${s.label}の見張りを${s.enabled ? "止める" : "再開する"}`}
              className="flex items-center gap-1 rounded-full border border-panel px-2 py-0.5 text-[10px] transition hover:border-[var(--line)]"
              style={{ opacity: s.enabled ? 1 : 0.45 }}
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
              <span className="text-fg">{s.label}</span>
              <span className="text-muted">{st.text}</span>
            </button>
          );
        })}
      </div>

      {/* 読めなかったもの。新着ゼロと同じ場所に置かない */}
      {broken.length > 0 && (
        <div className="mb-2 rounded-forge border border-[rgba(255,155,155,0.4)] p-2">
          <p className="text-[10px] text-[#ff9b9b] label-mono">見に行けていません（新着が無いのではありません）</p>
          {broken.map((s) => (
            <p key={s.key} className="mt-1 text-[11px] leading-relaxed text-fg">
              {s.label}：{s.error}
            </p>
          ))}
        </div>
      )}

      {live.length === 0 ? (
        <p className="text-[11px] text-muted">
          見張っている対象がありません。上の印を押すと再開できます。
        </p>
      ) : newCount === 0 && live.every((s) => (s.items?.length ?? 0) === 0) ? (
        <p className="text-[11px] text-muted">いま気にすべきものはありません。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {live
            .filter((s) => (s.items?.length ?? 0) > 0)
            .map((s) => (
              <div key={s.key}>
                <p className="mb-1 text-[9px] tracking-[0.12em] text-muted label-mono">
                  {s.label} {s.items.length}件
                  {s.new?.length ? `・新着 ${s.new.length}` : ""}
                </p>
                {s.items.slice(0, 5).map((it) => (
                  <div
                    key={it.key}
                    className="mb-1 flex items-start gap-2 rounded-forge border border-panel p-2"
                    style={it.is_new ? { borderColor: "var(--accent)" } : undefined}
                  >
                    <span
                      className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: it.urgent ? "#ff9b9b" : it.is_new ? "var(--accent)" : "#4a4f57" }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] text-fg">{it.title}</p>
                      {it.detail && (
                        <p className="truncate text-[10px] text-muted">{it.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
                {s.items.length > 5 && (
                  <p className="text-[10px] text-muted">…ほか {s.items.length - 5} 件</p>
                )}
              </div>
            ))}
        </div>
      )}

      {/* LINEの受信口。URLをそのまま貼れる形で出す */}
      {lineOff && hook?.path && (
        <div className="mt-2 rounded-forge border border-panel p-2">
          <p className="text-[10px] text-muted label-mono">LINEから受け取るには</p>
          <p className="mt-1 text-[11px] leading-relaxed text-fg">
            LINE Developers の Webhook URL にこれを貼り、チャネルシークレットを
            「連携」の <span className="label-mono">LINE_CHANNEL_SECRET</span> に入れてください。
          </p>
          <code className="mt-1 block break-all rounded border border-panel p-1.5 text-[10px] text-muted">
            {API_URL}{hook.path}
          </code>
        </div>
      )}

      {note && <p className="mt-2 text-[10px] text-muted">{note}</p>}
    </div>
  );
}
