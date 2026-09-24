"use client";

/**
 * NewsletterPanel — ⑤ 顧客リスト（購読者）＋ 定期配信の管理.
 *
 *  - 購読者：SEOページのフォームから集まる。確認メール済み(confirmed)だけが配信対象。
 *  - 配信：件名＋（テーマを渡せばAIが本文執筆）で下書き → テスト送信 → 本送信。
 *  - 全配信メールに配信停止リンクが自動で入る（特定電子メール法の要件）。
 */

import { useCallback, useEffect, useState } from "react";
import {
  newsletterSubscribers, newsletterIssues, newsletterDraft, newsletterSend,
  API_URL, type Subscriber, type NewsletterStats, type NewsletterIssue,
} from "@/lib/api";

const maskEmail = (e: string) => {
  const [u, d] = (e || "").split("@");
  if (!d) return e;
  return `${u.slice(0, 2)}${u.length > 2 ? "•••" : ""}@${d}`;
};

export default function NewsletterPanel() {
  const [subs, setSubs] = useState<Subscriber[]>([]);
  const [stats, setStats] = useState<NewsletterStats | null>(null);
  const [issues, setIssues] = useState<NewsletterIssue[]>([]);
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [body, setBody] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!API_URL) return;
    try {
      const [s, i] = await Promise.all([newsletterSubscribers(), newsletterIssues()]);
      setSubs(s.items);
      setStats(s.stats);
      setIssues(i);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const draft = async () => {
    if (!subject.trim()) { setNote("⚠ 件名を入れてください"); return; }
    setBusy(true); setNote(topic.trim() ? "AIが本文を執筆中…" : null);
    try {
      const r = await newsletterDraft(subject.trim(), body.trim(), topic.trim());
      setNote(r.error ? `⚠ ${r.error}` : "✓ 下書きを作成しました（まだ送信していません）");
      if (!r.error) { setSubject(""); setTopic(""); setBody(""); }
      await load();
    } catch { setNote("⚠ 作成に失敗しました"); }
    finally { setBusy(false); }
  };

  const send = async (id: string, test: boolean) => {
    if (test && !testTo.trim()) { setNote("⚠ テスト送信先を入れてください"); return; }
    if (!test && !window.confirm(`確認済みの購読者 ${stats?.confirmed ?? 0} 名に送信します。よろしいですか？`)) return;
    setBusy(true); setNote("送信中…");
    try {
      const r = await newsletterSend(id, test ? testTo.trim() : "");
      setNote(r.error ? `⚠ ${r.error}` : `✓ ${r.sent}件に送信しました`);
      await load();
    } catch { setNote("⚠ 送信に失敗しました"); }
    finally { setBusy(false); }
  };

  if (!API_URL) {
    return <div className="panel p-3 text-[11px] leading-relaxed text-muted">ニュースレターはバックエンド接続後に使えます。</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Stats */}
      <div className="panel p-3">
        <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">NEWSLETTER — 顧客リスト</div>
        <div className="grid grid-cols-4 gap-2">
          {[
            { k: "total", label: "合計" },
            { k: "confirmed", label: "配信対象" },
            { k: "pending", label: "確認待ち" },
            { k: "unsubscribed", label: "停止" },
          ].map((s) => (
            <div key={s.k} className="rounded-forge border border-panel p-2 text-center">
              <div className="text-base font-semibold text-fg-strong">{(stats as unknown as Record<string, number>)?.[s.k] ?? 0}</div>
              <div className="text-[8px] tracking-[0.12em] text-muted label-mono">{s.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          SEOページ（/g/…）の登録フォームから集まります。確認メールのリンクを踏んだ方だけが配信対象です。
        </p>
        {subs.length > 0 && (
          <div className="mt-2 max-h-28 overflow-y-auto rounded-forge border border-panel p-2">
            {subs.slice(0, 20).map((s) => (
              <div key={s.email} className="flex items-center justify-between gap-2 text-[10px]">
                <span className="truncate text-fg">{maskEmail(s.email)}</span>
                <span className="shrink-0 label-mono" style={{ color: s.status === "confirmed" ? "#60d394" : s.status === "pending" ? "#ffd060" : "#8b8f97" }}>
                  {s.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Compose */}
      <div className="panel p-3">
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">配信を作る</div>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="件名"
          className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:outline-none" />
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="テーマ（入れるとAIが本文を書きます・任意）"
          className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-[12px] text-fg-strong placeholder:text-muted focus:outline-none" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="本文（テーマを入れた場合は空でOK）"
          className="mb-2 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-[12px] text-fg-strong placeholder:text-muted focus:outline-none" />
        <button type="button" onClick={() => void draft()} disabled={busy}
          className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.14em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">
          {busy ? "…" : "下書きを作成"}
        </button>
        {note && <p className="mt-2 text-[10px]" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</p>}
      </div>

      {/* Issues */}
      <div className="panel p-3">
        <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">配信一覧 — 承認して送信</div>
        <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="テスト送信先メール（自分のアドレス）"
          className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-[12px] text-fg-strong placeholder:text-muted focus:outline-none" />
        {issues.length === 0 ? (
          <p className="text-[11px] text-muted">まだ配信はありません。</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {issues.map((i) => (
              <div key={i.id} className="rounded-forge border border-panel p-2">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] label-mono"
                    style={{ color: i.status === "sent" ? "#60d394" : "#ffd060", border: `1px solid ${i.status === "sent" ? "#60d39444" : "#ffd06044"}` }}>
                    {i.status === "sent" ? `送信済 ${i.sent_count ?? 0}` : "下書き"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{i.subject}</span>
                  <button type="button" onClick={() => void send(i.id, true)} disabled={busy}
                    className="shrink-0 rounded-forge border border-panel px-2 py-1 text-[9px] text-muted label-mono">テスト</button>
                  <button type="button" onClick={() => void send(i.id, false)} disabled={busy}
                    className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-2 py-1 text-[9px] text-fg-strong label-mono">送信</button>
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-muted line-clamp-2">{i.body}</p>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          ※ 全配信メールに配信停止リンクが自動で入ります。送信には「連携」のメール（EMAIL_ADDRESS / EMAIL_PASSWORD）が必要です。
          配信停止リンクを機能させるには、バックエンドに <code className="text-fg">PUBLIC_SITE_URL</code> を設定してください。
        </p>
      </div>
    </div>
  );
}
