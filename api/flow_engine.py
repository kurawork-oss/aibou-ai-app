# flow_engine.py — 「ステップを順に実行する」ための唯一の実装
# =====================================================================
# このアプリには“手順を並べて実行する”機能が3か所にあり、それぞれ別実装だった。
#   ・AI STUDIO のワークフロー … 文章生成の連鎖（人格・資料・条件は持てる）
#   ・BOARD の自動化           … トリガー→通知やタスク作成もできる（頭は無い）
#   ・AUTO のオートパイロット   … ゴールを分解して1手ずつ実行
# 同じことを3通りに書いていたため、片方だけ賢くなる／片方だけ壊れる状態だった。
# ここに実行部分を1つに集め、両方から呼ぶ。
#
# ステップの形（欠けている項目は既定で動く）:
#   {
#     "name":        表示名,
#     "type":        "ai_generate"（既定） | "fetch" | "notify" | "create_task",
#     "prompt":      指示。{input} {original} {stepN} を差し込める,
#     "params":      {"prompt": ..., "message": ..., "title": ...}（旧自動化の形）,
#     "ai_id":       担当のカスタムAI（人格とルールを適用）,
#     "notebook_id": VAULTのノートブック（その資料だけを根拠にする）,
#     "when":        条件（満たさなければこのステップを飛ばす）
#   }
#
# fetch（外から読む）について
# ---------------------------
# 手順はこれまで「AIに書かせる・知らせる・タスクにする」の3つしか無く、
# **外の値を1つも読めなかった**。天気を見て傘の通知、在庫を見て補充のタスク、
# 為替を見て判断——どれも作れない。それを作れるようにするのが fetch。
#
# ただし、外から来た文章はそのままAIへの指示として効いてしまう
# （間接プロンプトインジェクション）。だから2つ守る:
#
#   ・行き先は netguard が検査する（内向きのアドレスへは出ていかない）
#   ・AIへ渡すときは untrusted で囲う（命令ではなくデータとして扱わせる）
#
# 通知やタスクへ渡すのは**囲っていない素の文章**にする。囲いの説明文が
# LINEの通知に混ざっても読みにくいだけで、そこにAIは居ない。
#
# 方針: 絶対に raise しない。1ステップ失敗しても続行し、理由を残す。
# =====================================================================

import json
import re

import llm
import netguard
import untrusted

STEP_TYPES = ("ai_generate", "fetch", "notify", "create_task")

#: fetch で受け取る文字数の上限（1ステップぶん）。
#: 長いページを丸ごと次のプロンプトへ流すと、そこだけで枠を食い潰す。
FETCH_CHARS = 8_000

MAX_STEPS = 20
KNOWLEDGE_CHARS = 12_000   # 1ステップに渡す資料の上限（プロンプトが膨らみすぎないように）


# ── プロンプト組み立て ───────────────────────────────────────────────

def fill(template: str, original: str, current: str, outputs: list) -> str:
    """{input}（直前の出力）{original}（最初の入力）{stepN}（N番目の出力）を差し込む。"""
    out = (template or "").replace("{input}", current or "").replace("{original}", original or "")

    def sub(m):
        n = int(m.group(1))
        return outputs[n - 1] if 1 <= n <= len(outputs) else ""

    return re.sub(r"\{step(\d+)\}", sub, out)


def persona_prefix(ai) -> str:
    """カスタムAIの人格とルールを、そのステップの前置きにする。"""
    if not ai:
        return ""
    parts = [f"あなたは「{ai.get('name')}」です。"
             + ((ai.get("persona") or "").strip())]
    if (ai.get("rules") or "").strip():
        parts.append(f"【必ず守るルール】\n{ai['rules'].strip()}")
    return "\n".join(p for p in parts if p.strip()) + "\n\n"


def knowledge_block(notebook_id: str, question: str = "") -> tuple:
    """VAULTのノートブックを資料として読み込む。(block, label, warning)。

    資料が多いときは全文ではなく、その指示に関係する段落だけを選ぶ
    （先頭から詰めるだけだと、後ろに答えがある資料に永久に届かない）。
    資料が使えないときも止めず、warning を残して素の生成を続ける
    （黙って根拠なしの回答を返さないよう、理由は必ず表に出す）。
    """
    if not notebook_id:
        return "", "", ""
    try:
        import vault
        docs, err = vault._load_docs(notebook_id)
    except Exception as e:
        return "", "", f"資料を読み込めませんでした（{e}）"
    if err:
        return "", "", f"資料を読み込めませんでした（{err.get('error')}）"

    warn = ""
    try:
        import retrieval
        picked = retrieval.select(docs or {}, question, budget=KNOWLEDGE_CHARS)
        context = picked["context"]
        if picked["chunks"] and not picked["matched"]:
            warn = "指示に関係する記述が資料内に見つかりませんでした（先頭から渡しています）"
    except Exception:
        # 検索側が壊れても止めないよう、従来どおり先頭から詰める
        parts = [f"## {t}\n{(b if isinstance(b, str) else str(b or '')).strip()}"
                 for t, b in (docs or {}).items() if str(b or "").strip()]
        context = "\n\n".join(parts)[:KNOWLEDGE_CHARS]

    if not context:
        return "", "", "指定のノートブックに資料がありません"
    block = (
        "【資料】以下の資料に書かれていることだけを根拠にしてください。"
        "資料に無いことは推測せず「資料には記載がありません」と書いてください。\n"
        + context + "\n\n"
    )
    return block, notebook_id, warn


def condition_met(when: str, original: str, current: str) -> tuple:
    """分岐条件を判定する。(met: bool, reason: str)。

    判定できないときは実行する側に倒す（作った本人はそのステップを走らせたい
    はずで、黙って飛ばすほうが分かりにくい）。
    """
    when = (when or "").strip()
    if not when:
        return True, ""
    prompt = (
        "次の条件が満たされているかを判定してください。"
        "説明は書かず、YES か NO の1語だけで答えてください。\n\n"
        f"【条件】{when}\n\n"
        f"【最初の入力】\n{(original or '')[:2000]}\n\n"
        f"【直前の出力】\n{(current or '')[:4000]}\n\n"
        "【判定(YES/NO)】"
    )
    try:
        ans = (llm.generate_text(prompt, max_tokens=8) or "").strip().upper()
    except Exception as e:
        return True, f"条件を判定できなかったため実行しました（{e}）"
    if ans.startswith("NO") or ans.startswith("いいえ"):
        return False, f"条件「{when}」を満たさないためスキップ"
    if ans.startswith("YES") or ans.startswith("はい"):
        return True, ""
    return True, "条件の判定が曖昧だったため実行しました"


# ── 行動するステップ ─────────────────────────────────────────────────

def _act_notify(text: str) -> dict:
    try:
        import notify as notify_mod
        res = notify_mod.notify_all(text)
        return {"ok": bool(res.get("ok")), "detail": res}
    except Exception as e:
        return {"ok": False, "error": f"通知に失敗しました: {e}"}


def _act_fetch(url: str, max_chars: int = FETCH_CHARS) -> dict:
    """外のURLを読む。{"ok", "text", "url", "error"}。

    JSONはそのままの形で渡す（整形して渡すほうがAIは読み違えにくい）。
    HTMLは本文だけ取り出す（タグごと渡すと、中身より記号のほうが多くなる）。
    """
    url = (url or "").strip()
    if not url:
        return {"ok": False, "error": "URLが空です"}
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
        url = "https://" + url

    res = netguard.fetch(url)
    if not res.ok:
        return {"ok": False, "error": res.error, "url": res.url}

    body = res.text or ""
    ctype = (res.content_type or "").lower()
    if "json" in ctype:
        try:
            body = json.dumps(json.loads(body), ensure_ascii=False, indent=2)
        except Exception:
            pass          # 壊れたJSONなら、素のまま渡す（読めるかはAIに任せる）
    elif "html" in ctype or "<html" in body[:400].lower():
        try:
            import web
            body = web.extract_text(body)
        except Exception:
            pass

    out = {"ok": True, "text": body[:max_chars], "url": res.url}
    if len(body) > max_chars or res.truncated:
        out["truncated"] = True
    if len(res.hops) > 1:
        out["redirected_from"] = res.hops[0]
    notes = untrusted.findings(out["text"])
    if notes:
        out["warning"] = "読み取った文章に、AIへの命令のような書き方があります（" + "／".join(notes) + "）"
    return out


def _act_create_task(title: str, content: str) -> dict:
    try:
        import tasks as tasks_module
        task = tasks_module.create_task(title or "自動化のタスク", content or "", "pending")
        if isinstance(task, dict) and task.get("error"):
            return {"ok": False, "error": task["error"]}
        return {"ok": True, "detail": task}
    except Exception as e:
        return {"ok": False, "error": f"タスク作成に失敗しました: {e}"}


# ── 本体 ─────────────────────────────────────────────────────────────

def run_steps(steps, input_text: str = "", resolve_ai=None) -> dict:
    """ステップを順に実行し、実行記録を返す。

    resolve_ai: ai_id → カスタムAIのdict を返す関数（無ければ人格は適用しない）。

    戻り値 {"results": [...], "final_output": str, "ran": int, "skipped": int}
    results の各行: {step, name, type, output, ok, skipped, reason?, ai?,
                     knowledge?, warning?, error?, detail?}
    """
    steps = list(steps or [])[:MAX_STEPS]
    results = []
    outputs: list = []           # {stepN} 用に全ステップの出力を積む（素のまま）
    original = input_text or ""
    current = original

    # AIへ渡すときだけ使う、囲った版。
    #
    # 外から読んだ文章は「命令ではなくデータ」として囲う必要があるが、
    # 通知やタスクの本文にその囲いの説明が混ざると、ただ読みにくい。
    # 渡す先で分ける——AIには囲った版、人には素の版。
    safe_outputs: list = []
    current_safe = original

    for i, step in enumerate(steps):
        step = step if isinstance(step, dict) else {}
        params = step.get("params") or {}
        st = (step.get("type") or "ai_generate").strip()
        if st not in STEP_TYPES:
            st = "ai_generate"
        name = step.get("name") or f"Step {i + 1}"

        # 指示は新形式(prompt)を優先し、旧自動化の形(params)にも対応する。
        # fetch は「読むURL」がそれにあたるので、params.url を先に見る
        # （ここに url を入れ忘れると、URLの代わりに直前の出力を取りに行く）。
        if st == "fetch":
            template = (step.get("url") or params.get("url")
                        or step.get("prompt") or params.get("prompt") or "")
        else:
            template = (step.get("prompt") or params.get("prompt")
                        or params.get("message") or params.get("title") or "")

        if st in ("ai_generate", "fetch") and not str(template).strip():
            outputs.append("")
            results.append({"step": i + 1, "name": name, "type": st, "output": "",
                            "ok": False, "skipped": True,
                            "reason": "URLが空のためスキップ" if st == "fetch"
                                      else "指示が空のためスキップ"})
            continue

        met, reason = condition_met(step.get("when") or "", original, current)
        if not met:
            # 飛ばしても後続の {stepN} の番号がずれないように場所は確保する
            outputs.append("")
            results.append({"step": i + 1, "name": name, "type": st, "output": "",
                            "ok": True, "skipped": True, "reason": reason})
            continue

        text = fill(str(template), original, current, outputs)
        row = {"step": i + 1, "name": name, "type": st, "skipped": False}
        if reason:
            row["reason"] = reason

        if st == "ai_generate":
            ai = resolve_ai(step.get("ai_id") or "") if resolve_ai else None
            # AIに渡す指示は、囲った版で組み立てる
            safe_text = fill(str(template), original, current_safe, safe_outputs)
            knowledge, nb_id, warn = knowledge_block(step.get("notebook_id") or "", safe_text)
            prompt = persona_prefix(ai) + knowledge + safe_text
            try:
                out = llm.generate_text(prompt, max_tokens=2200) or ""
                row["ok"] = True
            except Exception as e:
                out = f"[error: {e}]"
                row["ok"] = False
                row["error"] = str(e)
            if ai:
                row["ai"] = ai.get("name")
            if nb_id:
                row["knowledge"] = nb_id
            if warn:
                row["warning"] = warn
            row["output"] = out
            outputs.append(out)
            safe_outputs.append(out)   # AIが書いた物なので、囲う必要はない
            current = out            # 生成結果だけを次の {input} に渡す
            current_safe = out

        elif st == "fetch":
            res = _act_fetch(text or current, int(params.get("max_chars") or FETCH_CHARS))
            row["ok"] = res["ok"]
            if res.get("error"):
                row["error"] = res["error"]
            if res.get("warning"):
                row["warning"] = res["warning"]
            if res.get("truncated"):
                row["truncated"] = True
            if res.get("redirected_from"):
                row["redirected_from"] = res["redirected_from"]
            got = res.get("text", "") if res["ok"] else ""
            row["output"] = got
            row["url"] = res.get("url") or (text or current)
            outputs.append(got)
            # 次のAIへは囲って渡す（ここが本体。素で渡すと、読んだページの
            # 「〜してください」がそのまま指示になる）
            safe_outputs.append(
                untrusted.wrap(got, source=row["url"], kind="読み取った内容") if got else "")
            if res["ok"]:
                current = got
                current_safe = safe_outputs[-1]

        elif st == "notify":
            res = _act_notify(text or current)
            row["ok"] = res["ok"]
            if res.get("error"):
                row["error"] = res["error"]
            if res.get("detail"):
                row["detail"] = res["detail"]
            row["output"] = current  # 通知は流れを変えない
            outputs.append(current)
            safe_outputs.append(current_safe)

        else:  # create_task
            title = str(params.get("title") or text or current or "").strip()
            res = _act_create_task(fill(title, original, current, outputs),
                                   str(params.get("content") or current or ""))
            row["ok"] = res["ok"]
            if res.get("error"):
                row["error"] = res["error"]
            if res.get("detail"):
                row["detail"] = res["detail"]
            row["output"] = current
            outputs.append(current)
            safe_outputs.append(current_safe)

        results.append(row)

        # 生成・取得が失敗したら以降は続けない
        # （空の入力で後続を回しても意味がないうえ、「読めなかったのに
        #   読めたことにして通知」がいちばん困る形になる）
        if st in ("ai_generate", "fetch") and not row.get("ok"):
            break

    ran = [r for r in results if not r.get("skipped")]
    gen = [r for r in ran if r.get("type") == "ai_generate" and r.get("ok")]
    return {
        "results": results,
        "final_output": gen[-1]["output"] if gen else (ran[-1]["output"] if ran else ""),
        "ran": len(ran),
        "skipped": len(results) - len(ran),
    }
