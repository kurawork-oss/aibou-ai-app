# agent.py — HOME「手足となって動く」マルチステップ・エージェント
# =====================================================================
# /chat の単発ツール実行を一般化した、plan→act→observe を最大 MAX_STEPS 回
# 繰り返す自律ループ。ユーザーの1つの指示に対し、必要なツールを次々に呼んで
# 実際にタスクを片付け、最後に日本語で結果を報告する。
#
# 進捗は Claude Code 風に逐次イベントで流す（run_stream がジェネレータ）:
#   {"phase": "start"}
#   {"phase": "prepare", "what": "指示文の組み立て"}   # 返事が始まる前の準備
#   {"phase": "thinking", "step": n}
#   {"phase": "tool", "step": n, "tool": "add_task", "params": {...}, "note": "..."}
#   {"phase": "observation", "step": n, "tool": "...", "result": "..."}
#   {"phase": "final", "text": "最終報告"}
#   {"phase": "done", "steps": n}
#   {"phase": "error", "detail": "..."}   # 生成失敗時（done は必ず続けて出す）
#
# すべてのイベントに ms（直前のイベントからの経過）と total_ms（開始からの合計）
# を付ける。理由:
#   これまでは「考えています…」としか出せず、遅いと感じたときに、どこが遅いのか
#   画面から分からなかった。準備が重いのか、生成が重いのか、ツールが重いのかで
#   打ち手はまったく違う。時間が出ていれば、それを見て決められる。
#
#   prepare を分けたのも同じ理由。記憶やルールの読み込みは返事が始まる前に
#   終わらせる必要があるので、そこが重くなると待ち時間に直結するが、
#   ループの外にあるためイベントが1つも出ていなかった。
#
# 設計方針は既存モジュールと統一：設定が欠けても絶対に crash させない。
# =====================================================================

import json
import time
from datetime import datetime, timezone, timedelta

import llm
import risk
import toolcall
import tools

# ツールを何回まで連鎖できるか（無限ループ / 無駄呼び出しの安全弁）。
MAX_STEPS = 6
# 各ステップの生成トークン上限（ツール呼び出し or 最終報告に十分な小さめの値）。
STEP_MAX_TOKENS = 1200

# 承認モード時、実行前にユーザー確認を挟む「機微な」ツール（外部送信・不可逆な副作用）。
# 危なさの段階は risk.py が持つ（0 読むだけ / 1 中が変わる / 2 外に残る /
# 3 取り返せない）。以前はここに平たい集合が1つあり、メール送信とWeb検索が
# 同じ扱いだったため、承認モードを切ると送信も黙って通った。
# 段階3は承認モードに関わらず必ず聞く。
#
# 後方互換のために名前は残す（外から参照している所がある）。
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


def _tool_names():
    """AIに選ばせる道具の名前。説明文と同じ絞り込みを使う。

    説明だけ絞って宣言は全部渡す、という食い違いを作らないため、
    どちらもここから引く。
    """
    try:
        import capabilities
        return capabilities.enabled_tools()
    except Exception:
        return set(tools.TOOL_DOCS)


def _tools_doc() -> str:
    """AIに渡す道具の説明。パックと連携の状況で絞る。

    絞り込みが何かの理由で失敗しても、会話が止まってはいけないので、
    そのときは全部入りに落とす。
    """
    try:
        import capabilities
        return capabilities.tools_doc()
    except Exception:
        return tools.TOOLS_DOC


def _system_prompt(name: str) -> str:
    """いつも渡す指示。道具の一覧と呼び方は、ここには入れない。

    道具をどう呼ばせるかは2通りある（正式な function calling と、文章に
    目印を書かせる方式）。両方の説明を混ぜて渡すと、正式な口が使えるときに
    モデルが目印を書いてしまう。使う方式のぶんだけを、後から足す。
    """
    assistant = (name or "AIbou").strip() or "AIbou"
    return (
        f"あなたは「{assistant}」。THE FORGE OS のホーム・エージェントであり、"
        "ユーザーの手足となって“会話だけで終わらせず実際に手を動かす”自律エージェントです。\n"
        f"今日の日付: {_today_str()}\n\n"
        "【行動の原則】\n"
        "1. 目的の達成に行動が必要なら、道具を1つ呼ぶ。一度に呼ぶのは必ず1つ。\n"
        "2. 道具の結果を踏まえ、まだ必要なら次の道具を呼ぶ。\n"
        "3. 状況が曖昧なときは、まず list_state で現状を把握してから動く。\n"
        "4. すべて完了したら、実行した内容と結果を日本語で簡潔に報告する。\n"
        "5. 無駄な呼び出しはしない。行動が不要な質問には普通に答える。"
    )


def _marker_protocol() -> str:
    """正式な function calling が使えないモデル向けの、これまでの頼み方。

    道具の説明もここに入れる。正式な口では宣言として渡すので要らない。
    """
    return (
        "\n\n" + _tools_doc() + "\n\n"
        "【ツールの呼び方】\n"
        "行動が必要なら、返答の一番最初の行に必ず次の形式を“1行だけ”出力する：\n"
        f'   {_MARKER}{{"tool":"ツール名","params":{{...}}}}\n'
        "実行結果は次の行で <<<TOOL_RESULT>>> として渡される。\n"
        "完了したらツール記法は一切使わず、日本語で報告する。"
    )


# ルールは無くても動くべきもの。読めなくても絶対に止めない。
def _rules_always() -> str:
    try:
        import rules
        return rules.always_block()
    except Exception:
        return ""


def _rules_topic(text: str) -> str:
    try:
        import rules
        return rules.for_topic(text)
    except Exception:
        return ""


def _rules_for_tool(tool: str) -> str:
    try:
        import rules
        return rules.for_tool(tool)
    except Exception:
        return ""


def _setup_needed(instruction: str, tool: str, params: dict, result: str):
    """道具の失敗が「連携が足りないだけ」かを見る。読めなければ None。

    ここが失敗しても会話は続けるべきなので、包んでおく。
    """
    try:
        import setup_flow
        return setup_flow.blocked(instruction, tool, params, result)
    except Exception:
        return None


def _stamper():
    """イベントに経過時間を刻む関数を作る。

    ms       … 直前のイベントからの経過（その工程にかかった時間）
    total_ms … 開始からの合計

    monotonic を使う（時計合わせで巻き戻っても負の値にならない）。
    """
    t0 = time.monotonic()
    last = [t0]

    def stamp(ev: dict) -> dict:
        now = time.monotonic()
        ev["ms"] = int((now - last[0]) * 1000)
        ev["total_ms"] = int((now - t0) * 1000)
        last[0] = now
        return ev

    return stamp


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
    stamp = _stamper()
    yield stamp({"phase": "start"})
    if not instruction:
        yield stamp({"phase": "final", "text": "指示が空です。何をしましょうか？"})
        yield stamp({"phase": "done", "steps": 0})
        return

    # 準備（返事が始まる前にやること）。ここが重いと待ち時間に直結するので、
    # 何をどれだけ待ったのかが分かるよう、工程として出す。
    system_prompt = _system_prompt(name)

    # 人が書いたルール。GitHubには触らない（同期済みの内容を読むだけ）。
    always = _rules_always()
    topic = _rules_topic(instruction)
    if always or topic:
        system_prompt += "\n\n" + "\n\n".join(x for x in (always, topic) if x)
        yield stamp({"phase": "prepare", "what": "ルールを読む",
                     "detail": f"{len(always) + len(topic):,}字"})

    convo = _build_convo(system_prompt, history, instruction)
    # 正式な口が使えないモデルに落ちたとき用。道具の説明と目印の頼み方が入る。
    convo_marker = _build_convo(system_prompt + _marker_protocol(), history, instruction)
    yield stamp({"phase": "prepare", "what": "指示文の組み立て",
                 "detail": f"{len(convo):,}字"})

    executed: list = []  # 実行したツール名の記録（最終フォールバック用）
    failed: list = []    # 失敗したツールと理由（成功したように報告しないため）
    rules_shown: set = set()   # ツール別ルールを見せた相手（同じ物を繰り返さない）

    for step in range(1, MAX_STEPS + 1):
        yield stamp({"phase": "thinking", "step": step})
        try:
            # 道具の選択は、モデルが正式に備えている口（function calling）で行う。
            # 使えないモデルでは、これまでどおり文章から目印を拾う方式に落ちる。
            decision = toolcall.decide(
                convo + "\nアシスタント:",
                convo_marker + "\nアシスタント:",
                _tool_names(), tools.TOOL_DOCS)
        except Exception as e:
            yield stamp({"phase": "error", "detail": _friendly_error(e)})
            yield stamp({"phase": "done", "steps": step - 1})
            return

        call = decision.get("call")
        preface = decision.get("text") or ""
        if not call:
            # 道具を呼ばなかった＝最終報告。
            final = preface.strip() or _fallback_report(executed, failed)
            yield stamp({"phase": "final", "text": final})
            yield stamp({"phase": "done", "steps": step - 1})
            return

        tool = (call.get("tool") or "").strip()
        params = call.get("params") or {}

        # そのツールにルールがあるなら、実行する前に一度だけ読ませて、
        # 呼び直させる。取り返しのつかない操作（投稿・送信）の直前に必ず通るので、
        # 「書いてあるのに守らなかった」が起きにくい。
        # 1つのツールにつき1回だけ（毎回やると同じ所を回り続ける）。
        rule_text = _rules_for_tool(tool)
        if rule_text and tool not in rules_shown:
            rules_shown.add(tool)
            yield stamp({"phase": "prepare", "what": f"{tool} のルールを確認",
                         "detail": f"{len(rule_text):,}字"})
            back = (
                f"\nアシスタント: {_MARKER}{json.dumps(call, ensure_ascii=False)}"
                f"\n<<<TOOL_RESULT>>> {rule_text}\n"
                "（まだ実行していません。上のルールに沿って内容を直し、"
                "同じツールをもう一度呼んでください）"
            )
            convo += back
            convo_marker += back
            continue

        # 実行の前に人に聞くべきか。段階3（送る・投稿する・お金が動く）は
        # 承認モードを切っていても必ず聞く。設定の組み合わせで
        # 「黙ってメールが飛んだ」が起きないようにする。
        if risk.needs_confirmation(tool, approval):
            info = risk.describe(tool)
            yield stamp({"phase": "approval", "step": step, "tool": tool,
                         "params": params, "note": (preface or "").strip(),
                         "level": info["level"], "level_label": info["label"],
                         "why": info["why"],
                         "always_confirm": info["always_confirm"]})
            yield stamp({"phase": "done", "steps": step - 1, "awaiting_approval": True})
            return

        yield stamp({"phase": "tool", "step": step, "tool": tool,
                     "params": params, "note": (preface or "").strip()})

        result = tools.execute_tool(tool, params)
        executed.append(tool)
        if _looks_failed(result):
            failed.append((tool, result))
        yield stamp({"phase": "observation", "step": step, "tool": tool, "result": result})

        # 失敗の理由が「まだ連携していない」だけなら、そこで話を終わらせない。
        # 用事を預かって、繋ぐ入口を出す。繋げたら預けた用事から再開する。
        # 「設定してきてください」で会話が切れると、戻ってきたときに最初の
        # 頼みごとを言い直すことになる。それが一番いらない手間。
        need = _setup_needed(instruction, tool, params, result)
        if need:
            yield stamp({"phase": "setup_required", "step": step,
                         "provider": need.get("provider", ""),
                         "label": need.get("label", ""),
                         "connect_path": need.get("connect_path", ""),
                         "can_connect": bool(need.get("can_connect")),
                         "needs_owner": bool(need.get("needs_owner")),
                         "held_id": need.get("held_id", "")})
            yield stamp({"phase": "final", "text": need.get("message", "")})
            yield stamp({"phase": "done", "steps": step,
                         "awaiting_setup": True})
            return

        # 実行の痕跡を会話に足して次のステップへ。
        # 2通りの指示文の両方に積む（途中で落ちる先が変わっても筋が通るように）。
        trace = (
            f"\nアシスタント: {_MARKER}{json.dumps(call, ensure_ascii=False)}"
            f"\n<<<TOOL_RESULT>>> {result}"
        )
        convo += trace
        convo_marker += trace

    # ステップ上限に到達 → ツール無しで最終報告を促す。
    try:
        final = llm.generate_text(
            convo + "\nアシスタント（これ以上ツールは使わず、ここまでで実行した内容を日本語で簡潔に報告）:",
            max_tokens=STEP_MAX_TOKENS,
        )
    except Exception:
        final = ""
    if not (final or "").strip():
        final = _fallback_report(executed, failed)
    yield stamp({"phase": "final", "text": final.strip()})
    yield stamp({"phase": "done", "steps": MAX_STEPS})


# ツールの結果は文字列で返る（絶対に raise しない作りのため）。
# 成功と失敗を見分ける手掛かりは、その文面しかない。
_FAIL_MARKS = ("失敗", "エラー", "できません", "ませんでした",
               "不明なツール", "が空です", "見つかりません", "保存先")


def _fallback_report(executed: list, failed: list) -> str:
    """生成が文章を返さなかったときの受け皿。

    ここで一律に「完了しました」「実行しました」と書くと、全部失敗していても
    成功したように読める。エージェントは実際に手を動かすので、この嘘は重い。
    """
    if failed:
        lines = "、".join(f"{t}（{r}）" for t, r in failed[:3])
        more = f" ほか{len(failed) - 3}件" if len(failed) > 3 else ""
        return f"うまくいかなかったものがあります：{lines}{more}"
    if executed:
        return f"実行しました（{'、'.join(executed)}）。"
    return "完了しました。"


def _looks_failed(result: str) -> bool:
    r = (result or "")
    return any(m in r for m in _FAIL_MARKS)


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
