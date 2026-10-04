"use client";

/**
 * SlideEditor — スライドを1枚ずつ直す（Genspark のような編集体験）.
 *
 *  ・左：サムネイル一覧（クリックで選択、並べ替え・複製・削除・追加）
 *  ・右：選んだ1枚のプレビュー ＋ 項目ごとの編集フォーム
 *  ・レイアウト変更（表紙 / 章 / 箇条書き / 2段組み / 数字 / 引用 / 画像）
 *  ・「この1枚をAIで直す」…デッキ全体ではなく1枚だけ書き直す
 *  ・画像は英語プロンプトから差し替え（比率16:9）
 *
 * 変更は onChange で親（ArtifactViewer）に返し、そこで保存される。
 */

import { useEffect, useState } from "react";
import SlideView, { getTheme } from "@/components/SlideView";
import {
  slideLayouts, slideRevise, imageGenerate, API_URL,
  type Slide, type SlideDeck, type SlideLayoutDef,
} from "@/lib/api";
import { enterSubmits } from "@/lib/enterKey";

/** バックエンドに繋がらない時でも編集できるようにするフォールバック定義。 */
const FALLBACK_LAYOUTS: SlideLayoutDef[] = [
  { key: "title", label: "表紙", fields: ["title", "subtitle", "image"] },
  { key: "section", label: "章の区切り", fields: ["title", "subtitle"] },
  { key: "bullets", label: "箇条書き", fields: ["title", "bullets"] },
  { key: "two_col", label: "2段組み", fields: ["title", "bullets"] },
  { key: "stat", label: "数字を大きく", fields: ["stat", "title", "subtitle"] },
  { key: "quote", label: "引用", fields: ["quote", "author"] },
  { key: "image", label: "画像で見せる", fields: ["title", "image", "bullets"] },
];

const FIELD_LABELS: Record<string, string> = {
  title: "見出し",
  subtitle: "補足",
  bullets: "箇条書き（1行ずつ）",
  stat: "数字",
  quote: "引用文",
  author: "引用元",
  image: "画像（英語プロンプト、またはURL）",
};

export default function SlideEditor({
  deck, index, onChange, onSelect,
}: {
  deck: SlideDeck;
  index: number;
  onChange: (next: SlideDeck) => void;
  onSelect: (i: number) => void;
}) {
  const [layouts, setLayouts] = useState<SlideLayoutDef[]>(FALLBACK_LAYOUTS);
  const [instruction, setInstruction] = useState("");
  const [imgPrompt, setImgPrompt] = useState("");
  const [busy, setBusy] = useState<"" | "ai" | "img">("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    slideLayouts()
      .then((d) => { if (alive && d.layouts?.length) setLayouts(d.layouts); })
      .catch(() => { /* フォールバックのままで編集できる */ });
    return () => { alive = false; };
  }, []);

  const i = Math.max(0, Math.min(index, deck.slides.length - 1));
  const slide = deck.slides[i] ?? {};
  const theme = getTheme(deck.theme);
  const layout = slide.layout || "bullets";
  const def = layouts.find((l) => l.key === layout) ?? FALLBACK_LAYOUTS[2];

  const commit = (slides: Slide[], select?: number) => {
    onChange({ ...deck, slides });
    if (select !== undefined) onSelect(Math.max(0, Math.min(select, slides.length - 1)));
  };
  const patch = (p: Partial<Slide>) =>
    commit(deck.slides.map((s, j) => (j === i ? { ...s, ...p } : s)));

  const addSlide = () => {
    const next = [...deck.slides];
    next.splice(i + 1, 0, { layout: "bullets", title: "新しいスライド", bullets: [] });
    commit(next, i + 1);
  };
  const duplicate = () => {
    const next = [...deck.slides];
    next.splice(i + 1, 0, JSON.parse(JSON.stringify(slide)) as Slide);
    commit(next, i + 1);
  };
  const remove = () => {
    if (deck.slides.length <= 1) { setNote("⚠ 最後の1枚は削除できません"); return; }
    commit(deck.slides.filter((_, j) => j !== i), Math.max(0, i - 1));
  };
  const move = (d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= deck.slides.length) return;
    const next = [...deck.slides];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next, j);
  };

  /** この1枚だけをAIで書き直す（前後の文脈を渡して話の繋がりを保つ）。 */
  const reviseWithAi = async () => {
    const inst = instruction.trim();
    if (!inst || busy || !API_URL) return;
    setBusy("ai");
    setNote("この1枚を直しています…");
    try {
      const around = [deck.slides[i - 1], deck.slides[i + 1]]
        .map((s, k) => (s ? `${k === 0 ? "前" : "次"}: ${s.title || s.quote || s.stat || ""}` : ""))
        .filter(Boolean).join(" / ");
      const r = await slideRevise({
        slide, instruction: inst, deckTitle: deck.title, layout, context: around,
      });
      if (r.error || !r.slide) setNote(`⚠ ${r.error ?? "直せませんでした"}`);
      else {
        // 画像URLは引き継ぐ（AIは英語プロンプトを返すため、既存の絵を失わない）
        const keep = slide.image?.startsWith("http") && !r.slide.image?.startsWith("http")
          ? { image: slide.image } : {};
        patch({ ...r.slide, ...keep });
        setInstruction("");
        setNote("✓ 直しました");
      }
    } catch { setNote("⚠ 通信に失敗しました"); } finally { setBusy(""); }
  };

  /** 画像を英語プロンプトから作って差し替える（16:9）。 */
  const replaceImage = async () => {
    const p = (imgPrompt || slide.image || "").trim();
    if (!p || busy || !API_URL) return;
    if (p.startsWith("http")) { patch({ image: p }); setNote("✓ 画像URLを設定しました"); return; }
    setBusy("img");
    setNote("画像を作っています…");
    try {
      const r = await imageGenerate({ prompt: p, aspect: "16:9", n: 1 });
      if (r.error || !r.images?.length) setNote(`⚠ ${r.error ?? "画像を作れませんでした"}`);
      else { patch({ image: r.images[0].url }); setNote("✓ 画像を差し替えました"); }
    } catch { setNote("⚠ 通信に失敗しました"); } finally { setBusy(""); }
  };

  return (
    <div className="grid min-h-0 gap-3 md:grid-cols-[9rem_1fr]">
      {/* ── サムネイル一覧：スマホは横スクロールのフィルムストリップ、
             md以上は左に縦並び（縦だとスマホで画面を占領してしまう） ── */}
      <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-1 md:max-h-[60vh] md:flex-col md:overflow-x-visible md:overflow-y-auto md:pb-0">
        {deck.slides.map((s, j) => (
          <button key={j} type="button" onClick={() => onSelect(j)}
            aria-label={`スライド${j + 1}を編集`} aria-current={j === i}
            className="relative w-28 shrink-0 overflow-hidden rounded-md border transition md:w-auto"
            style={{
              aspectRatio: "16 / 9",
              borderColor: j === i ? "var(--accent)" : "var(--panel-bd)",
              boxShadow: j === i ? "0 0 8px var(--glow)" : "none",
            }}>
            <SlideView slide={s} theme={theme} />
            <span className="absolute right-1 top-0.5 text-[8px] text-white/70 label-mono">{j + 1}</span>
          </button>
        ))}
        <button type="button" onClick={addSlide}
          className="w-16 shrink-0 rounded-md border border-dashed border-panel text-[10px] text-muted transition hover:border-[var(--line)] hover:text-fg-strong label-mono md:w-auto md:py-2">
          ＋
        </button>
      </div>

      {/* ── 右：選択中の1枚 ── */}
      <div className="flex min-w-0 flex-col gap-2">
        <div className="overflow-hidden rounded-lg border border-panel" style={{ aspectRatio: "16 / 9" }}>
          <SlideView slide={slide} theme={theme} />
        </div>

        {/* 枚の操作 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[9px] tracking-[0.16em] text-muted label-mono">{i + 1} / {deck.slides.length}</span>
          <div className="ml-auto flex gap-1">
            <button type="button" onClick={() => move(-1)} disabled={i === 0} aria-label="前へ移動"
              className="rounded-md border border-panel px-2 py-1 text-[10px] text-muted transition hover:text-fg-strong disabled:opacity-30">←</button>
            <button type="button" onClick={() => move(1)} disabled={i === deck.slides.length - 1} aria-label="後へ移動"
              className="rounded-md border border-panel px-2 py-1 text-[10px] text-muted transition hover:text-fg-strong disabled:opacity-30">→</button>
            <button type="button" onClick={duplicate} aria-label="複製"
              className="rounded-md border border-panel px-2 py-1 text-[10px] text-muted transition hover:text-fg-strong">複製</button>
            <button type="button" onClick={remove} aria-label="このスライドを削除"
              className="rounded-md border border-panel px-2 py-1 text-[10px] text-muted transition hover:text-[#ff9b9b]">削除</button>
          </div>
        </div>

        {/* レイアウト */}
        <div>
          <div className="mb-1 text-[9px] tracking-[0.16em] text-muted label-mono">レイアウト</div>
          <div className="flex flex-wrap gap-1">
            {layouts.map((l) => (
              <button key={l.key} type="button" onClick={() => patch({ layout: l.key })}
                aria-pressed={layout === l.key}
                className="rounded-full border px-2.5 py-1 text-[10px] label-mono"
                style={{
                  borderColor: layout === l.key ? "var(--accent)" : "var(--panel-bd)",
                  color: layout === l.key ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {/* レイアウトが使う項目だけを出す */}
        {def.fields.map((f) => {
          if (f === "bullets") {
            return (
              <div key={f}>
                <label className="mb-1 block text-[9px] tracking-[0.16em] text-muted label-mono" htmlFor="sl-bullets">
                  {FIELD_LABELS[f]}
                </label>
                <textarea id="sl-bullets" rows={4}
                  value={(slide.bullets ?? []).join("\n")}
                  onChange={(e) => patch({ bullets: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
                  className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[12px] text-fg-strong focus:border-[var(--line)] focus:outline-none" />
              </div>
            );
          }
          if (f === "image") {
            return (
              <div key={f}>
                <label className="mb-1 block text-[9px] tracking-[0.16em] text-muted label-mono" htmlFor="sl-image">
                  {FIELD_LABELS[f]}
                </label>
                <div className="flex gap-1.5">
                  <input id="sl-image"
                    value={imgPrompt}
                    onChange={(e) => setImgPrompt(e.target.value)}
                    placeholder={slide.image?.startsWith("http") ? "例：quiet lake at dawn（作り直す）" : "例：quiet lake at dawn"}
                    className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[12px] text-fg-strong focus:border-[var(--line)] focus:outline-none" />
                  <button type="button" onClick={() => void replaceImage()} disabled={!!busy || !API_URL}
                    className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 text-[10px] text-fg-strong disabled:opacity-40 label-mono">
                    {busy === "img" ? "…" : "差し替え"}
                  </button>
                  {slide.image && (
                    <button type="button" onClick={() => patch({ image: "" })} aria-label="画像を外す"
                      className="shrink-0 rounded-forge border border-panel px-2 text-[10px] text-muted transition hover:text-[#ff9b9b] label-mono">✕</button>
                  )}
                </div>
              </div>
            );
          }
          const multiline = f === "quote";
          return (
            <div key={f}>
              <label className="mb-1 block text-[9px] tracking-[0.16em] text-muted label-mono" htmlFor={`sl-${f}`}>
                {FIELD_LABELS[f] ?? f}
              </label>
              {multiline ? (
                <textarea id={`sl-${f}`} rows={2}
                  value={(slide[f as keyof Slide] as string) ?? ""}
                  onChange={(e) => patch({ [f]: e.target.value } as Partial<Slide>)}
                  className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[12px] text-fg-strong focus:border-[var(--line)] focus:outline-none" />
              ) : (
                <input id={`sl-${f}`}
                  value={(slide[f as keyof Slide] as string) ?? ""}
                  onChange={(e) => patch({ [f]: e.target.value } as Partial<Slide>)}
                  className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[12px] text-fg-strong focus:border-[var(--line)] focus:outline-none" />
              )}
            </div>
          );
        })}

        {/* 発表用メモ */}
        <div>
          <label className="mb-1 block text-[9px] tracking-[0.16em] text-muted label-mono" htmlFor="sl-notes">
            発表メモ（スライドには出ません）
          </label>
          <textarea id="sl-notes" rows={2} value={slide.notes ?? ""}
            onChange={(e) => patch({ notes: e.target.value })}
            className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[12px] text-muted focus:border-[var(--line)] focus:text-fg-strong focus:outline-none" />
        </div>

        {/* AIで1枚だけ直す */}
        {API_URL && (
          <div className="rounded-forge border border-panel p-2.5">
            <div className="mb-1 text-[9px] tracking-[0.16em] text-muted label-mono">この1枚をAIで直す</div>
            <div className="flex gap-1.5">
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => enterSubmits(e) && void reviseWithAi()}
                placeholder="例：もっと短く力強く／数字を入れて／引用にして"
                className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[12px] text-fg-strong focus:border-[var(--line)] focus:outline-none" />
              <button type="button" onClick={() => void reviseWithAi()} disabled={!!busy || !instruction.trim()}
                className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 text-[10px] text-fg-strong disabled:opacity-40 label-mono">
                {busy === "ai" ? "…" : "直す"}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted">他のスライドは変わりません。</p>
          </div>
        )}

        {note && <p className="text-[10px]" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</p>}
      </div>
    </div>
  );
}
