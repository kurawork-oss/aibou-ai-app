# main.py — AIbou Brain API（JARVIS的パーソナルAIのFastAPIバックエンド）
# =====================================================================
# Next.jsフロントから叩かれる「脳」。Streamlit / core.py には一切依存しない自己完結版。
# 無料デプロイ先: Google Cloud Run / Hugging Face Spaces（ffmpeg入りコンテナ）。
#
# 提供する機能:
#   GET  /health          ヘルスチェック（認証不要・コールドスタート温め用）
#   POST /chat            SSEストリーミング会話（記憶を注入＋会話を記憶）
#   POST /vision          画像＋プロンプトのマルチモーダル理解
#   POST /tts             テキスト→音声（edge-tts, MP3 base64）
#   POST /memory/add      記憶を1件追加
#   GET  /memory/recent   直近の記憶
#   GET  /income/summary  副業ジョブ(income_jobs)のステータス別集計
#   POST /video           絵コンテ→動画（リポジトリ root の renderer.py を再利用）
#
# 設計方針: 設定が欠けていても絶対にcrashせず、helpfulなJSONエラーを返す。
# =====================================================================

import asyncio
import base64
import os
import sys
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

import agenda
import agent
import artifacts
import autopilot
import board
import automations
import config
import code_agent
import evolve
import fileread
import forge
import gh
import gservice
import income
import keychain
import life
import llm
import migrate
import notify
import proactive
import scheduler
import studio
import tasks as tasks_module
import tools
import vault
from memory_store import mem_add, mem_recall, mem_recent

async def _scheduler_loop():
    """常駐ループ：60秒ごとに定期実行(scheduler.tick)を確認する（best-effort）。
    サーバーがスリープする無料プランでは起きている間のみ動く（外部cronは /scheduler/tick）。"""
    while True:
        try:
            await asyncio.sleep(60)
            await asyncio.get_event_loop().run_in_executor(None, scheduler.tick)
        except asyncio.CancelledError:
            break
        except Exception as e:  # pragma: no cover
            print(f"[scheduler] loop error: {e}")


@asynccontextmanager
async def _lifespan(_app: "FastAPI"):
    """起動時：SUPABASE_DB_URL があればテーブルを自動作成（冪等・best-effort）。
    定期実行の常駐ループも起動する。未設定でも何もせず、絶対に起動を止めない。"""
    try:
        if migrate.db_url():
            res = await asyncio.get_event_loop().run_in_executor(None, migrate.run_migrations)
            print(f"[migrate] startup: {res}")
    except Exception as e:  # pragma: no cover
        print(f"[migrate] startup error: {e}")
    task = asyncio.ensure_future(_scheduler_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(
    title="AIbou Brain API",
    description="JARVIS的パーソナルAIアシスタントのバックエンド（chat / vision / tts / memory / income / video）",
    version="1.0.0",
    lifespan=_lifespan,
)

# ── CORS ─────────────────────────────────────────────────────────
# FRONTEND_ORIGIN（既定 "*"）を許可。カンマ区切りで複数指定も可。
_origins = ["*"] if config.FRONTEND_ORIGIN == "*" else [
    o.strip() for o in config.FRONTEND_ORIGIN.split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_credentials=False,  # "*" と credentials は併用不可。Bearer運用なのでFalseで十分。
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 認証（任意のBearerトークン） ─────────────────────────────────
def _verify_supabase_jwt(token: str) -> bool:
    """Supabase Auth の access_token (HS256) を検証する。検証不可/失敗は False。"""
    secret = config.SUPABASE_JWT_SECRET
    if not (secret and token):
        return False
    try:
        import jwt as pyjwt
        pyjwt.decode(token, secret, algorithms=["HS256"], audience="authenticated")
        return True
    except Exception:
        return False


async def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
    """認証。次のいずれかで通過:
      1) APP_TOKEN 設定時: Authorization: Bearer <APP_TOKEN> の一致
      2) SUPABASE_JWT_SECRET 設定時: Supabase ログインの JWT（HS256）が有効
    APP_TOKEN も REQUIRE_AUTH も無ければ従来どおりオープン。
    REQUIRE_AUTH=1 なら上記いずれかを必須にする（バンドル埋め込みトークン不要の
    実効的な保護は「SUPABASE_JWT_SECRET + REQUIRE_AUTH=1」の組み合わせ）。
    /health はこの依存を付けない。"""
    token = ""
    if authorization and authorization.strip().lower().startswith("bearer "):
        token = authorization.strip()[7:].strip()

    if config.APP_TOKEN and token == config.APP_TOKEN:
        return
    if _verify_supabase_jwt(token):
        return
    # どの保護も構成されていなければオープン
    if not config.APP_TOKEN and not config.REQUIRE_AUTH:
        return
    raise HTTPException(status_code=401, detail="Unauthorized: valid bearer token required")


# =====================================================================
# Pydantic リクエストモデル
# =====================================================================
class ChatMessage(BaseModel):
    role: str = Field(..., description="'user' | 'assistant' | 'model'")
    content: str = ""


class ChatRequest(BaseModel):
    message: str
    history: Optional[List[ChatMessage]] = None
    persona: Optional[str] = None
    name: Optional[str] = None  # アシスタント名（既定 "AIbou"）


class VisionRequest(BaseModel):
    prompt: Optional[str] = "この画像について説明してください。"
    image_base64: str
    mime: Optional[str] = "image/jpeg"


class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = None  # 既定は config.DEFAULT_TTS_VOICE
    rate: Optional[str] = None   # 話速 例 "+0%" / "-20%" / "+30%"。既定 config.DEFAULT_TTS_RATE


class KeySetRequest(BaseModel):
    name: str
    value: str = ""


class VaultGenerateRequest(BaseModel):
    notebook_id: str
    instruction: str = ""


class VaultDiagramRequest(BaseModel):
    notebook_id: str
    kind: str = "tree"


class MissionCreateRequest(BaseModel):
    goal: str
    notify: bool = True


class NotifyRequest(BaseModel):
    message: str


class AutomationCreateRequest(BaseModel):
    name: str
    trigger: Optional[dict] = None
    steps: list = []


class AutomationRunRequest(BaseModel):
    input: str = ""


class EvolveRequest(BaseModel):
    instruction: str


class AgendaAddRequest(BaseModel):
    title: str
    date: str = ""
    time: str = ""
    note: str = ""


class AgendaParseRequest(BaseModel):
    text: str
    today: str = ""


class MemoryAddRequest(BaseModel):
    role: str = "user"
    content: str
    importance: Optional[int] = 0


class Scene(BaseModel):
    narration: str = ""
    visual: str = ""


class VideoRequest(BaseModel):
    scenes: List[Scene]
    image_prompt: Optional[str] = ""


class ForgeRequest(BaseModel):
    kind: str = "app"          # app | image | slides | sheet | doc
    prompt: str = ""


class CodeFile(BaseModel):
    path: str
    content: str = ""
    action: Optional[str] = None


class CodeGenerateRequest(BaseModel):
    instruction: str
    files: List[CodeFile] = Field(default_factory=list)
    history: List[ChatMessage] = Field(default_factory=list)
    depth: str = "normal"      # normal | deep（計画→実装→自己レビュー）


class AiConfigRequest(BaseModel):
    provider: Optional[str] = None   # auto | gemini | huggingface
    hf_model: Optional[str] = None
    code_model: Optional[str] = None


class AgentActRequest(BaseModel):
    instruction: str
    history: Optional[List[ChatMessage]] = None
    name: Optional[str] = None       # アシスタント名（既定 "AIbou"）
    approval: bool = False           # 機微なツールを実行前に承認させる


class AgentExecuteRequest(BaseModel):
    tool: str
    params: dict = Field(default_factory=dict)


class ScheduleRequest(BaseModel):
    instruction: str
    time: str = "08:00"
    days: str = "daily"   # "daily" | "mon,wed,fri" 形式


class GithubImportRequest(BaseModel):
    repo: str
    ref: str = ""
    path: str = ""


class LifeEntryRequest(BaseModel):
    category: str = "other"
    content: str
    entry_date: str = ""


class LifeExtractRequest(BaseModel):
    turns: List[ChatMessage] = Field(default_factory=list)


class GithubPushRequest(BaseModel):
    repo: str
    base: str = "main"
    branch: str = ""
    message: str = ""
    files: List[CodeFile] = Field(default_factory=list)
    create_pr: bool = True
    pr_title: str = ""



class EnqueueRequest(BaseModel):
    theme: str


class JobActionRequest(BaseModel):
    id: str


class VaultCreateRequest(BaseModel):
    name: str


class VaultAddRequest(BaseModel):
    notebook_id: str
    title: str = ""
    content: str = ""


class VaultQueryRequest(BaseModel):
    notebook_id: str
    question: str


class TaskCreateRequest(BaseModel):
    title: str
    content: str = ""
    status: str = "pending"
    priority: str = "mid"     # high | mid | low
    due: str = ""             # YYYY-MM-DD
    project: str = ""         # プロジェクト（グループ）名


class TaskUpdateRequest(BaseModel):
    status: Optional[str] = None
    response: Optional[str] = None
    content: Optional[str] = None
    priority: Optional[str] = None
    due: Optional[str] = None
    project: Optional[str] = None


class BoardSaveRequest(BaseModel):
    nodes: list = Field(default_factory=list)
    edges: list = Field(default_factory=list)


class SlidesExportRequest(BaseModel):
    title: str = ""
    slides: list = Field(default_factory=list)


class BoardCreateRequest(BaseModel):
    name: str = ""


class BoardRenameRequest(BaseModel):
    name: str


class AiCreateRequest(BaseModel):
    name: str
    persona: str = ""
    model: str = "gemini-2.5-flash"
    rules: str = ""


class WorkflowCreateRequest(BaseModel):
    name: str
    steps: list = []


class WorkflowRunRequest(BaseModel):
    input: str = ""


# =====================================================================
# プロンプト構築
# =====================================================================
def build_system_prompt(name: Optional[str], persona: Optional[str], memory_block: str) -> str:
    """アシスタントの基本人格＋persona＋想起した記憶 を1つのsystem promptに合成する。"""
    assistant_name = (name or "AIbou").strip() or "AIbou"
    parts = [
        f"あなたは「{assistant_name}」という名前の、ユーザー専属のパーソナルAIアシスタント（JARVIS的存在）です。",
        "簡潔で的確、かつ親しみやすい口調で、ユーザーの目標達成を全力でサポートしてください。",
        "わからないことは正直に伝え、必要なら確認を取ってください。",
    ]
    if persona and persona.strip():
        parts.append(f"\n【ペルソナ / 振る舞いの指針】\n{persona.strip()}")
    if memory_block:
        parts.append(f"\n{memory_block}")
    return "\n".join(parts)


def build_conversation(system_prompt: str, history: Optional[List[ChatMessage]], message: str) -> str:
    """system prompt ＋ 履歴 ＋ 今回のメッセージ を1つのテキストプロンプトに結合する。
    google-generativeai のシンプルな single-prompt 形式（stream対応）に合わせる。"""
    lines = [system_prompt, "\n--- 会話履歴 ---"]
    for m in (history or []):
        role = (m.role or "").lower()
        speaker = "ユーザー" if role in ("user", "human") else "アシスタント"
        content = (m.content or "").strip()
        if content:
            lines.append(f"{speaker}: {content}")
    lines.append(f"ユーザー: {message.strip()}")
    lines.append("アシスタント:")
    return "\n".join(lines)


def _sse(data: dict) -> str:
    """dict を SSE の1イベント（data: <json>\\n\\n）に変換する。"""
    import json
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


# =====================================================================
# エンドポイント
# =====================================================================
@app.get("/health")
async def health():
    """ヘルスチェック（認証不要）。フロントがコールドスタートを温めるのに使う。"""
    return {"status": "ok"}


@app.post("/chat")
async def chat(req: ChatRequest, _auth: None = Depends(require_auth)):
    """SSEストリーミング会話。
    1) 記憶を想起して system prompt を構築
    2) Gemini を stream=True で呼び、トークンを data: {"token": "..."} で逐次送信
    3) 完了後 data: {"done": true} を送り、会話を agent_memory に保存（best-effort）
    """
    # AIプロバイダ（Gemini か HuggingFace）が1つも無ければ crash させず案内。
    if llm.active_provider() == "none":
        async def err_stream():
            yield _sse({"error": "AI未設定です。Settings → KEYCHAIN に GEMINI_API_KEY か HUGGINGFACE_TOKEN を保存してください。"})
            yield _sse({"done": True})
        return StreamingResponse(err_stream(), media_type="text/event-stream")

    # 記憶を想起（Supabaseが無ければ空文字）
    memory_block = mem_recall(req.message, limit=8)
    system_prompt = build_system_prompt(req.name, req.persona, memory_block)
    # ツール実行を許可（行動を頼まれた時だけマーカーを使う旨をルール付けする）
    system_prompt += (
        "\n\n" + tools.TOOLS_DOC + "\n"
        "【ツールの使い方】行動（記憶・通知・副業投入・メモ保存など）を明確に頼まれた時だけ、"
        "返答の冒頭で必ず " + tools.TOOL_CALL_MARKER + '{"tool":"名","params":{...}} を1行で出すこと。'
        "通常の会話・質問では絶対に使わないこと。"
    )
    prompt = build_conversation(system_prompt, req.history, req.message)
    marker = tools.TOOL_CALL_MARKER

    async def event_stream():
        collected: List[str] = []
        loop = asyncio.get_event_loop()

        def _next(it):
            try:
                return next(it)
            except StopIteration:
                return None

        try:
            it = llm.stream_text(prompt)
            buf = ""
            decided = None  # None=判定中 / "tool" / "normal"

            while True:
                text = await loop.run_in_executor(None, _next, it)
                if text is None:
                    break
                if not text:
                    continue
                if decided == "normal":
                    collected.append(text)
                    yield _sse({"token": text})
                    continue
                if decided == "tool":
                    buf += text  # ツール呼び出し全体を黙って蓄積
                    continue
                # 判定中：先頭がツールマーカーか見極める
                buf += text
                stripped = buf.lstrip()
                if not stripped:
                    continue
                if stripped.startswith(marker):
                    decided = "tool"
                elif marker.startswith(stripped):
                    continue  # まだマーカーになる可能性 → さらにバッファ
                else:
                    decided = "normal"
                    collected.append(buf)
                    yield _sse({"token": buf})
                    buf = ""

            # 判定がつかないまま終了した短い応答は通常扱いで送出
            if decided is None and buf:
                collected.append(buf)
                yield _sse({"token": buf})

            # ツール呼び出しなら実行 → 結果を踏まえ最終回答をストリーム
            if decided == "tool":
                call, preface = tools.extract_tool_call(buf)
                if call:
                    result = await loop.run_in_executor(
                        None, lambda: tools.execute_tool(call.get("tool", ""), call.get("params", {}) or {})
                    )
                    followup = (
                        prompt
                        + "\nアシスタント:（ツールを実行しました）"
                        + "\n<<<TOOL_RESULT>>> " + result
                        + "\nアシスタント（上の結果を踏まえ、ツール記法は使わず日本語で簡潔に報告）:"
                    )
                    it2 = llm.stream_text(followup)
                    while True:
                        t2 = await loop.run_in_executor(None, _next, it2)
                        if t2 is None:
                            break
                        if t2:
                            collected.append(t2)
                            yield _sse({"token": t2})
                else:
                    collected.append(buf)
                    yield _sse({"token": buf})
        except Exception as e:
            if config.is_zero_quota_429(e):
                yield _sse({"error": (
                    "Gemini無料枠の上限（またはこのキーの無料枠が0）に達しました。"
                    "KEYCHAIN に HUGGINGFACE_TOKEN を入れると自動でHuggingFaceに切り替わります。"
                )})
            else:
                yield _sse({"error": f"generation failed: {e}"})

        yield _sse({"done": True})

        # 会話を記憶（best-effort）
        try:
            full = "".join(collected).strip()
            if req.message:
                mem_add("user", req.message, importance=0)
            if full:
                mem_add("assistant", full, importance=0)
        except Exception:
            pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/agent/act")
async def agent_act(req: AgentActRequest, _auth: None = Depends(require_auth)):
    """HOME：手足となって動く自律エージェント（SSE）。plan→act→observe を
    繰り返し、進捗を data:{"phase":...} で実況、最後に final→done を送る。"""
    if llm.active_provider() == "none":
        async def err_stream():
            yield _sse({"phase": "error", "detail": "AI未設定です。Settings → KEYCHAIN に GEMINI_API_KEY か HUGGINGFACE_TOKEN を保存してください。"})
            yield _sse({"phase": "done", "steps": 0})
        return StreamingResponse(err_stream(), media_type="text/event-stream")

    history = [h.model_dump() for h in (req.history or [])]

    async def event_stream():
        loop = asyncio.get_event_loop()
        gen = agent.run_stream(req.instruction, history, req.name or "AIbou", req.approval)

        def _next(g):
            try:
                return next(g)
            except StopIteration:
                return None

        collected_final = ""
        while True:
            ev = await loop.run_in_executor(None, _next, gen)
            if ev is None:
                break
            if ev.get("phase") == "final":
                collected_final = ev.get("text", "")
            yield _sse(ev)

        # 会話を記憶（best-effort）— CHAT と同じ扱い。
        try:
            if req.instruction:
                mem_add("user", req.instruction, importance=0)
            if collected_final:
                mem_add("assistant", collected_final, importance=0)
        except Exception:
            pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/agent/execute")
async def agent_execute(req: AgentExecuteRequest, _auth: None = Depends(require_auth)):
    """承認された単一ツールを実行する（承認モードの『承認』ボタン用）。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: tools.execute_tool(req.tool, req.params or {}))
    return {"result": result}


@app.post("/vision")
async def vision(req: VisionRequest, _auth: None = Depends(require_auth)):
    """画像（base64）＋プロンプトをGeminiのマルチモーダルで理解し、テキストを返す。"""
    model = config.get_gemini_model()
    if model is None:
        return JSONResponse(
            status_code=503,
            content={"error": "GEMINI_API_KEY is not configured on the server."},
        )
    try:
        raw = base64.b64decode(req.image_base64)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "image_base64 is not valid base64."})

    prompt = req.prompt or "この画像について説明してください。"
    mime = req.mime or "image/jpeg"
    try:
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(
            None,
            lambda: model.generate_content([prompt, {"mime_type": mime, "data": raw}]),
        )
        return {"text": getattr(resp, "text", "") or ""}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"vision failed: {e}"})


@app.post("/tts")
async def tts(req: TTSRequest, _auth: None = Depends(require_auth)):
    """edge-tts でテキストを音声(MP3)化し、base64で返す。失敗時は audio_base64="" を返す。"""
    text = (req.text or "").strip()
    if not text:
        return {"audio_base64": "", "error": "text is empty"}
    voice = (req.voice or config.DEFAULT_TTS_VOICE).strip() or config.DEFAULT_TTS_VOICE
    rate = (req.rate or config.DEFAULT_TTS_RATE).strip() or config.DEFAULT_TTS_RATE

    try:
        audio_bytes = await _synthesize_tts(text, voice, rate)
        if not audio_bytes:
            return {"audio_base64": "", "error": "tts produced no audio"}
        return {"audio_base64": base64.b64encode(audio_bytes).decode("ascii")}
    except Exception as e:
        # フォールバック: 空文字（フロント側で無音扱い）
        return {"audio_base64": "", "error": f"tts failed: {e}"}


async def _synthesize_tts(text: str, voice: str, rate: str = "+0%") -> bytes:
    """edge-tts で MP3 バイト列を生成する（asyncで実行）。rate は "+0%" 等の文字列。"""
    import edge_tts
    # rate が不正フォーマットなら edge-tts が例外を出すので軽くサニタイズ
    r = (rate or "+0%").strip()
    if not (r.endswith("%") and (r[0] in "+-")):
        r = "+0%"
    communicate = edge_tts.Communicate(text, voice, rate=r)
    buf = bytearray()
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            buf.extend(chunk["data"])
    return bytes(buf)


@app.post("/memory/add")
async def memory_add(req: MemoryAddRequest, _auth: None = Depends(require_auth)):
    """記憶を1件追加する。Supabaseが無ければ ok=false（ただしcrashはしない）。"""
    ok = mem_add(req.role, req.content, importance=req.importance or 0)
    if not ok:
        return {"ok": False, "error": "memory store unavailable (Supabase not configured)"}
    return {"ok": True}


@app.get("/memory/recent")
async def memory_recent(limit: int = 20, _auth: None = Depends(require_auth)):
    """直近の記憶を返す。Supabaseが無ければ空リスト。"""
    return {"items": mem_recent(limit=limit)}


@app.get("/income/summary")
async def income_summary(_auth: None = Depends(require_auth)):
    """副業ジョブ(income_jobs)のステータス別件数＋合計を返す。
    Supabaseが無ければ {} を返す（crashしない）。"""
    c = config.get_supabase()
    if not c:
        return {}
    statuses = ["pending", "approved", "rejected", "completed", "failed"]
    summary = {s: 0 for s in statuses}
    total = 0
    try:
        rows = (c.table("income_jobs")
                .select("status")
                .limit(10000)
                .execute().data) or []
        for r in rows:
            st = (r.get("status") or "").strip()
            total += 1
            if st in summary:
                summary[st] += 1
        summary["total"] = total
        return summary
    except Exception:
        # テーブルが無い等。空で縮退。
        return {}


@app.post("/forge/generate")
async def forge_generate(req: ForgeRequest, _auth: None = Depends(require_auth)):
    """Forge：アプリ/画像/スライド/表/文書 を生成して返す。
    重い同期処理（Gemini）はスレッドに逃がす。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: forge.generate(req.kind, req.prompt))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


@app.post("/code/generate")
async def code_generate(req: CodeGenerateRequest, _auth: None = Depends(require_auth)):
    """CODE：AIコーディングエージェント（SSE）。段階進捗を data:{"phase":...} で流し、
    最後に data:{"phase":"done", explanation, files, edits} を送る（Claude Code 風の実況）。"""
    files = [f.model_dump() for f in req.files]
    history = [h.model_dump() for h in req.history]
    depth = req.depth

    async def event_stream():
        loop = asyncio.get_event_loop()
        gen = code_agent.run_stream(req.instruction, files, history, depth)

        def _next(g):
            try:
                return next(g)
            except StopIteration:
                return None

        while True:
            ev = await loop.run_in_executor(None, _next, gen)
            if ev is None:
                break
            yield _sse(ev)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/code/scaffold")
async def code_scaffold(kind: str = "web", _auth: None = Depends(require_auth)):
    """CODE：スターターワークスペース（web | python | empty）。"""
    return code_agent.scaffold(kind)


@app.get("/ai/config")
async def ai_config_get(_auth: None = Depends(require_auth)):
    """AIプロバイダ/モデルの現在設定と選択肢を返す（設定UI用）。"""
    return {
        "provider": llm._kc("LLM_PROVIDER") or "auto",
        "hf_model": llm._kc("HF_MODEL") or llm.DEFAULT_HF_MODEL,
        "code_model": llm._kc("CODE_MODEL") or llm.DEFAULT_CODE_MODEL,
        "active": llm.active_provider(),
        "gemini_ready": config.gemini_configured(),
        "hf_ready": bool(llm._hf_token()),
        "presets": {
            "chat": [
                "meta-llama/Llama-3.3-70B-Instruct",
                "Qwen/Qwen2.5-72B-Instruct",
                "deepseek-ai/DeepSeek-V3-0324",
                "mistralai/Mistral-Small-24B-Instruct-2501",
                "meta-llama/Llama-3.1-8B-Instruct",
            ],
            "code": [
                "Qwen/Qwen2.5-Coder-32B-Instruct",
                "deepseek-ai/DeepSeek-V3-0324",
                "Qwen/Qwen2.5-Coder-7B-Instruct",
            ],
        },
    }


@app.post("/ai/config")
async def ai_config_set(req: AiConfigRequest, _auth: None = Depends(require_auth)):
    """AIプロバイダ/モデルを設定（KEYCHAIN経由で永続化）。"""
    if req.provider is not None:
        keychain.set_key("LLM_PROVIDER", req.provider.strip())
    if req.hf_model is not None:
        keychain.set_key("HF_MODEL", req.hf_model.strip())
    if req.code_model is not None:
        keychain.set_key("CODE_MODEL", req.code_model.strip())
    return await ai_config_get()


@app.get("/github/repos")
async def github_repos(_auth: None = Depends(require_auth)):
    """CODE：アクセス可能なGitHubリポジトリ一覧（GITHUB_TOKEN必須）。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, gh.list_repos)
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


@app.post("/github/import")
async def github_import(req: GithubImportRequest, _auth: None = Depends(require_auth)):
    """CODE：リポジトリ（またはフォルダ）をワークスペースとして取り込む。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: gh.import_repo(req.repo, req.ref, req.path))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


@app.post("/github/push")
async def github_push(req: GithubPushRequest, _auth: None = Depends(require_auth)):
    """CODE：ワークスペースを新ブランチへ1コミットでプッシュ（+PR作成）。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: gh.push_files(
            req.repo, req.base, req.branch, req.message,
            [f.model_dump() for f in req.files], req.create_pr, req.pr_title,
        ),
    )
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


@app.get("/life/entries")
async def life_entries(category: Optional[str] = None, _auth: None = Depends(require_auth)):
    """ME：経験の箱の一覧（category で絞り込み可）。"""
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, lambda: life.list_entries(category or ""))
    return {"items": items, "categories": life.CATEGORIES}


@app.post("/life/entries")
async def life_add(req: LifeEntryRequest, _auth: None = Depends(require_auth)):
    """ME：経験を1件保存。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: life.add_entry(req.category, req.content, req.entry_date))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=400, content=result)
    return result


@app.delete("/life/entries/{entry_id}")
async def life_delete(entry_id: str, _auth: None = Depends(require_auth)):
    """ME：経験を1件削除。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: life.delete_entry(entry_id))


@app.post("/life/extract")
async def life_extract(req: LifeExtractRequest, _auth: None = Depends(require_auth)):
    """ME：直近の相談会話から「経験の箱」候補を抽出（保存はユーザー確認後）。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, lambda: life.extract_entries([t.model_dump() for t in req.turns])
    )
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


@app.post("/life/chat")
async def life_chat(req: ChatRequest, _auth: None = Depends(require_auth)):
    """ME：経験の箱を常に踏まえた相談チャット（SSE）。
    通常 /chat と違いツール実行は無し — 純粋な相談相手として振る舞う。"""
    if llm.active_provider() == "none":
        async def err_stream():
            yield _sse({"error": "AI未設定です。Settings → KEYCHAIN に GEMINI_API_KEY か HUGGINGFACE_TOKEN を保存してください。"})
            yield _sse({"done": True})
        return StreamingResponse(err_stream(), media_type="text/event-stream")

    system_prompt = await asyncio.get_event_loop().run_in_executor(
        None, lambda: life.build_life_prompt(req.name or "")
    )
    prompt = build_conversation(system_prompt, req.history, req.message)

    async def event_stream():
        loop = asyncio.get_event_loop()

        def _next(it):
            try:
                return next(it)
            except StopIteration:
                return None

        try:
            it = llm.stream_text(prompt)
            while True:
                text = await loop.run_in_executor(None, _next, it)
                if text is None:
                    break
                if text:
                    yield _sse({"token": text})
            yield _sse({"done": True})
        except Exception as e:
            if config.is_zero_quota_429(e):
                yield _sse({"error": (
                    "Gemini無料枠の上限に達しました。KEYCHAIN に HUGGINGFACE_TOKEN を入れると"
                    "自動でHuggingFaceに切り替わります。"
                )})
            else:
                yield _sse({"error": f"life chat failed: {e}"})
            yield _sse({"done": True})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/income/jobs")
async def income_jobs(status: Optional[str] = None, limit: int = 50, _auth: None = Depends(require_auth)):
    """副業ジョブの一覧（新しい順）。status で絞り込み可。Supabase未設定なら空。"""
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, lambda: income.list_jobs(status, limit))
    return {"items": items}


@app.post("/income/enqueue")
async def income_enqueue(req: EnqueueRequest, _auth: None = Depends(require_auth)):
    """テーマから各媒体メタデータを生成し、承認待ち(pending)で積む。"""
    loop = asyncio.get_event_loop()
    job = await loop.run_in_executor(None, lambda: income.enqueue(req.theme))
    if isinstance(job, dict) and job.get("error"):
        return JSONResponse(status_code=503, content=job)
    return job


@app.post("/income/approve")
async def income_approve(req: JobActionRequest, _auth: None = Depends(require_auth)):
    ok = await asyncio.get_event_loop().run_in_executor(None, lambda: income.set_status(req.id, "approved"))
    return {"ok": ok}


@app.post("/income/reject")
async def income_reject(req: JobActionRequest, _auth: None = Depends(require_auth)):
    ok = await asyncio.get_event_loop().run_in_executor(None, lambda: income.set_status(req.id, "rejected"))
    return {"ok": ok}


# ── Document Vault（知識/RAG） ───────────────────────────────────
@app.get("/vault/notebooks")
async def vault_notebooks(_auth: None = Depends(require_auth)):
    items = await asyncio.get_event_loop().run_in_executor(None, vault.list_notebooks)
    return {"items": items}


@app.post("/vault/create")
async def vault_create(req: VaultCreateRequest, _auth: None = Depends(require_auth)):
    return await asyncio.get_event_loop().run_in_executor(None, lambda: vault.create_notebook(req.name))


@app.post("/vault/add")
async def vault_add(req: VaultAddRequest, _auth: None = Depends(require_auth)):
    return await asyncio.get_event_loop().run_in_executor(
        None, lambda: vault.add_text(req.notebook_id, req.title, req.content)
    )


@app.post("/vault/query")
async def vault_query(req: VaultQueryRequest, _auth: None = Depends(require_auth)):
    return await asyncio.get_event_loop().run_in_executor(
        None, lambda: vault.query(req.notebook_id, req.question)
    )


@app.post("/vault/generate")
async def vault_generate(req: VaultGenerateRequest, _auth: None = Depends(require_auth)):
    """ノートブックの資料を根拠に文書(Markdown)を作成する。"""
    result = await asyncio.get_event_loop().run_in_executor(
        None, lambda: vault.generate_doc(req.notebook_id, req.instruction)
    )
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


@app.post("/vault/diagram")
async def vault_diagram(req: VaultDiagramRequest, _auth: None = Depends(require_auth)):
    """資料から Mermaid 図（ロジックツリー等）を生成する。"""
    result = await asyncio.get_event_loop().run_in_executor(
        None, lambda: vault.generate_diagram(req.notebook_id, req.kind)
    )
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


# ── プロアクティブ（今日のブリーフィング） ───────────────────────
@app.get("/briefing")
async def briefing(_auth: None = Depends(require_auth)):
    text = await asyncio.get_event_loop().run_in_executor(None, proactive.build_briefing)
    return {"text": text}


@app.post("/video")
async def video(req: VideoRequest, _auth: None = Depends(require_auth)):
    """絵コンテ(scenes)から動画を生成する。リポジトリ root の renderer.py を再利用する。
    renderer / ffmpeg が使えない場合は 503 {"error": "video rendering unavailable"}。"""
    renderer = _load_renderer()
    if renderer is None:
        return JSONResponse(status_code=503, content={"error": "video rendering unavailable"})

    # ffmpeg が無ければ即座に縮退（renderer.is_available があれば利用）
    try:
        if hasattr(renderer, "is_available") and not renderer.is_available():
            return JSONResponse(status_code=503, content={"error": "video rendering unavailable"})
    except Exception:
        pass

    scenes = [{"narration": s.narration, "visual": s.visual} for s in req.scenes]
    image_prompt = req.image_prompt or ""

    try:
        loop = asyncio.get_event_loop()
        path = await loop.run_in_executor(
            None, lambda: renderer.render_forge_video(scenes, image_prompt)
        )
    except Exception:
        path = None

    if not path or not os.path.exists(path):
        return JSONResponse(status_code=503, content={"error": "video rendering unavailable"})

    try:
        with open(path, "rb") as f:
            data = f.read()
        return {"video_base64": base64.b64encode(data).decode("ascii")}
    except Exception:
        return JSONResponse(status_code=503, content={"error": "video rendering unavailable"})


# ── renderer.py（リポジトリ root）の遅延ロード ───────────────────
_renderer_module = None
_renderer_tried = False


def _load_renderer():
    """リポジトリ root の renderer.py を import する（api/ の親を sys.path に追加）。
    import できなければ None（絶対にraiseしない）。"""
    global _renderer_module, _renderer_tried
    if _renderer_module is not None:
        return _renderer_module
    if _renderer_tried:
        return None
    _renderer_tried = True
    try:
        parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if parent not in sys.path:
            sys.path.insert(0, parent)
        import renderer  # type: ignore
        _renderer_module = renderer
        return renderer
    except Exception:
        _renderer_module = None
        return None


# ── Tasks（アクティブタスク管理） ─────────────────────────────────

@app.get("/tasks")
async def get_tasks(status: Optional[str] = None, limit: int = 100,
                    _auth: None = Depends(require_auth)):
    """タスク一覧を返す。status パラメータで絞り込み可。"""
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, lambda: tasks_module.list_tasks(status, limit))
    return {"items": items}


@app.post("/tasks")
async def create_task(req: TaskCreateRequest, _auth: None = Depends(require_auth)):
    """新しいタスクを作成する。"""
    loop = asyncio.get_event_loop()
    task = await loop.run_in_executor(
        None, lambda: tasks_module.create_task(req.title, req.content, req.status,
                                               req.priority, req.due, req.project)
    )
    if isinstance(task, dict) and task.get("error"):
        return JSONResponse(status_code=400, content=task)
    return task


@app.patch("/tasks/{task_id}")
async def update_task(task_id: str, req: TaskUpdateRequest,
                      _auth: None = Depends(require_auth)):
    """タスクのステータス・返答・内容・優先度・期限・プロジェクトを更新する。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, lambda: tasks_module.update_task(task_id, req.status, req.response, req.content,
                                               req.priority, req.due, req.project)
    )
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=404, content=result)
    return result


@app.delete("/tasks/{task_id}")
async def delete_task(task_id: str, _auth: None = Depends(require_auth)):
    """タスクを削除する。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: tasks_module.delete_task(task_id))


# ── AI Studio（カスタムAI・ワークフロー） ──────────────────────────

@app.get("/studio/ais")
async def studio_list_ais(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, studio.list_ais)}


@app.post("/studio/ais")
async def studio_create_ai(req: AiCreateRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    ai = await loop.run_in_executor(
        None, lambda: studio.create_ai(req.name, req.persona, req.model, req.rules)
    )
    if isinstance(ai, dict) and ai.get("error"):
        return JSONResponse(status_code=400, content=ai)
    return ai


@app.delete("/studio/ais/{ai_id}")
async def studio_delete_ai(ai_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: studio.delete_ai(ai_id))


@app.get("/studio/workflows")
async def studio_list_workflows(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, studio.list_workflows)}


@app.post("/studio/workflows")
async def studio_create_workflow(req: WorkflowCreateRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    wf = await loop.run_in_executor(
        None, lambda: studio.create_workflow(req.name, req.steps)
    )
    if isinstance(wf, dict) and wf.get("error"):
        return JSONResponse(status_code=400, content=wf)
    return wf


@app.delete("/studio/workflows/{wf_id}")
async def studio_delete_workflow(wf_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: studio.delete_workflow(wf_id))


@app.post("/studio/workflows/{wf_id}/run")
async def studio_run_workflow(wf_id: str, req: WorkflowRunRequest,
                              _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, lambda: studio.run_workflow(wf_id, req.input)
    )
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


# ── Autopilot（ゴール自動実行） ───────────────────────────────────

@app.get("/autopilot/missions")
async def autopilot_list(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, autopilot.list_missions)}


@app.post("/autopilot/missions")
async def autopilot_create(req: MissionCreateRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    m = await loop.run_in_executor(None, lambda: autopilot.create_mission(req.goal, req.notify))
    if isinstance(m, dict) and m.get("error"):
        return JSONResponse(status_code=400, content=m)
    return m


@app.post("/autopilot/missions/{mission_id}/step")
async def autopilot_step(mission_id: str, _auth: None = Depends(require_auth)):
    """次の未完了ステップを1つ実行する（フロント or cron が繰り返し呼ぶ）。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: autopilot.run_step(mission_id))
    if isinstance(result, dict) and result.get("error") and not result.get("mission"):
        return JSONResponse(status_code=404, content=result)
    return result


@app.delete("/autopilot/missions/{mission_id}")
async def autopilot_delete(mission_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: autopilot.delete_mission(mission_id))


@app.post("/notify")
async def notify_send(req: NotifyRequest, _auth: None = Depends(require_auth)):
    """設定済みチャンネル（LINE/Discord/Slack）へ通知を送る。未設定なら skipped。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: notify.notify_all(req.message))


# ── Automations（ノーコード自動化 / Zapier風） ────────────────────

@app.get("/automations")
async def automations_list(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, automations.list_flows)}


@app.post("/automations")
async def automations_create(req: AutomationCreateRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    f = await loop.run_in_executor(
        None, lambda: automations.create_flow(req.name, req.trigger, req.steps)
    )
    if isinstance(f, dict) and f.get("error"):
        return JSONResponse(status_code=400, content=f)
    return f


@app.delete("/automations/{flow_id}")
async def automations_delete(flow_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: automations.delete_flow(flow_id))


@app.post("/automations/{flow_id}/run")
async def automations_run(flow_id: str, req: AutomationRunRequest,
                          _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: automations.run_flow(flow_id, req.input))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=404, content=result)
    return result


# ── Agenda（組み込みカレンダー / 予定） ───────────────────────────

@app.get("/agenda")
async def agenda_list(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, agenda.list_events)}


@app.post("/agenda")
async def agenda_add(req: AgendaAddRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    ev = await loop.run_in_executor(
        None, lambda: agenda.add_event(req.title, req.date, req.time, req.note)
    )
    if isinstance(ev, dict) and ev.get("error"):
        return JSONResponse(status_code=400, content=ev)
    return ev


@app.post("/agenda/parse")
async def agenda_parse(req: AgendaParseRequest, _auth: None = Depends(require_auth)):
    """自然言語の予定文を解釈して登録する。"""
    loop = asyncio.get_event_loop()
    ev = await loop.run_in_executor(None, lambda: agenda.parse_and_add(req.text, req.today))
    if isinstance(ev, dict) and ev.get("error"):
        return JSONResponse(status_code=400, content=ev)
    return ev


@app.delete("/agenda/{event_id}")
async def agenda_delete(event_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: agenda.delete_event(event_id))


# ── Notifications（アプリ内通知） ─────────────────────────────────

@app.get("/notifications")
async def notifications_list(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, notify.list_internal)
    unread = sum(1 for n in items if not n.get("read"))
    return {"items": items, "unread": unread}


@app.post("/notifications/read")
async def notifications_read(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, notify.mark_all_read)


# ── Board（Miro風ホワイトボード・複数ボード） ─────────────────────────

@app.get("/board")
async def board_get(_auth: None = Depends(require_auth)):
    """（旧API互換）最初のボードを返す。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, board.get_board)


@app.post("/board")
async def board_save(req: BoardSaveRequest, _auth: None = Depends(require_auth)):
    """（旧API互換）最初のボードを保存する。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.save_board(req.nodes, req.edges))


@app.get("/boards")
async def boards_list(_auth: None = Depends(require_auth)):
    """ボード一覧（メタのみ・更新順）。"""
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, board.list_boards)}


@app.post("/boards")
async def boards_create(req: BoardCreateRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.create_board(req.name))


@app.get("/boards/{board_id}")
async def boards_get(board_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: board.get_board(board_id))
    if res.get("error"):
        return JSONResponse(status_code=404, content=res)
    return res


@app.post("/boards/{board_id}")
async def boards_save(board_id: str, req: BoardSaveRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.save_board(req.nodes, req.edges, board_id))


@app.patch("/boards/{board_id}")
async def boards_rename(board_id: str, req: BoardRenameRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.rename_board(board_id, req.name))


@app.post("/boards/{board_id}/duplicate")
async def boards_duplicate(board_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.duplicate_board(board_id))


@app.delete("/boards/{board_id}")
async def boards_delete(board_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.delete_board(board_id))


# ── Artifacts（エージェント生成物：ドキュメント / スプレッドシート） ──

@app.get("/artifacts")
async def artifacts_list(_auth: None = Depends(require_auth)):
    """生成物のメタデータ一覧（content は含めない・新しい順）。"""
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, artifacts.list_artifacts)}


@app.get("/artifacts/{artifact_id}")
async def artifacts_get(artifact_id: str, _auth: None = Depends(require_auth)):
    """1件の完全な内容（content 込み）。ダウンロードに使う。"""
    loop = asyncio.get_event_loop()
    art = await loop.run_in_executor(None, lambda: artifacts.get(artifact_id))
    if not art:
        return JSONResponse(status_code=404, content={"error": "artifact not found"})
    return art


@app.delete("/artifacts/{artifact_id}")
async def artifacts_delete(artifact_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: artifacts.delete(artifact_id))


# ── Admin：DB永続化（テーブル自動作成） ──────────────────────────────

@app.get("/admin/db/status")
async def admin_db_status(_auth: None = Depends(require_auth)):
    """必要テーブルの存在状況（永続化の可否を判断するUI用）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, migrate.table_status)


@app.post("/admin/migrate")
async def admin_migrate(_auth: None = Depends(require_auth)):
    """SUPABASE_DB_URL を使って supabase_schema.sql を実行（テーブル自動作成）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, migrate.run_migrations)


# ── ファイル読み取り（PDF / テキスト → 本文抽出） ──────────────────────

@app.post("/file/extract")
async def file_extract(file: UploadFile = File(...), _auth: None = Depends(require_auth)):
    """アップロードされたファイルからテキストを抽出して返す（PDF/テキスト対応）。"""
    data = await file.read()
    name = file.filename or "file"
    ctype = file.content_type or ""
    loop = asyncio.get_event_loop()
    text = await loop.run_in_executor(None, lambda: fileread.extract_text(name, data, ctype))
    return {"name": name, "chars": len(text), "text": text}


# ── 定期実行（スケジューラ） ──────────────────────────────────────────

@app.get("/scheduler")
async def scheduler_list(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, scheduler.list_schedules)}


@app.post("/scheduler")
async def scheduler_add(req: ScheduleRequest, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: scheduler.add(req.instruction, req.time, req.days))


@app.delete("/scheduler/{schedule_id}")
async def scheduler_delete(schedule_id: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: scheduler.delete(schedule_id))


@app.post("/scheduler/tick")
async def scheduler_tick():
    """外部cron（無料のcron-job.org等）から叩く実行トリガ。認証不要（副作用は登録済み定期のみ）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, scheduler.tick)


# ── Google 連携（OAuth：スプレッドシート / ドキュメント） ──────────────
# start / callback はブラウザ遷移 & Google からのリダイレクトなので認証を付けない
# （OAuth 自体が本人確認になる）。status は認証必須。

def _google_redirect(request: Request) -> str:
    """明示設定を最優先。無ければリクエストから callback URL を組み立てる。"""
    base = str(request.base_url).rstrip("/")
    # プロキシ(Render/Vercel)越しは https を強制（localhost は除く）。
    if base.startswith("http://") and "localhost" not in base and "127.0.0.1" not in base:
        base = "https://" + base[len("http://"):]
    return gservice.redirect_uri(default=f"{base}/google/auth/callback")


@app.get("/google/status")
async def google_status(_auth: None = Depends(require_auth)):
    """Google連携の状態（設定済み / 接続済み）を返す。"""
    return gservice.status()


@app.get("/google/auth/start")
async def google_auth_start(request: Request):
    """Googleの同意画面へリダイレクト（KEYCHAINにCLIENT_ID/SECRETが必要）。"""
    if not gservice.configured():
        return HTMLResponse(
            "<h3>Google未設定です</h3><p>Settings → KEYCHAIN で "
            "GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を設定してください。</p>",
            status_code=400,
        )
    return RedirectResponse(gservice.auth_url(_google_redirect(request)))


@app.get("/google/auth/callback")
async def google_auth_callback(request: Request, code: str = "", error: str = ""):
    """Googleからのコールバック。コードを refresh_token に交換して保存する。"""
    if error:
        return HTMLResponse(f"<h3>接続に失敗しました</h3><p>{error}</p>")
    redirect = _google_redirect(request)
    res = await asyncio.get_event_loop().run_in_executor(None, lambda: gservice.exchange_code(code, redirect))
    if res.get("ok"):
        return HTMLResponse(
            "<div style='font-family:sans-serif;text-align:center;margin-top:15%'>"
            "<h2>✓ Google連携が完了しました</h2>"
            "<p>このタブを閉じて、アプリに戻ってください。</p></div>"
        )
    return HTMLResponse(
        "<div style='font-family:sans-serif;text-align:center;margin-top:12%'>"
        f"<h3>接続に失敗しました</h3><p>{res.get('error')}</p>"
        f"<p style='color:#888;font-size:13px'>Google Cloud の『承認済みのリダイレクトURI』が<br>"
        f"<code>{redirect}</code><br>と完全一致しているか確認してください。</p></div>"
    )


@app.post("/google/disconnect")
async def google_disconnect(_auth: None = Depends(require_auth)):
    return gservice.disconnect()


@app.post("/slides/google")
async def slides_to_google(req: SlidesExportRequest, _auth: None = Depends(require_auth)):
    """スライド構成（title + slides[]）を Google スライドに変換して URL を返す。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: gservice.create_presentation(req.title, req.slides))


# ── Home（コックピット集約サマリー） ──────────────────────────────

@app.get("/home/summary")
async def home_summary(_auth: None = Depends(require_auth)):
    """ホーム画面のKPIを1回で集約して返す（各機能の進捗）。"""
    loop = asyncio.get_event_loop()

    def _gather():
        # タスク
        try:
            all_tasks = tasks_module.list_tasks(None, 1000)
        except Exception:
            all_tasks = []
        task_counts = {}
        for t in all_tasks:
            s = t.get("status") or "pending"
            task_counts[s] = task_counts.get(s, 0) + 1
        # ミッション
        try:
            missions = autopilot.list_missions(1000)
        except Exception:
            missions = []
        active_missions = sum(1 for m in missions if m.get("status") == "active")
        # 自動化
        try:
            flows = automations.list_flows(1000)
        except Exception:
            flows = []
        # 副業
        try:
            pending_income = len(income.list_jobs("pending", 1000))
        except Exception:
            pending_income = 0
        # 予定
        try:
            events = agenda.list_events(1000)
        except Exception:
            events = []
        # 通知
        try:
            unread = notify.unread_count()
        except Exception:
            unread = 0
        return {
            "tasks": {"total": len(all_tasks), "by_status": task_counts,
                      "open": task_counts.get("pending", 0) + task_counts.get("in_progress", 0)},
            "missions": {"total": len(missions), "active": active_missions},
            "automations": {"total": len(flows)},
            "income": {"pending": pending_income},
            "events": {"total": len(events), "upcoming": events[:5]},
            "notifications": {"unread": unread},
        }

    return await loop.run_in_executor(None, _gather)


# ── Evolve（セルフ進化：指示→提案） ──────────────────────────────

@app.post("/evolve/propose")
async def evolve_propose(req: EvolveRequest, _auth: None = Depends(require_auth)):
    """自然言語の指示から、app/custom_ai/automation/answer の提案を返す。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: evolve.propose(req.instruction))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=503, content=result)
    return result


# ── Keychain（APIキー保管庫） ────────────────────────────────────

@app.get("/keys")
async def list_keys(_auth: None = Depends(require_auth)):
    """保存済みキーを「マスク値 + 設定有無」で返す（フル値は決して返さない）。"""
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, keychain.list_keys)}


@app.post("/keys")
async def set_key(req: KeySetRequest, _auth: None = Depends(require_auth)):
    """キーを保存/更新する。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: keychain.set_key(req.name, req.value))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=400, content=result)
    return result


@app.delete("/keys/{name}")
async def delete_key(name: str, _auth: None = Depends(require_auth)):
    """キーを削除する。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: keychain.delete_key(name))


# ローカル実行用エントリ（uvicorn main:app --reload と同等）
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
