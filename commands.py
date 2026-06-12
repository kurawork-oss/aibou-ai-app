# commands.py — AIbou アプリ専用コマンド（HUBのコマンド入力で "/" から実行）
# =====================================================================
# 例：/help /remember /recall /task /tasks /income /app /digest /rules /clear
# 日本語エイリアスにも対応（/日報 /覚えて /タスク など）。
# 各コマンドは既存のエージェントツール（agent.execute_tool）や memory に接続する。
# run_agent を介さず即実行＝速い・トークン節約。絶対にraiseしない。
# =====================================================================

import streamlit as st

COMMANDS = {
    "help":     "コマンド一覧を表示",
    "remember": "事実を長期記憶に保存： /remember 覚える内容",
    "recall":   "記憶を検索： /recall キーワード",
    "task":     "タスクを作成： /task タスク内容",
    "tasks":    "現在のタスク一覧",
    "income":   "副業(Auto Income)の状況",
    "app":      "ミニアプリを生成して保存： /app 作りたいアプリ",
    "digest":   "最近の会話を要約して記憶に保存（日報）",
    "rules":    "現在の常時ルールを表示",
    "clear":    "この画面の会話履歴をクリア",
}

ALIASES = {
    "？": "help", "ヘルプ": "help",
    "覚えて": "remember", "記憶": "remember",
    "思い出して": "recall", "想起": "recall",
    "タスク": "task", "一覧": "tasks", "タスク一覧": "tasks",
    "収益": "income", "副業": "income",
    "アプリ": "app", "日報": "digest", "要約": "digest",
    "ルール": "rules", "クリア": "clear",
}


def is_command(text):
    return bool(text) and text.strip().startswith("/")


def _help():
    lines = ["**📖 利用可能なコマンド**"]
    for k, v in COMMANDS.items():
        lines.append(f"・**/{k}** — {v}")
    lines.append("\n（日本語でも可：/日報 /覚えて /タスク /収益 …）")
    return "\n".join(lines)


def handle(text):
    """コマンドを実行して返答文字列を返す。'__CLEAR__' は履歴クリアの指示。"""
    body = text.strip()[1:].strip()
    if not body:
        return _help()
    parts = body.split(maxsplit=1)
    raw = parts[0]
    name = ALIASES.get(raw, raw.lower())
    arg = parts[1].strip() if len(parts) > 1 else ""

    if name == "help":
        return _help()
    if name == "clear":
        return "__CLEAR__"
    if name == "rules":
        r = (st.session_state.get("user_rules") or "").strip()
        return "【常時ルール】\n" + (r if r else "(未設定。Settings → 📜 ルール で設定できます)")

    try:
        import agent
    except Exception:
        return "⚠️ エージェントを読み込めませんでした。"

    if name == "remember":
        return agent.execute_tool("remember", {"content": arg}) if arg else "使い方： /remember 覚える内容"
    if name == "recall":
        return agent.execute_tool("recall", {"query": arg})
    if name == "task":
        return agent.execute_tool("create_task", {"goal": "", "content": arg}) if arg else "使い方： /task タスク内容"
    if name == "tasks":
        return agent.execute_tool("list_tasks", {})
    if name == "income":
        return agent.execute_tool("income_status", {})
    if name == "app":
        return agent.execute_tool("generate_app", {"description": arg}) if arg else "使い方： /app 作りたいアプリの説明"
    if name == "digest":
        return _digest()

    return f"未知のコマンド: /{raw}（/help で一覧）"


def _digest():
    """最近の会話を要約して記憶へ保存（オンデマンド日報）。"""
    try:
        import datetime
        import memory
        import agent
        log = memory.retrieve("", recent_n=40, match_n=0)
        if not log:
            return "本日の記録がありません。"
        summary = agent.get_ai_response(
            "以下は最近の会話ログです。日本語で (1)3〜5行の要約 (2)今後のために覚えるべき"
            "重要事実を最大5個の箇条書き、の順で簡潔に出力してください。\n\n" + log
        )
        if not summary or str(summary).startswith("⚠️"):
            return "要約に失敗しました（AIキーを確認してください）。"
        memory.add("summary", f"【{datetime.date.today()} 日報】\n{summary}", importance=3)
        return "📒 日報を記憶に保存しました。\n\n" + summary
    except Exception as e:
        return f"❌ 日報作成に失敗: {e}"
