"use client";

/**
 * FeaturePacks — 使う機能のかたまりを、まとめて入り切りする。
 *
 * なぜ要るか
 * ----------
 * 機能が多いのは、AIに任せられる幅が広いということで、それ自体は強み。
 * ただし全員が全部を使うわけではない。開発をしない人に「コード」の
 * 道具を持たせておくと、二つ損をする。
 *
 *   1. `#` の候補に、絶対に使わない物が混ざる
 *   2. AIに渡す道具の説明が長くなり、毎回のやり取りが重くなる
 *
 * 個別の40項目を並べても選べないので、「何をする人か」の粒度で束ねる。
 *
 * 切ると何が起きるか
 * ------------------
 * その機能の**画面は消えない**。消えるのは
 *   - `#` の近道
 *   - AIが自分で選べる道具
 * だけ。だから切ったあとで気が変わっても、管理タブからは触れる。
 * 「切ったら二度と使えない」という怖さを作らないための線引き。
 *
 * 「仕事の基本」は切れない。切るとタスクも予定もメールも見張りも
 * 使えなくなり、相棒がほぼ何も出来なくなる（サーバー側も拒む）。
 */

import { useCallback, useEffect, useState } from "react";

import { API_URL, capabilities, setPacks, type FeaturePack } from "@/lib/api";
import { announcePacksChanged } from "@/lib/shell";

export default function FeaturePacks() {
  const [packs, setList] = useState<FeaturePack[] | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await capabilities();
      setList(d.packs);
    } catch {
      setList([]);
    }
  }, []);

  useEffect(() => { if (API_URL) void load(); }, [load]);

  if (!API_URL) {
    return (
      <div className="mb-4 rounded-forge border border-panel p-3 text-[11px] leading-relaxed text-muted">
        使う機能の切り替えは、バックエンド接続後に使えます（DIAGNOSTICS参照）。
      </div>
    );
  }

  const toggle = async (p: FeaturePack) => {
    if (p.always || !packs) return;
    setBusy(p.key);
    setNote("");
    // 押した通りに先に描く（往復を待つと、反応が無いように見える）
    const next = packs.map((x) => x.key === p.key ? { ...x, enabled: !x.enabled } : x);
    setList(next);
    const res = await setPacks(next.filter((x) => x.enabled).map((x) => x.key))
      .catch((e: unknown) => ({
        ok: false,
        error: e instanceof Error ? e.message : "保存できませんでした",
      }));
    setBusy("");
    if (!res.ok) {
      // 保存できていないのに、切り替わったように見せない。
      // 理由はサーバーの言葉をそのまま出す（保存先が無いのに
      // 「通信を確かめて」と言うと、直しようがない）。
      setList(packs);
      setNote(res.error || "保存できませんでした");
      return;
    }
    await load();
    // 開いている会話の `#` の候補も入れ替える（切ったのに残っていた）
    announcePacksChanged();
  };

  return (
    <div className="mb-5">
      <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">
        USE THESE
      </label>
      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        使わない物を切ると、<code>#</code> の候補とAIが選ぶ道具から外れます。
        画面は消えないので、あとから管理タブで触れます。
      </p>

      {packs === null ? (
        <p className="text-[11px] text-muted">読み込み中…</p>
      ) : packs.length === 0 ? (
        <p className="text-[11px] text-muted">
          いま取得できませんでした。通信を確かめてから、設定を開き直してください。
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {packs.map((p) => (
            <label
              key={p.key}
              className="flex items-center justify-between gap-3 rounded-forge border border-panel px-3 py-2.5"
              style={{ opacity: p.always ? 0.75 : 1 }}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-fg-strong">
                  {p.label}
                  {p.always && (
                    <span className="ml-1.5 text-[10px] text-muted">（切れません）</span>
                  )}
                </span>
                <span className="block text-[11px] leading-relaxed text-muted">{p.hint}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={p.enabled}
                disabled={p.always || busy === p.key}
                onChange={() => void toggle(p)}
                aria-label={`${p.label}を使う`}
                className="h-5 w-5 shrink-0 accent-[var(--accent)]"
              />
            </label>
          ))}
        </div>
      )}

      {note && <p className="mt-2 text-[11px] text-[#ff9b9b]">{note}</p>}
    </div>
  );
}
