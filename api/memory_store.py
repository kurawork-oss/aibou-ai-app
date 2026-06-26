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

from typing import List, Optional

from config import get_supabase, gemini_configured

# 単独利用前提なので user_id は固定（将来マルチユーザー化する場合の拡張ポイント）。
DEFAULT_USER_ID = "local"

# Gemini 埋め込みモデル（768次元）。意味記憶のベクトル化に使用。
EMBED_MODEL = "models/text-embedding-004"


def embed(text: str) -> Optional[list]:
    """テキストを Gemini の埋め込み（768次元ベクトル）に変換して返す。
    失敗時は None を返す（絶対にraiseしない）。

    * config.gemini_configured() が False（APIキー未設定など）なら即 None。
    * genai.embed_content(model="models/text-embedding-004", content=text) を呼ぶ。
    * レスポンス形式の揺れ（dict / オブジェクト）を吸収して list を取り出す。
    """
    # 入力が空、または Gemini が未設定ならベクトル化しない。
    if not text or not gemini_configured():
        return None
    try:
        import google.generativeai as genai
        resp = genai.embed_content(model=EMBED_MODEL, content=str(text))
        # 返り値は通常 {"embedding": [...]} だが、属性アクセスにも備える。
        vec = None
        if isinstance(resp, dict):
            vec = resp.get("embedding")
        else:
            vec = getattr(resp, "embedding", None)
        # batch 形式（[[...]]）で返るケースの保険：先頭要素を採用。
        if vec and isinstance(vec, (list, tuple)) and vec and isinstance(vec[0], (list, tuple)):
            vec = vec[0]
        if not vec:
            return None
        return list(vec)
    except Exception:
        # ネットワーク・APIエラー等はすべて飲み込んで None。
        return None


def mem_add(role: str, content: str, importance: int = 0) -> bool:
    """記憶を1件保存。role: 'user'|'assistant'|'fact'。importance>=1 は優先想起。
    embed() に成功した場合は embedding 列も併せて保存する（意味検索用）。
    Supabaseが無ければ何もせず False を返す（絶対にraiseしない）。"""
    c = get_supabase()
    if not c or not content:
        return False
    try:
        # 保存する行データ。embedding はベクトル化に成功した時だけ含める。
        row = {
            "user_id": DEFAULT_USER_ID,
            "role": str(role or "user"),
            "content": str(content)[:4000],
            "importance": int(importance or 0),
        }
        # 埋め込みは best-effort。失敗してもベクトル無しで insert を続行する。
        vec = embed(str(content))
        if vec:
            row["embedding"] = vec
        c.table("agent_memory").insert(row).execute()
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

    # ── ① 意味検索（Gemini埋め込み × Supabase RPC） ──────────────
    # まず query をベクトル化し、match_memories RPC でコサイン類似の近いものを取得。
    # RPC未定義 / embed失敗 / 何らかの例外があれば、下のキーワード+直近にフォールバック。
    try:
        qvec = embed(query) if query else None
        if qvec:
            res = c.rpc("match_memories", {
                "query_embedding": qvec,
                "match_count": max(1, int(limit or 8)),
                "p_user_id": DEFAULT_USER_ID,
            }).execute()
            sem_rows = (getattr(res, "data", None)) or []
            sem_lines = []
            seen_sem = set()
            for r in sem_rows:
                cont = (r.get("content") or "").strip()
                if not cont or cont in seen_sem:
                    continue
                seen_sem.add(cont)
                tag = "★事実" if (r.get("importance") or 0) >= 1 else (r.get("role") or "")
                sem_lines.append(f"- ({tag}) {cont[:300]}")
            if sem_lines:
                return "【関連する記憶】\n" + "\n".join(sem_lines[:18])
    except Exception:
        # RPC が無い / 失敗した場合は黙ってフォールバックへ。
        pass

    # ── ② フォールバック：重要事実 ＋ 直近 ＋ キーワード一致 ──────
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
