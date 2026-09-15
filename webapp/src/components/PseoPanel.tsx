"use client";

/**
 * PseoPanel — Programmatic SEO（掛け合わせキーワードの大量ページ）管理.
 *
 *  1. 軸を入れる（例：軸1「筋トレ, ヨガ」× 軸2「初心者, 自宅」）→ 計画をプレビュー
 *  2. 「下書きを生成」でAIが本文を執筆 → すべて draft（非公開）で保存
 *  3. 内容を確認して「公開」= 承認したページだけが /g/{slug} と sitemap.xml に出る
 *
 * セミオート原則：AIが勝手に公開することはない（暴走・誤情報の防止）。
 */

import { useCallback, useEffect, useState } from "react";
import {
  pseoPlan, pseoGenerate, pseoPages, pseoSetStatus, pseoDelete,
  API_URL, type PseoPage, type PseoSpec,
} from "@/lib/api";

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "下書き", color: "#ffd060" },
  approved: { label: "公開中", color: "#60d394" },
  rejected: { label: "却下", color: "#ff6b6b" },
};

export default function PseoPanel() {
  const [ax1, setAx1] = useState("");
  const [ax2, setAx2] = useState("");
  const [template, setTemplate] = useState("");
  const [limit, setLimit] = useState(5);
  const [plan, setPlan] = useState<PseoSpec[]>([]);
  const [pages, setPages] = useState<PseoPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const axes = (): string[][] =>
    [ax1, ax2]
      .map((s) => s.split(/[,、]/).map((v) => v.trim()).filter(Boolean))
      .filter((a) => a.length > 0);

  const load = useCallback(async () => {
    if (!API_URL) return;
    try { setPages(await pseoPages()); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const doPlan = async () => {
    const a = axes();
    if (!a.length) { setNote("⚠ 軸を1つ以上入れてください"); return; }
    setBusy(true); setNote(null);
    try { setPlan(await pseoPlan(a, template, 50)); }
    catch { setNote("⚠ 計画の取得に失敗しました"); }
    finally { setBusy(false); }
  };

  const doGenerate = async () => {
    const a = axes();
    if (!a.length) { setNote("⚠ 軸を1つ以上入れてください"); return; }
    setBusy(true); setNote("生成中…（1ページあたり数秒かかります）");
    try {
      const r = await pseoGenerate(a, template, limit);
      setNote(r.error ? `⚠ ${r.error}` : `✓ 下書きを${r.count}ページ生成しました（未公開）`);
      await load();
    } catch { setNote("⚠ 生成に失敗しました"); }
    finally { setBusy(false); }
  };

  const setStatus = async (slug: string, status: "approved" | "rejected" | "draft") => {
    await pseoSetStatus(slug, status);
    await load();
  };
  const remove = async (slug: string) => {
    if (!window.confirm(`「${slug}」を削除しますか？`)) return;
    await pseoDelete(slug);
    await load();
  };

  if (!API_URL) {
    return (
      <div className="panel p-3 text-[11px] leading-relaxed text-muted">
        Programmatic SEO はバックエンド接続後に使えます（設定 →「しらべる」）。
      </div>
    );
  }

  const drafts = pages.filter((p) => p.status === "draft").length;
  const live = pages.filter((p) => p.status === "approved").length;

  return (
    <div className="flex flex-col gap-3">
      {/* Builder */}
      <div className="panel p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] tracking-[0.2em] text-muted label-mono">PROGRAMMATIC SEO — 掛け合わせページ</span>
          <span className="text-[9px] text-muted label-mono">下書き {drafts} · 公開 {live}</span>
        </div>
        <p className="mb-2 text-[10px] leading-relaxed text-muted">
          2つの軸を掛け合わせて、競合が手作業でやらない細かいキーワードのページを量産します。
          生成物は<b className="text-fg">必ず下書き</b>で保存され、承認したページだけが公開されます。
        </p>

        <div className="flex flex-col gap-2">
          <input value={ax1} onChange={(e) => setAx1(e.target.value)}
            placeholder="軸1（カンマ区切り）例：筋トレ, ヨガ, ランニング"
            className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none" />
          <input value={ax2} onChange={(e) => setAx2(e.target.value)}
            placeholder="軸2（任意）例：初心者, 自宅, 40代"
            className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none" />
          <div className="flex gap-2">
            <input value={template} onChange={(e) => setTemplate(e.target.value)}
              placeholder="タイトル型（任意）例：{1}向け{0}のはじめ方"
              className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-[12px] text-fg-strong placeholder:text-muted focus:outline-none" />
            <input type="number" min={1} max={20} value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
              aria-label="生成ページ数"
              className="w-20 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-fg-strong focus:outline-none" />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void doPlan()} disabled={busy}
              className="flex-1 rounded-forge border border-panel py-2 text-[10px] tracking-[0.14em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">
              計画をプレビュー
            </button>
            <button type="button" onClick={() => void doGenerate()} disabled={busy}
              className="flex-1 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.14em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">
              {busy ? "…" : `下書きを生成（${limit}ページ）`}
            </button>
          </div>
        </div>

        {note && <p className="mt-2 text-[10px]" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</p>}

        {plan.length > 0 && (
          <div className="mt-2 max-h-32 overflow-y-auto rounded-forge border border-panel p-2">
            <div className="mb-1 text-[9px] tracking-[0.14em] text-muted label-mono">計画 {plan.length}ページ</div>
            {plan.slice(0, 30).map((s) => (
              <div key={s.slug} className="truncate text-[11px] text-fg">・{s.title}</div>
            ))}
          </div>
        )}
      </div>

      {/* Pages */}
      <div className="panel p-3">
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">生成ページ — 承認して公開</div>
        {pages.length === 0 ? (
          <p className="text-[11px] text-muted">まだページがありません。上で下書きを生成してください。</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {pages.map((p) => {
              const st = STATUS_META[p.status] ?? STATUS_META.draft;
              const isOpen = open === p.slug;
              return (
                <div key={p.slug} className="rounded-forge border border-panel p-2">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] label-mono"
                      style={{ background: `${st.color}22`, color: st.color, border: `1px solid ${st.color}44` }}>{st.label}</span>
                    <button type="button" onClick={() => setOpen(isOpen ? null : p.slug)} className="min-w-0 flex-1 truncate text-left text-[12px] text-fg">
                      {p.title}
                    </button>
                    {p.status === "approved" && (
                      <a href={`/g/${encodeURIComponent(p.slug)}`} target="_blank" rel="noopener noreferrer"
                        title="公開ページを開く" className="shrink-0 text-[10px] text-[var(--accent)] label-mono">↗</a>
                    )}
                    {p.status !== "approved" ? (
                      <button type="button" onClick={() => void setStatus(p.slug, "approved")}
                        className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-2 py-1 text-[9px] text-fg-strong label-mono">公開</button>
                    ) : (
                      <button type="button" onClick={() => void setStatus(p.slug, "draft")}
                        className="shrink-0 rounded-forge border border-panel px-2 py-1 text-[9px] text-muted label-mono">非公開に</button>
                    )}
                    <button type="button" onClick={() => void remove(p.slug)} className="shrink-0 text-[10px] text-[#ff8888]">✕</button>
                  </div>

                  {isOpen && (
                    <div className="mt-2 border-t border-panel pt-2">
                      {p.content?.disclosure && (
                        <p className="mb-1 text-[11px] text-[#ffd060]">{p.content.disclosure}</p>
                      )}
                      {p.content?.lead && <p className="text-[11px] leading-relaxed text-muted">{p.content.lead}</p>}
                      {(p.content?.sections ?? []).map((s, i) => (
                        <div key={i} className="mt-1.5">
                          <div className="text-[11px] text-fg-strong">■ {s.h2}</div>
                          <p className="text-[10px] leading-relaxed text-muted line-clamp-3">{s.body}</p>
                        </div>
                      ))}
                      <div className="mt-1.5 text-[9px] text-muted label-mono">/g/{p.slug}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          ※ 公開ページには景品表示法（ステマ規制）対応の表記が自動で入ります。
          Google Search Console に <code className="text-fg">/sitemap.xml</code> を登録すると承認済みページが順次インデックスされます。
        </p>
      </div>
    </div>
  );
}
