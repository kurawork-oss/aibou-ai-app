"use client";

/**
 * Canvas — 会話の隣に、いま出来た物を出す面。
 *
 * なぜ要るか
 * ----------
 * 会話が得意なのは**出来事**、苦手なのは**物**。
 *
 *   「画像を作って」          → 出来事。会話で頼める
 *   出来た画像そのもの        → 物。吹き出しに押し込むと見られない
 *
 * ここまで、道具は全部「文字列」を返していた。だから画像を作っても
 *
 *     「画像を生成しました：https://…（HOMEの『生成物』からも見られます）」
 *
 * としか言えず、頼んだ人は別の画面へ見に行くことになっていた。
 * 作っておいて住所を渡すのは、渡していないのと同じ。
 *
 * 置き方
 * ------
 *   スマホ … 会話の上にかぶせるシート（下から出る）。会話は後ろに残る
 *   PC    … 左に会話、右にキャンバス（同時に見える）
 *
 * 閉じても失われない
 * ------------------
 * 出た物は生成物として保存済みなので、閉じても「管理 → ファイル」から
 * 開き直せる。**閉じると消える物は置かない**——消えるかもしれない物を
 * 前に置かれると、人は閉じられなくなる。
 *
 * 溜めない
 * --------
 * 出来た順に積むが、上限を持つ。会話のログをもう1本作るのが目的では
 * ないので、古い物は落とす（保存済みなので失われない）。
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import Markdown from "@/components/Markdown";
import SlideView, { getTheme } from "@/components/SlideView";
import type { MadeItem } from "@/lib/api";

/** 手元に残す数。これを超えたら古い物から落とす（保存済みなので消えない）。 */
export const KEEP = 12;

/** 出来た物を積む。同じ物が2回来たら1つにする。 */
export function pushItem(list: MadeItem[], next: MadeItem): MadeItem[] {
  const same = (a: MadeItem, b: MadeItem) =>
    a.kind === b.kind
    && (a.artifact_id ? a.artifact_id === b.artifact_id
      : a.url ? a.url === b.url
      : a.query ? a.query === b.query
      : a.source ? a.source === b.source
      : false);
  const rest = list.filter((x) => !same(x, next));
  return [...rest, next].slice(-KEEP);
}

const LABEL: Record<MadeItem["kind"], string> = {
  image: "画像",
  document: "ドキュメント",
  slides: "スライド",
  table: "表",
  search: "検索結果",
  page: "ページ",
  diagram: "図",
  link: "リンク",
};

const ICON: Record<MadeItem["kind"], string> = {
  image: "🖼", document: "📄", slides: "📊", table: "📋",
  search: "🔍", page: "🌐", diagram: "🗺", link: "🔗",
};

export default function Canvas({
  items, open, bottomOffset = 0, onClose, onOpenFiles,
}: {
  items: MadeItem[];
  open: boolean;
  /**
   * スマホで、下に空けておく高さ（入力欄と下のナビのぶん）。
   *
   * ここを 0 にして画面いっぱいに出すと、見た直後にやりたい
   * 「直して」「もっと」のために、毎回閉じさせることになる。
   */
  bottomOffset?: number;
  onClose: () => void;
  /** 「ファイル」へ行く導線（閉じても見られることを、その場で示す）。 */
  onOpenFiles?: () => void;
}) {
  const [at, setAt] = useState(0);

  // 新しい物が来たら、そちらを見せる（見たいのはたいてい最新）
  useEffect(() => { setAt(Math.max(0, items.length - 1)); }, [items.length]);

  const here = items[Math.min(at, items.length - 1)];

  // Escで閉じる。かぶせる面は、必ず戻れるようにする。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 画面の外へ出してから描く。会話の側は動きのある箱（transform）の中に
  // あり、その中では position:fixed が画面ではなく**その箱**を基準にする。
  // 実測で 393px の画面に 361px で出て、上端も 128px のはずが 383px だった。
  // 見た目の細かい話に見えるが、かぶせる面が画面いっぱいに出ないと、
  // 下に隠れた物が押せてしまう。
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!open || !here || !mounted) return null;

  return createPortal(
    <AnimatePresence>
      <motion.aside
        key="canvas"
        aria-label="作った物"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24 }}
        transition={{ type: "spring", stiffness: 320, damping: 32 }}
        /* スマホは会話にかぶせる。PC（lg以上）は右半分に置いて、
           会話と並べて見られるようにする。 */
        className="canvas-sheet fixed inset-x-0 top-[12vh] z-30 flex flex-col rounded-t-forge border-t border-panel
                   lg:inset-y-0 lg:left-auto lg:right-0 lg:top-0 lg:w-[42vw] lg:max-w-[640px]
                   lg:rounded-none lg:border-l lg:border-t-0"
        style={{
          // 入力欄のぶんを空ける。PC は左右に並ぶので、そこでは 0 に戻す
          // （globals.css の .canvas-sheet が lg 以上で bottom:0 にする）。
          bottom: bottomOffset,
          background: "var(--bg)",
          boxShadow: "0 -8px 40px rgba(0,0,0,0.5)",
        }}
      >
        {/* 見出し（何が出ているか・閉じる） */}
        <div className="flex shrink-0 items-center gap-2 border-b border-panel px-3 py-2.5">
          <span className="shrink-0 text-[15px]">{ICON[here.kind]}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-fg-strong">
              {here.title || LABEL[here.kind]}
            </span>
            <span className="block text-[10px] tracking-[0.12em] text-muted label-mono">
              {LABEL[here.kind]}
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="キャンバスを閉じる"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-forge text-muted transition hover:text-fg-strong"
          >
            ✕
          </button>
        </div>

        {/* 2つ以上あるときだけ、行き来できるようにする */}
        {items.length > 1 && (
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-panel px-2 py-1.5">
            {items.map((it, i) => (
              <button
                key={`${it.kind}-${it.artifact_id || it.url || it.query || i}`}
                type="button"
                onClick={() => setAt(i)}
                className="shrink-0 rounded-forge border px-2.5 py-1.5 text-[11px] transition"
                style={{
                  borderColor: i === at ? "var(--accent)" : "var(--panel-bd)",
                  color: i === at ? "var(--fg-strong)" : "var(--muted)",
                  background: i === at ? "var(--btn-bg)" : "transparent",
                }}
              >
                {ICON[it.kind]} {(it.title || LABEL[it.kind]).slice(0, 12)}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <Body item={here} />
        </div>

        {/* 閉じても失われないことを、閉じる前に言う */}
        {onOpenFiles && (here.artifact_id || here.kind === "image") && (
          <div className="shrink-0 border-t border-panel px-3 py-2">
            <button
              type="button"
              onClick={() => { onClose(); onOpenFiles(); }}
              className="min-h-[44px] w-full rounded-forge border border-panel text-[11px] text-muted transition hover:text-fg-strong"
            >
              閉じても「管理 → ファイル」に残ります（開く）
            </button>
          </div>
        )}
      </motion.aside>
    </AnimatePresence>,
    document.body,
  );
}

/* ── 種類ごとの中身 ─────────────────────────────────────────────── */
function Body({ item }: { item: MadeItem }) {
  switch (item.kind) {
    case "image":
      return (
        <figure className="m-0">
          {/* 生成画像は外部URL。next/image を通すと設定した配信元しか
              出せないので、ここは素の img で受ける。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.url}
            alt={item.title || "生成した画像"}
            className="w-full rounded-forge border border-panel"
          />
          {item.title && (
            <figcaption className="mt-2 text-[11px] leading-relaxed text-muted">
              {item.title}
            </figcaption>
          )}
        </figure>
      );

    case "document":
      return <Markdown text={item.content || ""} />;

    case "table":
      return <Csv text={item.content || ""} />;

    case "slides":
      return <Deck item={item} />;

    case "search":
      return <SearchHits item={item} />;

    case "page":
      return (
        <div>
          <Outside url={item.url} label="元のページを開く" />
          <p className="mt-3 whitespace-pre-wrap text-[12px] leading-relaxed text-fg">
            {item.text || ""}
          </p>
        </div>
      );

    case "link":
      return (
        <div className="text-[12px] leading-relaxed text-muted">
          <p className="mb-2">
            {item.where ? `${item.where}に作りました。` : "外のサービスに作りました。"}
          </p>
          <Outside url={item.url} label="開く" />
        </div>
      );

    case "diagram":
      return <Diagram source={item.source || ""} />;
  }
}

/** 外のページを開く。新しいタブで開き、元のタブは渡さない。 */
function Outside({ url, label }: { url?: string; label: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-[44px] items-center rounded-forge border border-panel px-3 text-[12px] text-[var(--accent)] transition hover:border-[var(--line)]"
    >
      {label} ↗
    </a>
  );
}

function Csv({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (!rows.length) return <p className="text-[12px] text-muted">中身がありません。</p>;
  const [head, ...body] = rows;
  return (
    // 表は横に長くなる。ここだけ横に流す（ページ全体は流さない）。
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {head.map((c, i) => (
              <th key={i} className="border border-panel px-2 py-1.5 text-left text-fg-strong">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="border border-panel px-2 py-1.5 text-fg">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 引用符つきCSVを読む（改行やカンマを含む欄がある）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  const s = text || "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cur); cur = ""; rows.push(row); row = [];
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

function Deck({ item }: { item: MadeItem }) {
  const [i, setI] = useState(0);
  const deck = item.deck;
  const slides = deck?.slides ?? [];
  if (!slides.length) return <p className="text-[12px] text-muted">スライドがありません。</p>;
  const theme = getTheme(deck?.theme);
  const at = Math.min(i, slides.length - 1);
  return (
    <div>
      <div
        className="overflow-hidden rounded-forge border border-panel"
        style={{ aspectRatio: "16 / 9", containerType: "inline-size" }}
      >
        <SlideView slide={slides[at]} theme={theme} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => setI((v) => Math.max(0, v - 1))}
          disabled={at === 0} aria-label="前のスライド"
          className="min-h-[44px] flex-1 rounded-forge border border-panel text-[12px] text-muted transition disabled:opacity-30">
          ←
        </button>
        <span className="shrink-0 text-[11px] text-muted label-mono">
          {at + 1} / {slides.length}
        </span>
        <button type="button" onClick={() => setI((v) => Math.min(slides.length - 1, v + 1))}
          disabled={at === slides.length - 1} aria-label="次のスライド"
          className="min-h-[44px] flex-1 rounded-forge border border-panel text-[12px] text-muted transition disabled:opacity-30">
          →
        </button>
      </div>
    </div>
  );
}

function SearchHits({ item }: { item: MadeItem }) {
  const hits = item.results ?? [];
  if (!hits.length) return <p className="text-[12px] text-muted">見つかりませんでした。</p>;
  return (
    <ul className="flex list-none flex-col gap-1.5 p-0">
      {hits.map((r, i) => (
        <li key={`${r.url}-${i}`}>
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-forge border border-panel p-2.5 transition hover:border-[var(--line)]"
          >
            <span className="block text-[12px] leading-snug text-fg-strong">{r.title || r.url}</span>
            <span className="mt-0.5 block truncate text-[10px] text-[var(--accent)]">{host(r.url)}</span>
            {r.snippet && (
              <span className="mt-1 block text-[11px] leading-relaxed text-muted">{r.snippet}</span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** 出どころを見せる。長いURLをそのまま出すと、どこの物か読み取れない。 */
export function host(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

/**
 * 図（mermaid）。
 *
 * mermaid は2MB近くある。初めて図が出たときにだけ読み込む
 * （PWAの初回読み込みを、使わない人にまで払わせない）。
 */
function Diagram({ source }: { source: string }) {
  const [svg, setSvg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    if (!source.trim()) return;
    setSvg(""); setErr("");
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",   // 図の中からスクリプトやリンクを動かさない
          fontFamily: "inherit",
        });
        const id = `d${Math.random().toString(36).slice(2, 9)}`;
        const { svg: out } = await mermaid.render(id, source);
        if (alive) setSvg(out);
      } catch (e) {
        // 描けない図は、書いた物をそのまま見せる。黙って消すと
        // 「AIが何か言おうとしたが出なかった」だけが残る。
        if (alive) setErr(e instanceof Error ? e.message : "図を描けませんでした");
      }
    })();
    return () => { alive = false; };
  }, [source]);

  if (err) {
    return (
      <div>
        <p className="mb-2 text-[11px] leading-relaxed text-muted">
          図を描けませんでした（{err}）。元の記述を出します。
        </p>
        <pre className="overflow-x-auto rounded-forge border border-panel p-2.5 text-[11px] text-fg">
          {source}
        </pre>
      </div>
    );
  }
  if (!svg) return <p className="text-[12px] text-muted">図を描いています…</p>;
  return (
    // mermaid が作ったSVGを埋める。securityLevel: "strict" で
    // スクリプトとリンクは落ちているので、描画だけが残る。
    <div className="overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
