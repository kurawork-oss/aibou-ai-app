"use client";

/**
 * CommandPalette — `#` で道具を直接呼ぶ窓。
 *
 * なぜ要るか
 * ----------
 * ふつうに「猫の絵を描いて」と書くと、AIが「どの道具を使うか」を考える。
 * 融通は利くが、一手ぶん待つ。
 *
 * `#画像 猫の絵` と書けば、その一手を飛ばして直行できる。速くて、結果が読める。
 * この2本立てが「使い分け」。
 *
 * いちばんの失敗は「隠れたメニューになること」
 * ------------------------------------------
 * 道具は40近くある。それを一覧で並べたら、15モードが40項目になっただけで
 * 何も良くなっていない。だから**打ちながら絞る**（VS Codeのコマンドパレットと
 * 同じ）。多くても邪魔にならないので、むしろ全部載せられる。
 *
 * そして `#` は近道であって、必須ではない。ふつうの言葉でも同じことができる
 * ——ここが崩れると「呪文を覚えないと使えないアプリ」になる。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { CommandItem } from "@/lib/api";

/**
 * 打った字で絞る。前方一致を上に、含むものを下に。
 *
 * よみ（かな・英語）でも引く。日本語入力はかなを通るので、漢字の前方一致
 * だけだと「#がぞう」と打った人が「画像」を見つけられない。
 */
export function filterCommands(items: CommandItem[], q: string): CommandItem[] {
  const s = q.trim().toLowerCase();
  if (!s) return items;
  const starts: CommandItem[] = [];
  const has: CommandItem[] = [];
  for (const c of items) {
    const cmd = c.cmd.toLowerCase();
    const yomi = (c.yomi ?? "").toLowerCase();
    const label = c.label.toLowerCase();
    if (cmd.startsWith(s) || yomi.startsWith(s)) starts.push(c);
    else if (cmd.includes(s) || yomi.includes(s) || label.includes(s)) has.push(c);
  }
  return [...starts, ...has];
}

/**
 * 入力中の文字から「いま # を打っている状態か」を読む。
 *
 * 行頭の # だけを対象にする。文の途中の # は、ハッシュタグや
 * 見出し記法として書きたいことがあるので拾わない。
 */
export function readHashInput(text: string): { active: boolean; query: string } {
  const t = text ?? "";
  if (!(t.startsWith("#") || t.startsWith("＃"))) return { active: false, query: "" };
  const rest = t.slice(1);
  // 空白より前だけが「コマンド名」。空白のあとは引数なので、候補は閉じる。
  if (/[\s　]/.test(rest)) return { active: false, query: "" };
  return { active: true, query: rest };
}

export default function CommandPalette({
  items, query, onPick, onClose,
}: {
  items: CommandItem[];
  query: string;
  onPick: (c: CommandItem) => void;
  onClose: () => void;
}) {
  const hits = useMemo(() => filterCommands(items, query), [items, query]);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 絞り込みが変わったら先頭に戻す（前の位置に残ると、意図しない物を選ぶ）
  useEffect(() => { setSel(0); }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hits.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((v) => (v + 1) % hits.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((v) => (v - 1 + hits.length) % hits.length); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); onPick(hits[sel]); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hits, sel, onPick, onClose]);

  // 選択中の行を見える位置に保つ
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!items.length) return null;

  return (
    <div
      role="listbox"
      aria-label="コマンド"
      /* .glass-silver は position:relative を自分で持っているので使わない
         （Tailwind の absolute を打ち消して、窓が入力欄の幅まで広がらない）。
         .panel は位置を触らないので、こちらに載せる。

         背景は不透明にする。.panel の既定はほぼ透明で、下の会話が透けて
         候補が読めなかった（重ねて出す物なので、ここは透かさない）。 */
      className="absolute bottom-full left-0 right-0 mb-1.5 max-h-[52vh] overflow-y-auto rounded-forge border border-panel p-1.5 shadow-lg"
      style={{ background: "#0d1016", boxShadow: "0 10px 30px rgba(0,0,0,0.55)" }}
      ref={listRef}
    >
      {hits.length === 0 ? (
        /* 見つからなくても行き止まりにしない。そのまま送ればAIが受け取る。 */
        <p className="px-2 py-2 text-[11px] leading-relaxed text-muted">
          その名前の近道はありません。そのまま送れば、ふつうの頼みごととして
          AIbouが受け取ります。
        </p>
      ) : (
        hits.map((c, i) => (
          <button
            key={c.cmd}
            type="button"
            data-i={i}
            role="option"
            aria-selected={i === sel}
            onMouseEnter={() => setSel(i)}
            onClick={() => onPick(c)}
            className="flex w-full items-center gap-2 rounded-forge px-2 py-2 text-left transition"
            style={{
              background: i === sel ? "var(--btn-bg)" : "transparent",
              borderLeft: i === sel ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <span className="w-5 shrink-0 text-center text-[14px]">{c.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-fg-strong">{c.label}</span>
              <span className="block truncate text-[11px] text-muted">
                #{c.cmd}{c.arg ? ` ${c.arg}` : ""}
              </span>
            </span>
            {/* 直行できない物は、AIが受け取ることを先に言っておく */}
            {!c.direct && (
              <span className="shrink-0 text-[10px] text-muted label-mono">画面</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}
