"use client";

/**
 * LpBuilder — LP / ホームページ と Webアプリ の作成（base44 / Claude のような体験）.
 *
 *  1. 作りたいものを書く → 1ファイル完結のHTMLを生成
 *  2. 右側でライブプレビュー（PC/スマホ幅を切替）／コード表示
 *  3. 「もっと〇〇して」と指示して反復開発（既存HTMLを渡して直す）
 *  4. .html でダウンロード、または生成物として保存
 *
 * kind="app" のときは「動くWebアプリ」を作る。生成HTMLは外部CDNに依存せず
 * localStorage で保存するので、iframe の中でそのまま操作して動作確認できる。
 */

import { useState } from "react";
import { lpGenerate, API_URL } from "@/lib/api";
import { addToArchive } from "@/components/AppArchive";
import { previewDoc, PREVIEW_SANDBOX } from "@/lib/preview";

const STYLES = [
  { key: "modern", label: "モダン" },
  { key: "bold", label: "力強い" },
  { key: "warm", label: "やわらか" },
  { key: "dark", label: "ダーク" },
  { key: "minimal", label: "ミニマル" },
];

/** kind ごとの文言・例。UIは同じで、指示の出し方だけが変わる。 */
const COPY = {
  lp: {
    heading: "LP / HP",
    cta: "デザインを生成",
    ctaBusy: "デザインを生成中…（20〜40秒ほどかかります）",
    filename: "landing-page",
    newPlaceholder: "例：カフェのLP。自家焙煎が強みで、店舗情報と予約ボタンを入れて",
    refinePlaceholder: "例：ヒーローの色を暖色に。料金表を3プランにして、FAQを増やして",
    empty: ["左に作りたいページを書いて「デザインを生成」", "生成後は「もっと〇〇して」で何度でも直せます"],
    note: "※ 外部CDNに依存しない1ファイルHTMLです。ダウンロードしてそのまま公開できます。",
    examples: [
      "オーガニック食材の宅配サービスのLP。無農薬・当日収穫が強み。申込ボタンを目立たせて",
      "個人トレーナーのホームページ。実績とメニュー料金、体験申込フォームへの導線",
      "AI業務効率化コンサルのLP。中小企業向け、導入事例と無料相談CTA",
    ],
  },
  app: {
    heading: "Webアプリ",
    cta: "アプリを生成",
    ctaBusy: "アプリを生成中…（20〜40秒ほどかかります）",
    filename: "web-app",
    newPlaceholder: "例：家計簿アプリ。日付・費目・金額を入れて一覧表示、月の合計も出して",
    refinePlaceholder: "例：費目でしぼり込めるようにして。合計をグラフでも見せて",
    empty: ["左に作りたいアプリを書いて「アプリを生成」", "プレビューの中でそのまま操作して動作確認できます"],
    note: "※ ブラウザだけで動く1ファイルHTMLです。プレビュー内でそのまま操作できます（プレビューの保存はメモリ上のため、再読込しても残るかは「別タブで開く」やダウンロード後に確認してください）。",
    examples: [
      "家計簿アプリ。日付・費目・金額を入れて一覧表示、月の合計と費目別の内訳も出して",
      "ToDoアプリ。優先度と期限をつけられて、完了したものは折りたたむ",
      "読書記録アプリ。書名・著者・評価（5段階）・感想を保存して、評価順に並べ替え",
      "見積書ジェネレーター。品目と単価と数量から合計と消費税を計算して印刷できる",
    ],
  },
} as const;

export default function LpBuilder({ kind = "lp" }: { kind?: "lp" | "app" }) {
  const t = COPY[kind];
  const [brief, setBrief] = useState("");
  const [style, setStyle] = useState("modern");
  const [html, setHtml] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<"preview" | "code">("preview");
  const [device, setDevice] = useState<"pc" | "sp">("pc");

  const run = async (refine: boolean) => {
    const text = brief.trim();
    if (!text || busy) return;
    setBusy(true);
    setNote(refine ? "修正中…" : t.ctaBusy);
    try {
      const r = await lpGenerate({ brief: text, style, current: refine ? html : "", kind });
      if (r.error || !r.html) {
        setNote(`⚠ ${r.error ?? "生成できませんでした"}`);
      } else {
        setHtml(r.html);
        setTitle(r.title ?? "");
        setNote(refine ? "✓ 修正しました" : "✓ 生成しました");
        setBrief("");
        setView("preview");
        // 作ったものは ARCHIVE に残す。以前はダウンロードしないと消えていて、
        // タブを閉じただけで作業がなくなっていた。
        addToArchive(r.title || text.slice(0, 40), text, r.html, t.note, "html");
      }
    } catch {
      setNote("⚠ 通信に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(title || t.filename).replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 40)}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /** 別タブで開く（アプリはiframeのsandboxを外した素の環境でも確認したい）。 */
  const openInTab = () => {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    // 開いた側が読み終わるまで少し猶予を持たせて解放する
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await lpGenerate({ brief: title || "保存", style, current: html, save: true, kind });
      setNote(r.artifact ? "✓ 生成物に保存しました" : `⚠ ${r.error ?? "保存に失敗"}`);
    } catch { setNote("⚠ 保存に失敗しました"); } finally { setBusy(false); }
  };

  if (!API_URL) {
    return <div className="panel p-3 text-[11px] leading-relaxed text-muted">{t.heading}作成はバックエンド接続後に使えます（設定 →「しらべる」）。</div>;
  }

  return (
    /* min-w-0 が無いと grid の子が内容幅まで広がり、スマホ幅で横にはみ出す。 */
    <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[22rem_1fr]">
      {/* ── 左：指示 ── */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto">
        <div className="panel p-3">
          <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">
            {html ? `${t.heading} — 修正指示` : `${t.heading} — 何を作りますか？`}
          </div>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={5}
            placeholder={html ? t.refinePlaceholder : t.newPlaceholder}
            className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
          />

          <div className="mt-2 flex flex-wrap gap-1">
            {STYLES.map((s) => (
              <button key={s.key} type="button" onClick={() => setStyle(s.key)}
                className="rounded-full border px-2.5 py-1 text-[10px] label-mono"
                style={{
                  borderColor: style === s.key ? "var(--accent)" : "var(--panel-bd)",
                  color: style === s.key ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {s.label}
              </button>
            ))}
          </div>

          <button type="button" onClick={() => void run(!!html)} disabled={busy || !brief.trim()}
            className="mt-2 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">
            {busy ? "…" : html ? "この指示で修正する" : t.cta}
          </button>

          {note && <p className="mt-2 text-[10px] leading-relaxed" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</p>}
        </div>

        {!html && (
          <div className="panel p-3">
            <div className="mb-1.5 text-[9px] tracking-[0.16em] text-muted label-mono">例</div>
            <div className="flex flex-col gap-1.5">
              {t.examples.map((ex) => (
                <button key={ex} type="button" onClick={() => setBrief(ex)}
                  className="rounded-forge border border-panel p-2 text-left text-[10px] leading-relaxed text-muted transition hover:border-[var(--line)] hover:text-fg-strong">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {html && (
          <div className="panel p-3">
            <div className="mb-1.5 text-[9px] tracking-[0.16em] text-muted label-mono">書き出し</div>
            <div className="flex flex-col gap-1.5">
              <button type="button" onClick={download}
                className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.12em] text-fg-strong label-mono">⭳ HTMLをダウンロード</button>
              <button type="button" onClick={openInTab}
                className="rounded-forge border border-panel py-2 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong label-mono">↗ 別タブで開く</button>
              <button type="button" onClick={() => void save()} disabled={busy}
                className="rounded-forge border border-panel py-2 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">生成物に保存</button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">{t.note}</p>
          </div>
        )}
      </div>

      {/* ── 右：プレビュー ── */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <div className="flex overflow-hidden rounded-forge border border-panel">
            {(["preview", "code"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setView(v)}
                className="px-3 py-1 text-[10px] tracking-[0.12em] label-mono"
                style={{ color: view === v ? "var(--fg-strong)" : "var(--muted)", background: view === v ? "var(--btn-bg)" : "transparent" }}>
                {v === "preview" ? "▶ PREVIEW" : "◧ CODE"}
              </button>
            ))}
          </div>
          {view === "preview" && (
            <div className="flex overflow-hidden rounded-forge border border-panel">
              {(["pc", "sp"] as const).map((d) => (
                <button key={d} type="button" onClick={() => setDevice(d)}
                  className="px-3 py-1 text-[10px] label-mono"
                  style={{ color: device === d ? "var(--fg-strong)" : "var(--muted)", background: device === d ? "var(--btn-bg)" : "transparent" }}>
                  {d === "pc" ? "PC" : "スマホ"}
                </button>
              ))}
            </div>
          )}
          {title && <span className="ml-auto truncate text-[10px] text-muted label-mono">{title}</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-forge border border-panel bg-[rgba(255,255,255,0.02)]">
          {!html ? (
            <div className="grid h-full place-items-center p-6 text-center">
              <p className="text-[11px] leading-relaxed tracking-[0.14em] text-muted/60 label-mono">
                {t.empty[0]}<br />{t.empty[1]}
              </p>
            </div>
          ) : view === "code" ? (
            <pre className="h-full overflow-auto p-3 text-[10px] leading-relaxed text-fg"><code>{html}</code></pre>
          ) : (
            /* PCは枠いっぱい、スマホは390px幅で中央寄せ。
               （grid+justify-center だとトラック幅が内容に縮み、width:100%が潰れる） */
            <div className="h-full w-full overflow-auto p-3">
              <div
                className={device === "sp" ? "mx-auto" : "h-full w-full"}
                style={device === "sp" ? { width: 390, height: 780 } : undefined}
              >
                {/* JSを動かして実際に操作できるプレビュー。allow-same-origin は付けない
                    ので親のデータには触れられない（詳細は lib/preview.ts）。 */}
                <iframe
                  key={kind}
                  title={kind === "app" ? "アプリプレビュー" : "LPプレビュー"}
                  srcDoc={previewDoc(html)}
                  sandbox={PREVIEW_SANDBOX}
                  className="h-full w-full border border-panel bg-white"
                  style={{ minHeight: 480 }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
