"use client";

/**
 * ActionMenu —「できること」の一覧。入力欄の「＋」か、先頭の「/」で出る。
 *
 * 以前は、行き先が 下のナビ・管理の切り替え・「もっと」・設定のタブ に
 * 分かれていた。いまはここ1つ（lib/chatActions.ts）。選ぶと、その画面が
 * 会話の上に開く（会話は残ったまま。「会話に戻る」で戻る）。
 *
 * キーボードでも選べる（↑↓・Enter・Esc）。日本語の変換中のキーは拾わない。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ACTION_GROUPS, filterActions, type ChatAction } from "@/lib/chatActions";
import { isComposingKey } from "@/lib/enterKey";

export default function ActionMenu({
  items, query, onPick, onClose, onAttach,
}: {
  items: ChatAction[];
  query: string;
  onPick: (a: ChatAction) => void;
  onClose: () => void;
  /** 「＋」から開いたときだけ渡す（「/」のときは画像の項目を出さない）。 */
  onAttach?: () => void;
}) {
  const hits = useMemo(() => filterActions(items, query), [items, query]);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSel(0); }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposingKey(e)) return;
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (!hits.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((v) => (v + 1) % hits.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((v) => (v - 1 + hits.length) % hits.length); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); onPick(hits[sel]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hits, sel, onPick, onClose]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // 押した所の外を押したら閉じる
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = listRef.current;
      if (el && !el.contains(e.target as Node) && !(e.target as Element)?.closest?.("[data-action-menu-toggle]")) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  const grouped = !query.trim();
  let i = -1;
  const row = (a: ChatAction) => {
    i += 1;
    const idx = i;
    return (
      <button
        key={a.id}
        type="button"
        data-action={a.id}
        data-i={idx}
        role="option"
        aria-selected={idx === sel}
        onMouseEnter={() => setSel(idx)}
        onClick={() => onPick(a)}
        className="flex w-full items-center gap-2.5 rounded-forge px-2 py-2 text-left transition"
        style={{
          background: idx === sel ? "var(--btn-bg)" : "transparent",
          borderLeft: idx === sel ? "2px solid var(--accent)" : "2px solid transparent",
        }}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-panel text-[13px] text-fg" aria-hidden>
          {a.mark}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-fg-strong">{a.label}</span>
          <span className="block truncate text-[11px] text-muted">{a.hint}</span>
        </span>
      </button>
    );
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="できること"
      className="absolute bottom-full left-0 right-0 z-30 mb-1.5 max-h-[60vh] overflow-y-auto rounded-forge border border-panel p-1.5"
      style={{ background: "#0d1016", boxShadow: "0 10px 30px rgba(0,0,0,0.55)" }}
    >
      {onAttach && (
        <button
          type="button"
          onClick={onAttach}
          className="mb-1 flex w-full items-center gap-2.5 rounded-forge border-b border-panel px-2 py-2 text-left"
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-panel text-[13px] text-fg" aria-hidden>⧉</span>
          <span className="text-[13px] text-fg-strong">画像をつける</span>
        </button>
      )}
      {hits.length === 0 ? (
        <p className="px-2 py-2 text-[11px] leading-relaxed text-muted">
          その名前のものはありません。そのまま送れば、ふつうの頼みごととして受け取ります。
        </p>
      ) : grouped ? (
        ACTION_GROUPS.map((g) => {
          const inGroup = hits.filter((a) => a.group === g.key);
          if (!inGroup.length) return null;
          return (
            <div key={g.key} className="mb-1">
              <div className="px-2 pb-0.5 pt-1.5 text-[10px] tracking-[0.18em] text-muted label-mono">{g.label}</div>
              {inGroup.map(row)}
            </div>
          );
        })
      ) : (
        hits.map(row)
      )}
      <p className="px-2 pb-1 pt-1.5 text-[10px] leading-relaxed text-muted">
        「タスク見せて」「声を変えて」「Gmail とつないで」のように頼んでも開きます。
      </p>
    </div>
  );
}
