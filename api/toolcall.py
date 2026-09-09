"""
api/toolcall.py — 「次に何をするか」をモデルに聞く。正式な口を使う。

これまでの作り
--------------
モデルに文章でこう頼んでいた:

    返答の一番最初の行に必ず次の形式を1行だけ出力する:
    <<<TOOL_CALL>>>{"tool":"名前","params":{...}}

そして返ってきた文章から、その文字列を探していた。

これは動くが、次が普通に起きる:
  ・目印を書き忘れる／前置きを付けてしまう
  ・引数のJSONが壊れている（閉じ括弧が無い、全角の引用符）
  ・道具を2つ同時に呼びたいときに表現できない

いまのモデルは function calling を正式に備えている。宣言した関数の中から
選ばせ、引数は構造化されたまま受け取れるので、上の失敗が原理的に起きない。

方針
----
・使えるなら正式な口（Gemini / OpenAI の function calling）
・使えないモデル（HuggingFaceのルーター経由など）では、これまでの目印方式
・どちらで動いたかを返す（画面や記録で分かるように）

「正式な口が使えないから道具が使えない」にはしない。落ちる先を必ず用意する。
"""

import json
from typing import Any, Dict, List, Optional

import config
import tools as tools_mod
import toolschema

# 目印方式に落ちたときに使う（従来と同じ文字列）
MARKER = tools_mod.TOOL_CALL_MARKER


def _gemini_call(prompt: str, decls: List[dict]) -> Optional[dict]:
    """Gemini の function calling。使えなければ None。"""
    try:
        resp = config.generate_resilient(
            prompt, tools=[{"function_declarations": decls}])
    except Exception:
        return None
    if resp is None:
        return None

    text_parts: List[str] = []
    call = None
    try:
        for cand in (getattr(resp, "candidates", None) or []):
            for part in (getattr(getattr(cand, "content", None), "parts", None) or []):
                fc = getattr(part, "function_call", None)
                if fc is not None and getattr(fc, "name", ""):
                    if call is None:      # 最初の1つだけ実行する（今の作りは逐次）
                        call = {"tool": str(fc.name),
                                "params": _plain(getattr(fc, "args", None))}
                    continue
                t = getattr(part, "text", "") or ""
                if t:
                    text_parts.append(t)
    except Exception:
        return None

    if call is None and not text_parts:
        return None
    return {"text": "".join(text_parts).strip(), "call": call, "native": True}


def _plain(args: Any) -> dict:
    """Gemini が返す引数（MapComposite等）を、素の dict にする。"""
    if args is None:
        return {}
    try:
        out = {}
        for k in args:
            v = args[k]
            if hasattr(v, "__iter__") and not isinstance(v, (str, bytes)):
                try:
                    v = [x for x in v]
                except Exception:
                    v = str(v)
            out[str(k)] = v
        return out
    except Exception:
        try:
            return dict(args)
        except Exception:
            return {}


def _openai_call(prompt: str, decls: List[dict]) -> Optional[dict]:
    """OpenAI の function calling。使えなければ None。"""
    import llm
    token = llm._openai_token()
    if not token:
        return None
    try:
        import requests
    except Exception:
        return None
    payload = {
        "model": llm.openai_model(),
        "messages": [{"role": "user", "content": prompt}],
        "tools": [{"type": "function", "function": d} for d in decls],
    }
    try:
        r = requests.post("https://api.openai.com/v1/chat/completions",
                          headers={"Authorization": f"Bearer {token}",
                                   "Content-Type": "application/json"},
                          json=payload, timeout=90)
        d = r.json() if r.content else {}
    except Exception:
        return None
    try:
        msg = (d.get("choices") or [{}])[0].get("message") or {}
    except Exception:
        return None
    if not msg:
        return None
    call = None
    for c in (msg.get("tool_calls") or []):
        fn = c.get("function") or {}
        if fn.get("name"):
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except Exception:
                args = {}
            call = {"tool": fn["name"], "params": args if isinstance(args, dict) else {}}
            break
    text = (msg.get("content") or "").strip()
    if call is None and not text:
        return None
    return {"text": text, "call": call, "native": True}


def _marker_call(prompt: str) -> dict:
    """これまでの方式。文章の中の目印を探す。"""
    import llm
    text = llm.generate_text(prompt)
    call, preface = tools_mod.extract_tool_call(text)
    return {"text": (preface or "").strip(),
            "call": ({"tool": call.get("tool"), "params": call.get("params") or {}}
                     if call else None),
            "native": False}


def decide(prompt: str, marker_prompt: str, tool_names,
           docs: Dict[str, str]) -> dict:
    """次の一手を決める。

    prompt        … 正式な口で聞くときの指示文（道具の一覧は宣言で渡すので入れない）
    marker_prompt … 落ちる先で聞くときの指示文（道具の一覧と目印の頼み方が入る）

    2つ受け取るのは、どちらの方式でも筋の通った頼み方をするため。
    片方に両方の説明を入れると、正式な口が使えるときにモデルが目印を書く。

    戻り値:
      {"text": モデルの言葉, "call": {"tool","params"} or None, "native": bool}

    call が入っていても、引数はまだ検査していない。execute_tool 側で
    検査してから実行する（そこが唯一の入口になるようにしてある）。
    """
    decls = toolschema.declarations(tool_names, docs)
    if decls:
        for attempt in (_gemini_call, _openai_call):
            try:
                got = attempt(prompt, decls)
            except Exception:
                got = None
            if got is not None:
                return got
    # 正式な口が使えない（HF経由など）→ これまでの方式
    return _marker_call(marker_prompt)


def native_available() -> bool:
    """正式な口が使える見込みがあるか（画面の表示用）。"""
    try:
        if config.gemini_configured():
            return True
        import llm
        return bool(llm._openai_token())
    except Exception:
        return False
