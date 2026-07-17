# board.py — Miro風ホワイトボードの永続化（複数ボード対応）
# =====================================================================
# dashboard_boards テーブルに 1行=1ボード で保存する。
#   ボード: {id, name, nodes, edges, updated_at}
#   nodes: [{id, x, y, text, color, w, h?, kind?}, ...]  kind: sticky|text|frame
#   edges: [{id, from, to}, ...]（from→to の向きで矢印を描く）
# Supabase 未設定時はプロセス内メモリに縮退（フロントはオフライン時 localStorage）。
# 旧API互換: get_board()/save_board() は「最初のボード」を対象にする。
# =====================================================================

import uuid
from datetime import datetime, timezone
from typing import List, Optional

import config

_mem_boards: List[dict] = []  # [{id, name, nodes, edges, updated_at}]

MAX_NODES = 500
MAX_TEXT = 2000
MAX_BOARDS = 50
NODE_KINDS = ("sticky", "text", "frame")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize(nodes: List[dict], edges: List[dict]) -> tuple:
    """保存前の軽い正規化（型・サイズの安全弁。絶対に raise しない）。"""
    out_nodes = []
    for n in (nodes or [])[:MAX_NODES]:
        if not isinstance(n, dict):
            continue
        kind = str(n.get("kind") or "sticky")
        out_nodes.append({
            "id": str(n.get("id") or uuid.uuid4()),
            "x": float(n.get("x") or 0),
            "y": float(n.get("y") or 0),
            "text": str(n.get("text") or "")[:MAX_TEXT],
            "color": str(n.get("color") or "yellow")[:16],
            "w": float(n.get("w") or 200),
            "h": float(n.get("h") or 0),  # 0 = auto（stickyは自動高さ）
            "kind": kind if kind in NODE_KINDS else "sticky",
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


def _meta(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "name": row.get("name") or "ボード",
        "updated_at": row.get("updated_at") or "",
        "count": len(row.get("nodes") or []),
    }


# ── boards CRUD ──────────────────────────────────────────────────────
def list_boards() -> List[dict]:
    """ボードの一覧（メタのみ・更新順）。1枚も無ければ既定ボードを作る。"""
    c = config.get_supabase()
    if c:
        try:
            res = (c.table("dashboard_boards")
                   .select("id,name,nodes,updated_at")
                   .order("updated_at", desc=True).limit(MAX_BOARDS).execute())
            rows = res.data or []
            if rows:
                return [_meta(r) for r in rows]
            created = create_board("メインボード")
            return [_meta(created)] if created.get("id") else []
        except Exception:
            pass
    if not _mem_boards:
        create_board("メインボード")
    return [_meta(b) for b in _mem_boards]


def create_board(name: str = "") -> dict:
    """ボードを作成して返す（メタ + 空の nodes/edges）。"""
    name = (name or "").strip() or f"ボード {len(_mem_boards) + 1}"
    row = {"id": str(uuid.uuid4()), "name": name[:60], "nodes": [], "edges": [], "updated_at": _now_iso()}
    c = config.get_supabase()
    if c:
        try:
            res = c.table("dashboard_boards").insert(
                {"id": row["id"], "name": row["name"], "nodes": [], "edges": []}).execute()
            if res.data:
                return {**res.data[0], "nodes": [], "edges": []}
        except Exception:
            # 旧テーブル（name列なし）→ 名前なしで作成
            try:
                res = c.table("dashboard_boards").insert({"id": row["id"], "nodes": [], "edges": []}).execute()
                if res.data:
                    return {**res.data[0], "name": row["name"], "nodes": [], "edges": []}
            except Exception:
                pass
    _mem_boards.insert(0, row)
    return row


def get_board(board_id: Optional[str] = None) -> dict:
    """ボード1枚を返す（{id, name, nodes, edges}）。board_id 省略時は最初のボード。"""
    c = config.get_supabase()
    if c:
        try:
            q = c.table("dashboard_boards").select("*")
            if board_id:
                q = q.eq("id", board_id)
            else:
                q = q.order("updated_at", desc=True)
            rows = (q.limit(1).execute().data) or []
            if rows:
                r = rows[0]
                return {"id": r.get("id"), "name": r.get("name") or "ボード",
                        "nodes": r.get("nodes") or [], "edges": r.get("edges") or []}
            if board_id:
                return {"error": "board not found"}
            created = create_board("メインボード")
            return {"id": created.get("id"), "name": created.get("name"),
                    "nodes": [], "edges": []}
        except Exception:
            pass
    for b in _mem_boards:
        if not board_id or b["id"] == board_id:
            return {"id": b["id"], "name": b["name"], "nodes": b["nodes"], "edges": b["edges"]}
    if board_id:
        return {"error": "board not found"}
    created = create_board("メインボード")
    return {"id": created["id"], "name": created["name"], "nodes": [], "edges": []}


def save_board(nodes: List[dict], edges: List[dict], board_id: Optional[str] = None) -> dict:
    """ボードを保存する（全置換）。board_id 省略時は最初のボード。"""
    nodes, edges = _sanitize(nodes, edges)
    target = get_board(board_id)
    if target.get("error"):
        return target
    bid = target["id"]

    c = config.get_supabase()
    if c:
        try:
            c.table("dashboard_boards").update(
                {"nodes": nodes, "edges": edges, "updated_at": _now_iso()}).eq("id", bid).execute()
        except Exception:
            try:  # 旧テーブル（updated_at がトリガー無しでも）最低限 nodes/edges を保存
                c.table("dashboard_boards").update({"nodes": nodes, "edges": edges}).eq("id", bid).execute()
            except Exception:
                pass
    for b in _mem_boards:
        if b["id"] == bid:
            b["nodes"], b["edges"], b["updated_at"] = nodes, edges, _now_iso()
    return {"ok": True, "id": bid, "nodes": nodes, "edges": edges}


def rename_board(board_id: str, name: str) -> dict:
    name = (name or "").strip()
    if not (board_id and name):
        return {"error": "board_id and name are required"}
    c = config.get_supabase()
    if c:
        try:
            c.table("dashboard_boards").update({"name": name[:60], "updated_at": _now_iso()}).eq("id", board_id).execute()
        except Exception:
            pass
    for b in _mem_boards:
        if b["id"] == board_id:
            b["name"] = name[:60]
    return {"ok": True, "id": board_id, "name": name[:60]}


def delete_board(board_id: str) -> dict:
    global _mem_boards
    if not board_id:
        return {"error": "board_id is required"}
    _mem_boards = [b for b in _mem_boards if b["id"] != board_id]
    c = config.get_supabase()
    if c:
        try:
            c.table("dashboard_boards").delete().eq("id", board_id).execute()
        except Exception:
            pass
    return {"ok": True}


def duplicate_board(board_id: str) -> dict:
    """ボードを複製する（"名前 (copy)"）。"""
    src = get_board(board_id)
    if src.get("error"):
        return src
    new = create_board(f"{src.get('name', 'ボード')} (copy)")
    if not new.get("id"):
        return {"error": "duplicate failed"}
    save_board(src.get("nodes") or [], src.get("edges") or [], new["id"])
    return {"ok": True, "id": new["id"], "name": new.get("name")}


# ── agent tool ───────────────────────────────────────────────────────
def add_note(text: str, color: str = "yellow", board_name: str = "") -> dict:
    """付箋を1枚追加する（エージェント用）。board_name 部分一致で対象ボードを選べる。"""
    text = (text or "").strip()
    if not text:
        return {"error": "text is empty"}

    bid: Optional[str] = None
    bname = ""
    if board_name:
        key = board_name.strip().lower()
        match = next((m for m in list_boards() if key in (m.get("name") or "").lower()), None)
        if match:
            bid, bname = match["id"], match["name"]
    board = get_board(bid)
    if board.get("error"):
        return board
    bid, bname = board["id"], board.get("name", "")

    nodes = board.get("nodes") or []
    n = len(nodes)
    node = {
        "id": str(uuid.uuid4()),
        "x": 40 + (n % 4) * 230,
        "y": 40 + (n // 4) * 150,
        "text": text[:MAX_TEXT],
        "color": color if color in ("yellow", "cyan", "green", "pink", "purple", "orange") else "yellow",
        "w": 200, "h": 0, "kind": "sticky",
    }
    nodes.append(node)
    save_board(nodes, board.get("edges") or [], bid)
    return {"ok": True, "node": node, "count": len(nodes), "board": bname}
