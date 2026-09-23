"use client";

/**
 * 操作の記録（api/audit.py）— AIbou があなたの代わりに「外で」したこと。
 *
 * 身に覚えのない送信があったとき、ここを見れば
 *
 *   ・AIbou がやったのか
 *   ・どこから頼まれたのか（会話・実行モード・定期実行・#）
 *   ・**確認カードを見て押したのか、確認なしで動いたのか**
 *   ・どの台・どのブラウザで動いたのか
 *
 * が分かる。読むだけの操作（検索など）は出さない——全部出すと、肝心の行が
 * 埋もれる。本文（メールの中身・ページの本文）はサーバーにも残していない。
 */

import { useCallback, useEffect, useState } from "react";
import { API_URL, auditRecent, type AuditRow } from "@/lib/api";
import { TOOL_LABELS } from "@/components/AgentTrace";

function when(at: number): string {
  const d = new Date(at * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export default function AuditLog() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const got = await auditRecent(50);
    if (got) { setRows(got); setFailed(false); } else { setFailed(true); }
  }, []);

  useEffect(() => { if (API_URL) void load(); }, [load]);

  if (!API_URL) return null;
  const list = rows ?? [];

  return (
    <section className="rounded-forge border border-panel p-3" aria-label="操作の記録">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">操作の記録</span>
        <button type="button" onClick={() => void load()}
          className="text-[10px] text-muted underline label-mono">読み直す</button>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        AIbouがあなたの代わりに<b className="text-fg-strong">外で</b>したこと
        （メール・予定・手元のファイル・ブラウザ・手順）を新しい順に出します。
        確認して押したのか、確認なしで動いたのかも残ります。本文は残していません。
      </p>

      {failed && <p className="text-[11px] text-[#ffb4b4]">記録を取得できませんでした</p>}
      {rows && !list.length && (
        <p className="text-[11px] text-muted">まだありません。</p>
      )}

      <ol className="flex flex-col gap-1">
        {list.map((r) => (
          <li key={r.id} className="rounded-forge border border-panel px-2 py-1.5 text-[11px] leading-relaxed">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span aria-label={r.ok ? "できた" : "できなかった"}
                    style={{ color: r.ok ? "var(--accent)" : "#ffb4b4" }}>
                {r.ok ? "✓" : "✗"}
              </span>
              <span className="text-muted label-mono">{when(r.at)}</span>
              <span className="text-fg-strong">{TOOL_LABELS[r.tool] || r.tool}</span>
              <span className="rounded-full border border-panel px-1.5 text-[10px] text-muted">
                {r.source_label || r.source}
              </span>
              {/* 確認なしで動いた物を拾えるように、はっきり分ける */}
              <span className="rounded-full border px-1.5 text-[10px]"
                    style={r.approved
                      ? { borderColor: "var(--line)", color: "var(--accent)" }
                      : { borderColor: "#ffd06055", color: "#ffd060" }}>
                {r.approved ? "確認して実行" : "確認なし"}
              </span>
            </div>
            {r.target && <div className="break-all text-fg">{r.target}</div>}
            {r.where && <div className="text-[10px] text-muted">{r.where}</div>}
            {r.instruction && (
              <div className="text-[10px] text-muted">頼まれた言葉: {r.instruction}</div>
            )}
            {!r.ok && r.summary && <div className="text-[10px] text-[#ffb4b4]">{r.summary}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}
