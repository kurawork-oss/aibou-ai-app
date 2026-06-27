"""
api/evolve.py — セルフ進化モード（チャット指示 → ノーコードで自己拡張）。

ユーザーの「こういう機能が欲しい」という自然言語の指示から、既存のビルディング
ブロック（Forgeアプリ / カスタムAI / 自動化フロー）のどれを作れば実現できるかを
Gemini に判定させ、生成パラメータ付きの「提案」を返す。フロントはその提案を
ワンタップで適用（= 既存エンドポイントを呼んで実体化）できる。

実際のデプロイ済みコードを書き換えるのではなく、ユーザーのワークスペースを
ノーコードで“進化”させる安全な方式。
"""

import json
import re

import config

_SYS = (
    "あなたは『THE FORGE OS』のセルフ進化エンジンです。ユーザーの要望を読み、"
    "次の4種類のうち最も適切な方法で、その要望を実現する設定を提案してください。\n"
    "種別:\n"
    "  - app        : 単発のツール/アプリが欲しい場合（Streamlitアプリを生成）\n"
    "  - custom_ai  : 特定の役割・人格を持つ専用AIが欲しい場合\n"
    "  - automation : 複数ステップの自動処理（生成→通知 等）が欲しい場合\n"
    "  - answer     : 上記で作る必要がなく、説明や助言で十分な場合\n\n"
    "必ず次のJSONだけを ```json ... ``` の中に出力してください。\n"
    "{\n"
    '  "type": "app | custom_ai | automation | answer",\n'
    '  "summary": "何を作るか/答えるかの短い説明(日本語)",\n'
    '  "params": { ... 種別ごとの内容 ... }\n'
    "}\n\n"
    "params の形式:\n"
    '  app        → {"prompt": "Forgeに渡すアプリ生成プロンプト"}\n'
    '  custom_ai  → {"name": "AI名", "persona": "人格/役割", "model": "gemini-2.5-flash", "rules": "厳守ルール(ClaudeMD的)"}\n'
    '  automation → {"name": "自動化名", "steps": [{"type": "ai_generate|notify|create_task", "name": "...", "params": {"prompt or message or title": "...（{input}使用可）"}}]}\n'
    '  answer     → {"text": "ユーザーへの回答(日本語)"}\n'
)


def _extract_json(text: str):
    m = re.search(r"```json\s*(.*?)```", text, re.DOTALL)
    raw = m.group(1).strip() if m else None
    if raw is None:
        s, e = text.find("{"), text.rfind("}")
        raw = text[s:e + 1] if (s != -1 and e != -1 and e > s) else None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def propose(instruction: str) -> dict:
    """指示から「提案（type/summary/params）」を生成する。"""
    instruction = (instruction or "").strip()
    if not instruction:
        return {"error": "instruction is empty"}
    model = config.get_gemini_model()
    if model is None:
        return {"error": "GEMINI_API_KEY is not configured"}
    try:
        resp = model.generate_content(_SYS + "\n\n【ユーザーの要望】\n" + instruction)
        data = _extract_json(getattr(resp, "text", "") or "")
    except Exception as e:
        return {"error": f"generation failed: {e}"}

    if not isinstance(data, dict) or "type" not in data:
        return {"error": "提案の解析に失敗しました", "raw": getattr(resp, "text", "")}

    t = data.get("type")
    if t not in ("app", "custom_ai", "automation", "answer"):
        data["type"] = "answer"
    data.setdefault("summary", "")
    data.setdefault("params", {})
    return data
