# income_engine.py — AIbou 副業オートメーション・エンジン
# =================================================================
# 「アセット・マルチユース型 AI不労所得エコシステム」のコア（脳）。
#   - generate_metadata() : 1テーマ → 各プラットフォーム用メタデータをAIで一括生成
#   - enqueue_theme()      : 生成結果を承認キュー(income_jobs)へ投入（冪等性つき）
#   - approve / reject     : 管理画面(Mission Control)からの承認・差し戻し
#   - get_stats()          : KPI(収益/PV/稼働日数)の取得・更新
#
# 【役割分担】
# このモジュールは「生成」と「承認キュー管理」までを担当する。
# 各プラットフォームへの実配信（YouTube/Shutterstock等）は、要件定義書どおり
# GitHub Actions 側の“配信レイヤ”が承認済み(approved)ジョブを拾って実行する想定。
#
# 【このアプリ特有の事情】
# app.py → core.py → 各 view を exec() で読み込む構造のため、agent.py と同様に
# income_engine も「独立した普通のモジュール」として実装し、core.py 側の道具
# （supabase / get_ai_response）は register_services() で後から注入する。
# Supabase 未接続でも st.session_state にフォールバックして動く（絶対に落とさない）。
# =================================================================

import os
import json
import time
import uuid
import hashlib
import datetime

import streamlit as st


# === 外部サービス（core.py から注入される道具箱） ============================
_SERVICES = {}


def register_services(**kwargs):
    """core.py 側の道具（supabase / get_ai_response 等）を登録する。"""
    _SERVICES.update(kwargs)


def _db():
    return _SERVICES.get("supabase")


def _ai(prompt, model=None):
    """注入された get_ai_response を呼ぶ。未注入でも例外を出さない。"""
    fn = _SERVICES.get("get_ai_response")
    if not fn:
        return "⚠️ AIエンジンが初期化されていません。"
    try:
        return fn(prompt, model=model)
    except Exception as e:
        return f"⚠️ AI呼び出しエラー: {e}"


# === 信頼性：指数バックオフ・リトライ（要件 §3.1） ==========================
# 外部API（AI生成）が一時的に落ちている / レート制限(429)の場合に再試行する。
# 5秒 → 10秒 → 20秒 → 40秒 → 60秒（最大5回）。成功時はsleepしない。
# ※ GitHub Actions の配信レイヤは MAX_RETRIES=5 を、画面からの生成は応答性のため
#   max_attempts=3 を既定で使う（どちらもこの同じロジックを共有）。
RETRY_DELAYS = [5, 10, 20, 40, 60]
MAX_RETRIES = 5


def _looks_like_error(text):
    if not text or not str(text).strip():
        return True
    t = str(text).lstrip()
    return t.startswith("⚠️") or t.startswith("❌")


def _ai_with_retry(prompt, model=None, max_attempts=MAX_RETRIES):
    last = ""
    for attempt in range(max_attempts):
        last = _ai(prompt, model=model)
        if not _looks_like_error(last):
            return last
        if attempt < max_attempts - 1:
            time.sleep(RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)])
    return last


# === AI出力からJSONを安全に取り出す（波括弧の対応を数える） =================
def _extract_json(text):
    """テキスト中の最初の {...} を、波括弧の深さを数えて正確に切り出しdict化する。
    AIが前後に説明文や ```json フェンスを付けても壊れない。"""
    if not text:
        return None
    start = text.find("{")
    if start == -1:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except Exception:
                    return None
    return None


# === メタデータ一括生成（要件 §2.1） ========================================
PLATFORM_SCHEMA = """{
  "theme": "テーマ（日本語）",
  "shutterstock": {
    "title_en": "English stock-style descriptive title",
    "tags": ["english_keyword", "..."]
  },
  "youtube": {
    "title": "動画タイトル（日本語）",
    "description": "概要欄（日本語・2〜4文）",
    "timestamps": ["00:00 オープニング", "00:30 ..."],
    "hashtags": ["#タグ"]
  },
  "note": {
    "title": "記事タイトル（日本語）",
    "markdown": "## 見出し\\n本文...\\n### 小見出し\\n本文..."
  }
}"""


def generate_metadata(theme, model=None, max_attempts=3):
    """1つのテーマから各プラットフォーム用メタデータを一括生成してdictで返す。
    失敗時は {"error": "..."} を返し、絶対にraiseしない。"""
    theme = (theme or "").strip()
    if not theme:
        return {"error": "テーマが空です。"}
    prompt = (
        "あなたはコンテンツ制作のプロです。以下の【テーマ】から、各プラットフォーム向けの"
        "メタデータを作成してください。\n\n"
        f"【テーマ】\n{theme}\n\n"
        "【ルール】\n"
        "- shutterstock.tags は英語の単語/短フレーズで最大50個（50個以内厳守）。\n"
        "- youtube.timestamps は想定構成で5〜8個。\n"
        "- note.markdown は H2/H3 を使った800〜1500字程度の記事。\n\n"
        "【出力形式】以下のJSONだけを出力してください（前後の説明文やコードフェンスは不要）。\n\n"
        + PLATFORM_SCHEMA
    )
    raw = _ai_with_retry(prompt, model=model, max_attempts=max_attempts)
    if _looks_like_error(raw):
        return {"error": raw}
    data = _extract_json(raw)
    if not data:
        return {"error": "AI出力をJSONとして解釈できませんでした。", "raw": str(raw)[:500]}
    data.setdefault("theme", theme)
    # Shutterstockタグは50個以内に丸める（要件§2.1）
    try:
        ss = data.get("shutterstock", {})
        if isinstance(ss, dict) and isinstance(ss.get("tags"), list):
            ss["tags"] = ss["tags"][:50]
    except Exception:
        pass
    return data


def suggest_theme(model=None):
    """シード注入の簡易版：AIに横展開しやすい収益テーマを1つ提案させる。"""
    prompt = (
        "ストックフォト・YouTube・noteで横展開しやすく、需要が安定しているコンテンツの"
        "テーマを1つだけ、日本語の短いフレーズで提案してください。説明やラベルは不要、"
        "テーマのフレーズのみを出力すること。"
    )
    res = _ai_with_retry(prompt, model=model, max_attempts=2)
    if _looks_like_error(res):
        return ""
    return res.strip().split("\n")[0].strip("　 「」\"'：:")[:60]


# === 承認キュー（income_jobs）：冪等性つきステート管理（要件 §3.1） =========
def _dedupe_key(theme):
    return hashlib.sha256((theme or "").strip().lower().encode("utf-8")).hexdigest()[:16]


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _local_jobs():
    """Supabase未接続時のフォールバック保管庫（セッション内のみ）。"""
    if "income_jobs_local" not in st.session_state:
        st.session_state.income_jobs_local = []
    return st.session_state.income_jobs_local


def list_jobs(status=None, limit=100):
    """承認キューのジョブを新しい順に返す。"""
    db = _db()
    if db:
        try:
            q = db.table("income_jobs").select("*")
            if status:
                q = q.eq("status", status)
            res = q.order("created_at", desc=True).limit(limit).execute()
            return res.data or []
        except Exception:
            return []
    jobs = list(_local_jobs())
    if status:
        jobs = [j for j in jobs if j.get("status") == status]
    return list(reversed(jobs))[:limit]


def get_job(job_id):
    db = _db()
    if db:
        try:
            res = db.table("income_jobs").select("*").eq("id", job_id).execute()
            return (res.data or [None])[0]
        except Exception:
            return None
    for j in _local_jobs():
        if j.get("id") == job_id:
            return j
    return None


def _find_active_by_dedupe(key):
    """同一テーマで pending / approved / completed のジョブを探す（重複生成防止）。"""
    db = _db()
    rows = []
    if db:
        try:
            rows = db.table("income_jobs").select("*").eq("dedupe_key", key).execute().data or []
        except Exception:
            rows = []
    else:
        rows = [j for j in _local_jobs() if j.get("dedupe_key") == key]
    return [r for r in rows if r.get("status") in ("pending", "approved", "completed")]


def enqueue_theme(theme, model=None, force=False):
    """テーマを生成→承認キューに投入する。
    冪等性：同テーマで処理中/処理済みのジョブがあれば重複生成しない（force=Trueで強制）。
    returns: (job dict or None, メッセージ文字列)。絶対にraiseしない。"""
    theme = (theme or "").strip()
    if not theme:
        return None, "テーマを入力してください。"
    key = _dedupe_key(theme)

    if not force and _find_active_by_dedupe(key):
        return None, f"「{theme}」は既に処理中/処理済みです（冪等性により重複生成を防止）。"

    payload = generate_metadata(theme, model=model)
    if payload.get("error"):
        status, log = "failed", payload.get("error", "")
    else:
        status, log = "pending", ""

    job = {
        "id": str(uuid.uuid4()),
        "dedupe_key": key,
        "theme": theme,
        "status": status,
        "payload": payload,
        "log": log,
        "created_at": _now(),
        "updated_at": _now(),
    }

    db = _db()
    if db:
        try:
            db.table("income_jobs").insert(job).execute()
        except Exception as e:
            _local_jobs().append(job)  # DB書き込み失敗時もローカルに退避し処理を継続
            return job, f"⚠️ DB保存に失敗したためセッション内に保持しました: {e}"
    else:
        _local_jobs().append(job)

    if status == "failed":
        return job, f"❌ 生成に失敗しました: {log}"
    return job, f"✅ 「{theme}」を生成し、承認待ちに追加しました。"


def set_status(job_id, status, log=None):
    """ジョブのステータスを更新する。"""
    patch = {"status": status, "updated_at": _now()}
    if log is not None:
        patch["log"] = log
    db = _db()
    if db:
        try:
            db.table("income_jobs").update(patch).eq("id", job_id).execute()
            return True
        except Exception:
            return False
    for j in _local_jobs():
        if j.get("id") == job_id:
            j.update(patch)
            return True
    return False


def approve_job(job_id):
    """承認：配信キュー(approved)へ。実配信はGitHub Actions側の配信レイヤが拾う想定。"""
    ok = set_status(job_id, "approved", log="承認済み（配信キューへ）")
    return "✅ 承認しました。配信キュー(approved)に追加されました。" if ok else "❌ 更新に失敗しました。"


def approve_all_pending():
    """承認待ちを一括承認する（Approve & Deploy All）。承認件数を返す。"""
    n = 0
    for j in list_jobs(status="pending", limit=500):
        if set_status(j["id"], "approved", log="一括承認"):
            n += 1
    return n


def reject_job(job_id):
    ok = set_status(job_id, "rejected", log="却下")
    return "🗑️ 却下しました。" if ok else "❌ 更新に失敗しました。"


def reject_and_regenerate(job_id, model=None):
    """差し戻し：現ジョブを rejected にし、同テーマで再生成する（Reject & Regenerate）。"""
    job = get_job(job_id)
    set_status(job_id, "rejected", log="差し戻し（再生成）")
    if not job:
        return None, "対象ジョブが見つかりませんでした。"
    return enqueue_theme(job.get("theme", ""), model=model, force=True)


# === KPI（収益 / PV / 稼働日数） ============================================
DEFAULT_STATS = {
    "revenue": {"shutterstock": 0, "youtube": 0, "note": 0},
    "pv": 0,
    "uptime_start": datetime.date.today().isoformat(),
}


def get_stats():
    db = _db()
    if db:
        try:
            res = db.table("income_stats").select("data").eq("id", 1).execute()
            if res.data and res.data[0].get("data"):
                d = res.data[0]["data"]
                if isinstance(d, str):
                    d = json.loads(d)
                return {**DEFAULT_STATS, **d}
        except Exception:
            pass
        return dict(DEFAULT_STATS)
    return st.session_state.get("income_stats_local", dict(DEFAULT_STATS))


def update_stats(data):
    merged = {**get_stats(), **(data or {})}
    db = _db()
    if db:
        try:
            db.table("income_stats").upsert({"id": 1, "data": merged}).execute()
            return True
        except Exception:
            return False
    st.session_state.income_stats_local = merged
    return True


# === サイドバーの信号機表示用（要件 §4.2 Sidebar） =========================
def system_status():
    ai_ready = bool(_SERVICES.get("get_ai_response"))
    try:
        keys = st.session_state.get("global_api_keys", {}) or {}
        ai_key = bool(
            keys.get("gemini") or keys.get("anthropic") or keys.get("grok")
            or keys.get("openai") or os.environ.get("GEMINI_API_KEY")
        )
    except Exception:
        ai_key = False
    counts = {"pending": 0, "approved": 0, "completed": 0, "failed": 0, "rejected": 0}
    jobs = list_jobs(limit=500)
    for j in jobs:
        s = j.get("status")
        if s in counts:
            counts[s] += 1
    return {
        "db": bool(_db()),
        "ai_engine": ai_ready,
        "ai_key": ai_key,
        "counts": counts,
        "total": len(jobs),
    }
