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

import time
from typing import List, Optional

from config import get_supabase, gemini_configured

# 単独利用前提なので user_id は固定（将来マルチユーザー化する場合の拡張ポイント）。
DEFAULT_USER_ID = "local"

# Gemini 埋め込みモデル（768次元）。意味記憶のベクトル化に使用。
EMBED_MODEL = "models/text-embedding-004"

# ── 返答が始まるまでの往復を減らすための覚え書き ──────────────────────
# 記憶の想起は「返事を書き始める前」に終わらせる必要があるので、ここでの
# 往復はそのまま利用者の待ち時間になる。素の実装では毎メッセージごとに
#   ① Gemini へ埋め込み（ネットワーク往復）
#   ② Supabase の match_memories RPC（往復）
#   ③ RPCが無ければさらに agent_memory を120行取得（往復）
# を直列でやっていた。①②はRPCを入れていない環境では毎回まるごと無駄になる。
#
# 覚え書きはクライアントごと（＝利用者ごと）に持つ。ここを共通の辞書にすると、
# 別の人のDBの状態やデータを取り違える恐れがあるため、必ずクライアント自身に
# ぶら下げる。クライアントが捨てられれば覚え書きも一緒に消える。
_SEMANTIC_FLAG = "_aibou_semantic_ok"     # match_memories RPC が使えるか
_ROWS_CACHE = "_aibou_rows_cache"         # (取得時刻, 行) の短期キャッシュ
_ROWS_TTL = 20.0                          # 秒。会話が続く間の再取得を防ぐ程度


def _remember(client, attr: str, value) -> None:
    """クライアント自身に覚えさせる（付けられない実装なら黙って諦める）。"""
    try:
        setattr(client, attr, value)
    except Exception:
        pass


def _recall_note(client, attr: str, default=None):
    return getattr(client, attr, default)


def _forget_rows_cache() -> None:
    """記憶を書き換えたら、行のキャッシュは捨てる（古い内容で答えないため）。"""
    c = get_supabase()
    if c is not None:
        _remember(c, _ROWS_CACHE, None)


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
        # 鍵の扱いは生成と同じ経路に通す（その人の鍵を使い、他と混ざらない）
        import config as _config
        resp = _config.embed_with_current_key(text, EMBED_MODEL)
        if resp is None:
            return None
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
        # match_memories RPC が無い環境では、書いたベクトルを読む相手がいない。
        # 1ターンにつき2回（利用者の発言＋返答）のGemini往復がまるごと無駄に
        # なり、無料枠も削るので、無いと分かっている間は作らない。
        # （プロセスを再起動すると「不明」に戻り、また試す）
        vec = embed(str(content)) if _recall_note(c, _SEMANTIC_FLAG, None) is not False else None
        if vec:
            row["embedding"] = vec
        try:
            c.table("agent_memory").insert(row).execute()
        except Exception:
            # embedding 列が無いDB（pgvectorを流していない）では、この1文で
            # **記憶そのものが保存されない**。意味検索はあれば嬉しい追加機能
            # なので、ベクトルを落として本文だけでも残す。
            # ここを諦めていた間、そのDBの人の記憶は1件も入らなかった。
            if "embedding" not in row:
                raise
            row.pop("embedding", None)
            _remember(c, _SEMANTIC_FLAG, False)   # 以降ベクトル化も試さない
            c.table("agent_memory").insert(row).execute()
        _forget_rows_cache()      # 書いた直後に古い一覧で答えないように
        return True
    except Exception:
        return False


_ALIVE_OK = "_aibou_alive_filter_ok"      # deleted_at で絞り込めるDBか


def _fetch(cols: str, limit: int) -> List[dict]:
    """記憶を読む。消された物（墓標）は外す。

    なぜ外すのか
    ------------
    端末で「忘れて」と言われた記憶は、合流でサーバー側にも墓標が立つ。
    ここで外さないと、**消したはずのことをサーバーが思い出し続ける**。
    覚えてくれないことより、消したのに戻ってくるほうが体感は悪い。

    なぜ失敗したら外さずに読み直すのか
    ----------------------------------
    deleted_at 列が無い古いDBでは、この条件を付けると問い合わせごと失敗する。
    そこで諦めると、**記憶が丸ごと空になる**——合流できないのは仕方ないが、
    そのせいで何も思い出せなくなるのは別の話で、しかも「なんとなく賢くない」
    としか見えない。落ちるなら、落ちる前の状態へ戻るほうがよい。

    （合流のときに墓標の中身は空にしてあるので、絞り込めないDBでも
      消した文章そのものは出てこない。ここは二枚目の備え。）
    """
    c = get_supabase()
    if not c:
        return []

    def base():
        return (c.table("agent_memory").select(cols)
                .eq("user_id", DEFAULT_USER_ID))

    if getattr(c, _ALIVE_OK, None) is not False:
        try:
            rows = (base().is_("deleted_at", "null")
                    .order("created_at", desc=True)
                    .limit(limit).execute().data) or []
            _remember(c, _ALIVE_OK, True)
            return rows
        except Exception:
            # 一度分かったら、以降は無駄に2回投げない
            _remember(c, _ALIVE_OK, False)

    try:
        return (base().order("created_at", desc=True)
                .limit(limit).execute().data) or []
    except Exception:
        return []


def mem_recent(limit: int = 20) -> List[dict]:
    """直近の記憶を created_at 降順で返す。無ければ []（絶対にraiseしない）。"""
    return _fetch("id,role,content,importance,created_at", max(1, int(limit or 20)))


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
    #
    # 一度でも「RPCが無い」と分かったら、以降はベクトル化（Gemini往復）ごと
    # 飛ばす。RPCを入れていない環境で毎回2往復ぶん待たされるのを防ぐため。
    try:
        qvec = embed(query) if (query and _recall_note(c, _SEMANTIC_FLAG, None) is not False) else None
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
            _remember(c, _SEMANTIC_FLAG, True)      # RPCは生きている
            if sem_lines:
                return "【関連する記憶】\n" + "\n".join(sem_lines[:18])
    except Exception:
        # RPC が無い / 失敗した場合は黙ってフォールバックへ。
        # 次回からは埋め込みもRPCも呼ばない（毎回2往復ぶん損をするため）。
        _remember(c, _SEMANTIC_FLAG, False)

    # ── ② フォールバック：重要事実 ＋ 直近 ＋ キーワード一致 ──────
    # 会話が続く間、同じ行を毎メッセージ取りに行かないよう短時間だけ覚える。
    # 記憶を書いたときは捨てるので、古い内容のまま答えることはない。
    cached = _recall_note(c, _ROWS_CACHE, None)
    rows: Optional[List[dict]] = None
    if cached and (time.monotonic() - cached[0]) < _ROWS_TTL:
        rows = cached[1]
    if rows is None:
        rows = _fetch("role,content,importance", 120)
        _remember(c, _ROWS_CACHE, (time.monotonic(), rows))
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
