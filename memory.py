# memory.py — AIbou 長期記憶レイヤ（テキスト記憶 v1）
# =====================================================================
# コア(AIエージェント)に「過去の文脈・覚えている事実」を持たせる。
#   * 会話の各ターンを agent_memory テーブルへ保存
#   * 毎ターン、関連する記憶（重要事実＋直近＋キーワード一致）を取り出して
#     システムプロンプトへ注入 → “覚えているJARVIS”
#   * remember(): 永続的に覚える事実を明示登録 / recall(): 記憶検索
#
# 【別Supabaseプロジェクトに分離可能】
#   MEMORY_SUPABASE_URL / MEMORY_SUPABASE_KEY を設定すると、記憶だけ別プロジェクト
#   （別Googleアカウント等）に保存できる。未設定なら本体のSupabaseを共用する。
#   別プロジェクト側のキーは service role 推奨（認証ユーザーが居ないため）。
#
# v1 は埋め込み(ベクトル)無しの「重要度＋直近＋キーワード」検索。テキストのみで
# 無料枠に優しく、将来 pgvector による意味検索へ拡張可能。絶対にraiseしない。
# =====================================================================

import os

import streamlit as st

_main_client = None      # 本体Supabase（core.pyが注入。JWT適用済み＝RLSが効く）
_sep_client = None        # 記憶専用の別プロジェクト
_sep_tried = False


def register_main(client):
    """core.py から本体のSupabaseクライアントを注入する。"""
    global _main_client
    _main_client = client


def _secret(name):
    try:
        if name in st.secrets and st.secrets[name]:
            return st.secrets[name]
    except Exception:
        pass
    return os.environ.get(name, "")


def _client():
    """記憶の保存先クライアント。MEMORY_SUPABASE_* があれば別プロジェクト、無ければ本体。"""
    global _sep_client, _sep_tried
    url = _secret("MEMORY_SUPABASE_URL")
    if url:
        if _sep_client is None and not _sep_tried:
            _sep_tried = True
            key = _secret("MEMORY_SUPABASE_KEY") or _secret("SUPABASE_SERVICE_KEY")
            try:
                from supabase import create_client
                _sep_client = create_client(url, key) if key else None
            except Exception:
                _sep_client = None
        return _sep_client
    return _main_client


def _uid():
    try:
        return (st.session_state.get("current_user") or {}).get("id") or "local"
    except Exception:
        return "local"


def enabled():
    return _client() is not None


def add(role, content, importance=0):
    """記憶を1件保存。role: 'user'|'assistant'|'fact'。importance>=1 は優先的に想起。"""
    c = _client()
    if not c or not content:
        return
    try:
        c.table("agent_memory").insert({
            "user_id": _uid(), "role": role,
            "content": str(content)[:4000], "importance": int(importance),
        }).execute()
    except Exception:
        pass


def retrieve(query="", recent_n=8, match_n=6):
    """関連記憶をまとめたテキストを返す（重要事実＋直近＋キーワード一致）。無ければ ''。"""
    c = _client()
    if not c:
        return ""
    try:
        rows = (c.table("agent_memory")
                .select("role,content,importance")
                .eq("user_id", _uid())
                .order("created_at", desc=True).limit(120).execute().data) or []
    except Exception:
        return ""
    if not rows:
        return ""

    facts = [r for r in rows if (r.get("importance") or 0) >= 1][:6]
    recent = rows[:recent_n]
    qwords = [w for w in (query or "").lower().split() if len(w) >= 2]
    matches = []
    if qwords:
        for r in rows[recent_n:]:
            cont = (r.get("content") or "").lower()
            if any(w in cont for w in qwords):
                matches.append(r)
            if len(matches) >= match_n:
                break

    seen, lines = set(), []
    for r in facts + matches + list(reversed(recent)):
        cont = (r.get("content") or "").strip()
        if not cont or cont in seen:
            continue
        seen.add(cont)
        tag = "★事実" if (r.get("importance") or 0) >= 1 else r.get("role", "")
        lines.append(f"- ({tag}) {cont[:300]}")
    if not lines:
        return ""
    return "【記憶：過去の文脈と覚えている事実】\n" + "\n".join(lines[:18])
