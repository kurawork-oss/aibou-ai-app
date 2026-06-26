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
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import config
import forge
import income
import proactive
import tools
import vault
from memory_store import mem_add, mem_recall, mem_recent

app = FastAPI(
    title="AIbou Brain API",
    description="JARVIS的パーソナルAIアシスタントのバックエンド（chat / vision / tts / memory / income / video）",
    version="1.0.0",
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
async def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
    """APP_TOKEN が設定されていれば Authorization: Bearer <APP_TOKEN> を要求する。
    未設定ならオープン（誰でも叩ける）。/health はこの依存を付けない。"""
    if not config.APP_TOKEN:
        return  # 保護なし
    expected = f"Bearer {config.APP_TOKEN}"
    if not authorization or authorization.strip() != expected:
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
    model = config.get_gemini_model()

    # Geminiが未設定でも crash させず、SSEでエラーを通知する。
    if model is None:
        async def err_stream():
            yield _sse({"error": "GEMINI_API_KEY is not configured on the server."})
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
            stream = await loop.run_in_executor(
                None, lambda: model.generate_content(prompt, stream=True)
            )
            it = iter(stream)
            buf = ""
            decided = None  # None=判定中 / "tool" / "normal"

            while True:
                chunk = await loop.run_in_executor(None, _next, it)
                if chunk is None:
                    break
                text = getattr(chunk, "text", None) or ""
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
                    stream2 = await loop.run_in_executor(
                        None, lambda: model.generate_content(followup, stream=True)
                    )
                    it2 = iter(stream2)
                    while True:
                        c2 = await loop.run_in_executor(None, _next, it2)
                        if c2 is None:
                            break
                        t2 = getattr(c2, "text", None)
                        if t2:
                            collected.append(t2)
                            yield _sse({"token": t2})
                else:
                    collected.append(buf)
                    yield _sse({"token": buf})
        except Exception as e:
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

    try:
        audio_bytes = await _synthesize_tts(text, voice)
        if not audio_bytes:
            return {"audio_base64": "", "error": "tts produced no audio"}
        return {"audio_base64": base64.b64encode(audio_bytes).decode("ascii")}
    except Exception as e:
        # フォールバック: 空文字（フロント側で無音扱い）
        return {"audio_base64": "", "error": f"tts failed: {e}"}


async def _synthesize_tts(text: str, voice: str) -> bytes:
    """edge-tts で MP3 バイト列を生成する（asyncで実行）。"""
    import edge_tts
    communicate = edge_tts.Communicate(text, voice)
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


# ローカル実行用エントリ（uvicorn main:app --reload と同等）
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
