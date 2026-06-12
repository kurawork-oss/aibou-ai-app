# agent.py — AIbou Agent Engine
# =================================================================
# AIbou（相棒AI）の頭脳。
#   1) get_ai_response() : Gemini / Claude / Grok / OpenAI を
#      ユーザーが入れたAPIキーに応じて切り替える「統一インターフェース」
#   2) run_agent()       : 会話だけでなく「カレンダー登録・タスク更新・
#      通知・Web検索」などの“ツール”を実際に実行するエージェントループ
#
# 【このアプリ特有の事情】
# app.py → core.py → 各 view を exec() で読み込む構造のため、
# agent.py は「独立した普通のモジュール」として実装し、core.py 側の道具
# （Googleカレンダー / スプレッドシート / Supabase）は register_services()
# で“後から注入”する形にしている（循環インポートを避けるため）。
# =================================================================

import os
import json
import datetime

import streamlit as st

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

try:
    import google.generativeai as genai
    GENAI_AVAILABLE = True
except Exception:
    GENAI_AVAILABLE = False

try:
    import key_manager
    KEY_MANAGER_AVAILABLE = True
except Exception:
    KEY_MANAGER_AVAILABLE = False

try:
    import memory as _memory
    MEMORY_AVAILABLE = True
except Exception:
    MEMORY_AVAILABLE = False


# === 外部サービス（core.py から注入される道具箱） ============================
_SERVICES = {}


def register_services(**kwargs):
    """core.py 側で定義した道具（sheet / calendar / supabase 等）を登録する。"""
    _SERVICES.update(kwargs)


# === APIキー取得（Vault → 環境変数 → Streamlit Secrets の順にフォールバック）===
def _get_key(*names):
    """与えられた候補名（複数表記に対応）でキーを探す。"""
    keys = st.session_state.get("global_api_keys", {}) or {}
    for n in names:
        if keys.get(n):
            return keys[n]
    for n in names:
        if os.environ.get(n):
            return os.environ[n]
    try:
        for n in names:
            if n in st.secrets and st.secrets[n]:
                return st.secrets[n]
    except Exception:
        pass
    return ""


def _resolve_purpose(purpose):
    """用途(purpose)に割り当てられたキーを (provider, key) で返す。未割り当ては (None, '')。
    解決順：アプリ内Vault の key_slots → 環境変数の用途別キー。"""
    if not purpose or not KEY_MANAGER_AVAILABLE:
        return None, ""
    try:
        slots = st.session_state.get("key_slots", {}) or {}
    except Exception:
        slots = {}
    prov, key = key_manager.resolve_from_slots(slots, purpose)
    if key:
        return prov, key
    ek = key_manager.env_key(purpose)
    if ek:
        return key_manager.purpose_provider(purpose), ek
    return None, ""


# === メッセージ整形ヘルパー =================================================
def _to_messages(prompt_or_messages):
    """文字列1本でも OpenAI互換の messages 配列でも受け取れるようにする。"""
    if isinstance(prompt_or_messages, str):
        return [{"role": "user", "content": prompt_or_messages}]
    return list(prompt_or_messages or [])


def _split_system(messages):
    """system ロールを抜き出し、(systemテキスト, 残りの会話) を返す。"""
    system_parts, convo = [], []
    for m in messages:
        if m.get("role") == "system":
            system_parts.append(m.get("content", ""))
        else:
            convo.append(m)
    return "\n".join([s for s in system_parts if s]).strip(), convo


def _flatten(messages):
    """Gemini 用：会話を1本のプロンプト文字列に畳む。"""
    return "\n\n".join([f"{m.get('role', 'user')}: {m.get('content', '')}" for m in messages])


# === 各プロバイダ呼び出し ====================================================
def _call_gemini(messages, api_key, model=None):
    if not GENAI_AVAILABLE:
        return "⚠️ google-generativeai がインストールされていません。"
    genai.configure(api_key=api_key)
    use_model = model if (model and str(model).startswith("gemini")) else "gemini-2.5-flash"
    system, convo = _split_system(messages)
    prompt = ((system + "\n\n") if system else "") + _flatten(convo)
    return genai.GenerativeModel(use_model).generate_content(prompt).text


def _call_claude(messages, api_key, model=None):
    if requests is None:
        return "⚠️ requests がインストールされていません。"
    system, convo = _split_system(messages)
    payload = {
        "model": model if (model and "claude" in str(model)) else "claude-sonnet-4-6",
        "max_tokens": 2000,
        "messages": [
            {"role": ("assistant" if m.get("role") == "assistant" else "user"),
             "content": m.get("content", "")}
            for m in convo
        ],
    }
    if system:
        payload["system"] = system
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json=payload, timeout=60,
    )
    data = r.json()
    if "content" in data:
        return "".join([blk.get("text", "") for blk in data["content"] if blk.get("type") == "text"]) or str(data)
    return f"⚠️ Claudeエラー: {data}"


def _call_openai_like(messages, api_key, base_url, model):
    if requests is None:
        return "⚠️ requests がインストールされていません。"
    msgs = [
        {"role": ("system" if m.get("role") == "system"
                  else "assistant" if m.get("role") == "assistant" else "user"),
         "content": m.get("content", "")}
        for m in messages
    ]
    r = requests.post(
        base_url,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": model, "messages": msgs, "max_tokens": 2000}, timeout=60,
    )
    data = r.json()
    try:
        return data["choices"][0]["message"]["content"]
    except Exception:
        return f"⚠️ APIエラー: {data}"


def get_ai_response(prompt_or_messages, tools=None, model=None, provider=None, purpose=None):
    """
    Settings(Secure Vault)で設定されたAPIキーに応じてAIを切り替えて呼び出す。
    優先順位: 用途別キー(purpose) → 明示provider → Gemini → Claude → Grok → OpenAI
    - prompt_or_messages: 文字列 or [{"role": "...", "content": "..."}]
    - purpose: 用途ID（例 "income_gen"）。割り当て済みなら専用キーを最優先で使う。
    - 返り値は常に文字列（例外時もエラーメッセージ文字列を返し、絶対にraiseしない）
    """
    messages = _to_messages(prompt_or_messages)
    gemini = _get_key("gemini", "GEMINI_API_KEY")
    claude = _get_key("anthropic", "ANTHROPIC_API_KEY")
    grok = _get_key("grok", "GROK_API_KEY")
    openai_key = _get_key("openai", "OPENAI_API_KEY")

    chosen = provider or st.session_state.get("ai_provider")
    try:
        # 用途別キー（マルチアカウント）が割り当てられていれば最優先で使う
        fp, fk = _resolve_purpose(purpose)
        if fk:
            if fp in ("claude", "anthropic"):
                return _call_claude(messages, fk, model)
            if fp == "grok":
                return _call_openai_like(messages, fk, "https://api.x.ai/v1/chat/completions",
                                         model if (model and "grok" in str(model)) else "grok-3")
            if fp == "openai":
                return _call_openai_like(messages, fk, "https://api.openai.com/v1/chat/completions",
                                         model if (model and "gpt" in str(model)) else "gpt-4o")
            return _call_gemini(messages, fk, model)
        # 明示的にプロバイダ指定がある場合はそれを優先
        if chosen == "gemini" and gemini:
            return _call_gemini(messages, gemini, model)
        if chosen == "claude" and claude:
            return _call_claude(messages, claude, model)
        if chosen == "grok" and grok:
            return _call_openai_like(messages, grok, "https://api.x.ai/v1/chat/completions",
                                     model if (model and "grok" in str(model)) else "grok-3")
        if chosen == "openai" and openai_key:
            return _call_openai_like(messages, openai_key, "https://api.openai.com/v1/chat/completions",
                                     model if (model and "gpt" in str(model)) else "gpt-4o")

        # 自動フォールバック（持っているキーで一番優先度の高いものを使う）
        if gemini:
            return _call_gemini(messages, gemini, model)
        if claude:
            return _call_claude(messages, claude, model)
        if grok:
            return _call_openai_like(messages, grok, "https://api.x.ai/v1/chat/completions", "grok-3")
        if openai_key:
            return _call_openai_like(messages, openai_key, "https://api.openai.com/v1/chat/completions", "gpt-4o")
        return "⚠️ AIのAPIキーが設定されていません。Settings → Secure Vault で設定してください。"
    except Exception as e:
        return f"⚠️ AI呼び出しエラー: {e}"


# === ツール定義 =============================================================
# requires_confirmation=True のツールは「外部に作用する操作」。
# run_agent はこれらを即実行せず、UI側（HUB）に承認を委ねる。
TOOLS = [
    {
        "name": "create_calendar_event",
        "description": "Googleカレンダーに予定を追加する",
        "requires_confirmation": True,
        "parameters": {
            "title": "予定のタイトル",
            "start_datetime": "開始日時（ISO8601形式、例：2026-06-06T10:00:00+09:00）",
            "end_datetime": "終了日時（ISO8601形式）",
            "description": "説明（任意）",
        },
    },
    {
        "name": "send_notification",
        "description": "LINE・Discordに通知メッセージを送る",
        "requires_confirmation": True,
        "parameters": {
            "message": "送信するメッセージ",
            "channel": "送信先（line または discord）",
        },
    },
    {
        "name": "update_task_status",
        "description": "Google Sheetsのタスクステータスを更新する",
        "requires_confirmation": False,
        "parameters": {
            "task_id": "タスクID",
            "new_status": "新しいステータス（未着手/実行中/確認待ち/完了）",
            "log_message": "ログメッセージ（任意）",
        },
    },
    {
        "name": "save_to_vault",
        "description": "Document Vault(Supabase)にメモやドキュメントを保存する",
        "requires_confirmation": False,
        "parameters": {
            "notebook_name": "保存先ノートブック名",
            "title": "ドキュメントタイトル",
            "content": "保存するテキスト内容",
        },
    },
    {
        "name": "web_search",
        "description": "最新情報をWeb検索する（Grok APIが必要）",
        "requires_confirmation": False,
        "parameters": {
            "query": "検索クエリ",
        },
    },
    {
        "name": "create_task",
        "description": "新しいタスクを作成して『現在のタスク』(Google Sheets)に追加する",
        "requires_confirmation": False,
        "parameters": {
            "goal": "目標/プロジェクト名",
            "content": "タスク内容",
        },
    },
    {
        "name": "list_tasks",
        "description": "現在のタスク一覧（ステータス付き）を取得して報告する",
        "requires_confirmation": False,
        "parameters": {
            "status_filter": "絞り込むステータス（任意：未着手/実行中/確認待ち/完了）",
        },
    },
    {
        "name": "enqueue_income_theme",
        "description": "副業オートメーション(Auto Income)にテーマを投入し、各媒体メタデータを生成して承認待ちInboxに追加する",
        "requires_confirmation": False,
        "parameters": {
            "theme": "生成テーマ（例：雪のロッジの環境音）",
        },
    },
    {
        "name": "generate_app",
        "description": "要望から単一ファイルのStreamlitミニアプリを生成し、App Archiveに保存する（後でApp Archiveから起動）",
        "requires_confirmation": False,
        "parameters": {
            "description": "作りたいアプリの説明（例：割り勘計算アプリ）",
        },
    },
    {
        "name": "search_vault",
        "description": "Document Vault(保存済みメモ/ノート)を検索して該当内容を返す",
        "requires_confirmation": False,
        "parameters": {
            "query": "検索キーワード（空なら全件の概要）",
        },
    },
    {
        "name": "approve_income",
        "description": "Auto Income の承認待ちアセットを一括承認し、配信キューへ送る",
        "requires_confirmation": True,
        "parameters": {},
    },
    {
        "name": "income_status",
        "description": "Auto Income の状況（承認待ち/承認済/完了/失敗の件数と概算収益）を報告する",
        "requires_confirmation": False,
        "parameters": {},
    },
    {
        "name": "remember",
        "description": "ユーザーが『覚えておいて』と言った事実・好み・重要情報を長期記憶に保存する",
        "requires_confirmation": False,
        "parameters": {
            "content": "覚える内容（例：私の誕生日は6月12日）",
        },
    },
    {
        "name": "recall",
        "description": "長期記憶から過去の事実・文脈を検索して思い出す",
        "requires_confirmation": False,
        "parameters": {
            "query": "思い出したいキーワード",
        },
    },
]

CONFIRM_TOOLS = {t["name"] for t in TOOLS if t.get("requires_confirmation")}


def _tool(name):
    for t in TOOLS:
        if t["name"] == name:
            return t
    return None


# === ツール実行 =============================================================
def execute_tool(tool_name, params):
    """AIが選択したツールを実際に実行して結果（文字列）を返す。絶対にraiseしない。"""
    params = params or {}
    try:
        if tool_name == "create_calendar_event":
            get_calendar_service = _SERVICES.get("get_calendar_service")
            create_calendar_event = _SERVICES.get("create_calendar_event")
            if not (get_calendar_service and create_calendar_event):
                return "❌ カレンダー機能が初期化されていません。"
            cal_json = _get_key("google_calendar", "GOOGLE_CREDENTIALS")
            service = get_calendar_service(cal_json)
            if not service:
                return "❌ カレンダー連携が未設定です。Settings → Secure Vault で Google Calendar JSON を登録してください。"
            ok = create_calendar_event(
                service, params.get("title", ""),
                params.get("start_datetime", ""), params.get("end_datetime", ""),
            )
            return (f"✅ カレンダーに追加しました：{params.get('title', '')}"
                    if ok else "❌ カレンダーへの追加に失敗しました")

        if tool_name == "update_task_status":
            sheet = _SERVICES.get("sheet")
            if not sheet:
                return "❌ スプレッドシートに接続されていません。"
            all_tasks = sheet.get_all_values()
            for i, row in enumerate(all_tasks[1:], start=2):
                if row and row[0] == params.get("task_id"):
                    sheet.update_cell(i, 4, params.get("new_status", ""))
                    if params.get("log_message"):
                        sheet.update_cell(i, 5, params["log_message"])
                    return f"✅ タスク {params.get('task_id')} を「{params.get('new_status')}」に更新しました"
            return f"❌ タスクID {params.get('task_id')} が見つかりません"

        if tool_name == "send_notification":
            if requests is None:
                return "⚠️ requests がインストールされていません。"
            channel = (params.get("channel") or "discord").lower()
            if channel == "line":
                url = _get_key("line_webhook", "LINE_WEBHOOK")
            else:
                url = _get_key("discord_webhook", "DISCORD_WEBHOOK")
            if not url:
                return f"⚠️ {channel} のWebhook URLが未設定です。Settings → Secure Vault で設定してください。"
            requests.post(url, json={"content": params.get("message", "")}, timeout=30)
            return f"✅ {channel} に通知を送信しました"

        if tool_name == "save_to_vault":
            supabase = _SERVICES.get("supabase")
            if not supabase:
                return "⚠️ Supabase未接続のため保存できませんでした。"
            try:
                supabase.table("vault_notebooks").insert({
                    "name": params.get("notebook_name", ""),
                    "docs": {params.get("title", ""): params.get("content", "")},
                    "chat": [],
                }).execute()
                return f"✅ Vault「{params.get('notebook_name')}」に保存しました：{params.get('title')}"
            except Exception as e:
                return f"⚠️ Vault保存に失敗しました（vault_notebooksテーブル未作成の可能性）: {e}"

        if tool_name == "web_search":
            if requests is None:
                return "⚠️ requests がインストールされていません。"
            grok = _get_key("grok", "GROK_API_KEY")
            if not grok:
                return "⚠️ Grok APIキーが未設定です。Web検索にはGrok APIキーが必要です。"
            r = requests.post(
                "https://api.x.ai/v1/chat/completions",
                headers={"Authorization": f"Bearer {grok}", "Content-Type": "application/json"},
                json={
                    "model": "grok-3",
                    "messages": [{"role": "user", "content": f"以下について最新情報を教えてください：{params.get('query', '')}"}],
                    "max_tokens": 1000,
                }, timeout=60,
            )
            return r.json()["choices"][0]["message"]["content"]

        if tool_name == "create_task":
            sheet = _SERVICES.get("sheet")
            if not sheet:
                return "❌ スプレッドシートに接続されていません。"
            if not hasattr(sheet, "append_row"):
                return "⚠️ このスプレッドシートは追記に未対応です（GOOGLE_CREDENTIALS を確認）。"
            tid = "T-" + datetime.datetime.now().strftime("%m%d%H%M%S")
            sheet.append_row([tid, params.get("goal", ""), params.get("content", ""), "未着手", "", ""])
            return f"✅ タスクを作成しました（ID: {tid}）：{params.get('content', '')}"

        if tool_name == "list_tasks":
            sheet = _SERVICES.get("sheet")
            if not sheet:
                return "❌ スプレッドシートに接続されていません。"
            rows = sheet.get_all_values()[1:]
            flt = (params.get("status_filter") or "").strip()
            out = []
            for r in rows:
                r = (list(r) + [""] * 6)[:6]
                if flt and r[3] != flt:
                    continue
                out.append(f"[{r[0]}] {r[2]} — {r[3]}")
            return ("現在のタスク：\n" + "\n".join(out[:30])) if out else "該当するタスクはありません。"

        if tool_name == "enqueue_income_theme":
            try:
                import income_engine
            except Exception:
                return "⚠️ income_engine を読み込めませんでした。"
            _job, _msg = income_engine.enqueue_theme(params.get("theme", ""))
            return _msg

        if tool_name == "generate_app":
            desc = (params.get("description") or "").strip()
            if not desc:
                return "❌ 作りたいアプリの説明が必要です。"
            sysp = ("あなたはStreamlitアプリ職人です。以下の要望から、単一ファイルで完結する"
                    "Streamlitミニアプリのコードだけを出力してください。説明・前置き・コードフェンスは不要。"
                    "使用可能ライブラリは streamlit(as st) / pandas(as pd) / datetime / time / os / json のみ。")
            code = get_ai_response(sysp + "\n\n【要望】\n" + desc) or ""
            code = code.replace("```python", "").replace("```", "").strip()
            if not code or code.startswith("⚠️"):
                return "❌ コード生成に失敗しました（AIキーを確認してください）。"
            import re as _re
            name = (_re.sub(r"[^a-z0-9]+", "_", desc.lower())[:30].strip("_")) or "app"
            os.makedirs("forge_apps", exist_ok=True)
            with open(os.path.join("forge_apps", f"{name}.py"), "w", encoding="utf-8") as f:
                f.write(code)
            return f"✅ ミニアプリ「{name}」を生成し App Archive に保存しました（App Archive から起動できます）。"

        if tool_name == "search_vault":
            supabase = _SERVICES.get("supabase")
            if not supabase:
                return "⚠️ Supabase未接続のため検索できません。"
            q = (params.get("query") or "").lower()
            rows = supabase.table("vault_notebooks").select("name,docs").execute().data or []
            hits = []
            for r in rows:
                docs = r.get("docs") or {}
                if isinstance(docs, dict):
                    for title, content in docs.items():
                        if not q or q in f"{title} {content}".lower():
                            hits.append(f"📓 {r.get('name','')} / {title}: {str(content)[:200]}")
            return ("Vault検索結果：\n" + "\n".join(hits[:10])) if hits else "該当するメモは見つかりませんでした。"

        if tool_name == "approve_income":
            try:
                import income_engine
            except Exception:
                return "⚠️ income_engine を読み込めませんでした。"
            n = income_engine.approve_all_pending()
            return f"✅ 承認待ちの {n} 件を承認し、配信キューに送りました。"

        if tool_name == "income_status":
            try:
                import income_engine
                s = income_engine.system_status() or {}
                c = s.get("counts", {}) or {}
                rev = (income_engine.get_stats() or {}).get("revenue", {}) or {}
                total = sum(v for v in rev.values() if isinstance(v, (int, float)))
                return (f"💰 Auto Income：承認待ち {c.get('pending',0)} / 承認済 {c.get('approved',0)} / "
                        f"完了 {c.get('completed',0)} / 失敗 {c.get('failed',0)}。今月収益(概算) ¥{total:,.0f}")
            except Exception as e:
                return f"❌ 状況取得に失敗: {e}"

        if tool_name == "remember":
            if not MEMORY_AVAILABLE:
                return "⚠️ 記憶機能が利用できません。"
            _memory.add("fact", params.get("content", ""), importance=2)
            return f"🧠 覚えました：{params.get('content', '')}"

        if tool_name == "recall":
            if not MEMORY_AVAILABLE:
                return "⚠️ 記憶機能が利用できません。"
            r = _memory.retrieve(params.get("query", ""))
            return r or "関連する記憶は見つかりませんでした。"

        return f"❌ 不明なツール: {tool_name}"
    except Exception as e:
        return f"❌ ツール実行エラー（{tool_name}）: {e}"


# === エージェントループ =====================================================
TOOL_CALL_MARKER = "<<<TOOL_CALL>>>"


def _extract_tool_call(text):
    """
    テキストから <<<TOOL_CALL>>>{...} を取り出す。
    波括弧の深さを数えて“対応する閉じ括弧”まで正確に切り出すため、
    params に入れ子のオブジェクトがあっても壊れない。
    returns: (call_dict or None, ツール宣言を除いた表示用テキスト)
    """
    idx = text.find(TOOL_CALL_MARKER)
    if idx == -1:
        return None, text
    start = text.find("{", idx)
    if start == -1:
        return None, text

    depth, end, in_str, esc = 0, -1, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
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
        return None, text

    try:
        call = json.loads(text[start:end + 1])
    except Exception:
        return None, text

    visible = (text[:idx] + text[end + 1:]).replace(TOOL_CALL_MARKER, "").strip()
    return call, visible


def _tools_doc():
    lines = []
    for t in TOOLS:
        ps = ", ".join([f'"{k}"' for k in t["parameters"].keys()])
        flag = "（要・承認）" if t.get("requires_confirmation") else ""
        lines.append(f'- {t["name"]}{flag}: {t["description"]} / params: {{ {ps} }}')
    return "\n".join(lines)


def _build_system_prompt():
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S (%a)")
    return (
        "あなたはAIbou（相棒AI）です。ユーザーの秘書・参謀として、会話するだけでなく、"
        "カレンダー登録・タスク管理・通知送信・情報収集など、実際の行動を実行できます。\n\n"
        f"現在時刻: {now}\n\n"
        "【利用可能なツール】\n" + _tools_doc() + "\n\n"
        "【ツールの使い方（厳守）】\n"
        "ツールを使いたいときは、返答の中に次の1行を“正確に”出力してください：\n"
        '<<<TOOL_CALL>>>{"tool": "ツール名", "params": { ... }}\n'
        "- 日時は必ずISO8601（例：2026-06-06T10:00:00+09:00、タイムゾーンは+09:00）で指定すること。\n"
        "- 「予定を追加して」「アポを入れて」等、行動を明確に頼まれたときだけツールを使うこと。\n"
        "- 普段の雑談や質問では絶対にTOOL_CALLを出力しないこと。\n"
        "- ツールの実行結果は <<<TOOL_RESULT>>> として渡されるので、それを踏まえて簡潔な日本語で"
        "報告し、必要なら次のアクションを提案すること。\n"
        "- 絵文字は控えめに、冷静で端的なトーンを維持すること。"
    )


def run_agent(user_input, chat_history=None):
    """
    ユーザー入力を受け取り、必要に応じてツールを実行して最終応答を返す。
    returns: (最終応答テキスト, 更新されたchat_history, pending_action or None)

    pending_action は「外部に作用する操作（承認が必要なツール）」が要求されたときに
    返される {"tool": ..., "params": ...} の辞書。呼び出し側(HUB)が承認UIを出し、
    承認後に execute_tool() を呼ぶことで“承認ゲート”を実現する。
    """
    chat_history = chat_history or []
    sys_content = _build_system_prompt()
    # ユーザー設定ルール（アプリ内で設定・常時適用＝CLAUDE rules的）
    try:
        _rules = (st.session_state.get("user_rules") or "").strip()
        if _rules:
            sys_content += "\n\n【ユーザー設定ルール（常に厳守）】\n" + _rules
    except Exception:
        pass
    if MEMORY_AVAILABLE:
        try:
            _mem = _memory.retrieve(user_input)
            if _mem:
                sys_content += "\n\n" + _mem + "\n（上記の記憶を踏まえ、必要に応じて自然に参照して応答すること。）"
        except Exception:
            pass
    messages = ([{"role": "system", "content": sys_content}]
                + [{"role": m.get("role"), "content": m.get("content", "")} for m in chat_history
                   if m.get("role") in ("user", "assistant")]
                + [{"role": "user", "content": user_input}])

    final_text = ""
    pending = None

    for _ in range(4):  # 最大4ステップのツールループ
        ai_text = get_ai_response(messages) or ""
        call, preface = _extract_tool_call(ai_text)
        if not call:
            final_text = preface
            break

        tool_name = call.get("tool")
        tool_params = call.get("params", {}) or {}

        # 外部に作用するツールは即実行せず、承認をUIに委ねる
        if tool_name in CONFIRM_TOOLS:
            pending = {"tool": tool_name, "params": tool_params}
            final_text = preface or "この操作を実行してよろしいですか？"
            break

        # 安全なツール（読み取り・内部データ）は即実行し、結果を会話に戻す
        result = execute_tool(tool_name, tool_params)
        messages.append({"role": "assistant", "content": ai_text})
        messages.append({"role": "user", "content": f"<<<TOOL_RESULT>>> {result}"})
        final_text = (preface + "\n\n" + result).strip() if preface else result

    final_text = (final_text or "").replace(TOOL_CALL_MARKER, "").strip()
    # 長期記憶へ会話を保存（次回以降の文脈として想起される）
    if MEMORY_AVAILABLE:
        try:
            _memory.add("user", user_input)
            if final_text:
                _memory.add("assistant", final_text)
        except Exception:
            pass
    updated_history = chat_history + [
        {"role": "user", "content": user_input},
        {"role": "assistant", "content": final_text},
    ]
    return final_text, updated_history, pending


def describe_pending(pending):
    """承認待ちアクションを人間に分かりやすい文字列にする（UI表示用）。"""
    if not pending:
        return ""
    tool, p = pending.get("tool"), pending.get("params", {})
    if tool == "create_calendar_event":
        return (f"📅 カレンダーに予定を登録します\n\n"
                f"**{p.get('title', '(無題)')}**\n"
                f"開始: {p.get('start_datetime', '')}\n終了: {p.get('end_datetime', '')}")
    if tool == "send_notification":
        return (f"📨 {p.get('channel', 'discord')} に通知を送信します\n\n{p.get('message', '')}")
    return f"{tool} を実行します"
