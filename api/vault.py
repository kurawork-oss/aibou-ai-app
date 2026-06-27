# vault.py — Document Vault（資料ノートブック）のRAGロジック（絶対にcrashしない）
# =====================================================================
# ユーザーがアップロードしたテキスト資料を「ノートブック」単位で蓄え、
# その資料”だけ”を根拠にGeminiへ質問するシンプルなRAG（検索拡張生成）。
#
# Streamlit / core.py には一切依存しない自己完結モジュール。設定（Supabase /
# Gemini）が欠けていても例外を出さず、空リスト / エラーdict で優雅に縮退する。
#
# Supabase テーブル vault_notebooks（supabase_schema.sql 参照）:
#   id    uuid    primary key default gen_random_uuid()
#   name  text    not null
#   docs  jsonb   default '{}'::jsonb   … {タイトル: 本文} のマップ
#   chat  jsonb   default '[]'::jsonb   … 質問応答の履歴（将来拡張用）
#   created_at timestamptz default now()
# =====================================================================

import re

import config


def list_notebooks() -> list:
    """ノートブック一覧を [{id, name, doc_count}] で返す。
    新しい順（created_at降順）→ 同着は name 昇順。
    Supabaseが無ければ []（絶対にraiseしない）。"""
    c = config.get_supabase()
    if not c:
        return []
    try:
        rows = (c.table("vault_notebooks")
                .select("id,name,docs,created_at")
                .order("created_at", desc=True)
                .order("name", desc=False)
                .limit(1000)
                .execute().data) or []
    except Exception:
        return []

    result = []
    for r in rows:
        docs = r.get("docs") or {}
        # docs は jsonb のマップ想定。万一マップでなければ件数0扱い。
        doc_count = len(docs) if isinstance(docs, dict) else 0
        result.append({
            "id": r.get("id"),
            "name": r.get("name") or "",
            "doc_count": doc_count,
        })
    return result


def create_notebook(name: str) -> dict:
    """ノートブックを1件作成し {id, name} を返す。
    名前が空、またはSupabase未設定/失敗時は error dict を返す（絶対にraiseしない）。"""
    name = (name or "").strip()
    if not name:
        return {"error": "name is empty"}
    c = config.get_supabase()
    if not c:
        return {"error": "vault unavailable (Supabase not configured)"}
    try:
        res = (c.table("vault_notebooks")
               .insert({"name": name, "docs": {}, "chat": []})
               .execute())
        row = (res.data or [{}])[0]
        return {"id": row.get("id"), "name": row.get("name") or name}
    except Exception as e:
        return {"error": f"create failed: {e}"}


def add_text(notebook_id: str, title: str, content: str) -> dict:
    """対象ノートブックの docs(jsonb) に {title: content} をマージしてupdateする。
    成功で {ok: True}。引数不足・未設定・失敗時は error dict（絶対にraiseしない）。"""
    notebook_id = (notebook_id or "").strip()
    title = (title or "").strip()
    content = content or ""
    if not notebook_id:
        return {"error": "notebook_id is empty"}
    if not title:
        return {"error": "title is empty"}
    c = config.get_supabase()
    if not c:
        return {"error": "vault unavailable (Supabase not configured)"}
    try:
        # 既存 docs を読み込み、新しい資料をマージ（同名タイトルは上書き）。
        rows = (c.table("vault_notebooks")
                .select("docs")
                .eq("id", notebook_id)
                .limit(1)
                .execute().data) or []
        if not rows:
            return {"error": "notebook not found"}
        docs = rows[0].get("docs") or {}
        if not isinstance(docs, dict):
            docs = {}
        docs[title] = content
        c.table("vault_notebooks").update({"docs": docs}).eq("id", notebook_id).execute()
        return {"ok": True}
    except Exception as e:
        return {"error": f"add_text failed: {e}"}


def query(notebook_id: str, question: str) -> dict:
    """ノートブックの全資料を連結し、その資料”だけ”を根拠にGeminiへ日本語で質問する。
    {answer: str} を返す。資料が無ければ案内文、未設定/失敗時は error dict
    （絶対にraiseしない）。"""
    notebook_id = (notebook_id or "").strip()
    question = (question or "").strip()
    if not notebook_id:
        return {"error": "notebook_id is empty"}
    if not question:
        return {"error": "question is empty"}

    c = config.get_supabase()
    if not c:
        return {"error": "vault unavailable (Supabase not configured)"}

    # 対象ノートブックの資料を取得
    try:
        rows = (c.table("vault_notebooks")
                .select("docs")
                .eq("id", notebook_id)
                .limit(1)
                .execute().data) or []
    except Exception as e:
        return {"error": f"query failed: {e}"}
    if not rows:
        return {"error": "notebook not found"}

    docs = rows[0].get("docs") or {}
    if not isinstance(docs, dict):
        docs = {}

    # タイトル付きで全資料を連結（本文が空のものは除外）
    parts = []
    for title, content in docs.items():
        body = (content or "").strip() if isinstance(content, str) else str(content or "").strip()
        if body:
            parts.append(f"## {title}\n{body}")
    context = "\n\n".join(parts).strip()

    # 資料が無ければGeminiを呼ばず案内文を返す
    if not context:
        return {"answer": "このノートブックにはまだ資料が登録されていません。先に資料を追加してください。"}

    model = config.get_gemini_model()
    if model is None:
        return {"error": "GEMINI_API_KEY is not configured"}

    # この資料のみに基づき日本語で回答するよう厳密に指示するプロンプト
    prompt = (
        "あなたは資料に基づいて回答するアシスタントです。"
        "以下の【資料】に書かれている情報”だけ”を根拠に、日本語で簡潔かつ正確に回答してください。"
        "資料に答えが書かれていない場合は推測せず、「資料には記載がありません」と答えてください。\n\n"
        f"【資料】\n{context}\n\n"
        f"【質問】\n{question}\n\n"
        "【回答】\n"
    )
    try:
        resp = model.generate_content(prompt)
        return {"answer": getattr(resp, "text", "") or ""}
    except Exception as e:
        return {"error": f"generation failed: {e}"}


def _load_context(notebook_id: str):
    """ノートブックの全資料を「## タイトル\\n本文」で連結して返す。
    (context, error_dict) のタプル。error_dict が None なら成功。"""
    notebook_id = (notebook_id or "").strip()
    if not notebook_id:
        return None, {"error": "notebook_id is empty"}
    c = config.get_supabase()
    if not c:
        return None, {"error": "vault unavailable (Supabase not configured)"}
    try:
        rows = (c.table("vault_notebooks").select("docs")
                .eq("id", notebook_id).limit(1).execute().data) or []
    except Exception as e:
        return None, {"error": f"load failed: {e}"}
    if not rows:
        return None, {"error": "notebook not found"}
    docs = rows[0].get("docs") or {}
    if not isinstance(docs, dict):
        docs = {}
    parts = []
    for title, content in docs.items():
        body = content if isinstance(content, str) else str(content or "")
        if body.strip():
            parts.append(f"## {title}\n{body.strip()}")
    return "\n\n".join(parts).strip(), None


def generate_doc(notebook_id: str, instruction: str) -> dict:
    """ノートブックの資料を根拠に、指示に沿った文書(Markdown)を作成する。"""
    instruction = (instruction or "").strip() or "資料を分かりやすくまとめた要約資料を作成してください。"
    context, err = _load_context(notebook_id)
    if err:
        return err
    if not context:
        return {"error": "このノートブックにはまだ資料が登録されていません。"}
    model = config.get_gemini_model()
    if model is None:
        return {"error": "GEMINI_API_KEY is not configured"}
    prompt = (
        "あなたは資料を整理して文書を作成する編集者です。"
        "以下の【資料】の情報だけを根拠に、【指示】に沿った文書を日本語の Markdown で作成してください。"
        "見出し(H2/H3)・箇条書き・表を適切に使い、読みやすく構成してください。\n\n"
        f"【資料】\n{context}\n\n【指示】\n{instruction}\n\n【文書(Markdown)】\n"
    )
    try:
        resp = model.generate_content(prompt)
        return {"markdown": getattr(resp, "text", "") or ""}
    except Exception as e:
        return {"error": f"generation failed: {e}"}


def generate_diagram(notebook_id: str, kind: str = "tree") -> dict:
    """資料から Mermaid 図（ロジックツリー等）を生成する。{mermaid, kind} を返す。"""
    kind = (kind or "tree").strip().lower()
    diagram_hint = {
        "tree": "ロジックツリー（mindmap または graph TD の木構造）",
        "flow": "フローチャート（flowchart TD）",
        "mindmap": "マインドマップ（mindmap）",
        "sequence": "シーケンス図（sequenceDiagram）",
    }.get(kind, "ロジックツリー（graph TD）")

    context, err = _load_context(notebook_id)
    if err:
        return err
    if not context:
        return {"error": "このノートブックにはまだ資料が登録されていません。"}
    model = config.get_gemini_model()
    if model is None:
        return {"error": "GEMINI_API_KEY is not configured"}
    prompt = (
        "あなたは情報を構造化して図解する専門家です。"
        f"以下の【資料】の要点を、{diagram_hint} として Mermaid 記法で表現してください。"
        "出力は Mermaid のコードだけにし、説明文やコードフェンスは付けないでください。"
        "日本語ノードラベルは半角の () [] {} を含めないでください（図が壊れます）。\n\n"
        f"【資料】\n{context}\n\n【Mermaid】\n"
    )
    try:
        resp = model.generate_content(prompt)
        code = (getattr(resp, "text", "") or "").strip()
        # 念のためコードフェンスを除去
        code = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", code).strip()
        return {"mermaid": code, "kind": kind}
    except Exception as e:
        return {"error": f"generation failed: {e}"}
