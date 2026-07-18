# artifacts.py — エージェントが生成した「成果物」（ドキュメント / スプレッドシート）の保管庫
# =====================================================================
# HOMEエージェントが create_document / create_spreadsheet で作ったファイルを、
# ここに保存する。Google等のOAuthは使わず自己完結（Aibou内でダウンロード可能）。
#
# 保存: Supabase の artifacts テーブル（あれば）→ 無ければプロセス内メモリ。
# 値は小さめのテキスト（Markdown / CSV）を想定。フロントは content を Blob 化して
# ダウンロードする。設計方針は他モジュールと統一：欠けても絶対に crash しない。
# =====================================================================

import uuid
from datetime import datetime, timezone
from typing import List, Optional

import config

# Supabase 未設定時のフォールバック（新しい順に先頭へ積む）。
_mem_artifacts: List[dict] = []

MAX_CONTENT = 200_000  # 1ファイルの上限（安全弁）


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create(kind: str, title: str, content: str, mime: str = "") -> dict:
    """成果物を1件保存して返す。kind: 'document' | 'spreadsheet' | その他。"""
    title = (title or "").strip() or "無題"
    content = content or ""
    if len(content) > MAX_CONTENT:
        content = content[:MAX_CONTENT]
    kind = (kind or "document").strip() or "document"
    if not mime:
        mime = "text/csv" if kind == "spreadsheet" else "text/markdown"
    art = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "title": title,
        "content": content,
        "mime": mime,
        "created_at": _now_iso(),
    }

    c = config.get_supabase()
    if c:
        try:
            res = c.table("artifacts").insert({
                "id": art["id"], "kind": kind, "title": title,
                "content": content, "mime": mime,
            }).execute()
            if res.data:
                return _with_meta(res.data[0])
        except Exception:
            pass  # テーブル未作成などはメモリへ縮退

    _mem_artifacts.insert(0, art)
    return _meta(art)


def _size(content: str) -> int:
    try:
        return len(content.encode("utf-8"))
    except Exception:
        return len(content or "")


def _meta(art: dict) -> dict:
    """一覧用のメタデータ（content は含めない・size と preview のみ）。
    画像(kind=image)は content がURLなので、サムネイル用に url を含める。"""
    content = art.get("content") or ""
    kind = art.get("kind")
    meta = {
        "id": art.get("id"),
        "kind": kind,
        "title": art.get("title"),
        "mime": art.get("mime"),
        "size": _size(content),
        "preview": content[:140],
        "created_at": art.get("created_at"),
    }
    if kind == "image":
        meta["url"] = content
    return meta


def _with_meta(row: dict) -> dict:
    row = dict(row or {})
    return _meta(row)


def list_artifacts(limit: int = 50) -> List[dict]:
    """成果物の一覧（メタデータのみ・新しい順）。"""
    c = config.get_supabase()
    if c:
        try:
            res = (c.table("artifacts")
                   .select("id,kind,title,mime,content,created_at")
                   .order("created_at", desc=True).limit(limit).execute())
            return [_meta(r) for r in (res.data or [])]
        except Exception:
            pass
    return [_meta(a) for a in _mem_artifacts[:limit]]


def get(artifact_id: str) -> Optional[dict]:
    """1件の完全な内容（content 込み）を返す。無ければ None。"""
    c = config.get_supabase()
    if c:
        try:
            res = (c.table("artifacts").select("*")
                   .eq("id", artifact_id).limit(1).execute())
            if res.data:
                return res.data[0]
        except Exception:
            pass
    for a in _mem_artifacts:
        if a.get("id") == artifact_id:
            return a
    return None


def delete(artifact_id: str) -> dict:
    global _mem_artifacts
    _mem_artifacts = [a for a in _mem_artifacts if a.get("id") != artifact_id]
    c = config.get_supabase()
    if c:
        try:
            c.table("artifacts").delete().eq("id", artifact_id).execute()
        except Exception:
            pass
    return {"ok": True}


def update(artifact_id: str, content=None, title=None) -> dict:
    """既存の成果物の内容/タイトルを更新する（スライドのテーマ変更など）。"""
    if not artifact_id:
        return {"error": "id is required"}
    patch = {}
    if content is not None:
        patch["content"] = content[:MAX_CONTENT]
    if title is not None:
        patch["title"] = title
    if not patch:
        return {"error": "nothing to update"}
    c = config.get_supabase()
    if c:
        try:
            res = c.table("artifacts").update(patch).eq("id", artifact_id).execute()
            if res.data:
                return _meta(res.data[0])
        except Exception:
            pass
    for a in _mem_artifacts:
        if a.get("id") == artifact_id:
            a.update(patch)
            return _meta(a)
    return {"error": "artifact not found"}
