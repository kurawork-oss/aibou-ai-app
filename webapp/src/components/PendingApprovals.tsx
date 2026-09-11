"use client";

/**
 * 承認待ちの一覧。
 *
 * なぜ画面にも要るのか
 * --------------------
 * 通知から答えられるようにしたが、通知は**届かないことがある**。
 * 端末で切っている、まだ許可していない、iPhone でホーム画面に
 * 追加していない、圏外だった——どれも普通に起きる。
 *
 * そのとき通知だけが窓口だと、「止まっていること自体が誰にも
 * 伝わらない」という、直したはずの状態へそのまま戻る。
 * だから開けば必ず見える場所にも置く。
 *
 * ここからの「実行する」は、ログイン済みの画面から叩くので合言葉は
 * 要らない（合言葉は、ログイン情報を持てないサービスワーカー用）。
 */

import { useCallback, useEffect, useState } from "react";
import { API_URL, authHeaders } from "@/lib/api";

interface Approval {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  note?: string;
  why?: string;
  source?: string;
  created_at?: number;
}

export default function PendingApprovals() {
  const [items, setItems] = useState<Approval[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!API_URL) return;
    try {
      const r = await fetch(`${API_URL}/approvals`, { headers: authHeaders(), cache: "no-store" });
      const b = await r.json().catch(() => null);
      setItems(Array.isArray(b?.items) ? b.items : []);
    } catch {
      /* 見えないだけ。ここで騒ぐと、繋がっていない人に毎回出る */
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const answer = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    setError("");
    try {
      /* 画面からは、合言葉の要らない口を使う（ログイン済みなので）。
         合言葉の口（/approvals/answer）は、ログイン情報を持てない
         サービスワーカー専用。入口を分けてあるのは、片方を緩めたときに
         もう片方まで通らないようにするため。 */
      const r = await fetch(`${API_URL}/approvals/${encodeURIComponent(id)}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ decision }),
      });
      const b = await r.json().catch(() => null);
      if (!b?.ok) setError(b?.error || "答えられませんでした。");
    } catch {
      setError("答えられませんでした（通信に失敗）。");
    }
    setBusy("");
    await load();
  };

  if (!items.length) return null;

  return (
    <section className="mb-3 rounded-forge border p-3"
             style={{ borderColor: "#ffd06055", background: "rgba(255,208,96,0.06)" }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] label-mono" style={{ color: "#ffd060" }}>
          確認待ち {items.length} 件
        </span>
        <button type="button" onClick={() => void load()}
                className="text-[10px] text-muted underline label-mono">
          読み直す
        </button>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        見ていない間に、取り返せない操作の手前で止まっています。
      </p>

      <div className="flex flex-col gap-2">
        {items.map((a) => (
          <div key={a.id} className="rounded-forge border border-panel p-2">
            <div className="text-[11px] text-fg-strong">{a.note || a.tool}</div>
            {a.why && (
              <div className="mt-0.5 text-[11px] leading-relaxed" style={{ color: "#ffd060" }}>
                {a.why}
              </div>
            )}
            <div className="mt-0.5 text-[10px] text-muted label-mono">
              {a.tool}{a.source ? ` · ${a.source === "schedule" ? "定期実行" : a.source}` : ""}
            </div>
            <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted">
              {JSON.stringify(a.params, null, 1)}
            </pre>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button" disabled={busy === a.id}
                onClick={() => void answer(a.id, "approve")}
                className="rounded-forge border px-3 py-1.5 text-[10px] label-mono disabled:opacity-50"
                style={{ borderColor: "var(--line)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}
              >
                実行する
              </button>
              <button
                type="button" disabled={busy === a.id}
                onClick={() => void answer(a.id, "reject")}
                className="rounded-forge border border-panel px-3 py-1.5 text-[10px] text-muted label-mono disabled:opacity-50"
              >
                やめる
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-[11px]" style={{ color: "#ff9d9d" }}>{error}</p>}
    </section>
  );
}
