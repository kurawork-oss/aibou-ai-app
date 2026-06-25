# memory_store.py — 長期記憶レイヤ（テキスト記憶 v1 / 絶対にcrashしない）
# =====================================================================
# 既存 memory.py の思想を踏襲しつつ、Streamlit非依存で再実装したもの。
#   * 会話の各ターンを Supabase の agent_memory に保存（best-effort）
#   * 毎ターン、関連する記憶（重要事実＋直近＋キーワード一致）を取り出して
#     システムプロンプトへ注入 → “覚えているJARVIS”
#
# agent_memory テーブル（supabase_schema.sql 参照）:
#   user_id text default 'local', role text, content text,
#   importance int default 0, created_at timestamptz default now()
#
# v1 は埋め込み(ベクトル)無しの「重要度＋直近＋キーワード」検索。Supabaseが無くても
# 例外を出さず空文字 / 空リストを返す。
# =====================================================================

from typing import List

from config import get_supabase

# 単独利用前提なので user_id は固定（将来マルチユーザー化する場合の拡張ポイント）。
DEFAULT_USER_ID = "local"


def mem_add(role: str, content: str, importance: int = 0) -> bool:
    """記憶を1件保存。role: 'user'|'assistant'|'fact'。importance>=1 は優先想起。
    Supabaseが無ければ何もせず False を返す（絶対にraiseしない）。"""
    c = get_supabase()
    if not c or not content:
        return False
    try:
        c.table("agent_memory").insert({
            "user_id": DEFAULT_USER_ID,
            "role": str(role or "user"),
            "content": str(content)[:4000],
            "importance": int(importance or 0),
        }).execute()
        return True
    except Exception:
        return False


def mem_recent(limit: int = 20) -> List[dict]:
    """直近の記憶を created_at 降順で返す。無ければ []（絶対にraiseしない）。"""
    c = get_supabase()
    if not c:
        return []
    try:
        rows = (c.table("agent_memory")
                .select("id,role,content,importance,created_at")
                .eq("user_id", DEFAULT_USER_ID)
                .order("created_at", desc=True)
                .limit(max(1, int(limit or 20)))
                .execute().data) or []
        return rows
    except Exception:
        return []


def mem_recall(query: str = "", limit: int = 8) -> str:
    """関連記憶をまとめた短いテキストブロックを返す。
    重要事実(importance>=1) ＋ 直近 ＋ クエリのキーワード一致 を結合する。
    記憶が無ければ ''（絶対にraiseしない）。

    返り値の形式:
        【関連する記憶】
        - (★事実) ...
        - (user) ...
    """
    c = get_supabase()
    if not c:
        return ""
    try:
        rows = (c.table("agent_memory")
                .select("role,content,importance")
                .eq("user_id", DEFAULT_USER_ID)
                .order("created_at", desc=True)
                .limit(120)
                .execute().data) or []
    except Exception:
        return ""
    if not rows:
        return ""

    recent_n = max(1, int(limit or 8))

    # 重要事実（最大6件）
    facts = [r for r in rows if (r.get("importance") or 0) >= 1][:6]
    # 直近（limit件）
    recent = rows[:recent_n]

    # クエリのキーワードで一致する古い記憶も拾う（2文字以上の語）
    qwords = [w for w in (query or "").lower().split() if len(w) >= 2]
    matches: List[dict] = []
    if qwords:
        for r in rows[recent_n:]:
            cont = (r.get("content") or "").lower()
            if any(w in cont for w in qwords):
                matches.append(r)
            if len(matches) >= 6:
                break

    # 重複を除いて整形（事実→キーワード一致→直近の時系列順）
    seen, lines = set(), []
    for r in facts + matches + list(reversed(recent)):
        cont = (r.get("content") or "").strip()
        if not cont or cont in seen:
            continue
        seen.add(cont)
        tag = "★事実" if (r.get("importance") or 0) >= 1 else (r.get("role") or "")
        lines.append(f"- ({tag}) {cont[:300]}")

    if not lines:
        return ""
    return "【関連する記憶】\n" + "\n".join(lines[:18])
