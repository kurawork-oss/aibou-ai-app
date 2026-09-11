"use client";

/**
 * 通知の設定。
 *
 * ここで一番大事なのは**断られた理由を出すこと**。
 * 通知まわりは「押しても何も起きない」形で失敗する:
 *
 *   ・iPhone は、ホーム画面に追加していないと何も起きない
 *   ・一度「許可しない」を選ぶと、次からダイアログすら出ない
 *   ・http のページでは、そもそも機能が無い
 *
 * どれも押した人から見れば「壊れている」にしか見えないので、
 * 状態と、次に何をすればいいかを必ず文で出す。
 */

import { useCallback, useEffect, useState } from "react";
import { disable, enable, sendTest, status, type PushStatus } from "@/lib/push";

const TONE: Record<string, string> = {
  on: "#60d394",
  denied: "#ff9d9d",
  insecure: "#ff9d9d",
  unsupported: "var(--muted)",
  "needs-install": "#ffd060",
  "no-backend": "#ffd060",
  off: "var(--muted)",
};

const LABEL: Record<string, string> = {
  on: "届きます",
  off: "まだ許可していません",
  denied: "拒否されています",
  insecure: "使えません（https が必要）",
  unsupported: "このブラウザでは使えません",
  "needs-install": "ホーム画面に追加が必要",
  "no-backend": "接続先がありません",
};

export default function PushSettings() {
  const [st, setSt] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    setSt(await status());
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onEnable = async () => {
    setBusy(true);
    setNote("");
    const next = await enable();
    setSt(next);
    setBusy(false);
  };

  const onDisable = async () => {
    setBusy(true);
    setNote("");
    setSt(await disable());
    setBusy(false);
  };

  const onTest = async () => {
    setBusy(true);
    const r = await sendTest();
    setNote(r.detail);
    setBusy(false);
  };

  const state = st?.state ?? "off";
  const canTry = state === "off" || state === "no-backend";

  return (
    <section className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">端末への通知</span>
        <span className="text-[10px] label-mono" style={{ color: TONE[state] || "var(--muted)" }}>
          {LABEL[state] || state}
        </span>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        許可すると、見ていない間に決まったことや、確認が必要になったことが
        この端末に届きます。LINE や Slack と違って、他所への登録は要りません。
      </p>

      {st?.reason && (
        <p className="mb-2 text-[11px] leading-relaxed"
           style={{ color: state === "on" ? "var(--muted)" : (TONE[state] || "var(--muted)") }}>
          {st.reason}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {state === "on" ? (
          <>
            <button
              type="button" disabled={busy} onClick={() => void onTest()}
              className="rounded-forge border px-3 py-2 text-[11px] disabled:opacity-50"
              style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}
            >
              {busy ? "送っています…" : "ためしに1通送る"}
            </button>
            <button
              type="button" disabled={busy} onClick={() => void onDisable()}
              className="rounded-forge border border-panel px-3 py-2 text-[11px] text-muted disabled:opacity-50"
            >
              通知を止める
            </button>
          </>
        ) : (
          <button
            type="button" disabled={busy || !canTry} onClick={() => void onEnable()}
            className="rounded-forge border px-3 py-2 text-[11px] disabled:opacity-40"
            style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}
          >
            {busy ? "許可を待っています…" : "通知を許可する"}
          </button>
        )}
      </div>

      {note && <p className="mt-2 text-[11px] leading-relaxed text-muted">{note}</p>}
    </section>
  );
}
