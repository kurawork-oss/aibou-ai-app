# agent.py — HOME「手足となって動く」マルチステップ・エージェント
# =====================================================================
# /chat の単発ツール実行を一般化した、plan→act→observe を最大 MAX_STEPS 回
# 繰り返す自律ループ。ユーザーの1つの指示に対し、必要なツールを次々に呼んで
# 実際にタスクを片付け、最後に日本語で結果を報告する。
#
# 進捗は Claude Code 風に逐次イベントで流す（run_stream がジェネレータ）:
#   {"phase": "start"}
#   {"phase": "thinking", "step": n}
#   {"phase": "tool", "step": n, "tool": "add_task", "params": {...}, "note": "..."}
#   {"phase": "observation", "step": n, "tool": "...", "result": "..."}
#   {"phase": "final", "text": "最終報告"}
#   {"phase": "done", "steps": n}
#   {"phase": "error", "detail": "..."}   # 生成失敗時（done は必ず続けて出す）
#
# 設計方針は既存モジュールと統一：設定が欠けても絶対に crash させない。
# =====================================================================

import json
from datetime import datetime, timezone, timedelta

import llm
import tools

# ツールを何回まで連鎖できるか（無限ループ / 無駄呼び出しの安全弁）。
MAX_STEPS = 6
# 各ステップの生成トークン上限（ツール呼び出し or 最終報告に十分な小さめの値）。
STEP_MAX_TOKENS = 1200

# 承認モード時、実行前にユーザー確認を挟む「機微な」ツール（外部送信・不可逆な副作用）。
SENSITIVE_TOOLS = {"send_email", "notify", "run_automation", "enqueue_income"}

_MARKER = tools.TOOL_CALL_MARKER


def _today_str() -> str:
    """今日の日付（JST）を YYYY-MM-DD (曜日) で返す。相対日付の基準に使う。"""
    try:
        now = datetime.now(timezone(timedelta(hours=9)))
        wd = "月火水木金土日"[now.weekday()]
        return f"{now.strftime('%Y-%m-%d')}（{wd}）"
    except Exception:
        return ""


def _system_prompt(name: str) -> str:
    assistant = (name or "AIbou").strip() or "AIbou"
    return (
        f"あなたは「{assistant}」。THE FORGE OS のホーム・エージェントであり、"
        "ユーザーの手足となって“会話だけで終わらせず実際に手を動かす”自律エージェントです。\n"
        f"今日の日付: {_today_str()}\n\n"
        + tools.TOOLS_DOC + "\n\n"
        "【行動プロトコル（厳守）】\n"
        "1. 目的の達成に行動が必要なら、返答の一番最初の行に必ず次の形式を“1行だけ”出力する：\n"
        f'   {_MARKER}{{"tool":"ツール名","params":{{...}}}}\n'
        "2. ツールの実行結果は次の行で <<<TOOL_RESULT>>> として渡される。それを踏まえ、"
        "まだ必要なら次のツールを（同じ形式で）1つ呼ぶ。\n"
        "3. 状況が曖昧なときは、まず list_state で現状を把握してから動く。\n"
        "4. すべて完了したら、ツール記法は一切使わず、実行した内容と結果を日本語で簡潔に報告する。\n"
        "5. 一度に呼ぶツールは必ず1つ。無駄な呼び出しはしない。行動が不要な質問には普通に答える。"
    )


def _build_convo(system_prompt: str, history, instruction: str) -> str:
    """system + 直近履歴 + 今回の指示 を single-prompt に結合する。"""
    lines = [system_prompt, "\n--- 会話履歴 ---"]
    for m in (history or []):
        role = (m.get("role") if isinstance(m, dict) else getattr(m, "role", "")) or ""
        content = (m.get("content") if isinstance(m, dict) else getattr(m, "content", "")) or ""
        content = content.strip()
        if not content:
            continue
        speaker = "ユーザー" if role.lower() in ("user", "human") else "アシスタント"
        lines.append(f"{speaker}: {content}")
    lines.append(f"ユーザー: {instruction.strip()}")
    return "\n".join(lines)


def run_stream(instruction: str, history=None, name: str = "AIbou", approval: bool = False):
    """エージェントを実行し、進捗イベントを逐次 yield するジェネレータ。
    approval=True のとき、機微なツール（SENSITIVE_TOOLS）は実行せず 'approval'
    イベントを出して停止する（人間が承認したら /agent/execute で実行する）。"""
    instruction = (instruction or "").strip()
    yield {"phase": "start"}
    if not instruction:
        yield {"phase": "final", "text": "指示が空です。何をしましょうか？"}
        yield {"phase": "done", "steps": 0}
        return

    convo = _build_convo(_system_prompt(name), history, instruction)
    executed: list = []  # 実行したツール名の記録（最終フォールバック用）

    for step in range(1, MAX_STEPS + 1):
        yield {"phase": "thinking", "step": step}
        try:
            text = llm.generate_text(convo + "\nアシスタント:", max_tokens=STEP_MAX_TOKENS)
        except Exception as e:
            yield {"phase": "error", "detail": _friendly_error(e)}
            yield {"phase": "done", "steps": step - 1}
            return

        call, preface = tools.extract_tool_call(text or "")
        if not call:
            # ツール呼び出し無し＝最終報告。
            final = (text or "").strip() or "完了しました。"
            yield {"phase": "final", "text": final}
            yield {"phase": "done", "steps": step - 1}
            return

        tool = (call.get("tool") or "").strip()
        params = call.get("params") or {}

        # 承認モード：機微なツールは実行せず、ユーザーの承認を待つ。
        if approval and tool in SENSITIVE_TOOLS:
            yield {"phase": "approval", "step": step, "tool": tool, "params": params, "note": (preface or "").strip()}
            yield {"phase": "done", "steps": step - 1, "awaiting_approval": True}
            return

        yield {"phase": "tool", "step": step, "tool": tool, "params": params, "note": (preface or "").strip()}

        result = tools.execute_tool(tool, params)
        executed.append(tool)
        yield {"phase": "observation", "step": step, "tool": tool, "result": result}

        # 実行の痕跡を会話に足して次のステップへ。
        convo += (
            f"\nアシスタント: {_MARKER}{json.dumps(call, ensure_ascii=False)}"
            f"\n<<<TOOL_RESULT>>> {result}"
        )

    # ステップ上限に到達 → ツール無しで最終報告を促す。
    try:
        final = llm.generate_text(
            convo + "\nアシスタント（これ以上ツールは使わず、ここまでで実行した内容を日本語で簡潔に報告）:",
            max_tokens=STEP_MAX_TOKENS,
        )
    except Exception:
        final = ""
    if not (final or "").strip():
        final = f"実行しました（{'、'.join(executed) or '操作なし'}）。"
    yield {"phase": "final", "text": final.strip()}
    yield {"phase": "done", "steps": MAX_STEPS}


def _friendly_error(e: Exception) -> str:
    """生成エラーを人間向けの短い説明に丸める。"""
    try:
        import config
        if config.is_zero_quota_429(e):
            return ("Gemini無料枠の上限（またはこのキーの無料枠が0）に達しました。"
                    "KEYCHAIN に HUGGINGFACE_TOKEN を入れると自動でHuggingFaceに切り替わります。")
    except Exception:
        pass
    return f"生成に失敗しました：{e}"


def generate(instruction: str, history=None, name: str = "AIbou") -> dict:
    """run_stream を最後まで回し、最終結果を dict で返す（テスト/非SSE用の互換API）。"""
    steps: list = []
    final = ""
    error = None
    for ev in run_stream(instruction, history, name):
        phase = ev.get("phase")
        if phase in ("tool", "observation"):
            steps.append(ev)
        elif phase == "final":
            final = ev.get("text", "")
        elif phase == "error":
            error = ev.get("detail")
    return {"final": final, "steps": steps, "error": error}
