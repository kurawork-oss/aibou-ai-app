# proactive.py — プロアクティブな朝のブリーフィング生成（絶対にcrashしない）
# =====================================================================
# JARVISが「こちらから話しかける」第一歩。朝、ユーザーに向けて
#   挨拶 ＋ 日付 ＋ 承認待ちジョブ件数 ＋ 直近の記憶ハイライト ＋ 今日の一言
# をひとまとめにした短いブリーフィングを生成する。
#
# 設計方針（config.py / main.py と同じ）:
#   * Supabase / Gemini が未設定でも絶対にcrashせず、最低限の挨拶を返す。
#   * Gemini があれば、素材を渡して自然で短い「秘書口調」にまとめさせる。
#   * 同期処理（Supabase / Gemini 呼び出し）はここで完結させ、呼び出し側（API）は
#     run_in_executor でスレッドに逃がせばよい。
# =====================================================================

import datetime
from typing import List

import config
import income
from memory_store import mem_recent

# 曜日の日本語表記（datetime.weekday(): 月=0 … 日=6）
_WEEKDAYS_JA = ["月", "火", "水", "木", "金", "土", "日"]


def _today_label() -> str:
    """「2026年6月26日（金）」形式の日付文字列を返す（JST想定）。"""
    # GitHub Actions の cron は UTC で動くため、JST(+9h)に補正してから整形する。
    now_jst = datetime.datetime.utcnow() + datetime.timedelta(hours=9)
    wd = _WEEKDAYS_JA[now_jst.weekday()]
    return f"{now_jst.year}年{now_jst.month}月{now_jst.day}日（{wd}）"


def _greeting_for_now() -> str:
    """時間帯に応じた挨拶（JST）。朝の利用が主なので「おはようございます」を基本に。"""
    now_jst = datetime.datetime.utcnow() + datetime.timedelta(hours=9)
    h = now_jst.hour
    if 5 <= h < 11:
        return "おはようございます"
    if 11 <= h < 18:
        return "こんにちは"
    return "こんばんは"


def _pending_count() -> int:
    """承認待ち(pending)ジョブの件数。Supabase未設定/失敗時は 0（crashしない）。"""
    try:
        return len(income.list_jobs(status="pending", limit=1000))
    except Exception:
        return 0


def _recent_highlights(limit: int = 4) -> List[str]:
    """直近の記憶ハイライトを短い文字列のリストで返す。無ければ []（crashしない）。"""
    try:
        rows = mem_recent(limit=limit) or []
    except Exception:
        return []
    highlights: List[str] = []
    for r in rows:
        content = (r.get("content") or "").strip()
        if not content:
            continue
        # 1行に収まるよう短く整形（改行をスペースに）
        snippet = " ".join(content.split())[:80]
        highlights.append(snippet)
    return highlights


def _fallback_briefing(date_label: str, greeting: str, pending: int, highlights: List[str]) -> str:
    """Gemini が無い/失敗したときの、素のテンプレ・ブリーフィング。"""
    lines = [
        f"{greeting}、ボス。本日は {date_label} です。",
    ]
    if pending > 0:
        lines.append(f"承認待ちのジョブが {pending} 件あります。お時間のあるときにご確認ください。")
    else:
        lines.append("承認待ちのジョブはありません。")
    if highlights:
        lines.append("直近のハイライト：")
        for h in highlights:
            lines.append(f"・{h}")
    lines.append("今日も良い一日になりますように。")
    return "\n".join(lines)


def build_briefing() -> str:
    """朝のブリーフィング本文を生成して返す（絶対にraiseしない）。

    1) 素材を集める：日付・挨拶・承認待ち件数・直近の記憶ハイライト
    2) Gemini があれば、素材を渡して自然で短い秘書口調にまとめさせる
    3) Gemini が無い/失敗時は、素のテンプレ・ブリーフィングを返す
    Supabase / Gemini いずれも未設定でも、最低限の挨拶は必ず返る。
    """
    date_label = _today_label()
    greeting = _greeting_for_now()
    pending = _pending_count()
    highlights = _recent_highlights(limit=4)

    fallback = _fallback_briefing(date_label, greeting, pending, highlights)

    model = config.get_gemini_model()
    if model is None:
        return fallback

    # Gemini に「素材」を渡し、短い秘書口調のブリーフィングにまとめてもらう。
    highlight_block = (
        "\n".join(f"- {h}" for h in highlights) if highlights else "（特になし）"
    )
    prompt = (
        "あなたはユーザー（『ボス』と呼ぶ）専属の優秀な秘書AIです。"
        "以下の素材をもとに、朝のブリーフィングを日本語で作成してください。\n"
        "条件：\n"
        "・親しみやすく落ち着いた秘書口調。\n"
        "・全体で3〜5文程度の短さ。箇条書きは使わず、自然な文章で。\n"
        "・最初に時間帯に合った挨拶と日付に触れる。\n"
        "・承認待ち件数があれば軽く促す。0件なら無理に触れなくてよい。\n"
        "・ハイライトがあれば1〜2点だけ自然に拾う。\n"
        "・最後に今日への前向きな一言を添える。\n"
        "・前置きや説明は不要。ブリーフィング本文だけを出力する。\n\n"
        f"【素材】\n"
        f"挨拶: {greeting}\n"
        f"日付: {date_label}\n"
        f"承認待ちジョブ件数: {pending} 件\n"
        f"直近のハイライト:\n{highlight_block}\n"
    )

    try:
        resp = model.generate_content(prompt)
        text = (getattr(resp, "text", "") or "").strip()
        return text or fallback
    except Exception:
        return fallback


# ローカル確認用（python proactive.py で素のブリーフィングを表示）
if __name__ == "__main__":
    print(build_briefing())
