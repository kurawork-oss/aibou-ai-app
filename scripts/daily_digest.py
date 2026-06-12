# scripts/daily_digest.py — 1日の会話を自動要約して「記憶」に保存（headless / GitHub Actions）
# =====================================================================
# 直近24hの agent_memory（user/assistant）をユーザー毎にまとめ、Geminiで
# 「3〜5行の要約＋重要事実」を生成し、role='summary'(importance=3) として保存する。
# → 翌日以降、コアが日報を高優先で想起する＝“記憶フォルダ”。
#
# 環境変数：
#   MEMORY_SUPABASE_URL / MEMORY_SUPABASE_KEY（記憶用。無ければ SUPABASE_URL/KEY）
#   GEMINI_API_KEY（要約用）
# =====================================================================
import os
import datetime


def _client():
    url = os.environ.get("MEMORY_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = (os.environ.get("MEMORY_SUPABASE_KEY")
           or os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY"))
    if not (url and key):
        return None
    try:
        from supabase import create_client
        return create_client(url, key)
    except Exception as e:
        print("supabase init error:", e)
        return None


def _summarize(transcript):
    import google.generativeai as genai
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    prompt = ("以下は本日の会話ログです。日本語で (1)3〜5行の要約 (2)今後のために覚えるべき"
              "重要事実を最大5個の箇条書き、の順で簡潔に出力してください。\n\n" + transcript)
    return genai.GenerativeModel("gemini-2.5-flash").generate_content(prompt).text


def main():
    c = _client()
    if not c:
        print("skip: Supabase 資格情報が未設定")
        return
    if not os.environ.get("GEMINI_API_KEY"):
        print("skip: GEMINI_API_KEY 未設定")
        return

    since = (datetime.datetime.utcnow() - datetime.timedelta(days=1)).isoformat()
    try:
        rows = (c.table("agent_memory")
                .select("user_id,role,content,created_at")
                .gte("created_at", since)
                .in_("role", ["user", "assistant"])
                .order("created_at").execute().data) or []
    except Exception as e:
        print("read error:", e)
        return
    if not rows:
        print("no entries in last 24h")
        return

    by_user = {}
    for r in rows:
        by_user.setdefault(r.get("user_id") or "local", []).append(r)

    today = datetime.date.today().isoformat()
    for uid, items in by_user.items():
        transcript = "\n".join(f"{r.get('role')}: {str(r.get('content',''))[:500]}" for r in items)[:8000]
        try:
            summary = _summarize(transcript)
        except Exception as e:
            print(f"AI error (user {str(uid)[:8]}):", e)
            continue
        try:
            c.table("agent_memory").insert({
                "user_id": uid, "role": "summary",
                "content": f"【{today} 日報】\n{summary}", "importance": 3,
            }).execute()
            print(f"summarized user {str(uid)[:8]} ({len(items)} msgs)")
        except Exception as e:
            print("write error:", e)


if __name__ == "__main__":
    main()
