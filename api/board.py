# board.py — Miro風ホワイトボードの永続化（付箋ノード + 接続エッジ）
# =====================================================================
# 単一の共有ボードを dashboard_boards テーブル（旧Streamlit時代から存在）に保存する。
#   nodes: [{id, x, y, text, color, w?}, ...]
#   edges: [{id, from, to}, ...]
# Supabase 未設定時はプロセス内メモリに縮退（フロントはオフライン時 localStorage）。
# =====================================================================

import uuid
from typing import List, Optional

import config

_mem_board: dict = {"nodes": [], "edges": []}
_row_id: Optional[str] = None  # dashboard_boards の使用行（単一ボード運用）

MAX_NODES = 500
MAX_TEXT = 2000


def _sanitize(nodes: List[dict], edges: List[dict]) -> tuple:
    """保存前の軽い正規化（型・サイズの安全弁。絶対に raise しない）。"""
    out_nodes = []
    for n in (nodes or [])[:MAX_NODES]:
        if not isinstance(n, dict):
            continue
        out_nodes.append({
            "id": str(n.get("id") or uuid.uuid4()),
            "x": float(n.get("x") or 0),
            "y": float(n.get("y") or 0),
            "text": str(n.get("text") or "")[:MAX_TEXT],
            "color": str(n.get("color") or "yellow")[:16],
            "w": float(n.get("w") or 200),
        })
    ids = {n["id"] for n in out_nodes}
    out_edges = []
    for e in (edges or [])[: MAX_NODES * 2]:
        if not isinstance(e, dict):
            continue
        f, t = str(e.get("from") or ""), str(e.get("to") or "")
        if f in ids and t in ids and f != t:
            out_edges.append({"id": str(e.get("id") or uuid.uuid4()), "from": f, "to": t})
    return out_nodes, out_edges


def get_board() -> dict:
    """ボードを返す。{nodes, edges}。"""
    global _row_id
    c = config.get_supabase()
    if c:
        try:
            res = c.table("dashboard_boards").select("*").limit(1).execute()
            rows = res.data or []
            if rows:
                _row_id = rows[0].get("id")
                return {"nodes": rows[0].get("nodes") or [], "edges": rows[0].get("edges") or []}
            return {"nodes": [], "edges": []}
        except Exception:
            pass
    return dict(_mem_board)


def save_board(nodes: List[dict], edges: List[dict]) -> dict:
    """ボードを保存する。{ok, nodes, edges}。"""
    global _row_id, _mem_board
    nodes, edges = _sanitize(nodes, edges)
    _mem_board = {"nodes": nodes, "edges": edges}

    c = config.get_supabase()
    if c:
        try:
            if _row_id is None:
                res = c.table("dashboard_boards").select("id").limit(1).execute()
                rows = res.data or []
                if rows:
                    _row_id = rows[0]["id"]
            if _row_id:
                c.table("dashboard_boards").update({"nodes": nodes, "edges": edges}).eq("id", _row_id).execute()
            else:
                res = c.table("dashboard_boards").insert({"nodes": nodes, "edges": edges}).execute()
                if res.data:
                    _row_id = res.data[0].get("id")
        except Exception:
            pass  # メモリには保存済み → 優雅に縮退

    return {"ok": True, "nodes": nodes, "edges": edges}


def add_note(text: str, color: str = "yellow") -> dict:
    """付箋を1枚追加する（エージェント用）。位置は既存ノード数から自動配置。"""
    text = (text or "").strip()
    if not text:
        return {"error": "text is empty"}
    board = get_board()
    nodes = board.get("nodes") or []
    n = len(nodes)
    # 4列のグリッドに順に置いていく（重なりにくい自動レイアウト）。
    node = {
        "id": str(uuid.uuid4()),
        "x": 40 + (n % 4) * 230,
        "y": 40 + (n // 4) * 150,
        "text": text[:MAX_TEXT],
        "color": color if color in ("yellow", "cyan", "green", "pink", "purple", "orange") else "yellow",
        "w": 200,
    }
    nodes.append(node)
    save_board(nodes, board.get("edges") or [])
    return {"ok": True, "node": node, "count": len(nodes)}
