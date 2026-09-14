"use client";

/**
 * SnsMode — SNS投稿サポート（まずは X と Instagram）.
 *
 *  テーマを書く → 各SNSの作法に合わせた投稿案を複数生成 → コピー、または X へ投稿。
 *
 * X だけは実際に投稿できる（拡張機能で4つの値を入れた場合）。
 * 投稿は取り返しがつかないので、人がこの画面で押したときだけ送る。
 * Instagram はビジネスアカウント＋審査が要るため、いまも下書きまで。
 *  文字数カウンタで上限超過を可視化し、PR案件なら #PR を自動付与する。
 *  自動投稿はしない（X APIは有料枠、Instagramは審査が必要なため、投稿は人が行う）。
 */

import { useEffect, useState } from "react";
import { snsGenerate, xPost, xStatus, API_URL, type SnsPost } from "@/lib/api";
import { explain } from "@/lib/needs";

const PLATFORMS = [
  { key: "x", label: "X", limit: 280, hint: "280字・タグ1〜3個" },
  { key: "instagram", label: "Instagram", limit: 2200, hint: "キャプション＋タグ10〜15個" },
];

const TONES = ["自然体", "丁寧", "フレンドリー", "専門家", "親しみやすく短め"];

export default function SnsMode() {
  const [platform, setPlatform] = useState("x");
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState("");
  const [promo, setPromo] = useState(false);
  const [thread, setThread] = useState(false);
  const [withImages, setWithImages] = useState(false);
  const [posts, setPosts] = useState<SnsPost[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  // Xへの実投稿。設定が済んでいるときだけボタンを出す（押せない物を見せない）
  const [xReady, setXReady] = useState(false);
  const [posting, setPosting] = useState<number | null>(null);
  const [postNote, setPostNote] =
    useState<{ i: number; text: string; ok: boolean; url?: string } | null>(null);

  useEffect(() => {
    if (!API_URL) return;
    xStatus().then((st) => setXReady(st.configured)).catch(() => setXReady(false));
  }, []);

  const meta = PLATFORMS.find((p) => p.key === platform) ?? PLATFORMS[0];

  /** 実際にXへ送る。押した人が内容を見たうえで送る、という前提の入口。 */
  const doPost = async (p: SnsPost, i: number) => {
    const body = [p.text, p.hashtags.join(" ")].filter(Boolean).join("\n\n");
    if (!window.confirm(`Xに投稿します。取り消せません。\n\n${body}`)) return;
    setPosting(i);
    setPostNote(null);
    try {
      const r = await xPost(body);
      if (r.ok) setPostNote({ i, ok: true, text: "投稿しました。", url: r.url });
      else setPostNote({ i, ok: false, text: r.error ?? "投稿できませんでした" });
    } catch (e) {
      setPostNote({ i, ok: false, text: explain(e, "Xへの投稿") });
    } finally {
      setPosting(null);
    }
  };

  const run = async () => {
    if (!topic.trim() || busy) return;
    setBusy(true);
    setNote("投稿案を作成中…");
    setPosts([]);
    try {
      const r = await snsGenerate({ platform, topic: topic.trim(), n: 3, tone, promo, thread, withImages });
      if (r.error || !r.posts?.length) setNote(`⚠ ${r.error ?? "生成できませんでした"}`);
      else { setPosts(r.posts); setNote(`✓ ${r.posts.length}案できました`); }
    } catch { setNote("⚠ 通信に失敗しました"); } finally { setBusy(false); }
  };

  const copy = async (p: SnsPost, i: number) => {
    const body = p.text + (p.hashtags.length ? `\n\n${p.hashtags.join(" ")}` : "");
    try {
      await navigator.clipboard?.writeText(body);
      setCopied(i);
      setTimeout(() => setCopied(null), 1600);
    } catch { /* ignore */ }
  };

  if (!API_URL) {
    return (
      <div className="mx-auto max-w-xl">
        <div className="panel p-3 text-[11px] leading-relaxed text-muted">
          SNSサポートはバックエンド接続後に使えます（Settings → DIAGNOSTICS）。
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-3 overflow-y-auto pb-2">
      {/* 入力 */}
      <div className="glass-silver p-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] tracking-[0.24em] text-muted label-mono">SNS SUPPORT</span>
        </div>
        <h2 className="label-mono text-glow text-sm text-fg-strong">SNS投稿サポート</h2>
        {/* 見出しだけだと、何を入れて何が返るのかが分からない */}
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          伝えたいことを1行書くと、<span className="text-fg">投稿先ごとの書き方に合わせた文案</span>を作ります。
          文字数やタグの付け方は、選んだ投稿先に合わせて変わります。
        </p>

        {/* プラットフォーム */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {PLATFORMS.map((p) => {
            const active = platform === p.key;
            return (
              <button key={p.key} type="button" onClick={() => { setPlatform(p.key); setPosts([]); }}
                className="rounded-forge border p-2 text-center transition"
                style={{
                  borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                  background: active ? "var(--btn-bg)" : "transparent",
                  boxShadow: active ? "0 0 10px var(--glow)" : "none",
                }}>
                <div className="text-[12px] text-fg-strong label-mono">{p.label}</div>
                <div className="mt-0.5 text-[11px] text-muted">{p.hint}</div>
              </button>
            );
          })}
        </div>

        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={3}
          placeholder="例：朝の散歩を習慣にすると集中力が上がる話／新商品の紹介／今日の学び"
          className="mt-3 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
        />

        {/* トーン */}
        <div className="mt-2 flex flex-wrap gap-1">
          {TONES.map((t) => (
            <button key={t} type="button" onClick={() => setTone(tone === t ? "" : t)}
              className="rounded-full border px-2.5 py-1 text-[10px]"
              style={{ borderColor: tone === t ? "var(--accent)" : "var(--panel-bd)", color: tone === t ? "var(--fg-strong)" : "var(--muted)" }}>
              {t}
            </button>
          ))}
        </div>

        {/* オプション */}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-muted">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={promo} onChange={(e) => setPromo(e.target.checked)} className="accent-[var(--accent)]" />
            PR・宣伝投稿（#PRを自動付与）
          </label>
          {platform === "x" && (
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={thread} onChange={(e) => setThread(e.target.checked)} className="accent-[var(--accent)]" />
              スレッド案も作る
            </label>
          )}
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={withImages} onChange={(e) => setWithImages(e.target.checked)} className="accent-[var(--accent)]" />
            画像も生成する
          </label>
        </div>

        <button type="button" onClick={() => void run()} disabled={busy || !topic.trim()}
          className="mt-3 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">
          {busy ? "…" : "投稿案を3つ作る"}
        </button>
        {note && <p className="mt-2 text-[10px]" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</p>}
      </div>

      {/* 結果 */}
      {posts.map((p, i) => (
        <div key={i} className="glass-silver p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[9px] tracking-[0.16em] text-muted label-mono">案 {i + 1}</span>
            <span className="text-[9px] label-mono" style={{ color: p.over_limit ? "#ff6b6b" : "#60d394" }}>
              {p.length} / {meta.limit}{p.over_limit ? " 超過" : ""}
            </span>
          </div>

          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{p.text}</p>

          {p.hashtags.length > 0 && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--accent)]">{p.hashtags.join(" ")}</p>
          )}

          {p.thread && p.thread.length > 0 && (
            <div className="mt-2 border-l-2 border-panel pl-2">
              <div className="text-[9px] tracking-[0.14em] text-muted label-mono">スレッド案</div>
              {p.thread.map((t, ti) => (
                <p key={ti} className="mt-1 text-[11px] leading-relaxed text-muted">{ti + 2}. {t}</p>
              ))}
            </div>
          )}

          {p.image_url && (
            <a href={p.image_url} target="_blank" rel="noopener noreferrer" className="mt-2 block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.image_url} alt="生成画像" className="max-h-56 rounded-forge border border-panel object-cover" />
            </a>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" onClick={() => void copy(p, i)}
              className="min-w-0 flex-1 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-1.5 text-[10px] tracking-[0.12em] text-fg-strong label-mono">
              {copied === i ? "✓ コピーしました" : "⧉ 本文＋タグをコピー"}
            </button>
            {/* Xだけは実際に投稿できる。押した人が内容を見た上で送る */}
            {platform === "x" && xReady && (
              <button type="button" onClick={() => void doPost(p, i)}
                disabled={posting !== null || p.over_limit}
                className="shrink-0 rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.12em] label-mono disabled:opacity-40"
                style={{ borderColor: "var(--accent)", color: "var(--fg-strong)", background: "var(--btn-bg)" }}>
                {posting === i ? "投稿中…" : "𝕏 に投稿"}
              </button>
            )}
          </div>
          {postNote?.i === i && (
            <p role="status" aria-live="polite" className="mt-1.5 text-[11px] leading-relaxed"
               style={{ color: postNote.ok ? "#60d394" : "#ff9b9b" }}>
              {postNote.text}
              {postNote.url && (
                <a href={postNote.url} target="_blank" rel="noopener noreferrer"
                   className="ml-1 underline">投稿を見る</a>
              )}
            </p>
          )}
        </div>
      ))}

      {posts.length > 0 && (
        <p className="px-1 text-[11px] leading-relaxed text-muted">
          {platform === "x" && xReady
            ? "※ 「𝕏 に投稿」を押したときだけ送ります。自動実行からは投稿しません。PR案件は表記を消さないでください。"
            : platform === "x"
              ? "※ Xに直接投稿するには、管理 → もっと →「連携」→ X で4つの値を設定してください。設定するまではコピーして投稿します。"
              : "※ Instagramはビジネスアカウント＋審査が必要なため、直接の投稿はできません。コピーして各アプリから投稿してください。PR案件は表記を消さないでください。"}
        </p>
      )}
    </div>
  );
}
