# tools.py — /chat に「実際に行動する」力を与える自己完結ツール層
# =====================================================================
# このモジュールは、AIモデルが会話の中で出力する「ツール呼び出しマーカー」を
# 解釈し、実際の副作用（記憶・通知・副業ジョブ投入・ノート保存など）を実行する。
#
# 設計方針（既存 config.py / main.py / agent.py と統一）:
#   * Streamlit / core.py には一切依存しない自己完結版（api/ 内で完結）。
#   * 設定や依存モジュールが欠けていても絶対に crash させず、人間向けの
#     分かりやすい結果文字列を返して優雅に縮退する（graceful degradation）。
#   * 追加認証（Google Sheets / Calendar 等）が必要なツールは含めない。
#     手持ち / 無料で動くもの（記憶・副業・Discord Webhook・ノート）だけを実装する。
#
# マーカープロトコル（既存 agent.py と同方式）:
#   モデルは返答の行頭で次の1行を“正確に”出力する：
#       <<<TOOL_CALL>>>{"tool": "ツール名", "params": { ... }}
#   extract_tool_call() がこれを安全に切り出してパースする。
# =====================================================================

import json
import os

# requests は通知(notify)で使う。未インストールでも import 自体は失敗させない。
try:
    import requests
except Exception:  # pragma: no cover
    requests = None

# 記憶・副業は api/ 内の自己完結モジュール（main.py と同じ参照の仕方）。
from memory_store import mem_add, mem_recall
import income

# vault は「ノート保存」用の任意モジュール。存在しない環境でも落ちないよう遅延的に扱う。
# （api/ 内に vault.py が無い場合は None になり、save_note は Supabase 直書きへ縮退する。）
try:
    import vault  # type: ignore
except Exception:  # pragma: no cover
    vault = None


# === マーカープロトコル =====================================================
# モデルが行頭で出力するツール呼び出しの目印（既存 agent.py と同一文字列）。
TOOL_CALL_MARKER = "<<<TOOL_CALL>>>"


# === ツール説明文（system prompt 用） =======================================
# 各ツールの「名前・用途・params」を箇条書きにした説明。/chat の system prompt に
# 差し込み、モデルにどんな行動が取れるかを伝えるためのドキュメント。
TOOLS_DOC = (
    "【利用可能なツール】\n"
    '- remember: ユーザーが「覚えておいて」と言った事実・好み・重要情報を長期記憶に保存する '
    '/ params: { "content": "覚える内容（例：私の誕生日は6月12日）" }\n'
    '- recall: 長期記憶から過去の事実・文脈を検索して思い出す '
    '/ params: { "query": "思い出したいキーワード" }\n'
    '- enqueue_income: 副業オートメーションにテーマを投入し、各媒体メタデータを生成して承認待ちに積む '
    '/ params: { "theme": "生成テーマ（例：雪のロッジの環境音）" }\n'
    '- income_status: 副業ジョブの状況（承認待ち/承認済/完了/失敗 などの件数）を報告する '
    "/ params: { }\n"
    '- notify: Discord（DISCORD_WEBHOOK 設定時）にメッセージを通知する '
    '/ params: { "message": "送信するメッセージ" }\n'
    '- save_note: ノート（Vault）にメモを保存する。ノートブックが無ければ作成する '
    '/ params: { "notebook": "保存先ノートブック名", "title": "タイトル", "content": "本文" }'
)


# === ツール呼び出しの抽出 ===================================================
def extract_tool_call(text: str):
    """
    テキストから <<<TOOL_CALL>>>{...} を取り出して (call_dict, preface_text) を返す。

    波括弧の深さを数えて“対応する閉じ括弧”まで正確に切り出すため、params に
    入れ子オブジェクトがあっても壊れない。文字列リテラル内の括弧も無視する。

    returns:
        (call_dict or None, preface_text)
        - call_dict : {"tool": ..., "params": {...}} のパース結果。失敗時 None。
        - preface_text : マーカー宣言を取り除いた、ユーザーに見せてよいテキスト。
    """
    text = text or ""
    idx = text.find(TOOL_CALL_MARKER)
    if idx == -1:
        # マーカー無し＝通常の会話。テキストはそのまま preface とする。
        return None, text

    # マーカー以降で最初の '{' を探す（ここから JSON 本体）。
    start = text.find("{", idx)
    if start == -1:
        return None, text

    # 波括弧の対応を数えながら JSON の終端 '}' を見つける。
    depth, end, in_str, esc = 0, -1, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            # 文字列リテラル内：エスケープと閉じクォートだけを見る。
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
                end = i
                break
    if end == -1:
        # 閉じ括弧が見つからない（途中で切れている等）＝呼び出し不成立。
        return None, text

    try:
        call = json.loads(text[start:end + 1])
    except Exception:
        # JSON として壊れている場合は呼び出し無しとして扱う。
        return None, text

    # マーカー＋JSON を取り除いた残りを、人間に見せる preface として整形する。
    visible = (text[:idx] + text[end + 1:]).replace(TOOL_CALL_MARKER, "").strip()
    return call, visible


# === 各ツールの実装（内部ヘルパー） =========================================
def _do_remember(params: dict) -> str:
    """重要な事実を長期記憶（importance=2）として保存する。"""
    content = (params.get("content") or "").strip()
    if not content:
        return "覚える内容が空です。"
    ok = mem_add("fact", content, importance=2)
    if not ok:
        return "記憶を保存できませんでした（記憶ストアが未設定の可能性があります）。"
    return f"覚えました：{content}"


def _do_recall(params: dict) -> str:
    """長期記憶から関連する文脈を想起して返す。"""
    query = (params.get("query") or "").strip()
    block = mem_recall(query)
    return block or "関連する記憶は見つかりませんでした。"


def _do_enqueue_income(params: dict) -> str:
    """副業オートメーションにテーマを投入し、承認待ちジョブとして積む。"""
    theme = (params.get("theme") or "").strip()
    if not theme:
        return "テーマが空です。"
    job = income.enqueue(theme)
    # enqueue は dict を返す（成功時はジョブ、失敗時は {"error": ...}）。
    if isinstance(job, dict):
        if job.get("error"):
            return f"テーマの投入に失敗しました：{job['error']}"
        if job.get("warning"):
            return f"「{theme}」を生成しましたが保存で問題がありました：{job['warning']}"
    return f"「{theme}」を承認待ちジョブとして投入しました。"


def _do_income_status(_params: dict) -> str:
    """副業ジョブをステータス別に集計して文章で報告する。"""
    jobs = income.list_jobs(limit=1000) or []
    if not jobs:
        return "副業ジョブはまだありません（または記憶ストアが未設定です）。"
    counts: dict = {}
    for j in jobs:
        st = (j.get("status") or "unknown").strip() or "unknown"
        counts[st] = counts.get(st, 0) + 1
    total = len(jobs)
    # よく使うステータスは日本語ラベルで読みやすく表示する。
    labels = {
        "pending": "承認待ち",
        "approved": "承認済",
        "rejected": "却下",
        "completed": "完了",
        "failed": "失敗",
    }
    parts = []
    for key, label in labels.items():
        if counts.get(key):
            parts.append(f"{label} {counts[key]}件")
    # 既知ラベル外のステータスもこぼさず加える。
    for key, n in counts.items():
        if key not in labels:
            parts.append(f"{key} {n}件")
    detail = "、".join(parts) if parts else "内訳なし"
    return f"副業ジョブの状況：合計 {total}件（{detail}）。"


def _do_notify(params: dict) -> str:
    """Discord Webhook（DISCORD_WEBHOOK）へメッセージを送る。未設定ならその旨を返す。"""
    message = (params.get("message") or "").strip()
    if not message:
        return "送信するメッセージが空です。"
    if requests is None:
        return "requests がインストールされていないため通知を送れません。"
    url = (os.environ.get("DISCORD_WEBHOOK") or "").strip()
    if not url:
        return "DISCORD_WEBHOOK が未設定のため通知を送れませんでした。"
    try:
        requests.post(url, json={"content": message[:1900]}, timeout=30)
        return "Discord に通知を送信しました。"
    except Exception as e:
        return f"通知の送信に失敗しました：{e}"


def _do_save_note(params: dict) -> str:
    """ノート（Vault）にメモを保存する。
    vault モジュールがあれば create_notebook（無ければ既存検索）→ add_text を使う。
    vault が無い環境では Supabase の vault_notebooks へ直接書き込んで縮退する。"""
    notebook = (params.get("notebook") or "").strip() or "Inbox"
    title = (params.get("title") or "").strip() or "無題"
    content = (params.get("content") or "").strip()
    if not content:
        return "保存する本文が空です。"

    # 1) vault モジュールがあればそれを使う（仕様どおりの優先パス）。
    if vault is not None:
        try:
            nb_id = None
            # 既存ノートブックを探す（list_notebooks があれば名前一致で再利用）。
            if hasattr(vault, "list_notebooks"):
                for nb in (vault.list_notebooks() or []):
                    name = nb.get("name") if isinstance(nb, dict) else getattr(nb, "name", None)
                    if name == notebook:
                        nb_id = nb.get("id") if isinstance(nb, dict) else getattr(nb, "id", None)
                        break
            # 無ければ作成する。
            if nb_id is None and hasattr(vault, "create_notebook"):
                created = vault.create_notebook(notebook)
                nb_id = created.get("id") if isinstance(created, dict) else getattr(created, "id", created)
            # 本文を追記する。
            if hasattr(vault, "add_text"):
                if nb_id is not None:
                    vault.add_text(nb_id, title, content)
                else:
                    vault.add_text(notebook, title, content)
                return f"ノート「{notebook}」に保存しました：{title}"
        except Exception as e:
            return f"ノート保存に失敗しました（vault）: {e}"

    # 2) フォールバック：Supabase の vault_notebooks へ直接1行追加する。
    try:
        import config
        c = config.get_supabase()
        if not c:
            return "ノートを保存できませんでした（Vault も Supabase も未設定です）。"
        c.table("vault_notebooks").insert({
            "name": notebook,
            "docs": {title: content},
            "chat": [],
        }).execute()
        return f"ノート「{notebook}」に保存しました：{title}"
    except Exception as e:
        return f"ノート保存に失敗しました（vault_notebooks テーブル未作成の可能性）: {e}"


# ツール名 → 実装関数のディスパッチ表。
_DISPATCH = {
    "remember": _do_remember,
    "recall": _do_recall,
    "enqueue_income": _do_enqueue_income,
    "income_status": _do_income_status,
    "notify": _do_notify,
    "save_note": _do_save_note,
}


# === ツール実行のエントリポイント ===========================================
def execute_tool(name: str, params: dict) -> str:
    """選択されたツールを実行し、人間向けの結果文字列を返す。絶対に raise しない。"""
    params = params or {}
    handler = _DISPATCH.get((name or "").strip())
    if handler is None:
        return f"不明なツールです：{name}"
    try:
        return handler(params)
    except Exception as e:
        # どのツールでも、想定外の例外は結果文字列に丸めて返す（crash させない）。
        return f"ツール実行エラー（{name}）：{e}"
