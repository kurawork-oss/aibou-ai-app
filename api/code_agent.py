# code_agent.py — CODE モード（Claude Code / Codex 風のAIコーディングエージェント）。
# 指示＋ワークスペースのファイル群を受け、Gemini に変更後のファイル群を
# 厳密JSONで出力させて返す。設定が無くても絶対に crash しない（error キー返却）。
import json
import re

import config
import llm

# ── 入出力の上限（暴走・巨大化のガード） ───────────────────────────
MAX_INPUT_FILES = 30          # 受け取るワークスペースのファイル数
MAX_FILE_CHARS = 12_000       # プロンプトに載せる1ファイルの最大文字数
MAX_TOTAL_CHARS = 60_000      # プロンプトに載せる合計最大文字数
MAX_OUTPUT_FILES = 20         # 1回の応答で変更できるファイル数
MAX_OUTPUT_CHARS = 200_000    # 応答1ファイルの最大文字数
MAX_HISTORY = 6               # 会話履歴の最大ターン数

_SYSTEM = (
    "あなたは世界トップクラスのコーディングエージェントです（Claude Code / Codex 相当）。"
    "ユーザーの指示に従い、ワークスペースのファイルを作成・編集・削除します。\n"
    "ルール:\n"
    "1. 出力は必ず次の形式の JSON オブジェクトのみ（前後に文章・コードフェンス禁止）:\n"
    '   {"explanation": "何をしたかの日本語の簡潔な説明",'
    ' "files": [{"path": "相対パス", "content": "ファイル全文", "action": "create|update|delete"}]}\n'
    "2. files には変更するファイルだけを含める（変更しないファイルは含めない）。\n"
    "3. create / update の content は差分ではなく**ファイル全文**。省略・中略は禁止。\n"
    "4. delete の場合 content は空文字でよい。\n"
    "5. パスは英数字と . _ / - のみの相対パス（例: index.html, src/app.py）。\n"
    "6. Webアプリは特段の指定が無ければ**単一ファイルの index.html**"
    "（CSS/JSインライン・CDN不使用）として動くものを作る。\n"
    "7. コードは完全で、そのまま動く品質にする。"
)


def _extract_json(text: str) -> dict | None:
    """モデル出力から最初のバランスした JSON オブジェクトを取り出して parse する。
    ```json フェンス・前後の文章・末尾カンマ程度の崩れは許容。失敗時 None。"""
    if not text:
        return None
    s = text.strip()
    # コードフェンスを剥がす
    m = re.search(r"```(?:json)?\s*(.*?)```", s, re.DOTALL)
    if m:
        s = m.group(1).strip()
    # 最初の { から括弧の対応で切り出す（文字列内の {} を考慮）
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    end = -1
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end < 0:
        return None
    frag = s[start:end]
    for candidate in (frag, re.sub(r",\s*([}\]])", r"\1", frag)):  # 末尾カンマ修復
        try:
            obj = json.loads(candidate)
            return obj if isinstance(obj, dict) else None
        except Exception:
            continue
    return None


def _safe_path(path: str) -> str | None:
    """ワークスペース相対の安全なパスだけ許可する。不正は None。"""
    p = (path or "").strip()
    if p.startswith("./"):
        p = p[2:]
    if not p or len(p) > 120:
        return None
    if p.startswith("/") or "\\" in p or ".." in p:
        return None
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", p):
        return None
    if p.count("/") > 6:
        return None
    return p


def _build_prompt(instruction: str, files: list, history: list | None) -> str:
    parts: list[str] = [_SYSTEM, ""]

    # 会話履歴（直近のみ）
    for h in (history or [])[-MAX_HISTORY:]:
        role = "ユーザー" if (h.get("role") == "user") else "エージェント"
        content = str(h.get("content") or "")[:2_000]
        if content:
            parts.append(f"【これまでの{role}】{content}")

    # ワークスペース（小さいファイル優先で合計上限まで）
    listed = []
    total = 0
    fs = [f for f in (files or [])[:MAX_INPUT_FILES] if f.get("path")]
    for f in sorted(fs, key=lambda x: len(str(x.get("content") or ""))):
        content = str(f.get("content") or "")[:MAX_FILE_CHARS]
        if total + len(content) > MAX_TOTAL_CHARS:
            listed.append(f"（{f['path']} は容量制限のため本文省略）")
            continue
        total += len(content)
        listed.append(f"----- {f['path']} -----\n{content}")
    parts.append("【現在のワークスペース】" + ("\n" + "\n\n".join(listed) if listed else "（空）"))

    parts.append(f"【指示】\n{(instruction or '').strip()}")
    parts.append("上記ルールに従い、JSONのみを出力してください。")
    return "\n\n".join(parts)


def generate(instruction: str, files: list, history: list | None = None) -> dict:
    """AIコーディングエージェント本体。
    成功: {"explanation": str, "files": [{"path","content","action"}]}
    失敗: {"error": str}（絶対に raise しない）"""
    if not (instruction or "").strip():
        return {"error": "instruction is required"}
    if llm.active_provider() == "none":
        return {"error": "AI未設定です。Settings → KEYCHAIN で GEMINI_API_KEY か HUGGINGFACE_TOKEN を設定してください。"}

    try:
        text = llm.generate_text(_build_prompt(instruction, files or [], history)) or ""
    except Exception as e:
        return {"error": f"generation failed: {e}"}

    obj = _extract_json(text)
    if not obj:
        return {"error": "モデル出力の解析に失敗しました。もう一度お試しください。"}

    skipped: list[str] = []
    out_files: list[dict] = []
    for f in (obj.get("files") or [])[:MAX_OUTPUT_FILES]:
        if not isinstance(f, dict):
            continue
        path = _safe_path(str(f.get("path") or ""))
        if not path:
            skipped.append(str(f.get("path") or "?"))
            continue
        action = str(f.get("action") or "update").lower()
        if action not in ("create", "update", "delete"):
            action = "update"
        content = "" if action == "delete" else str(f.get("content") or "")
        if len(content) > MAX_OUTPUT_CHARS:
            content = content[:MAX_OUTPUT_CHARS] + "\n/* …長すぎるため切り詰めました… */"
        out_files.append({"path": path, "content": content, "action": action})

    explanation = str(obj.get("explanation") or "").strip()
    if skipped:
        explanation += f"\n（不正なパスのためスキップ: {', '.join(skipped[:5])}）"
    return {"explanation": explanation or "変更を適用しました。", "files": out_files}


# ── スターター（Gemini 不要・即時） ─────────────────────────────────
_WEB_STARTER = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My App</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0a0e14; color:#e8eef5; font-family:system-ui,sans-serif; }
  .card { text-align:center; padding:2.5rem 3rem; border:1px solid #223;
          border-radius:16px; background:#101722; box-shadow:0 0 40px #0af2; }
  h1 { margin:0 0 .5rem; font-size:1.6rem; }
  p  { margin:0; color:#9ab; }
  button { margin-top:1.2rem; padding:.6rem 1.4rem; border-radius:10px;
           border:1px solid #345; background:#16202e; color:#cde; cursor:pointer; }
  button:hover { border-color:#0af; }
</style>
</head>
<body>
  <div class="card">
    <h1>⚡ My App</h1>
    <p>ここから作り始めましょう。</p>
    <button onclick="this.textContent='clicked! ' + (++window.n||(window.n=1))">Click</button>
  </div>
</body>
</html>
"""

_PY_STARTER = '''"""main.py — スターター。"""


def main() -> None:
    print("Hello from THE FORGE OS / CODE mode!")


if __name__ == "__main__":
    main()
'''


def scaffold(kind: str) -> dict:
    """スターターワークスペースを返す。kind: web | python | empty"""
    k = (kind or "empty").lower()
    if k == "web":
        return {"files": [{"path": "index.html", "content": _WEB_STARTER, "action": "create"}]}
    if k == "python":
        return {"files": [
            {"path": "main.py", "content": _PY_STARTER, "action": "create"},
            {"path": "README.md", "content": "# My Project\n\nCODEモードで生成したプロジェクト。\n", "action": "create"},
        ]}
    return {"files": []}
