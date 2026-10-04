"use client";

/**
 * Whiteboard — Miro風ホワイトボード v2（BOARDモードの中核）.
 *
 *  - 複数ボード：タブで切替、＋新規、✎名称変更、⧉複製、✕削除
 *  - ノード3種：付箋（sticky）/ テキスト（text）/ フレーム（frame・グループ枠）
 *  - 操作：背景ドラッグでパン、ホイールでカーソル中心ズーム、⊡で全体表示、
 *    ダブルクリックで付箋追加、右下ハンドルでリサイズ
 *  - 接続：🔗モードでA→Bを結ぶ**矢印**（線クリックで削除）
 *  - 履歴：↩︎/↪︎（Ctrl+Z / Ctrl+Shift+Z）でアンドゥ・リドゥ
 *  - 連携：付箋の「☑」でそのままタスク化（接続時）
 *  - 保存：接続時は /boards/{id} に自動保存（0.8sデバウンス）、
 *    未接続時は localStorage の複数ボードストア（v1から自動移行）
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  boardsList, boardCreate, boardGetById, boardSaveById, boardRename, boardDuplicate, boardDelete,
  createTask, API_URL,
  type BoardData, type BoardNode, type BoardEdge, type BoardMeta,
} from "@/lib/api";
import { useLive } from "@/lib/live";
import { isComposingKey } from "@/lib/enterKey";

/** 手元に無い物だけ足す（同じ id は手元を残す）。 */
function addMissing<T extends { id: string }>(cur: T[], remote: T[]): T[] {
  const have = new Set(cur.map((x) => x.id));
  const extra = remote.filter((x) => !have.has(x.id));
  return extra.length ? [...cur, ...extra] : cur;
}

const LS_V1 = "forge_board_v1";
const LS_V2 = "forge_boards_v2";
const LS_CURRENT = "forge_board_current";

const COLORS: Record<string, { bg: string; border: string }> = {
  yellow: { bg: "rgba(255,214,90,0.16)", border: "#ffd65a" },
  cyan: { bg: "rgba(0,243,255,0.12)", border: "#00f3ff" },
  green: { bg: "rgba(96,211,148,0.14)", border: "#60d394" },
  pink: { bg: "rgba(255,128,171,0.14)", border: "#ff80ab" },
  purple: { bg: "rgba(179,136,255,0.14)", border: "#b388ff" },
  orange: { bg: "rgba(255,167,89,0.15)", border: "#ffa759" },
};

const uid = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/* ── offline store (localStorage, multi-board, migrates v1) ───────── */
interface LocalBoard extends BoardData { id: string; name: string }
interface LocalStore { current: string; boards: LocalBoard[] }

function loadLocalStore(): LocalStore {
  try {
    const raw = localStorage.getItem(LS_V2);
    if (raw) {
      const s = JSON.parse(raw) as LocalStore;
      if (Array.isArray(s.boards) && s.boards.length) return s;
    }
  } catch { /* ignore */ }
  // v1（単一ボード）からの移行 or 新規作成。
  let nodes: BoardNode[] = [];
  let edges: BoardEdge[] = [];
  try {
    const v1 = localStorage.getItem(LS_V1);
    if (v1) {
      const d = JSON.parse(v1) as BoardData;
      nodes = d.nodes ?? [];
      edges = d.edges ?? [];
    }
  } catch { /* ignore */ }
  const first: LocalBoard = { id: uid(), name: "メインボード", nodes, edges };
  const store: LocalStore = { current: first.id, boards: [first] };
  // 即永続化：IDを安定させる（次回以降の loadLocalStore が同じIDを返すように）。
  saveLocalStore(store);
  return store;
}

function saveLocalStore(s: LocalStore) {
  try { localStorage.setItem(LS_V2, JSON.stringify(s)); } catch { /* ignore */ }
}

/* ── component ─────────────────────────────────────────────────────── */
export default function Whiteboard() {
  const online = !!API_URL;
  const [metas, setMetas] = useState<BoardMeta[]>([]);
  const [boardId, setBoardId] = useState<string>("");
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [edges, setEdges] = useState<BoardEdge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState({ x: 60, y: 40, scale: 1 });
  const [editing, setEditing] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [toast, setToast] = useState<string | null>(null);
  // 複数選択（Miroのように、まとめて動かす・色を変える・消す）
  const [sel, setSel] = useState<Set<string>>(new Set());
  // 範囲選択の枠（背景を Shift ドラッグ）。画面座標で持つ。
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  // まとめて動かすため、掴んだ時点の全選択ノードの位置を覚えておく
  const dragRef = useRef<{ id: string; px: number; py: number; nx: number; ny: number;
                           group: { id: string; x: number; y: number }[] } | null>(null);
  const bandRef = useRef<{ x0: number; y0: number } | null>(null);
  const resizeRef = useRef<{ id: string; px: number; py: number; w0: number; h0: number; kind: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipSave = useRef(true);
  const latest = useRef<{ boardId: string; nodes: BoardNode[]; edges: BoardEdge[] }>({ boardId: "", nodes: [], edges: [] });
  latest.current = { boardId, nodes, edges };

  // ── undo / redo ──
  const histRef = useRef<BoardData[]>([]);
  const redoRef = useRef<BoardData[]>([]);
  const [histVersion, setHistVersion] = useState(0); // ボタンの活性表示用
  const snapshot = useCallback(() => {
    const { nodes: n, edges: e } = latest.current;
    histRef.current.push(JSON.parse(JSON.stringify({ nodes: n, edges: e })));
    if (histRef.current.length > 50) histRef.current.shift();
    redoRef.current = [];
    setHistVersion((v) => v + 1);
  }, []);
  const undo = useCallback(() => {
    const prev = histRef.current.pop();
    if (!prev) return;
    const { nodes: n, edges: e } = latest.current;
    redoRef.current.push(JSON.parse(JSON.stringify({ nodes: n, edges: e })));
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setHistVersion((v) => v + 1);
  }, []);
  const redoAction = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    const { nodes: n, edges: e } = latest.current;
    histRef.current.push(JSON.parse(JSON.stringify({ nodes: n, edges: e })));
    setNodes(next.nodes);
    setEdges(next.edges);
    setHistVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoAction(); else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoAction();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redoAction]);

  const resetHistory = () => { histRef.current = []; redoRef.current = []; setHistVersion((v) => v + 1); };

  /* ── save flush（ボード切替・離脱時に未保存分を即書き込み） ── */
  const flushSave = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const { boardId: bid, nodes: n, edges: e } = latest.current;
    if (!bid || skipSave.current) return;
    if (online) {
      try { await boardSaveById(bid, { nodes: n, edges: e }); } catch { /* ignore */ }
    } else {
      const s = loadLocalStore();
      const idx = s.boards.findIndex((b) => b.id === bid);
      if (idx >= 0) {
        s.boards[idx] = { ...s.boards[idx], nodes: n, edges: e };
        saveLocalStore(s);
      }
    }
  }, [online]);

  // アンマウント時にも未保存分を落とさない。
  useEffect(() => () => { void flushSave(); }, [flushSave]);

  /* ── load boards ── */
  const loadBoard = useCallback(async (id: string) => {
    await flushSave();  // 切替前に現在ボードの変更を確定
    skipSave.current = true;
    if (online) {
      try {
        const d = await boardGetById(id);
        setNodes(d.nodes);
        setEdges(d.edges);
      } catch {
        setNodes([]);
        setEdges([]);
      }
    } else {
      const s = loadLocalStore();
      const b = s.boards.find((x) => x.id === id) ?? s.boards[0];
      setNodes(b?.nodes ?? []);
      setEdges(b?.edges ?? []);
    }
    setBoardId(id);
    try { localStorage.setItem(LS_CURRENT, id); } catch { /* ignore */ }
    resetHistory();
    setEditing(null);
    setConnectFrom(null);
    setTimeout(() => { skipSave.current = false; }, 60);
  }, [online, flushSave]);

  const refreshMetas = useCallback(async (): Promise<BoardMeta[]> => {
    if (online) {
      try {
        const items = await boardsList();
        setMetas(items);
        return items;
      } catch {
        setMetas([]);
        return [];
      }
    }
    const s = loadLocalStore();
    const items = s.boards.map((b) => ({ id: b.id, name: b.name, count: b.nodes.length }));
    setMetas(items);
    return items;
  }, [online]);

  useEffect(() => {
    (async () => {
      const items = await refreshMetas();
      let target = "";
      try { target = localStorage.getItem(LS_CURRENT) || ""; } catch { /* ignore */ }
      if (!items.some((m) => m.id === target)) target = items[0]?.id || "";
      if (target) await loadBoard(target);
      setLoaded(true);
    })();
  }, [refreshMetas, loadBoard]);

  /* ── ほかの所での変化（会話で貼った付箋・別の端末） ──
     手元に書きかけが無ければ、そのまま読み直す。書きかけがあるときは
     消さずに、向こうで増えた物だけ足す。保存はボード全体の上書きなので、
     手元の古い中身のまま保存すると、会話で貼った付箋が消える。 */
  const busyRef = useRef(false);
  busyRef.current = saveState === "saving" || editing !== null;
  const onExternalChange = useCallback(async () => {
    if (!online) return;
    void refreshMetas();
    const bid = latest.current.boardId;
    if (!bid) return;
    let d: BoardData;
    try { d = await boardGetById(bid); } catch { return; }
    if (latest.current.boardId !== bid) return;         // 読んでいる間にボードを替えた
    if (!busyRef.current) {
      skipSave.current = true;
      setNodes(d.nodes);
      setEdges(d.edges);
      setTimeout(() => { skipSave.current = false; }, 60);
    } else {
      setNodes((cur) => addMissing(cur, d.nodes));
      setEdges((cur) => addMissing(cur, d.edges));
    }
  }, [online, refreshMetas]);
  useLive(["board"], () => void onExternalChange());

  /* ── debounced save ── */
  useEffect(() => {
    if (!loaded || skipSave.current || !boardId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      const { boardId: bid, nodes: n, edges: e } = latest.current;
      if (online) {
        try { await boardSaveById(bid, { nodes: n, edges: e }); } catch { /* ignore */ }
      } else {
        const s = loadLocalStore();
        const idx = s.boards.findIndex((b) => b.id === bid);
        if (idx >= 0) s.boards[idx] = { ...s.boards[idx], nodes: n, edges: e };
        saveLocalStore(s);
      }
      setSaveState("saved");
      setMetas((p) => p.map((m) => (m.id === bid ? { ...m, count: n.length } : m)));
      setTimeout(() => setSaveState("idle"), 1200);
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [nodes, edges, loaded, boardId, online]);

  /* ── board ops ── */
  const addBoard = async () => {
    const name = window.prompt("新しいボードの名前", `ボード ${metas.length + 1}`);
    if (name === null) return;
    if (online) {
      try {
        const b = await boardCreate(name || "");
        await refreshMetas();
        await loadBoard(b.id);
      } catch { /* ignore */ }
    } else {
      const s = loadLocalStore();
      const b: LocalBoard = { id: uid(), name: (name || `ボード ${s.boards.length + 1}`).slice(0, 60), nodes: [], edges: [] };
      s.boards.unshift(b);
      s.current = b.id;
      saveLocalStore(s);
      await refreshMetas();
      await loadBoard(b.id);
    }
  };

  const renameCurrent = async () => {
    const cur = metas.find((m) => m.id === boardId);
    const name = window.prompt("ボード名を変更", cur?.name || "");
    if (!name) return;
    if (online) {
      try { await boardRename(boardId, name); } catch { /* ignore */ }
    } else {
      const s = loadLocalStore();
      const b = s.boards.find((x) => x.id === boardId);
      if (b) b.name = name.slice(0, 60);
      saveLocalStore(s);
    }
    await refreshMetas();
  };

  const duplicateCurrent = async () => {
    if (online) {
      try {
        const d = await boardDuplicate(boardId);
        await refreshMetas();
        if (d.id) await loadBoard(d.id);
      } catch { /* ignore */ }
    } else {
      const s = loadLocalStore();
      const src = s.boards.find((x) => x.id === boardId);
      if (!src) return;
      const copy: LocalBoard = { id: uid(), name: `${src.name} (copy)`.slice(0, 60), nodes: JSON.parse(JSON.stringify(src.nodes)), edges: JSON.parse(JSON.stringify(src.edges)) };
      s.boards.unshift(copy);
      s.current = copy.id;
      saveLocalStore(s);
      await refreshMetas();
      await loadBoard(copy.id);
    }
  };

  const deleteCurrent = async () => {
    const cur = metas.find((m) => m.id === boardId);
    if (!window.confirm(`ボード「${cur?.name ?? ""}」を削除しますか？（元に戻せません）`)) return;
    if (online) {
      try { await boardDelete(boardId); } catch { /* ignore */ }
    } else {
      const s = loadLocalStore();
      s.boards = s.boards.filter((b) => b.id !== boardId);
      if (!s.boards.length) s.boards = [{ id: uid(), name: "メインボード", nodes: [], edges: [] }];
      s.current = s.boards[0].id;
      saveLocalStore(s);
    }
    const items = await refreshMetas();
    if (items[0]) await loadBoard(items[0].id);
  };

  /* ── canvas coords ── */
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const rx = clientX - (rect?.left ?? 0);
    const ry = clientY - (rect?.top ?? 0);
    return { x: (rx - view.x) / view.scale, y: (ry - view.y) / view.scale };
  }, [view]);

  /** 要素内のローカル座標（既にrectを引いた値）→ キャンバス座標。 */
  const toCanvasLocal = useCallback((lx: number, ly: number) => (
    { x: (lx - view.x) / view.scale, y: (ly - view.y) / view.scale }
  ), [view]);

  /** 短い通知（選択件数など）。 */
  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1600);
  }, []);

  /* ── node ops ── */
  const addNode = useCallback((kind: "sticky" | "text" | "frame", x?: number, y?: number) => {
    snapshot();
    const rect = wrapRef.current?.getBoundingClientRect();
    const cx = x ?? ((rect?.width ?? 800) / 2 - view.x) / view.scale - 100;
    const cy = y ?? ((rect?.height ?? 500) / 2 - view.y) / view.scale - 50;
    const node: BoardNode =
      kind === "frame"
        ? { id: uid(), x: cx - 60, y: cy - 40, text: "フレーム", color: "cyan", w: 340, h: 240, kind }
        : kind === "text"
          ? { id: uid(), x: cx, y: cy, text: "", color: "cyan", w: 240, h: 0, kind }
          : { id: uid(), x: cx, y: cy, text: "", color: "yellow", w: 200, h: 0, kind };
    setNodes((p) => [...p, node]);
    setEditing(node.id);
  }, [view, snapshot]);

  const removeNode = (id: string) => {
    snapshot();
    setNodes((p) => p.filter((n) => n.id !== id));
    setEdges((p) => p.filter((e) => e.from !== id && e.to !== id));
    if (editing === id) setEditing(null);
  };

  const commitText = (id: string, text: string) => {
    const cur = nodes.find((n) => n.id === id);
    if (cur && cur.text !== text) {
      snapshot();
      setNodes((p) => p.map((n) => (n.id === id ? { ...n, text } : n)));
    }
    setEditing(null);
  };

  const setNodeColor = (id: string, color: string) => {
    snapshot();
    setNodes((p) => p.map((n) => (n.id === id ? { ...n, color } : n)));
  };

  const noteToTask = async (n: BoardNode) => {
    if (!online) return;
    const lines = (n.text || "").trim().split("\n");
    const title = (lines[0] || "").trim();
    if (!title) { setToast("⚠ 空の付箋はタスク化できません"); setTimeout(() => setToast(null), 2000); return; }
    try {
      await createTask(title.slice(0, 80), lines.slice(1).join("\n").trim());
      setToast(`✓ タスク化しました：${title.slice(0, 24)}`);
    } catch {
      setToast("⚠ タスク化に失敗しました");
    }
    setTimeout(() => setToast(null), 2200);
  };

  /* ── background pan / dblclick / wheel zoom ── */
  const onBgPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.shiftKey) {
      // Shift+ドラッグ = 範囲選択（素のドラッグはパンのまま残す）
      const r = wrapRef.current?.getBoundingClientRect();
      const x = e.clientX - (r?.left ?? 0), y = e.clientY - (r?.top ?? 0);
      bandRef.current = { x0: x, y0: y };
      setBand({ x0: x, y0: y, x1: x, y1: y });
      return;
    }
    setSel(new Set());       // 何もない所を掴んだら選択解除
    panRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
  };
  const onBgPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const b = bandRef.current;
    if (b) {
      const r = wrapRef.current?.getBoundingClientRect();
      setBand({ x0: b.x0, y0: b.y0, x1: e.clientX - (r?.left ?? 0), y1: e.clientY - (r?.top ?? 0) });
      return;
    }
    const pan = panRef.current;
    if (!pan) return;
    setView((v) => ({ ...v, x: pan.vx + (e.clientX - pan.px), y: pan.vy + (e.clientY - pan.py) }));
  };
  const onBgPointerUp = () => {
    panRef.current = null;
    if (bandRef.current && band) {
      // 枠に重なったノードを選ぶ（枠は画面座標なのでキャンバス座標へ直す）
      const a = toCanvasLocal(Math.min(band.x0, band.x1), Math.min(band.y0, band.y1));
      const c = toCanvasLocal(Math.max(band.x0, band.x1), Math.max(band.y0, band.y1));
      const picked = nodes.filter((n) => {
        const w = n.w ?? 200, h = n.h ?? 90;
        return n.x < c.x && n.x + w > a.x && n.y < c.y && n.y + h > a.y;
      }).map((n) => n.id);
      setSel(new Set(picked));
      if (picked.length > 1) flash(`${picked.length}件を選択`);
    }
    bandRef.current = null;
    setBand(null);
  };
  const onBgDoubleClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const p = toCanvas(e.clientX, e.clientY);
    addNode("sticky", p.x - 100, p.y - 40);
  };

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

  const zoomToFit = () => {
    if (!nodes.length) { setView({ x: 60, y: 40, scale: 1 }); return; }
    const rect = wrapRef.current?.getBoundingClientRect();
    const W = rect?.width ?? 800;
    const H = rect?.height ?? 500;
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + (n.w ?? 200)));
    const maxY = Math.max(...nodes.map((n) => n.y + (n.h && n.h > 0 ? n.h : 120)));
    const bw = Math.max(120, maxX - minX);
    const bh = Math.max(120, maxY - minY);
    const scale = Math.min(2.5, Math.max(0.25, Math.min((W - 80) / bw, (H - 80) / bh)));
    setView({ scale, x: (W - bw * scale) / 2 - minX * scale, y: (H - bh * scale) / 2 - minY * scale });
  };

  /* ── node drag / connect / resize ── */
  const onNodePointerDown = (e: ReactPointerEvent<HTMLDivElement>, n: BoardNode) => {
    if (editing === n.id) return;
    if ((e.target as HTMLElement).closest("button,[data-resize]")) return;
    e.stopPropagation();
    if (connectMode) {
      if (!connectFrom) {
        setConnectFrom(n.id);
      } else if (connectFrom !== n.id) {
        const dup = edges.some((ed) => (ed.from === connectFrom && ed.to === n.id) || (ed.from === n.id && ed.to === connectFrom));
        if (!dup) { snapshot(); setEdges((p) => [...p, { id: uid(), from: connectFrom, to: n.id }]); }
        setConnectFrom(null);
      }
      return;
    }
    // Shift+クリックは選択の追加/解除だけ（移動はしない）
    if (e.shiftKey) {
      setSel((prev) => {
        const next = new Set(prev);
        if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
        return next;
      });
      return;
    }
    // 選択外を掴んだらその1件だけの選択に切り替える（Miroと同じ挙動）
    const group = sel.has(n.id) ? Array.from(sel) : [n.id];
    if (!sel.has(n.id)) setSel(new Set([n.id]));
    snapshot();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      id: n.id, px: e.clientX, py: e.clientY, nx: n.x, ny: n.y,
      group: nodes.filter((m) => group.includes(m.id)).map((m) => ({ id: m.id, x: m.x, y: m.y })),
    };
  };
  const onNodePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) {
      const dx = (e.clientX - d.px) / view.scale;
      const dy = (e.clientY - d.py) / view.scale;
      // 選択中のノードは相対位置を保ったまま一緒に動く
      const base = new Map(d.group.map((g) => [g.id, g]));
      setNodes((p) => p.map((n) => {
        const g = base.get(n.id);
        return g ? { ...n, x: g.x + dx, y: g.y + dy } : n;
      }));
      return;
    }
    const r = resizeRef.current;
    if (r) {
      const dx = (e.clientX - r.px) / view.scale;
      const dy = (e.clientY - r.py) / view.scale;
      setNodes((p) => p.map((n) => {
        if (n.id !== r.id) return n;
        const w = Math.max(120, r.w0 + dx);
        const h = r.kind === "frame" ? Math.max(80, r.h0 + dy) : n.h;
        return { ...n, w, h };
      }));
    }
  };
  const onNodePointerUp = () => { dragRef.current = null; resizeRef.current = null; };

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>, n: BoardNode) => {
    e.stopPropagation();
    snapshot();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = { id: n.id, px: e.clientX, py: e.clientY, w0: n.w ?? 200, h0: n.h ?? 0, kind: n.kind ?? "sticky" };
  };

  /* ── edges geometry (arrowed) ── */
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const center = (n: BoardNode) => ({ x: n.x + (n.w ?? 200) / 2, y: n.y + (n.h && n.h > 0 ? n.h / 2 : 55) });
  const edgeLines = edges
    .map((e) => {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) return null;
      const ca = center(a);
      const cb = center(b);
      // 矢印の先端がノードに刺さりすぎないよう、終点を少し手前に。
      const dx = cb.x - ca.x;
      const dy = cb.y - ca.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const trim = Math.min(60, len * 0.18);
      return { id: e.id, x1: ca.x, y1: ca.y, x2: cb.x - (dx / len) * trim, y2: cb.y - (dy / len) * trim };
    })
    .filter(Boolean) as { id: string; x1: number; y1: number; x2: number; y2: number }[];

  // フレームを背面に描画する（DOM順で制御）
  const ordered = useMemo(() => [...nodes.filter((n) => n.kind === "frame"), ...nodes.filter((n) => n.kind !== "frame")], [nodes]);
  const canUndo = histRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
  void histVersion;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {/* ── Boards bar ── */}
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5" data-boards-bar>
        {metas.map((m) => {
          const active = m.id === boardId;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => { if (!active) void loadBoard(m.id); }}
              onDoubleClick={() => { if (active) void renameCurrent(); }}
              title={active ? "ダブルクリックで名称変更" : m.name}
              className="flex shrink-0 items-center gap-1.5 rounded-t-lg border-x border-t px-3 py-1.5 text-[10px] tracking-[0.1em] transition label-mono"
              style={{
                borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                color: active ? "var(--fg-strong)" : "var(--muted)",
                background: active ? "var(--btn-bg)" : "rgba(255,255,255,0.02)",
                boxShadow: active ? "0 -1px 10px var(--glow)" : "none",
              }}
            >
              ▦ {m.name}
              {typeof m.count === "number" && <span className="text-[11px] opacity-60">{m.count}</span>}
            </button>
          );
        })}
        <button type="button" onClick={() => void addBoard()} title="新しいボード"
          className="shrink-0 rounded-t-lg border-x border-t border-panel px-2.5 py-1.5 text-[11px] text-muted transition hover:text-fg-strong label-mono">
          ＋ ボード
        </button>
        <span className="mx-1 h-4 w-px shrink-0 bg-[var(--panel-bd)]" />
        <button type="button" onClick={() => void renameCurrent()} title="名称変更" className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted hover:text-fg-strong">✎</button>
        <button type="button" onClick={() => void duplicateCurrent()} title="複製" className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted hover:text-fg-strong">⧉</button>
        <button type="button" onClick={() => void deleteCurrent()} title="ボードを削除" className="shrink-0 rounded px-1.5 py-1 text-[11px] text-[#ff8888]">✕</button>
      </div>

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1 rounded-forge border border-panel p-0.5">
          <button type="button" onClick={() => addNode("sticky")}
            className="rounded px-2.5 py-1 text-[10px] tracking-[0.12em] text-fg-strong transition hover:bg-white/5 label-mono" title="付箋を追加">
            ＋ 付箋
          </button>
          <button type="button" onClick={() => addNode("text")}
            className="rounded px-2.5 py-1 text-[10px] tracking-[0.12em] text-muted transition hover:bg-white/5 hover:text-fg-strong label-mono" title="テキストを追加">
            Ｔ テキスト
          </button>
          <button type="button" onClick={() => addNode("frame")}
            className="rounded px-2.5 py-1 text-[10px] tracking-[0.12em] text-muted transition hover:bg-white/5 hover:text-fg-strong label-mono" title="フレーム（グループ枠）を追加">
            ▭ フレーム
          </button>
        </div>

        <button
          type="button"
          onClick={() => { setConnectMode((c) => !c); setConnectFrom(null); }}
          aria-pressed={connectMode}
          className="rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.12em] label-mono"
          style={{
            borderColor: connectMode ? "var(--accent)" : "var(--panel-bd)",
            color: connectMode ? "var(--fg-strong)" : "var(--muted)",
            background: connectMode ? "var(--btn-bg)" : "transparent",
          }}
          title="付箋どうしを矢印で結ぶ"
        >
          🔗 接続{connectMode ? (connectFrom ? "：2枚目を選択" : "：1枚目を選択") : ""}
        </button>

        <div className="flex items-center gap-0.5 rounded-forge border border-panel p-0.5">
          <button type="button" onClick={undo} disabled={!canUndo} aria-label="元に戻す" title="元に戻す (Ctrl+Z)"
            className="grid h-7 w-7 place-items-center rounded text-muted hover:text-fg-strong disabled:opacity-30">↩︎</button>
          <button type="button" onClick={redoAction} disabled={!canRedo} aria-label="やり直す" title="やり直す (Ctrl+Shift+Z)"
            className="grid h-7 w-7 place-items-center rounded text-muted hover:text-fg-strong disabled:opacity-30">↪︎</button>
        </div>

        <div className="flex items-center gap-0.5 rounded-forge border border-panel p-0.5">
          <button type="button" onClick={() => zoomBy(0.85)} aria-label="縮小" className="grid h-7 w-7 place-items-center rounded text-muted hover:text-fg-strong">−</button>
          <span className="w-11 text-center text-[10px] text-muted label-mono">{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.18)} aria-label="拡大" className="grid h-7 w-7 place-items-center rounded text-muted hover:text-fg-strong">＋</button>
          <button type="button" onClick={zoomToFit} aria-label="全体を表示" title="全体を表示" className="grid h-7 w-7 place-items-center rounded text-muted hover:text-fg-strong">⊡</button>
          <button type="button" onClick={() => setView({ x: 60, y: 40, scale: 1 })} aria-label="表示リセット" title="100%に戻す" className="grid h-7 w-7 place-items-center rounded text-muted hover:text-fg-strong">⌂</button>
        </div>

        <span className="ml-auto flex items-center gap-2 text-[9px] tracking-[0.12em] text-muted label-mono">
          {toast ? <span className="text-[var(--accent)]">{toast}</span> : null}
          {saveState === "saving" ? "● SAVING…" : saveState === "saved" ? "✓ SAVED" : online ? "AUTOSAVE" : "LOCAL（オフライン保存）"}
        </span>
      </div>

      {/* ── Canvas ── */}
      <div
        ref={wrapRef}
        data-board-canvas
        onPointerDown={onBgPointerDown}
        onPointerMove={onBgPointerMove}
        onPointerUp={onBgPointerUp}
        onDoubleClick={onBgDoubleClick}
        onWheel={onWheel}
        onScroll={(e) => {
          // 巨大なSVGレイヤーがあるため、フォーカス時の scrollIntoView が
          // overflow-hidden でも scrollTop を動かして視点が飛ぶ。常に0へ固定。
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
        className="relative min-h-0 flex-1 touch-none overflow-hidden rounded-forge border border-panel"
        style={{
          cursor: panRef.current ? "grabbing" : "default",
          background:
            `radial-gradient(circle, rgba(197,198,199,0.13) 1px, transparent 1px) 0 0 / ${24 * view.scale}px ${24 * view.scale}px, rgba(8,11,18,0.5)`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        {/* 空のキャンバスは、何をする場所なのかも次の一手も分からない。
            使い始めたら消えるので、作業の邪魔にはならない。

            以前はここと下に、同じ真ん中へ置く案内が2つあった。どちらも
            absolute inset-0 の中央寄せなので、文字がそのまま重なって
            読めなくなっていた。1つにまとめてある。 */}
        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
            <div>
              <p className="text-[12px] text-fg-strong">考えを広げる場所です</p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                上の「＋ 付箋」で貼るか、<span className="text-fg">何もない所をダブルクリック</span>すると置けます。
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted/70">
                付箋どうしは線でつなげます。書いた内容はそのまま保存されます。
              </p>
              {/* キーボードの併用技は指では使えないので、狭い画面には出さない。 */}
              {loaded && (
                <p className="mt-3 hidden text-[10px] leading-relaxed tracking-[0.1em] text-muted/60 label-mono sm:block">
                  Shift+ドラッグで範囲選択 · Shift+クリックで複数選択<br />
                  線はクリックで種類切替 / Shift+クリックでラベル / Alt+クリックで削除
                </p>
              )}
            </div>
          </div>
        )}

        <div className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "0 0" }}>
          {/* edges (arrows) */}
          <svg className="pointer-events-none absolute -left-[5000px] -top-[5000px]" width="10000" height="10000" aria-hidden>
            <defs>
              <marker id="wb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" fill="rgba(0,243,255,0.75)" />
              </marker>
            </defs>
            <g transform="translate(5000,5000)">
              {edgeLines.map((l) => {
                const ed = edges.find((x) => x.id === l.id);
                const style = ed?.style ?? "arrow";
                return (
                  <g key={l.id}>
                    <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                      stroke="rgba(0,243,255,0.5)" strokeWidth={2 / view.scale}
                      strokeDasharray={style === "dashed" ? `${6 / view.scale} ${5 / view.scale}` : undefined}
                      markerEnd={style === "arrow" ? "url(#wb-arrow)" : undefined} />
                    {/* 関係の説明（原因/根拠など）を線の中央に置く */}
                    {ed?.label && (
                      <text x={(l.x1 + l.x2) / 2} y={(l.y1 + l.y2) / 2 - 4 / view.scale}
                        textAnchor="middle" fill="rgba(223,230,242,0.9)"
                        fontSize={11 / view.scale} style={{ paintOrder: "stroke" }}
                        stroke="rgba(8,11,18,0.9)" strokeWidth={3 / view.scale}>
                        {ed.label}
                      </text>
                    )}
                    <line
                      x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                      stroke="transparent" strokeWidth={14 / view.scale}
                      className="pointer-events-auto cursor-pointer"
                      onClick={(e) => {
                        // 素のクリック＝種類を切替、Shift＝ラベル編集、Alt＝削除。
                        // 以前は必ず削除だったので、押し間違いで線が消えていた。
                        if (e.altKey) { snapshot(); setEdges((p) => p.filter((x) => x.id !== l.id)); return; }
                        if (e.shiftKey) {
                          const cur = ed?.label ?? "";
                          const next = window.prompt("この線のラベル（空で消す）", cur);
                          if (next === null) return;
                          snapshot();
                          setEdges((p) => p.map((x) => (x.id === l.id ? { ...x, label: next.trim() } : x)));
                          return;
                        }
                        const order = ["arrow", "line", "dashed"] as const;
                        const nextStyle = order[(order.indexOf(style) + 1) % order.length];
                        snapshot();
                        setEdges((p) => p.map((x) => (x.id === l.id ? { ...x, style: nextStyle } : x)));
                        flash(`線: ${nextStyle === "arrow" ? "矢印" : nextStyle === "line" ? "直線" : "点線"}`);
                      }}
                    >
                      <title>クリックで線の種類を切替 / Shift+クリックでラベル / Alt+クリックで削除</title>
                    </line>
                  </g>
                );
              })}
            </g>
          </svg>

          {/* nodes（フレームが先＝背面） */}
          {ordered.map((n) => {
            const c = COLORS[n.color] ?? COLORS.yellow;
            const kind = n.kind ?? "sticky";
            const isEditing = editing === n.id;
            const isConnectSrc = connectFrom === n.id;
            const isSel = sel.has(n.id);
            return (
              <div
                key={n.id}
                data-note
                data-selected={isSel ? "1" : undefined}
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onPointerMove={onNodePointerMove}
                onPointerUp={onNodePointerUp}
                onDoubleClick={(e) => { e.stopPropagation(); setEditing(n.id); }}
                className="group absolute select-none"
                style={{
                  left: n.x, top: n.y, width: n.w ?? 200,
                  height: kind === "frame" ? (n.h && n.h > 0 ? n.h : 240) : undefined,
                  cursor: connectMode ? "crosshair" : "grab",
                  // 選択リング。boxShadow は種類ごとに上書きされるので outline を使う
                  outline: isSel ? "2px solid var(--accent)" : undefined,
                  outlineOffset: isSel ? 2 : undefined,
                  ...(kind === "sticky" ? {
                    background: c.bg,
                    border: `1px solid ${isConnectSrc ? "var(--accent)" : c.border}`,
                    borderRadius: 10,
                    boxShadow: isConnectSrc ? "0 0 14px var(--glow)" : "0 6px 18px rgba(0,0,0,0.35)",
                    padding: 8,
                  } : kind === "text" ? {
                    background: "transparent",
                    border: isConnectSrc ? "1px dashed var(--accent)" : "1px dashed transparent",
                    borderRadius: 6,
                    padding: 4,
                  } : {
                    background: "rgba(255,255,255,0.015)",
                    border: `1.5px dashed ${isConnectSrc ? "var(--accent)" : c.border}`,
                    borderRadius: 12,
                    padding: 8,
                  }),
                }}
              >
                {/* frame label / content */}
                {kind === "frame" ? (
                  isEditing ? (
                    <input
                      autoFocus
                      defaultValue={n.text}
                      onBlur={(e) => commitText(n.id, e.target.value)}
                      onKeyDown={(e) => { if (!isComposingKey(e) && (e.key === "Enter" || e.key === "Escape")) (e.target as HTMLInputElement).blur(); }}
                      className="w-full bg-transparent text-[11px] tracking-[0.12em] text-fg-strong focus:outline-none label-mono"
                    />
                  ) : (
                    <span className="text-[11px] tracking-[0.12em] label-mono" style={{ color: c.border }}>{n.text || "フレーム"}</span>
                  )
                ) : isEditing ? (
                  <textarea
                    autoFocus
                    defaultValue={n.text}
                    onBlur={(e) => commitText(n.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur(); }}
                    rows={kind === "text" ? 2 : 3}
                    placeholder={kind === "text" ? "テキスト…" : "メモを書く…"}
                    className="w-full resize-none bg-transparent leading-relaxed text-fg-strong placeholder:text-muted focus:outline-none"
                    style={{ fontSize: kind === "text" ? 16 : 12 }}
                  />
                ) : (
                  <p
                    className="whitespace-pre-wrap break-words leading-relaxed"
                    style={{
                      fontSize: kind === "text" ? 16 : 12,
                      minHeight: kind === "text" ? "1.6rem" : "3.2rem",
                      color: kind === "text" ? "var(--fg-strong)" : "var(--fg)",
                    }}
                  >
                    {n.text || <span className="text-muted/60">（ダブルクリックで編集）</span>}
                  </p>
                )}

                {/* hover controls */}
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
                  {online && kind !== "frame" && (
                    <button type="button" onClick={() => void noteToTask(n)} title="この付箋をタスク化" aria-label="タスク化"
                      className="ml-1 text-[11px] text-muted hover:text-[#60d394]">☑</button>
                  )}
                  <button type="button" onClick={() => removeNode(n.id)} aria-label="削除" className="ml-auto text-[11px] text-[#ff8888]">✕</button>
                </div>

                {/* resize handle */}
                <div
                  data-resize
                  onPointerDown={(e) => onResizeDown(e, n)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                  title="ドラッグでサイズ変更"
                  className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize opacity-0 transition group-hover:opacity-100"
                  style={{ borderRight: `2px solid ${c.border}`, borderBottom: `2px solid ${c.border}`, borderBottomRightRadius: 8 }}
                />
              </div>
            );
          })}
        </div>

        {/* 範囲選択の枠（Shift+背景ドラッグ中） */}
        {band && (
          <div className="pointer-events-none absolute border border-[var(--accent)]"
            style={{
              left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1),
              width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0),
              background: "rgba(0,243,255,0.08)",
            }} />
        )}

        {/* 選択中のまとめ操作。何件選んでいるかと、できることを出す。 */}
        {sel.size > 0 && (
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-forge border border-[var(--line)] bg-[rgba(8,11,18,0.92)] px-2 py-1.5">
            <span className="text-[10px] text-fg-strong label-mono">{sel.size}件選択</span>
            {Object.entries(COLORS).map(([key, col]) => (
              <button key={key} type="button" aria-label={`選択中を${key}にする`}
                onClick={() => {
                  snapshot();
                  setNodes((p) => p.map((n) => (sel.has(n.id) ? { ...n, color: key } : n)));
                }}
                className="h-4 w-4 rounded-full border"
                style={{ background: col.bg, borderColor: col.border }} />
            ))}
            <button type="button" aria-label="選択中をまとめて削除" onClick={() => {
              snapshot();
              // 選択したノードと、それに繋がる線も一緒に消す（線だけ残らないように）
              setNodes((p) => p.filter((n) => !sel.has(n.id)));
              setEdges((p) => p.filter((e) => !sel.has(e.from) && !sel.has(e.to)));
              flash(`${sel.size}件を削除`);
              setSel(new Set());
            }}
              className="rounded border border-panel px-2 py-0.5 text-[10px] text-muted transition hover:text-[#ff9b9b] label-mono">
              削除
            </button>
            <button type="button" aria-label="選択を解除" onClick={() => setSel(new Set())}
              className="rounded border border-panel px-2 py-0.5 text-[10px] text-muted transition hover:text-fg-strong label-mono">
              選択解除
            </button>
          </div>
        )}

        {/* 空のときの案内は上の1か所にまとめた（ここにも同じ物があり、
            真ん中で重なって読めなくなっていた）。 */}
      </div>
    </div>
  );
}
