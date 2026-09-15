"use client";

/**
 * 「いつも許可」にした操作を、見て・戻す画面。
 *
 * なぜ要るか
 * ----------
 * 許す口（会話の確認に出る「いつも許可」）だけ作って、取り消す口を
 * 作らないと、**一度押したら二度と戻せない**。しかも押した本人は、
 * 何を許したのかを覚えていない。
 *
 * 許すこと自体は良いことで、同じ確認が繰り返し出ると読まずに押す癖が
 * つく——そうなると本当に読んでほしい確認（送る・お金が動く）も一緒に
 * 素通りする。減らしてよい所を減らすために、戻せる所が要る。
 *
 * 1件も無いときは、何も出さない。まだ一度も押していない人にとっては
 * 意味の無い区画で、設定が長くなるだけなので。
 */

import { useEffect, useState } from "react";
import * as alwaysAllow from "@/lib/alwaysAllow";

export default function AlwaysAllowSettings() {
  const [rows, setRows] = useState<alwaysAllow.Allowed[]>([]);

  // localStorage は描き出しの時点では読めない（サーバー側に無い）
  useEffect(() => { setRows(alwaysAllow.list()); }, []);

  if (!rows.length) return null;

  return (
    <section className="mt-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">いつも許可にした操作</span>
        <span className="text-[10px] text-muted label-mono">{rows.length}件</span>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        この端末では、下の操作を確認なしで実行します。
        <b className="text-fg-strong">送る・投稿する・お金が動く操作は、ここに入れられません</b>
        （必ず確認します）。
      </p>

      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.tool} className="flex items-center gap-2 rounded-forge border border-panel p-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-fg-strong label-mono">{r.tool}</div>
              <div className="text-[10px] text-muted">
                {r.label || "確認なしで実行"}
                {r.at > 0 && ` · ${new Date(r.at).toLocaleDateString("ja-JP")}`}
              </div>
            </div>
            <button
              type="button"
              aria-label={`${r.tool} を毎回確認に戻す`}
              onClick={() => { alwaysAllow.forget(r.tool); setRows(alwaysAllow.list()); }}
              className="shrink-0 text-[10px] text-muted underline label-mono"
            >
              毎回確認に戻す
            </button>
          </div>
        ))}
      </div>

      {rows.length > 1 && (
        <button
          type="button"
          onClick={() => { alwaysAllow.clear(); setRows([]); }}
          className="mt-2 w-full rounded-forge border border-panel px-3 py-2 text-[11px] text-muted"
        >
          全部、毎回確認に戻す
        </button>
      )}
    </section>
  );
}
