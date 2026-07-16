"use client";

/**
 * Whiteboard — Miro風ホワイトボード（BOARDモードの中核）.
 *
 *  - 無限キャンバス：背景ドラッグでパン、ホイールでカーソル中心ズーム
 *  - 付箋：ダブルクリック（or ＋付箋）で追加、ドラッグ移動、ダブルクリックで編集、
 *    6色パレット、✕削除
 *  - 接続：🔗モードで付箋A→Bをクリックすると線で結ぶ（線クリックで削除）
 *  - 保存：バックエンド接続時は /board に自動保存（0.8sデバウンス）、
 *    未接続時は localStorage（オフラインでも使える）
 *  - エージェント連携：board_add_note ツールで付箋が追加される
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { boardGet, boardSave, API_URL, type BoardData, type BoardNode, type BoardEdge } from "@/lib/api";

const LS_BOARD = "forge_board_v1";

const COLORS: Record<string, { bg: string; border: string }> = {
  yellow: { bg: "rgba(255,214,90,0.16)", border: "#ffd65a" },
  cyan: { bg: "rgba(0,243,255,0.12)", border: "#00f3ff" },
  green: { bg: "rgba(96,211,148,0.14)", border: "#60d394" },
  pink: { bg: "rgba(255,128,171,0.14)", border: "#ff80ab" },
  purple: { bg: "rgba(179,136,255,0.14)", border: "#b388ff" },
  orange: { bg: "rgba(255,167,89,0.15)", border: "#ffa759" },
};

const uid = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function loadLocal(): BoardData {
  try {
    const raw = localStorage.getItem(LS_BOARD);
    if (raw) {
      const d = JSON.parse(raw) as BoardData;
      return { nodes: d.nodes ?? [], edges: d.edges ?? [] };
    }
  } catch { /* ignore */ }
  return { nodes: [], edges: [] };
}

export default function Whiteboard() {
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [edges, setEdges] = useState<BoardEdge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState({ x: 60, y: 40, scale: 1 });
  const [editing, setEditing] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  const dragRef = useRef<{ id: string; px: number; py: number; nx: number; ny: number; moved: boolean } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipSave = useRef(true); // 初期ロード直後の保存を抑止

  // ── load ──
  useEffect(() => {
    (async () => {
      if (API_URL) {
        try {
          const d = await boardGet();
          if (d.nodes.length || d.edges.length) {
            setNodes(d.nodes);
            setEdges(d.edges);
          } else {
            // サーバーが空なら、以前のローカル下書きがあれば引き継ぐ。
            const local = loadLocal();
            setNodes(local.nodes);
            setEdges(local.edges);
          }
        } catch {
          const local = loadLocal();
          setNodes(local.nodes);
          setEdges(local.edges);
        }
      } else {
        const local = loadLocal();
        setNodes(local.nodes);
        setEdges(local.edges);
      }
      setLoaded(true);
      // 次のtickから保存を有効化
      setTimeout(() => { skipSave.current = false; }, 50);
    })();
  }, []);

  // ── debounced save（localStorage は常時 / バックエンドは接続時） ──
  useEffect(() => {
    if (!loaded || skipSave.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      try { localStorage.setItem(LS_BOARD, JSON.stringify({ nodes, edges })); } catch { /* ignore */ }
      if (API_URL) {
        try { await boardSave({ nodes, edges }); } catch { /* ignore */ }
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1200);
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [nodes, edges, loaded]);

  // ── canvas coords helper ──
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const rx = clientX - (rect?.left ?? 0);
    const ry = clientY - (rect?.top ?? 0);
    return { x: (rx - view.x) / view.scale, y: (ry - view.y) / view.scale };
  }, [view]);

  // ── note ops ──
  const addNote = useCallback((x?: number, y?: number, color = "yellow") => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const cx = x ?? ((rect?.width ?? 800) / 2 - view.x) / view.scale - 100;
    const cy = y ?? ((rect?.height ?? 500) / 2 - view.y) / view.scale - 50;
    const node: BoardNode = { id: uid(), x: cx, y: cy, text: "", color, w: 200 };
    setNodes((p) => [...p, node]);
    setEditing(node.id);
  }, [view]);

  const removeNode = (id: string) => {
    setNodes((p) => p.filter((n) => n.id !== id));
    setEdges((p) => p.filter((e) => e.from !== id && e.to !== id));
    if (editing === id) setEditing(null);
  };

  const setNodeText = (id: string, text: string) =>
    setNodes((p) => p.map((n) => (n.id === id ? { ...n, text } : n)));
  const setNodeColor = (id: string, color: string) =>
    setNodes((p) => p.map((n) => (n.id === id ? { ...n, color } : n)));

  // ── background pan / dblclick add ──
  const onBgPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // ノード上は無視
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
  };
  const onBgPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    setView((v) => ({ ...v, x: pan.vx + (e.clientX - pan.px), y: pan.vy + (e.clientY - pan.py) }));
  };
  const onBgPointerUp = () => { panRef.current = null; };
  const onBgDoubleClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const p = toCanvas(e.clientX, e.clientY);
    addNote(p.x - 100, p.y - 40);
  };

  // ── wheel zoom (cursor-centred) ──
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = wrapRef.current?.getBoundingClientRect();
    const mx = e.clientX - (rect?.left ?? 0);
    const my = e.clientY - (rect?.top ?? 0);
    setView((v) => {
      const next = Math.min(2.5, Math.max(0.25, v.scale * (e.deltaY > 0 ? 0.9 : 1.1)));
      const k = next / v.scale;
      return { scale: next, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
    });
  };

  const zoomBy = (factor: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const mx = (rect?.width ?? 800) / 2;
    const my = (rect?.height ?? 500) / 2;
    setView((v) => {
      const next = Math.min(2.5, Math.max(0.25, v.scale * factor));
      const k = next / v.scale;
      return { scale: next, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
    });
  };

  // ── node drag / connect ──
  const onNodePointerDown = (e: ReactPointerEvent<HTMLDivElement>, n: BoardNode) => {
    if (editing === n.id) return; // 編集中はドラッグしない
    if ((e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    if (connectMode) {
      if (!connectFrom) {
        setConnectFrom(n.id);
      } else if (connectFrom !== n.id) {
        const dup = edges.some((ed) => (ed.from === connectFrom && ed.to === n.id) || (ed.from === n.id && ed.to === connectFrom));
        if (!dup) setEdges((p) => [...p, { id: uid(), from: connectFrom, to: n.id }]);
        setConnectFrom(null);
      }
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id: n.id, px: e.clientX, py: e.clientY, nx: n.x, ny: n.y, moved: false };
  };
  const onNodePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.px) / view.scale;
    const dy = (e.clientY - d.py) / view.scale;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    setNodes((p) => p.map((n) => (n.id === d.id ? { ...n, x: d.nx + dx, y: d.ny + dy } : n)));
  };
  const onNodePointerUp = () => { dragRef.current = null; };

  // ── edges geometry ──
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edgeLines = edges
    .map((e) => {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) return null;
      return {
        id: e.id,
        x1: a.x + (a.w ?? 200) / 2, y1: a.y + 55,
        x2: b.x + (b.w ?? 200) / 2, y2: b.y + 55,
      };
    })
    .filter(Boolean) as { id: string; x1: number; y1: number; x2: number; y2: number }[];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => addNote()}
          className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.14em] text-fg-strong shadow-glow label-mono">
          ＋ 付箋
        </button>
        <button
          type="button"
          onClick={() => { setConnectMode((c) => !c); setConnectFrom(null); }}
          aria-pressed={connectMode}
          className="rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.14em] label-mono"
          style={{
            borderColor: connectMode ? "var(--accent)" : "var(--panel-bd)",
            color: connectMode ? "var(--fg-strong)" : "var(--muted)",
            background: connectMode ? "var(--btn-bg)" : "transparent",
          }}
        >
          🔗 接続{connectMode ? (connectFrom ? "：2枚目を選択" : "：1枚目を選択") : ""}
        </button>
        <div className="ml-1 flex items-center gap-1">
          <button type="button" onClick={() => zoomBy(0.85)} aria-label="縮小" className="grid h-7 w-7 place-items-center rounded-forge border border-panel text-muted hover:text-fg-strong">−</button>
          <span className="w-12 text-center text-[10px] text-muted label-mono">{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.18)} aria-label="拡大" className="grid h-7 w-7 place-items-center rounded-forge border border-panel text-muted hover:text-fg-strong">＋</button>
          <button type="button" onClick={() => setView({ x: 60, y: 40, scale: 1 })} aria-label="リセット" title="表示をリセット" className="grid h-7 w-7 place-items-center rounded-forge border border-panel text-muted hover:text-fg-strong">⌂</button>
        </div>
        <span className="ml-auto flex items-center gap-2 text-[9px] tracking-[0.12em] text-muted label-mono">
          {saveState === "saving" ? "● SAVING…" : saveState === "saved" ? "✓ SAVED" : API_URL ? "AUTOSAVE" : "LOCAL（オフライン保存）"}
        </span>
      </div>

      {/* Canvas */}
      <div
        ref={wrapRef}
        data-board-canvas
        onPointerDown={onBgPointerDown}
        onPointerMove={onBgPointerMove}
        onPointerUp={onBgPointerUp}
        onDoubleClick={onBgDoubleClick}
        onWheel={onWheel}
        className="relative min-h-0 flex-1 touch-none overflow-hidden rounded-forge border border-panel"
        style={{
          cursor: panRef.current ? "grabbing" : "default",
          background:
            `radial-gradient(circle, rgba(197,198,199,0.13) 1px, transparent 1px) 0 0 / ${24 * view.scale}px ${24 * view.scale}px, rgba(8,11,18,0.5)`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        {/* transformed layer */}
        <div className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "0 0" }}>
          {/* edges */}
          <svg className="pointer-events-none absolute -left-[5000px] -top-[5000px]" width="10000" height="10000" aria-hidden>
            <g transform="translate(5000,5000)">
              {edgeLines.map((l) => (
                <g key={l.id}>
                  <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="rgba(0,243,255,0.45)" strokeWidth={2 / view.scale} />
                  {/* クリックで削除できる透明な太線 */}
                  <line
                    x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                    stroke="transparent" strokeWidth={14 / view.scale}
                    className="pointer-events-auto cursor-pointer"
                    onClick={() => setEdges((p) => p.filter((e) => e.id !== l.id))}
                  />
                </g>
              ))}
            </g>
          </svg>

          {/* nodes */}
          {nodes.map((n) => {
            const c = COLORS[n.color] ?? COLORS.yellow;
            const isEditing = editing === n.id;
            const isConnectSrc = connectFrom === n.id;
            return (
              <div
                key={n.id}
                data-note
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onPointerMove={onNodePointerMove}
                onPointerUp={onNodePointerUp}
                onDoubleClick={(e) => { e.stopPropagation(); setEditing(n.id); }}
                className="group absolute select-none rounded-lg border p-2 shadow-lg"
                style={{
                  left: n.x, top: n.y, width: n.w ?? 200,
                  background: c.bg, borderColor: isConnectSrc ? "var(--accent)" : c.border,
                  boxShadow: isConnectSrc ? "0 0 14px var(--glow)" : "0 6px 18px rgba(0,0,0,0.35)",
                  cursor: connectMode ? "crosshair" : "grab",
                }}
              >
                {isEditing ? (
                  <textarea
                    autoFocus
                    defaultValue={n.text}
                    onBlur={(e) => { setNodeText(n.id, e.target.value); setEditing(null); }}
                    onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur(); }}
                    rows={3}
                    placeholder="メモを書く…"
                    className="w-full resize-none bg-transparent text-[12px] leading-relaxed text-fg-strong placeholder:text-muted focus:outline-none"
                  />
                ) : (
                  <p className="min-h-[3.2rem] whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg">
                    {n.text || <span className="text-muted/60">（ダブルクリックで編集）</span>}
                  </p>
                )}

                {/* hover controls: palette + delete */}
                <div className="mt-1 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  {Object.entries(COLORS).map(([key, col]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setNodeColor(n.id, key)}
                      aria-label={`色: ${key}`}
                      className="h-3.5 w-3.5 rounded-full border"
                      style={{ background: col.bg, borderColor: col.border, outline: n.color === key ? `1px solid ${col.border}` : "none" }}
                    />
                  ))}
                  <button type="button" onClick={() => removeNode(n.id)} aria-label="付箋を削除" className="ml-auto text-[11px] text-[#ff8888]">✕</button>
                </div>
              </div>
            );
          })}
        </div>

        {/* empty hint */}
        {loaded && nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <p className="text-center text-[11px] leading-relaxed tracking-[0.14em] text-muted/60 label-mono">
              ダブルクリックで付箋を追加<br />背景ドラッグで移動 · ホイールでズーム<br />
              エージェントに「ボードに◯◯を書いて」と頼むこともできます
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
