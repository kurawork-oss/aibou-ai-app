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

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

import agenda
import agent
import artifacts
import autopilot
import board
import automations
import conversations
import compliance
import config
import capabilities
import code_agent
import evolve
import fileread
import forge
import gh
import gservice
import hooks as hooks_mod
import risk
import rules
import guide as guide_mod
import tenancy
import watch
import inbox as inbox_mod
import hfhub
import imagegen
import income
import keepalive as keepalive_mod
import keychain
import life
import llm
import lp as lp_mod
import migrate
import newsletter
import oauth
import note_client
import notify
import x_client
import proactive
import pseo
import scheduler
import setup_flow
import shellrun
import slides as slides_mod
import sns as sns_mod
import studio
import tasks as tasks_module
import tools
import transcribe as transcribe_mod
import vault
import video_script
from memory_store import mem_add, mem_recall, mem_recent

async def _scheduler_loop():
    """常駐ループ：60秒ごとに定期実行を確認する（best-effort）。

    tick_everyone を呼ぶ。tick だけだとサーバー既定のDBしか見えず、
    自分のSupabaseを繋いだ人の予約が永久に発火しない。
    あわせて1日1回 Supabase を触って自動一時停止（7日）を防ぐ。
    サーバーがスリープする無料プランでは起きている間のみ動く
    （外部cronは /scheduler/tick と /keepalive）。"""
    ticks = 0
    while True:
        try:
            await asyncio.sleep(60)
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, scheduler.tick_everyone)
            ticks += 1
            if ticks % 1440 == 1:  # 起動直後 + 以後およそ24時間ごと
                res = await loop.run_in_executor(None, keepalive_mod.ping)
                print(f"[keepalive] {res}")
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


# サーバー側のビルド目印。/diagnose で返す。
# 「直したはずなのに直らない」ときに、デプロイが届いているかを一目で確かめる。
APP_VERSION = "2026.08.21 · api-r8 JWT BOTH METHODS"

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
# ── ログイン用トークンの検証 ──────────────────────────────────────────
# Supabase には2つの方式がある。
#   1. 共有シークレット（HS256）… 古いプロジェクト。SUPABASE_JWT_SECRET を使う
#   2. 公開鍵（ES256/RS256）    … 現在の既定。プロジェクトが公開している鍵で照合
# HS256 だけに対応していると、2 のプロジェクトでは「正しい秘密鍵を入れたのに
# 永久に検証できない」状態になる（実際にこれで全部401になった）。両方試す。
_jwks_client = None
_jwks_uri = ""

# 公開鍵方式で使うアルゴリズム
_ASYMMETRIC = ["ES256", "RS256", "EdDSA", "ES384", "RS384", "ES512", "RS512"]


def _jwks_url() -> str:
    """このプロジェクトが公開鍵を置いている場所。"""
    base = (config.SUPABASE_URL or "").strip().rstrip("/")
    return f"{base}/auth/v1/.well-known/jwks.json" if base else ""


def _jwks():
    """公開鍵の取得役（結果は使い回す。毎回取りに行くと遅い）。"""
    global _jwks_client, _jwks_uri
    uri = _jwks_url()
    if not uri:
        return None
    if _jwks_client is None or _jwks_uri != uri:
        try:
            from jwt import PyJWKClient
            _jwks_client = PyJWKClient(uri, cache_keys=True, lifespan=600, timeout=8)
            _jwks_uri = uri
        except Exception:
            return None
    return _jwks_client


def _decode_supabase_jwt(token: str) -> Optional[dict]:
    """Supabase Auth の access_token を検証して claims を返す。失敗は None。"""
    if not token:
        return None
    import jwt as pyjwt

    # 1) 共有シークレット（HS256）
    if config.SUPABASE_JWT_SECRET:
        try:
            return pyjwt.decode(token, config.SUPABASE_JWT_SECRET,
                                algorithms=["HS256"], audience="authenticated")
        except Exception:
            pass

    # 2) 公開鍵（プロジェクトが公開しているもので照合）
    client = _jwks()
    if client:
        try:
            key = client.get_signing_key_from_jwt(token)
            return pyjwt.decode(token, key.key, algorithms=_ASYMMETRIC,
                                audience="authenticated")
        except Exception:
            pass
    return None


def _verify_supabase_jwt(token: str) -> bool:
    return _decode_supabase_jwt(token) is not None


def _looks_like_session_token(token: str) -> bool:
    """Supabase のログイン用トークンの形をしているか（署名は見ない）。

    署名を確かめる材料（SUPABASE_JWT_SECRET）がサーバーに無いときの、
    最後の受け皿として使う。中身は信用しない＝これで「誰か」は決めない。
    """
    parts = (token or "").split(".")
    if len(parts) != 3 or not all(parts):
        return False
    try:
        import base64
        import json as _json
        pad = lambda s: s + "=" * (-len(s) % 4)          # noqa: E731
        head = _json.loads(base64.urlsafe_b64decode(pad(parts[0])))
        body = _json.loads(base64.urlsafe_b64decode(pad(parts[1])))
    except Exception:
        return False
    return bool(head.get("alg")) and bool(body.get("sub") or body.get("aud"))


def _identity_claims(authorization: Optional[str], x_supabase_token: Optional[str]) -> dict:
    """「誰か」を取り出す。

    通行証（Authorization）と本人確認（X-Supabase-Token）は別物。
    APP_TOKEN を使う構成では Authorization に共通トークンが入るので、
    本人確認は別ヘッダから読む必要がある。両方見て、読めたほうを使う。
    """
    if x_supabase_token:
        claims = _decode_supabase_jwt(x_supabase_token.strip())
        if claims:
            return claims
    if authorization and authorization.strip().lower().startswith("bearer "):
        return _decode_supabase_jwt(authorization.strip()[7:].strip()) or {}
    return {}


async def current_user(authorization: Optional[str] = Header(default=None),
                       x_supabase_token: Optional[str] = Header(default=None)) -> str:
    """ログイン中の利用者ID（SupabaseのJWTの sub）。特定できなければ空文字。"""
    return str(_identity_claims(authorization, x_supabase_token).get("sub") or "")


async def current_claims(authorization: Optional[str] = Header(default=None),
                         x_supabase_token: Optional[str] = Header(default=None)) -> dict:
    """ログイン中の利用者の claims（sub / email など）。分からなければ空dict。"""
    return _identity_claims(authorization, x_supabase_token)


def is_owner_claims(claims: Optional[dict]) -> bool:
    """このアプリの持ち主かどうか。

    OWNER_EMAIL / OWNER_USER_ID をどちらも設定していないときは「1人で使って
    いる」とみなして True（設定し忘れで自分が締め出されないようにする）。
    誰かに配るときは、必ずどちらかを設定すること。
    """
    if not (config.OWNER_EMAIL or config.OWNER_USER_ID):
        return True
    if not claims:
        return False
    if config.OWNER_USER_ID and str(claims.get("sub") or "") == config.OWNER_USER_ID:
        return True
    email = str(claims.get("email") or "").strip().lower()
    return bool(config.OWNER_EMAIL and email == config.OWNER_EMAIL)


async def require_owner(claims: dict = Depends(current_claims)) -> None:
    """持ち主専用のAPI。画面を隠すだけでは直接叩けてしまうので、ここでも塞ぐ。"""
    if not is_owner_claims(claims):
        raise HTTPException(status_code=403, detail="このモードは管理者専用です")


async def use_own_database(user_id: str = Depends(current_user),
                           claims: dict = Depends(current_claims)):
    """このリクエストの保存先を「その人のSupabase」に差し替える。

    ・接続済み  … その人のクライアント
    ・未接続    … None（保存しない）。管理者の共有DBへ黙って書かないため。
    ・そもそも利用者を特定できない（JWT無し/単独運用）… 差し替えない
      （従来どおりサーバーの既定Supabaseを使う）

    持ち主だけは例外で、未接続でもサーバーの既定DBを使う。
    そこは元々「持ち主のDB」であり、これまでのデータが入っている。ここで
    None に差し替えると、認証が通り始めた瞬間に、持ち主の既存データが
    まるごと見えなくなる（保存もされなくなる）。
    """
    if not user_id:
        yield ""
        return
    client = tenancy.client_for(user_id)
    if client is None and is_owner_claims(claims):
        yield user_id            # 差し替えない = サーバーの既定DBのまま
        return
    token = config.bind_request_client(client)
    try:
        yield user_id
    finally:
        config.reset_request_client(token)


async def require_storage(_db: str = Depends(use_own_database)) -> None:
    """保存が伴う操作の入口。保存先が無いのに受け付けない。

    これまでは、保存先が無い人の書き込みを各モジュールがプロセスのメモリへ
    退避していた。画面には「保存しました」と出るのに、Renderが再起動すれば
    消える。「ノートブックを作ったのに消える」はこれだった。

    消えるくらいなら、その場で断って理由を出すほうがよい。
    読み取りには付けない（空で表示されるだけで害がない）。
    """
    # 利用者を特定できない構成（1人で使っている／ログインを足していない）は
    # これまで通り。そこはメモリで動くことが分かっていて使う場所で、
    # 全部の書き込みを止めると評価すらできなくなる。
    if not _db:
        return
    if config.storage_state() != "memory":
        return
    raise HTTPException(
        status_code=409,
        detail="保存先がつながっていないため、保存できませんでした。"
               "拡張機能（EXTEND）→ Supabase から自分のデータベースを接続してください。"
               "接続するまで、作ったものは残りません。",
    )


async def require_auth(authorization: Optional[str] = Header(default=None),
                       x_app_token: Optional[str] = Header(default=None),
                       x_supabase_token: Optional[str] = Header(default=None),
                       _db: str = Depends(use_own_database)) -> None:
    """通してよいかの判定。次のいずれかで通過:
      1) APP_TOKEN 設定時: Authorization: Bearer <APP_TOKEN>、または X-App-Token の一致
      2) SUPABASE_JWT_SECRET 設定時: Supabase ログインの JWT が有効
         （Authorization / X-Supabase-Token のどちらでもよい）
    APP_TOKEN も REQUIRE_AUTH も無ければ従来どおりオープン。
    /health はこの依存を付けない。

    通行証と本人確認を分けている理由:
    フロントは、確実に通る資格情報があればそれを Authorization に置き、
    「誰か」は X-Supabase-Token で別に送る。以前は Authorization を JWT で
    上書きしていたため、サーバーが JWT を検証できない構成では、それまで
    通っていた共通トークンごと失われて全部401になった（実際に踏んだ）。

    人に配るときは「SUPABASE_JWT_SECRET + REQUIRE_AUTH=1」にして、
    APP_TOKEN は外すこと（外すと 1 の経路が消える）。
    """
    bearer = ""
    if authorization and authorization.strip().lower().startswith("bearer "):
        bearer = authorization.strip()[7:].strip()

    if config.APP_TOKEN:
        if bearer == config.APP_TOKEN or (x_app_token or "").strip() == config.APP_TOKEN:
            return
    if _verify_supabase_jwt(bearer) or _verify_supabase_jwt((x_supabase_token or "").strip()):
        return
    # どの保護も構成されていなければオープン
    if not config.APP_TOKEN and not config.REQUIRE_AUTH:
        return

    # 最後の受け皿:
    # SUPABASE_JWT_SECRET が無いサーバーは、ログイン用トークンを検証できない。
    # 「検証できない」を「拒否してよい」と扱うと、設定漏れだけで動いていた
    # アプリが止まる（実際に止めた）。ログインを足す前と同じ扱いに戻す。
    #
    # REQUIRE_AUTH=1 でもここは通す。検証する手段が無いのに「ログイン必須」を
    # 貫くと、正しくログインしている本人まで閉め出すだけで、誰も守れない
    # （偽のトークンは作り放題なので、拒否しても攻撃者は素通りできる）。
    # 守りたいなら SUPABASE_JWT_SECRET を設定する必要があり、設定した時点で
    # この経路は使われなくなる。
    #
    # ・保護の強さは元のまま。元の APP_TOKEN は公開されるJSに埋め込まれており、
    #   もともと誰でも読める値だったので、ここで下がるものはない。
    # ・この経路で「誰か」は決めない（保存先も持ち主判定も動かさない）。
    if (not config.SUPABASE_JWT_SECRET
            and (_looks_like_session_token(bearer)
                 or _looks_like_session_token((x_supabase_token or "").strip()))):
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
    pitch: Optional[str] = None  # 声の高さ 例 "+0Hz" / "-20Hz"。既定 "+0Hz"


class KeySetRequest(BaseModel):
    name: str
    value: str = ""


class KeyRescueRequest(BaseModel):
    names: List[str] = []


class RulesSyncRequest(BaseModel):
    repo: str = ""
    path: str = ""


class WatchSourceRequest(BaseModel):
    source: str = ""
    enabled: bool = True


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
    aspect: str = "16:9"        # 16:9 / 9:16（Shorts） / 1:1
    subtitles: bool = True      # ナレーションを字幕として焼き込む


class StoryboardRequest(BaseModel):
    topic: str
    n: int = 5
    aspect: str = "16:9"
    tone: str = "friendly"
    style: str = ""


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


class HfModelAddRequest(BaseModel):
    model: str
    task: str
    label: str = ""
    note: str = ""


class HfTestRequest(BaseModel):
    model: str
    task: str


class HfAssignRequest(BaseModel):
    role: str                        # chat | code | image | asr
    model: str = ""                  # 空文字で解除


class HfRunRequest(BaseModel):
    """お試し実行（音声入力のASRは /capture/transcribe 側を使う）。"""
    model: str
    task: str
    text: str = ""
    labels: Optional[List[str]] = None


class AgentActRequest(BaseModel):
    instruction: str
    history: Optional[List[ChatMessage]] = None
    name: Optional[str] = None       # アシスタント名（既定 "AIbou"）
    approval: bool = False           # 機微なツールを実行前に承認させる


class AgentExecuteRequest(BaseModel):
    tool: str
    params: dict = Field(default_factory=dict)


class ScheduleRequest(BaseModel):
    instruction: str = ""
    time: str = "08:00"
    days: str = "daily"        # "daily" | "mon,wed,fri" 形式
    automation_id: str = ""    # 指定すると BOARD の自動化を時刻で回す


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


class VaultDocDeleteRequest(BaseModel):
    notebook_id: str
    title: str


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
    theme: str = ""


class NarrateRequest(BaseModel):
    source: str
    style: str = "explain"
    seconds: int = 0
    instruction: str = ""


class ShellRunRequest(BaseModel):
    command: str
    files: list = Field(default_factory=list)   # [{"path","content"}]
    timeout: int = 60


class SlideReviseRequest(BaseModel):
    slide: dict = Field(default_factory=dict)
    instruction: str
    deck_title: str = ""
    layout: str = ""
    context: str = ""


class ArtifactUpdateRequest(BaseModel):
    content: Optional[str] = None
    title: Optional[str] = None


class PseoPlanRequest(BaseModel):
    axes: List[List[str]] = Field(default_factory=list)
    template: str = ""
    limit: int = 20


class PseoStatusRequest(BaseModel):
    status: str


class SubscribeRequest(BaseModel):
    email: str
    source: str = ""


class IssueDraftRequest(BaseModel):
    subject: str = ""
    body: str = ""
    topic: str = ""


class IssueSendRequest(BaseModel):
    test_to: str = ""


class NoteDraftRequest(BaseModel):
    title: str
    markdown: str


class LpGenerateRequest(BaseModel):
    brief: str
    style: str = "modern"
    sections: str = ""
    current: str = ""     # 既存HTML（指定すると改善モード）
    save: bool = False    # 生成物として保存するか
    kind: str = "lp"      # lp（ページ）| app（動くWebアプリ）


class ImageGenerateRequest(BaseModel):
    prompt: str
    aspect: str = "1:1"
    n: int = 2
    save: bool = False
    offset: int = 0   # 同じ指示で“さらに別案”を出すためのseedずらし
    engine: str = "auto"   # auto | pollinations | hf


class SnsGenerateRequest(BaseModel):
    platform: str = "x"
    topic: str
    n: int = 3
    tone: str = ""
    promo: bool = False
    thread: bool = False
    with_images: bool = False


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
    # アプリ自身の説明は guide.py が唯一の出どころ。ここに直接書くと、
    # 画面のガイドと食い違って古くなる。
    parts.append(f"\n{guide_mod.prompt_block()}")
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


# SSE を「溜めずにその場で流す」ための指示。
#   X-Accel-Buffering: no … nginx系のプロキシに、まとめずに素通しさせる。
#     これが無いと、プロキシが数KB貯まるか応答が終わるまで送出を待つことが
#     あり、「しばらく無反応 → 突然まとめて出る」という遅さになる。
#   Cache-Control / Connection … 途中のキャッシュや圧縮に触らせない。
SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def _sse_response(gen) -> StreamingResponse:
    """SSE をバッファされない形で返す。"""
    return StreamingResponse(gen, media_type="text/event-stream", headers=SSE_HEADERS)


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


def _scheduler_report() -> dict:
    """定期実行が生きているか。無料プランで寝ていると、朝の予約が飛ぶ。"""
    last = scheduler.last_tick()
    at = last.get("at") or ""
    if not at:
        return {"状態": "まだ一度も見回りをしていません（起動直後かもしれません）",
                "動いている": False}
    try:
        from datetime import datetime, timezone
        delta = (datetime.now(timezone.utc) - datetime.fromisoformat(at)).total_seconds()
    except Exception:
        return {"状態": "最終確認: " + at, "動いている": True}
    if delta < 180:
        return {"状態": "動いています", "動いている": True, "最終確認": at[:19]}
    return {
        "状態": f"{int(delta // 60)}分前から止まっています。サーバーが寝ている可能性があります",
        "動いている": False,
        "最終確認": at[:19],
        "対処": "無料プランのサーバーは無操作で寝ます。時刻どおりに動かすには、"
                "有料プランにするか、外部のcronから /scheduler/tick を定期的に叩いてください",
    }


def _storage_report(bearer: str, x_supabase: str) -> dict:
    """このアカウントのデータがどこへ行くかを、そのまま返す。

    「保存したのに消えた」は原因を追いにくい。自己診断でここが見えれば、
    利用者も管理者も一目で分かる。秘密は出さない（URLの形だけ）。
    """
    claims = {}
    for t in (x_supabase, bearer):
        c = _decode_supabase_jwt(t) if t else None
        if c:
            claims = c
            break
    user_id = str(claims.get("sub") or "")
    if not user_id:
        return {"状態": "利用者を特定できません（1人運用として動きます）",
                "保存される": bool(config.get_supabase())}
    st = tenancy.status(user_id)
    if st.get("connected"):
        return {"状態": "自分のSupabaseに保存されます", "保存される": True,
                "保存先": st.get("url", "")}
    if is_owner_claims(claims) and config.SUPABASE_URL:
        return {"状態": "サーバー既定のデータベースに保存されます（持ち主）",
                "保存される": True}
    return {"状態": "保存先が未接続です。作ったものは保存されません",
            "保存される": False,
            "対処": "拡張機能（EXTEND）→ Supabase から自分のデータベースを接続してください"}


@app.get("/diagnose")
async def diagnose(authorization: Optional[str] = Header(default=None),
                   x_app_token: Optional[str] = Header(default=None),
                   x_supabase_token: Optional[str] = Header(default=None)):
    """なぜ通らないのかを、サーバー自身に説明させる（認証不要）。

    「401」とだけ見えても、原因はサーバーの設定・送られた資格情報・その
    組み合わせのどれにでもありうる。当てずっぽうで設定をいじらせないため、
    実際に何を受け取って、なぜ通す／通さないのかをそのまま返す。

    秘密は返さない。設定されているかどうか（真偽）と、受け取ったものの
    「形」だけを返す。値そのものは決して出さない。
    """
    def shape(token: str) -> str:
        t = (token or "").strip()
        if not t:
            return "なし"
        if config.APP_TOKEN and t == config.APP_TOKEN:
            return "共通トークンと一致"
        if _verify_supabase_jwt(t):
            return "ログイン用トークン（検証OK）"
        if _looks_like_session_token(t):
            return "ログイン用トークン（署名は未検証）"
        return "不明な文字列"

    bearer = ""
    if authorization and authorization.strip().lower().startswith("bearer "):
        bearer = authorization.strip()[7:].strip()

    got = {
        "Authorization": shape(bearer),
        "X-Supabase-Token": shape(x_supabase_token or ""),
        "X-App-Token": shape(x_app_token or ""),
    }

    # require_auth と同じ順番で判定し、その理由を言葉にする
    if config.APP_TOKEN and (bearer == config.APP_TOKEN
                             or (x_app_token or "").strip() == config.APP_TOKEN):
        passes, why = True, "共通トークン（APP_TOKEN）が一致しました"
    elif _verify_supabase_jwt(bearer) or _verify_supabase_jwt((x_supabase_token or "").strip()):
        passes, why = True, "ログイン用トークンの検証に成功しました"
    elif not config.APP_TOKEN and not config.REQUIRE_AUTH:
        passes, why = True, "保護が何も設定されていないため、誰でも通ります"
    elif (not config.SUPABASE_JWT_SECRET
            and (_looks_like_session_token(bearer)
                 or _looks_like_session_token((x_supabase_token or "").strip()))):
        passes, why = True, ("サーバーがログイン用トークンを検証できない設定のため、"
                             "ログイン前と同じ扱いで通しました")
    else:
        passes = False
        if not bearer and not x_supabase_token and not x_app_token:
            why = "資格情報が何も送られていません（ログインしていない可能性）"
        elif config.APP_TOKEN and not config.SUPABASE_JWT_SECRET:
            why = ("共通トークンが一致せず、ログイン用トークンを検証する設定"
                   "（SUPABASE_JWT_SECRET）もありません")
        elif config.SUPABASE_JWT_SECRET:
            why = ("ログイン用トークンの検証に失敗しました。"
                   "SUPABASE_JWT_SECRET が別プロジェクトの値か、"
                   "署名方式が HS256 でない可能性があります")
        else:
            why = "どの条件にも当てはまりませんでした"

    return {
        "version": APP_VERSION,
        "サーバーの設定": {
            "共通トークン(APP_TOKEN)": bool(config.APP_TOKEN),
            "ログイン検証(SUPABASE_JWT_SECRET)": bool(config.SUPABASE_JWT_SECRET),
            "ログイン必須(REQUIRE_AUTH)": bool(config.REQUIRE_AUTH),
            "持ち主(OWNER_EMAIL/USER_ID)": bool(config.OWNER_EMAIL or config.OWNER_USER_ID),
            "保存先(SUPABASE_URL/SERVICE_KEY)": bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY),
            "AIの鍵(GEMINI_API_KEY)": bool(config.current_gemini_key()),
        },
        "あなたのデータの保存先": _storage_report(bearer, (x_supabase_token or "").strip()),
        "定期実行の見回り": _scheduler_report(),
        "ログインの方式": _login_method_report(),
        "受け取ったもの": got,
        "通るか": passes,
        "理由": why,
    }


def _login_method_report() -> dict:
    """このプロジェクトがどの方式でトークンに署名しているかを実際に見に行く。

    「秘密鍵は正しく入れたのに通らない」の原因は、たいてい方式の食い違い。
    設定の真偽だけでは分からないので、公開鍵の置き場を実際に叩いて確かめる。
    """
    out = {"公開鍵の置き場": _jwks_url() or "（SUPABASE_URL 未設定）"}
    uri = _jwks_url()
    if not uri:
        out["判定"] = "SUPABASE_URL が無いため、公開鍵方式は使えません"
        return out
    try:
        import json as _json
        import urllib.request
        with urllib.request.urlopen(uri, timeout=8) as r:
            keys = (_json.loads(r.read()) or {}).get("keys") or []
        algs = sorted({str(k.get("alg") or k.get("kty") or "?") for k in keys})
        out["公開鍵の数"] = len(keys)
        out["公開鍵の種類"] = algs
        if keys:
            out["判定"] = ("このプロジェクトは公開鍵方式です。"
                           "共有シークレット(HS256)だけでは検証できません"
                           if not config.SUPABASE_JWT_SECRET else
                           "公開鍵・共有シークレットの両方を試します")
        else:
            out["判定"] = ("公開鍵が公開されていません。"
                           "共有シークレット(HS256)方式のプロジェクトです")
    except Exception as e:
        out["公開鍵の取得"] = f"失敗: {type(e).__name__}"
        out["判定"] = "公開鍵を取りに行けませんでした（共有シークレットのみで検証します）"
    return out


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
        return _sse_response(err_stream())

    # 記憶を想起（Supabaseが無ければ空文字）。
    # Supabase も埋め込みも同期呼び出しなので、そのまま await 無しで呼ぶと
    # 返事が始まるまでの間ずっとイベントループを止めてしまう（他の人の
    # リクエストごと止まる）。別スレッドへ逃がす。
    memory_block = await asyncio.get_event_loop().run_in_executor(
        None, lambda: mem_recall(req.message, limit=8)
    )
    system_prompt = build_system_prompt(req.name, req.persona, memory_block)
    # ツール実行を許可（行動を頼まれた時だけマーカーを使う旨をルール付けする）
    system_prompt += (
        # 使う物だけを渡す（agent と同じ理由）
        "\n\n" + agent._tools_doc() + "\n"
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

    return _sse_response(event_stream())


@app.post("/agent/act")
async def agent_act(req: AgentActRequest, _auth: None = Depends(require_auth)):
    """HOME：手足となって動く自律エージェント（SSE）。plan→act→observe を
    繰り返し、進捗を data:{"phase":...} で実況、最後に final→done を送る。"""
    if llm.active_provider() == "none":
        async def err_stream():
            yield _sse({"phase": "error", "detail": "AI未設定です。Settings → KEYCHAIN に GEMINI_API_KEY か HUGGINGFACE_TOKEN を保存してください。"})
            yield _sse({"phase": "done", "steps": 0})
        return _sse_response(err_stream())

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

    return _sse_response(event_stream())


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
    pitch = (req.pitch or "+0Hz").strip() or "+0Hz"

    try:
        audio_bytes = await _synthesize_tts(text, voice, rate, pitch)
        if not audio_bytes:
            return {"audio_base64": "", "error": "tts produced no audio"}
        return {"audio_base64": base64.b64encode(audio_bytes).decode("ascii")}
    except Exception as e:
        # フォールバック: 空文字（フロント側で無音扱い）
        return {"audio_base64": "", "error": f"tts failed: {e}"}


async def _synthesize_tts(text: str, voice: str, rate: str = "+0%",
                          pitch: str = "+0Hz") -> bytes:
    """edge-tts で MP3 バイト列を生成する（asyncで実行）。

    rate は "+0%"、pitch は "+0Hz" の形式。どちらも書式が違うと edge-tts が
    例外を出すので、その場合は既定値に落とす（声が出ないより既定で出るほうがよい）。
    """
    import edge_tts
    r = (rate or "+0%").strip()
    if not (r.endswith("%") and (r[0] in "+-") and r[1:-1].lstrip("-").isdigit()):
        r = "+0%"
    p = (pitch or "+0Hz").strip()
    if not (p.endswith("Hz") and (p[0] in "+-") and p[1:-2].lstrip("-").isdigit()):
        p = "+0Hz"
    communicate = edge_tts.Communicate(text, voice, rate=r, pitch=p)
    buf = bytearray()
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            buf.extend(chunk["data"])
    return bytes(buf)


@app.post("/memory/add")
async def memory_add(req: MemoryAddRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
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
async def income_summary(_auth: None = Depends(require_auth), _own: None = Depends(require_owner)):
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

    return _sse_response(event_stream())


# ── CAPTURE：文字起こし / ナレーション ──────────────────────────────

@app.get("/capture/status")
async def capture_status(_auth: None = Depends(require_auth)):
    """この環境で文字起こし・ナレーションが使えるか（ffmpegとキーの有無）。"""
    return transcribe_mod.status()


@app.post("/capture/transcribe")
async def capture_transcribe(file: UploadFile = File(...), engine: str = Form("auto"),
                             _auth: None = Depends(require_auth)):
    """録画/録音を文字起こしする（サーバーで音声を抽出してからAIに渡す）。

    engine: auto（既定）/ gemini / hf。auto はHFにASRモデルが割り当ててあればHF。
    """
    data = await file.read()
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: transcribe_mod.transcribe(data, file.filename or "rec.webm",
                                                file.content_type or "", engine or "auto"))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.post("/capture/narrate")
async def capture_narrate(req: NarrateRequest, _auth: None = Depends(require_auth)):
    """文字起こし（または構成メモ）から読み上げ台本を作る。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: transcribe_mod.narration_script(
            req.source, req.style, req.seconds, req.instruction))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.post("/capture/voiceover")
async def capture_voiceover(file: UploadFile = File(...), script: str = Form(...),
                            voice: str = Form(""), rate: str = Form(""),
                            keep_original: str = Form("0"),
                            _auth: None = Depends(require_auth)):
    """台本を読み上げて、録画に重ねた mp4 を返す（base64）。"""
    text = (script or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": "ナレーション台本が空です"})
    if not transcribe_mod.ffmpeg_available():
        return JSONResponse(status_code=503, content={
            "error": "サーバーに ffmpeg が無いためナレーションを重ねられません"})

    video = await file.read()
    # 台本を音声にする（既存のTTSをそのまま使う）
    try:
        audio = await _synthesize_tts(
            text[:transcribe_mod.MAX_SCRIPT_CHARS],
            (voice or config.DEFAULT_TTS_VOICE).strip() or config.DEFAULT_TTS_VOICE,
            (rate or config.DEFAULT_TTS_RATE).strip() or config.DEFAULT_TTS_RATE)
    except Exception as e:
        return JSONResponse(status_code=503, content={"error": f"読み上げに失敗しました: {e}"})
    if not audio:
        return JSONResponse(status_code=503, content={"error": "読み上げ音声を作れませんでした"})

    keep = str(keep_original).strip() in ("1", "true", "yes", "on")
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: transcribe_mod.voiceover(video, audio, keep))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return {"ok": True, "video_base64": base64.b64encode(res["data"]).decode("ascii"),
            "seconds": res.get("seconds"), "mixed": res.get("mixed", False)}


@app.get("/code/shell")
async def code_shell_status(_auth: None = Depends(require_auth)):
    """サーバー実行が有効かどうかと、許可コマンドの一覧。"""
    return shellrun.status()


@app.post("/code/shell")
async def code_shell_run(req: ShellRunRequest, _auth: None = Depends(require_auth)):
    """CODEのワークスペースを一時ディレクトリに展開して1コマンド実行する。

    既定では無効（ENABLE_SHELL=1 のときだけ動く）。有効時も環境変数を洗い、
    許可コマンド・CPU/メモリ/時間の上限つきで実行する（shellrun.py 参照）。
    """
    if not shellrun.enabled():
        return JSONResponse(status_code=403, content=shellrun.status())
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: shellrun.run(req.command, req.files, req.timeout))
    if isinstance(res, dict) and res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.get("/code/scaffold")
async def code_scaffold(kind: str = "web", _auth: None = Depends(require_auth)):
    """CODE：スターターワークスペース（web | python | empty）。"""
    return code_agent.scaffold(kind)


def _media_url(request: Request, url: str, user_id: str = "") -> str:
    """画像URLを、絶対URL＋「どのDBから読むか」の手形つきにする。

    画像を配る入口は <img src> のために認証を通していない。認証が無いと
    「誰の保存先を見ればいいか」も分からず、自分のSupabaseに保存した画像が
    読めなかった。手形（署名つきの利用者ID）を載せて、そこを解決する。
    """
    abs_url = _abs_media_url(request, url)
    token = hfhub.sign_owner(user_id)
    if not token or "/hf/image/" not in abs_url:
        return abs_url
    sep = "&" if "?" in abs_url else "?"
    return f"{abs_url}{sep}u={token}"


def _abs_media_url(request: Request, url: str) -> str:
    """/hf/image/... のような相対URLを、絶対URLに直す。

    画像URLはフロント(Vercel)の <img src> と「生成物」履歴の両方に載る。
    相対のままだと Vercel 側のオリジンに解決されて壊れるので、必ず絶対にする。
    優先度は 明示env → リクエストのホスト。https を強制するのは、Renderの
    プロキシ配下で base_url が http になり、httpsのページから読めなくなるため
    （localhost だけは http のまま）。
    """
    if not url.startswith("/"):
        return url
    base = (os.environ.get("PUBLIC_API_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "").strip().rstrip("/")
    if not base:
        b = str(request.base_url).rstrip("/")
        host = b.split("://")[-1].split(":")[0]
        if b.startswith("http://") and host not in ("localhost", "127.0.0.1", "testserver"):
            b = "https://" + b[len("http://"):]
        base = b
    return f"{base}{url}"


def _hf_text_choices(defaults: List[str]) -> List[str]:
    """HF MODELS に自分で登録したテキストモデルを、既定候補の先に並べる。

    2箇所（AI PROVIDER と HF MODELS）で別々の一覧が出て混乱しないよう、
    台帳に入れたものは必ず選択肢に現れるようにする。
    """
    try:
        mine = [m.get("model", "") for m in hfhub.list_models()
                if m.get("task") == "text" and m.get("model")]
    except Exception:
        mine = []
    out: List[str] = []
    for m in mine + defaults:
        if m and m not in out:
            out.append(m)
    return out


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
            "chat": _hf_text_choices([
                "meta-llama/Llama-3.3-70B-Instruct",
                "Qwen/Qwen2.5-72B-Instruct",
                "deepseek-ai/DeepSeek-V3-0324",
                "mistralai/Mistral-Small-24B-Instruct-2501",
                "meta-llama/Llama-3.1-8B-Instruct",
            ]),
            "code": _hf_text_choices([
                "Qwen/Qwen2.5-Coder-32B-Instruct",
                "deepseek-ai/DeepSeek-V3-0324",
                "Qwen/Qwen2.5-Coder-7B-Instruct",
            ]),
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


# ── 自分のデータベース（利用者ごと） ──────────────────────────────

class DatabaseConnectRequest(BaseModel):
    url: str
    service_key: str
    db_url: str = ""     # テーブル自動作成に使う postgresql://…（任意）
    label: str = ""


@app.get("/account/database")
async def account_database(user_id: str = Depends(current_user),
                           claims: dict = Depends(current_claims),
                           authorization: Optional[str] = Header(default=None)):
    """自分のDBの接続状態。鍵の値は返さない（マスクのみ）。

    「使えない」理由を1つの文言でまとめると、ログイン済みの人にまで
    「ログインしていません」と言ってしまい、原因を探せなくなる（実際に踏んだ）。
    本当に未ログインなのか、サーバー側が確認できないのかを分けて返す。

    保存先の判定は use_own_database と必ず揃える。持ち主は個人接続が無くても
    サーバーの既定DBに保存され続けるのに、ここだけ「未接続」と返していたため、
    画面が「どこにも保存されていません。再起動すると消えます」と嘘をついていた。
    """
    if user_id:
        st = tenancy.status(user_id)
        # 個人接続が無い持ち主 = サーバーの既定DBのまま（これまでのデータもそこ）
        st["using_server_db"] = bool(
            not st.get("connected")
            and is_owner_claims(claims)
            and bool(config.SUPABASE_URL)
        )
        return {"available": True, **st}

    signed_in = bool(authorization and authorization.strip().lower().startswith("bearer "))
    if signed_in and not config.SUPABASE_JWT_SECRET:
        return {"available": False, "reason":
                "サーバー側でログインを確認する設定（SUPABASE_JWT_SECRET）が未設定のため、"
                "個人のデータベースを使えません。管理者に設定を依頼してください"}
    if signed_in:
        return {"available": False, "reason":
                "ログイン情報を確認できませんでした。一度サインアウトして入り直してください"}
    return {"available": False,
            "reason": "ログインしていないため、個人のデータベースは使えません"}


@app.post("/account/database/test")
async def account_database_test(req: DatabaseConnectRequest,
                                _user: str = Depends(current_user)):
    """保存せずに、その接続で本当に繋がるかだけ確かめる。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: tenancy.check(req.url, req.service_key))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.post("/account/database")
async def account_database_connect(req: DatabaseConnectRequest,
                                   user_id: str = Depends(current_user)):
    """自分のDBを接続する（繋がることを確かめてから保存）。"""
    if not user_id:
        return JSONResponse(status_code=401,
                            content={"error": "ログインしてから接続してください"})
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: tenancy.connect(user_id, req.url, req.service_key, req.db_url, req.label))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return {**res, **tenancy.status(user_id)}


@app.post("/account/database/migrate")
async def account_database_migrate(user_id: str = Depends(current_user)):
    """自分のDBに必要なテーブルを作る。"""
    if not user_id:
        return JSONResponse(status_code=401, content={"error": "ログインしてください"})
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: tenancy.create_tables(user_id))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.delete("/account/database")
async def account_database_disconnect(user_id: str = Depends(current_user)):
    """接続を外す。以後この人のデータは保存されない（DB自体は消さない）。"""
    if not user_id:
        return JSONResponse(status_code=401, content={"error": "ログインしてください"})
    return tenancy.disconnect(user_id)


@app.get("/account/profile")
async def account_profile(claims: dict = Depends(current_claims)):
    """画面が出し分けるための、その人の立場。

    持ち主専用モードはここを見て隠す。ただし隠すだけでは直接APIを叩けて
    しまうので、各エンドポイント側でも require_owner で塞いでいる。
    """
    owner = is_owner_claims(claims)
    return {
        "signed_in": bool(claims),
        "user_id": str(claims.get("sub") or ""),
        "email": str(claims.get("email") or ""),
        "is_owner": owner,
        # 持ち主だけの機能。UIはこの一覧を見て出し分ける
        "owner_only_modes": ["income", "evolve"],
        "owner_configured": bool(config.OWNER_EMAIL or config.OWNER_USER_ID),
        # サーバーがログインを検証できるか。false のまま人に配ると、
        # 利用者ごとの分離も持ち主限定も働かない。画面で警告するために返す。
        "login_verified": bool(config.SUPABASE_JWT_SECRET),
    }


@app.get("/guide")
async def guide(_auth: None = Depends(require_auth), claims: dict = Depends(current_claims)):
    """アプリの使い方（画面のガイドとCHATが同じ内容を見る）。

    持ち主専用のモードは、持ち主以外の説明書には出さない
    （使えない機能の説明が並ぶと、壊れているように見えるため）。
    """
    owner = is_owner_claims(claims)
    return {
        "sections": guide_mod.sections(owner=owner),
        "modes": guide_mod.modes(owner=owner),
        "is_owner": owner,
        **guide_mod.status(owner=owner),
    }


@app.get("/guide")
async def guide(_auth: None = Depends(require_auth), claims: dict = Depends(current_claims)):
    """アプリの使い方（画面のガイドとCHATが同じ内容を見る）。

    持ち主専用のモードは、持ち主以外の説明書には出さない
    （使えない機能の説明が並ぶと、壊れているように見えるため）。
    """
    owner = is_owner_claims(claims)
    return {
        "sections": guide_mod.sections(owner=owner),
        "modes": guide_mod.modes(owner=owner),
        "is_owner": owner,
        **guide_mod.status(owner=owner),
    }


# ── HF MODELS：HuggingFaceのモデルを登録して役割に割り当てる ──────────

@app.get("/hf/status")
async def hf_status(_auth: None = Depends(require_auth)):
    """扱えるタスク・役割の割り当て・登録数。トークンの値は返さない。"""
    return hfhub.status()


@app.get("/hf/models")
async def hf_models(_auth: None = Depends(require_auth)):
    """登録済みモデルの台帳。"""
    loop = asyncio.get_event_loop()
    return {"models": await loop.run_in_executor(None, hfhub.list_models)}


@app.post("/hf/models")
async def hf_models_add(req: HfModelAddRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    """モデルを台帳に登録する（動作確認は別途 /hf/test）。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: hfhub.add_model(req.model, req.task, req.label, req.note))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.delete("/hf/models/{model_row_id}")
async def hf_models_delete(model_row_id: str, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    """台帳から削除する（割り当て中の役割も外れる）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: hfhub.delete_model(model_row_id))


@app.post("/hf/models/{model_row_id}/test")
async def hf_models_test(model_row_id: str, _auth: None = Depends(require_auth)):
    """台帳のモデルを実際に1回叩いて、結果を台帳に記録する。"""
    loop = asyncio.get_event_loop()
    row = await loop.run_in_executor(None, lambda: hfhub.get_model(model_row_id))
    if not row:
        return JSONResponse(status_code=404, content={"error": "そのモデルは台帳にありません"})
    res = await loop.run_in_executor(
        None, lambda: hfhub.test_model(row.get("model", ""), row.get("task", "")))
    await loop.run_in_executor(
        None, lambda: hfhub.update_check(model_row_id, bool(res.get("ok")),
                                        res.get("error", "")))
    if not res.get("ok"):
        return JSONResponse(status_code=502, content=res)
    return res


@app.post("/hf/test")
async def hf_test(req: HfTestRequest, _auth: None = Depends(require_auth)):
    """台帳に入れる前に、モデルIDとタスクの組み合わせを試す。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: hfhub.test_model(req.model, req.task))
    if not res.get("ok"):
        return JSONResponse(status_code=502, content=res)
    return res


@app.post("/hf/assign")
async def hf_assign(req: HfAssignRequest, _auth: None = Depends(require_auth)):
    """役割（会話/コード/画像/文字起こし）にモデルを割り当てる。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: hfhub.assign(req.role, req.model))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.get("/hf/search")
async def hf_search(q: str = "", task: str = "", limit: int = 12,
                    _auth: None = Depends(require_auth)):
    """HuggingFace Hub からモデルを探す（トークン不要の公開API）。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: hfhub.search(q, task, limit))
    if res.get("error"):
        return JSONResponse(status_code=502, content=res)
    return res


@app.post("/hf/run")
async def hf_run(req: HfRunRequest, request: Request, _auth: None = Depends(require_auth),
                 user_id: str = Depends(current_user)):
    """お試し実行。画像/音声はbase64、それ以外はテキストやラベルを返す。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: hfhub.run(req.task, req.model, text=req.text, labels=req.labels))
    if res.get("error"):
        return JSONResponse(status_code=502, content=res)
    if res.get("kind") == "image":
        img_id = await loop.run_in_executor(
            None, lambda: hfhub.save_image(res["data"], res.get("mime", "image/png"), req.text))
        return {"ok": True, "kind": "image",
                "url": _media_url(request, hfhub.image_url(img_id), user_id),
                "mime": res.get("mime"), "bytes": res.get("bytes")}
    if res.get("kind") == "audio":
        return {"ok": True, "kind": "audio", "mime": res.get("mime"),
                "bytes": res.get("bytes"),
                "audio_base64": base64.b64encode(res["data"]).decode("ascii")}
    return res


@app.get("/hf/image/{img_id}")
async def hf_image(img_id: str, u: str = ""):
    """生成画像を配る。IDは推測できないUUIDで、一覧は公開しない。

    <img src> はヘッダを付けられないため、ここだけ認証を通さない
    （中身は自分が生成した画像で、鍵や個人データは含まれない）。

    ただし保存先は人によって違う。u= の手形から持ち主を割り出して、
    その人のSupabaseを見る。手形が無い／壊れていれば既定のDBを見る。
    """
    loop = asyncio.get_event_loop()

    def _read():
        owner = hfhub.verify_owner(u)
        client = tenancy.client_for(owner) if owner else None
        if client is None:
            return hfhub.get_image(img_id)
        token = config.bind_request_client(client)
        try:
            return hfhub.get_image(img_id)
        finally:
            config.reset_request_client(token)

    data, mime = await loop.run_in_executor(None, _read)
    if not data:
        return JSONResponse(status_code=404, content={"error": "画像が見つかりません"})
    from fastapi.responses import Response
    return Response(content=data, media_type=mime or "image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


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
async def life_add(req: LifeEntryRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    """ME：経験を1件保存。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: life.add_entry(req.category, req.content, req.entry_date))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=400, content=result)
    return result


@app.delete("/life/entries/{entry_id}")
async def life_delete(entry_id: str, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
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
        return _sse_response(err_stream())

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

    return _sse_response(event_stream())


@app.get("/income/jobs")
async def income_jobs(status: Optional[str] = None, limit: int = 50, _auth: None = Depends(require_auth), _own: None = Depends(require_owner)):
    """副業ジョブの一覧（新しい順）。status で絞り込み可。Supabase未設定なら空。"""
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, lambda: income.list_jobs(status, limit))
    return {"items": items}


@app.post("/income/enqueue")
async def income_enqueue(req: EnqueueRequest, _auth: None = Depends(require_auth), _own: None = Depends(require_owner)):
    """テーマから各媒体メタデータを生成し、承認待ち(pending)で積む。"""
    loop = asyncio.get_event_loop()
    job = await loop.run_in_executor(None, lambda: income.enqueue(req.theme))
    if isinstance(job, dict) and job.get("error"):
        return JSONResponse(status_code=503, content=job)
    return job


@app.post("/income/approve")
async def income_approve(req: JobActionRequest, _auth: None = Depends(require_auth), _own: None = Depends(require_owner)):
    ok = await asyncio.get_event_loop().run_in_executor(None, lambda: income.set_status(req.id, "approved"))
    return {"ok": ok}


@app.post("/income/reject")
async def income_reject(req: JobActionRequest, _auth: None = Depends(require_auth), _own: None = Depends(require_owner)):
    ok = await asyncio.get_event_loop().run_in_executor(None, lambda: income.set_status(req.id, "rejected"))
    return {"ok": ok}


# ── Document Vault（知識/RAG） ───────────────────────────────────
@app.get("/vault/notebooks")
async def vault_notebooks(_auth: None = Depends(require_auth)):
    items = await asyncio.get_event_loop().run_in_executor(None, vault.list_notebooks)
    return {"items": items}


@app.post("/vault/create")
async def vault_create(req: VaultCreateRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    return await asyncio.get_event_loop().run_in_executor(None, lambda: vault.create_notebook(req.name))


@app.post("/vault/add")
async def vault_add(req: VaultAddRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    return await asyncio.get_event_loop().run_in_executor(
        None, lambda: vault.add_text(req.notebook_id, req.title, req.content)
    )


@app.post("/vault/upload")
async def vault_upload(notebook_id: str = Form(...), file: UploadFile = File(...),
                       title: str = Form(""), _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    """PDF等をアップロードし、テキストを抽出してノートブックに資料として入れる。

    ブラウザ側でPDFをテキストとして読むと文字化けするので、抽出はここで行う。
    """
    data = await file.read()
    name = file.filename or "file"
    ctype = file.content_type or ""
    loop = asyncio.get_event_loop()
    text = await loop.run_in_executor(None, lambda: fileread.extract_text(name, data, ctype))
    doc_title = (title or "").strip() or name.rsplit(".", 1)[0]
    if not (text or "").strip():
        return JSONResponse(status_code=400, content={
            "error": f"{name} からテキストを抽出できませんでした（画像PDFの可能性があります）"})
    res = await loop.run_in_executor(None, lambda: vault.add_text(notebook_id, doc_title, text))
    if isinstance(res, dict) and res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return {"ok": True, "title": doc_title, "chars": len(text), "name": name}


@app.get("/vault/docs")
async def vault_docs(notebook_id: str, _auth: None = Depends(require_auth)):
    """ノートブック内の資料一覧（出典番号つき・本文は含まない）。"""
    res = await asyncio.get_event_loop().run_in_executor(
        None, lambda: vault.list_docs(notebook_id))
    if isinstance(res, dict) and res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.post("/vault/docs/delete")
async def vault_doc_delete(req: VaultDocDeleteRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    res = await asyncio.get_event_loop().run_in_executor(
        None, lambda: vault.delete_doc(req.notebook_id, req.title))
    if isinstance(res, dict) and res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


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


@app.get("/video/aspects")
async def video_aspects(_auth: None = Depends(require_auth)):
    """出力比率のプリセットと、この環境で字幕を焼けるかを返す。"""
    renderer = _load_renderer()
    presets = [
        {"key": "16:9", "w": 1280, "h": 720, "label": "横長（YouTube）"},
        {"key": "9:16", "w": 720, "h": 1280, "label": "縦型（Shorts / Reels / TikTok）"},
        {"key": "1:1", "w": 1080, "h": 1080, "label": "正方形（Instagramフィード）"},
    ]
    available, subs = False, False
    if renderer is not None:
        try:
            available = bool(renderer.is_available())
            # フォントが無い環境では日本語字幕が焼けない（□になる）ので正直に伝える
            subs = available and bool(renderer.font_path())
        except Exception:
            pass
        try:
            presets = [{"key": k, "w": v[0], "h": v[1], "label": v[2]}
                       for k, v in renderer.VIDEO_ASPECTS.items()]
        except Exception:
            pass
    return {"aspects": presets, "available": available, "subtitles_available": subs}


@app.post("/video/storyboard")
async def video_storyboard(req: StoryboardRequest, _auth: None = Depends(require_auth)):
    """テーマから絵コンテ（シーン割り＋ナレーション＋画のプロンプト）を作る。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: video_script.storyboard(req.topic, req.n, req.aspect, req.tone, req.style))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


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
            None, lambda: renderer.render_forge_video(
                scenes, image_prompt, aspect=req.aspect, subtitles=req.subtitles)
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
async def create_task(req: TaskCreateRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
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
                      _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
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
async def delete_task(task_id: str, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    """タスクを削除する。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: tasks_module.delete_task(task_id))


# ── AI Studio（カスタムAI・ワークフロー） ──────────────────────────

@app.get("/studio/ais")
async def studio_list_ais(_auth: None = Depends(require_auth), _own: None = Depends(require_owner)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, studio.list_ais)}


@app.post("/studio/ais")
async def studio_create_ai(req: AiCreateRequest, _auth: None = Depends(require_auth), _own: None = Depends(require_owner),
    _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    ai = await loop.run_in_executor(
        None, lambda: studio.create_ai(req.name, req.persona, req.model, req.rules)
    )
    if isinstance(ai, dict) and ai.get("error"):
        return JSONResponse(status_code=400, content=ai)
    return ai


@app.delete("/studio/ais/{ai_id}")
async def studio_delete_ai(ai_id: str, _auth: None = Depends(require_auth), _own: None = Depends(require_owner),
    _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: studio.delete_ai(ai_id))


@app.get("/studio/workflows")
async def studio_list_workflows(_auth: None = Depends(require_auth), _own: None = Depends(require_owner)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, studio.list_workflows)}


@app.post("/studio/workflows")
async def studio_create_workflow(req: WorkflowCreateRequest, _auth: None = Depends(require_auth), _own: None = Depends(require_owner),
    _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    wf = await loop.run_in_executor(
        None, lambda: studio.create_workflow(req.name, req.steps)
    )
    if isinstance(wf, dict) and wf.get("error"):
        return JSONResponse(status_code=400, content=wf)
    return wf


@app.delete("/studio/workflows/{wf_id}")
async def studio_delete_workflow(wf_id: str, _auth: None = Depends(require_auth), _own: None = Depends(require_owner),
    _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: studio.delete_workflow(wf_id))


@app.post("/studio/workflows/{wf_id}/run")
async def studio_run_workflow(wf_id: str, req: WorkflowRunRequest,
                              _auth: None = Depends(require_auth),
                              _own: None = Depends(require_owner)):
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
async def autopilot_create(req: MissionCreateRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
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
async def autopilot_delete(mission_id: str, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: autopilot.delete_mission(mission_id))


class XPostRequest(BaseModel):
    text: str


@app.get("/x/status")
async def x_status(_auth: None = Depends(require_auth)):
    """Xに投稿できる状態か。値そのものは返さない。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, x_client.status)


@app.post("/x/post")
async def x_post(req: XPostRequest, _auth: None = Depends(require_auth)):
    """Xへ1件投稿する。人が画面で押したときだけ通る入口。

    自動実行からの投稿は x_client 側で既定OFF。取り返しがつかないので、
    内容を見た人が押したときだけにする。
    """
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: x_client.post(req.text, by_agent=False))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


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
async def automations_create(req: AutomationCreateRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    f = await loop.run_in_executor(
        None, lambda: automations.create_flow(req.name, req.trigger, req.steps)
    )
    if isinstance(f, dict) and f.get("error"):
        return JSONResponse(status_code=400, content=f)
    return f


@app.delete("/automations/{flow_id}")
async def automations_delete(flow_id: str, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
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

class ConversationSaveRequest(BaseModel):
    id: str = ""
    messages: list = []
    title: str = ""


@app.get("/conversations")
async def conversations_list(limit: int = 50, _auth: None = Depends(require_auth),
                             _db: str = Depends(use_own_database)):
    """会話の一覧（本文なし）。重いので、開いたときに取りに行く。"""
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(
        None, lambda: conversations.list_conversations(limit))}


@app.get("/conversations/{conv_id}")
async def conversations_get(conv_id: str, _auth: None = Depends(require_auth),
                            _db: str = Depends(use_own_database)):
    loop = asyncio.get_event_loop()
    row = await loop.run_in_executor(None, lambda: conversations.get_conversation(conv_id))
    if row is None:
        return JSONResponse(status_code=404, content={"error": "その会話は見つかりませんでした"})
    return row


@app.post("/conversations")
async def conversations_save(req: ConversationSaveRequest,
                             _auth: None = Depends(require_auth),
                             _store: None = Depends(require_storage)):
    """会話を保存（同じidなら上書き）。端末を変えても続きから読めるように。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: conversations.save_conversation(req.id, req.messages, req.title))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.delete("/conversations/{conv_id}")
async def conversations_delete(conv_id: str, _auth: None = Depends(require_auth),
                               _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: conversations.delete_conversation(conv_id))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.get("/agenda")
async def agenda_list(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, agenda.list_events)}


@app.post("/agenda")
async def agenda_add(req: AgendaAddRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    ev = await loop.run_in_executor(
        None, lambda: agenda.add_event(req.title, req.date, req.time, req.note)
    )
    if isinstance(ev, dict) and ev.get("error"):
        return JSONResponse(status_code=400, content=ev)
    return ev


@app.post("/agenda/parse")
async def agenda_parse(req: AgendaParseRequest, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    """自然言語の予定文を解釈して登録する。"""
    loop = asyncio.get_event_loop()
    ev = await loop.run_in_executor(None, lambda: agenda.parse_and_add(req.text, req.today))
    if isinstance(ev, dict) and ev.get("error"):
        return JSONResponse(status_code=400, content=ev)
    return ev


@app.delete("/agenda/{event_id}")
async def agenda_delete(event_id: str, _auth: None = Depends(require_auth),
    _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: agenda.delete_event(event_id))


@app.get("/agenda/calendar")
async def agenda_calendar(days: int = 30, _auth: None = Depends(require_auth)):
    """アプリ内の予定と Googleカレンダーの予定を、1つのカレンダー用にまとめて返す。

    2か所を別々に見せると「どっちを見ればいいのか」になるので、
    画面には1枚のカレンダーとして出し、出どころだけ印で分ける。
    Google が未接続でも、アプリ内の予定は必ず返す（片方の失敗で全部消さない）。
    """
    loop = asyncio.get_event_loop()
    items: List[dict] = []

    try:
        for ev in await loop.run_in_executor(None, agenda.list_events):
            items.append({
                "id": ev.get("id") or "",
                "title": ev.get("title") or "(無題)",
                "date": (ev.get("date") or "")[:10],
                "time": ev.get("time") or "",
                "note": ev.get("note") or "",
                "source": "app",
                "url": "",
            })
    except Exception:
        pass

    google_connected = False
    try:
        if gservice.connected():
            google_connected = True
            res = await loop.run_in_executor(None, lambda: gservice.list_events(days, 25))
            for ev in (res.get("items") or []):
                start = str(ev.get("start") or "")
                items.append({
                    "id": "",
                    "title": ev.get("title") or "(無題)",
                    "date": start[:10],
                    "time": start[11:16] if len(start) >= 16 else "",
                    "note": "",
                    "source": "google",
                    "url": ev.get("url") or "",
                })
    except Exception:
        pass

    items.sort(key=lambda x: (x["date"] or "9999-99-99", x["time"] or ""))
    return {"items": items, "google_connected": google_connected}


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
async def board_save(req: BoardSaveRequest, _auth: None = Depends(require_auth),
                        _store: None = Depends(require_storage)):
    """（旧API互換）最初のボードを保存する。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.save_board(req.nodes, req.edges))


@app.get("/boards")
async def boards_list(_auth: None = Depends(require_auth)):
    """ボード一覧（メタのみ・更新順）。"""
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, board.list_boards)}


@app.post("/boards")
async def boards_create(req: BoardCreateRequest, _auth: None = Depends(require_auth),
                        _store: None = Depends(require_storage)):
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
async def boards_save(board_id: str, req: BoardSaveRequest, _auth: None = Depends(require_auth),
                        _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.save_board(req.nodes, req.edges, board_id))


@app.patch("/boards/{board_id}")
async def boards_rename(board_id: str, req: BoardRenameRequest, _auth: None = Depends(require_auth),
                        _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.rename_board(board_id, req.name))


@app.post("/boards/{board_id}/duplicate")
async def boards_duplicate(board_id: str, _auth: None = Depends(require_auth),
                        _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.duplicate_board(board_id))


@app.delete("/boards/{board_id}")
async def boards_delete(board_id: str, _auth: None = Depends(require_auth),
                        _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: board.delete_board(board_id))


# ── Artifacts（エージェント生成物：ドキュメント / スプレッドシート） ──

@app.get("/artifacts")
async def artifacts_list(_auth: None = Depends(require_auth)):
    """生成物のメタデータ一覧（content は含めない・新しい順）。"""
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, artifacts.list_artifacts)}


class ArtifactCreateRequest(BaseModel):
    kind: str = "document"
    title: str
    content: str
    mime: str = ""


@app.post("/artifacts")
async def artifacts_create(req: ArtifactCreateRequest,
                           _auth: None = Depends(require_auth),
                           _store: None = Depends(require_storage)):
    """作ったものを保管する。端末を変えても残るように。

    ARCHIVE（作ったアプリ）もここへ入れる。「作ったもの」の置き場を2つ持つと、
    どちらを見ればいいか分からなくなるので、artifacts に寄せている。
    """
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: artifacts.create(req.kind, req.title, req.content, req.mime))
    if isinstance(res, dict) and res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.get("/artifacts/{artifact_id}")
async def artifacts_get(artifact_id: str, _auth: None = Depends(require_auth)):
    """1件の完全な内容（content 込み）。ダウンロードに使う。"""
    loop = asyncio.get_event_loop()
    art = await loop.run_in_executor(None, lambda: artifacts.get(artifact_id))
    if not art:
        return JSONResponse(status_code=404, content={"error": "artifact not found"})
    return art


@app.patch("/artifacts/{artifact_id}")
async def artifacts_update(artifact_id: str, req: ArtifactUpdateRequest, _auth: None = Depends(require_auth)):
    """成果物の内容/タイトルを更新（スライドのテーマ変更など）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: artifacts.update(artifact_id, req.content, req.title))


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
async def scheduler_list(_auth: None = Depends(require_auth),
                         _db: str = Depends(use_own_database)):
    """予約の一覧と、見回りが生きているか。

    無料プランのサーバーは無操作で寝るので、朝の予約が発火しないことがある。
    「登録しました」と言われて何も来ないのが一番きついので、
    最後に見回りをした時刻も一緒に返して、画面から分かるようにする。
    """
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, scheduler.list_schedules)
    return {"items": items, "last_tick": scheduler.last_tick()}


@app.post("/scheduler")
async def scheduler_add(req: ScheduleRequest, _auth: None = Depends(require_auth),
                        _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, lambda: scheduler.add(req.instruction, req.time, req.days, req.automation_id))


@app.delete("/scheduler/{schedule_id}")
async def scheduler_delete(schedule_id: str, _auth: None = Depends(require_auth),
                        _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: scheduler.delete(schedule_id))


# ── Programmatic SEO（掛け合わせキーワードの大量ページ） ──────────────

@app.post("/pseo/plan")
async def pseo_plan(req: PseoPlanRequest, _auth: None = Depends(require_auth)):
    """軸の掛け合わせでページ計画を返す（生成はしない・プレビュー用）。"""
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, lambda: pseo.plan_pages(req.axes, req.template, req.limit))
    return {"items": items, "count": len(items)}


@app.post("/pseo/generate")
async def pseo_generate(req: PseoPlanRequest, _auth: None = Depends(require_auth)):
    """計画→本文生成→draft保存を一括実行（公開はされない）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: pseo.generate_batch(req.axes, req.template, req.limit))


@app.get("/pseo/pages")
async def pseo_pages(status: Optional[str] = None, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, lambda: pseo.list_pages(status))
    return {"items": items}


@app.patch("/pseo/pages/{slug}")
async def pseo_set_status(slug: str, req: PseoStatusRequest, _auth: None = Depends(require_auth)):
    """承認 / 却下（セミオート運用：承認したページだけ公開される）。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: pseo.set_status(slug, req.status))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.delete("/pseo/pages/{slug}")
async def pseo_delete(slug: str, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: pseo.delete_page(slug))


@app.get("/pseo/public/{slug}")
async def pseo_public(slug: str):
    """公開ページ用（認証不要）。承認済み以外は404にして未公開を守る。"""
    loop = asyncio.get_event_loop()
    page = await loop.run_in_executor(None, lambda: pseo.get_page(slug))
    if not page or page.get("status") != "approved":
        return JSONResponse(status_code=404, content={"error": "not found"})
    return page


@app.get("/pseo/sitemap")
async def pseo_sitemap():
    """承認済みページのみのサイトマップ（認証不要）。"""
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, pseo.sitemap)}


# ── LP / HP 作成（1ファイル完結HTML・反復デザイン） ────────────────────

@app.post("/lp/generate")
async def lp_generate(req: LpGenerateRequest, _auth: None = Depends(require_auth)):
    """LPを生成する。current を渡すと「その内容を指示どおり直す」改善モード。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: lp_mod.generate(req.brief, req.style, req.sections, req.current, req.kind))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    if req.save:
        meta = await loop.run_in_executor(None, lambda: lp_mod.save_as_artifact(res["title"], res["html"]))
        res["artifact"] = meta
    return res


@app.get("/lp/styles")
async def lp_styles(_auth: None = Depends(require_auth)):
    return {"styles": [{"key": k, "note": v} for k, v in lp_mod.STYLES.items()]}


# ── 画像スタジオ（アスペクト比・複数枚・履歴） ─────────────────────────

@app.get("/image/aspects")
async def image_aspects(_auth: None = Depends(require_auth)):
    return {"aspects": [{"key": k, "w": v[0], "h": v[1], "label": v[2]}
                        for k, v in imagegen.ASPECTS.items()]}


@app.get("/image/engines")
async def image_engines(_auth: None = Depends(require_auth)):
    """選べる生成エンジン（無料 / HFの割り当てモデル）と現在使えるか。"""
    return {"engines": imagegen.engines()}


@app.post("/image/generate")
async def image_generate(req: ImageGenerateRequest, request: Request,
                         _auth: None = Depends(require_auth),
                         user_id: str = Depends(current_user)):
    """同じ指示で複数バリエーションを作る。save=Trueで生成物（履歴）に保存。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: imagegen.generate_variants(req.prompt, req.n, req.aspect,
                                                 req.offset, req.engine))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    # 履歴に保存する前に絶対URLへ直す（保存後だと相対URLが残ってしまう）
    for img in res.get("images", []):
        img["url"] = _media_url(request, img.get("url", ""), user_id)
    if req.save:
        def _save():
            import artifacts
            saved = []
            for i, img in enumerate(res["images"], start=1):
                title = f"{req.prompt[:40]}" + (f" ({i})" if len(res["images"]) > 1 else "")
                saved.append(artifacts.create("image", title, img["url"], "image/url"))
            return saved
        res["artifacts"] = await loop.run_in_executor(None, _save)
    return res


# ── SNS投稿サポート（Instagram / X） ──────────────────────────────────

@app.get("/sns/platforms")
async def sns_platforms(_auth: None = Depends(require_auth)):
    return {"platforms": [{"key": k, **v} for k, v in sns_mod.PLATFORMS.items()]}


@app.post("/sns/generate")
async def sns_generate(req: SnsGenerateRequest, _auth: None = Depends(require_auth)):
    """SNS投稿案を複数生成する（自動投稿はしない・コピーして使う）。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: sns_mod.generate_posts(req.platform, req.topic, req.n, req.tone, req.promo, req.thread))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    if req.with_images:
        res["posts"] = await loop.run_in_executor(
            None, lambda: [sns_mod.with_image(p) for p in res["posts"]])
    return res


# ── ニュースレター（⑤ リスト取得 → 定期配信） ────────────────────────

@app.post("/newsletter/subscribe")
async def newsletter_subscribe(req: SubscribeRequest):
    """公開フォームからの購読登録（認証不要）。確認メールを送るまで配信しない。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: newsletter.subscribe(req.email, req.source))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.get("/newsletter/confirm")
async def newsletter_confirm(token: str = ""):
    """確認リンク（メール内から開かれる・認証不要）。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: newsletter.confirm(token))
    ok = not res.get("error")
    msg = "購読を確定しました。ありがとうございます。" if ok else res["error"]
    return HTMLResponse(
        f"<div style='font-family:sans-serif;text-align:center;margin-top:14%'>"
        f"<h2>{'✓ 登録完了' if ok else '⚠ エラー'}</h2><p>{msg}</p></div>",
        status_code=200 if ok else 400,
    )


@app.get("/newsletter/unsubscribe")
async def newsletter_unsubscribe(token: str = ""):
    """配信停止リンク（全配信メールに記載・認証不要）。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: newsletter.unsubscribe(token))
    ok = not res.get("error")
    msg = "配信を停止しました。今後お送りしません。" if ok else res["error"]
    return HTMLResponse(
        f"<div style='font-family:sans-serif;text-align:center;margin-top:14%'>"
        f"<h2>{'配信停止しました' if ok else '⚠ エラー'}</h2><p>{msg}</p></div>",
        status_code=200 if ok else 400,
    )


@app.get("/newsletter/subscribers")
async def newsletter_subscribers(status: Optional[str] = None, _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, lambda: newsletter.list_subscribers(status))
    st = await loop.run_in_executor(None, newsletter.stats)
    return {"items": items, "stats": st}


@app.get("/newsletter/issues")
async def newsletter_issues(_auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, newsletter.list_issues)}


@app.post("/newsletter/issues")
async def newsletter_draft(req: IssueDraftRequest, _auth: None = Depends(require_auth)):
    """配信の下書きを作る（topic指定でAIが本文を執筆）。送信はしない。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: newsletter.draft_issue(req.subject, req.body, req.topic))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.post("/newsletter/issues/{issue_id}/send")
async def newsletter_send(issue_id: str, req: IssueSendRequest, _auth: None = Depends(require_auth)):
    """確認済み購読者へ送信（test_to 指定でテスト送信のみ）。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: newsletter.send_issue(issue_id, req.test_to))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


# ── note（非公式APIでの下書き投稿・既定OFF） ──────────────────────────

@app.get("/note/status")
async def note_status(_auth: None = Depends(require_auth)):
    """note自動投稿の有効/無効と理由（認証情報の値は返さない）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, note_client.status)


@app.post("/note/draft")
async def note_draft(req: NoteDraftRequest, _auth: None = Depends(require_auth)):
    """noteに下書きを作成（ALLOW_NOTE_AUTOPOST=1 のときのみ実行）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: note_client.create_draft(req.title, req.markdown))


@app.get("/compliance/policy")
async def compliance_policy(_auth: None = Depends(require_auth)):
    """送信先ごとの配信ポリシー（既定ブロック／オプトインで解除済み）を返す。"""
    loop = asyncio.get_event_loop()
    return {"platforms": await loop.run_in_executor(None, compliance.policy_report)}


# ── Keep-Alive（Supabaseの自動一時停止を防ぐ） ────────────────────────

@app.get("/keepalive")
async def keepalive_get():
    """DBを軽く触って「活動あり」にする。外部cron（GitHub Actions等）から叩く。
    認証不要（副作用は1行のupsertのみ）。/health より確実にSupabaseを起こし続ける。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, keepalive_mod.ping)


@app.get("/keepalive/status")
async def keepalive_status(_auth: None = Depends(require_auth)):
    """最後に実行した時刻と結果（UI表示用）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, keepalive_mod.status)


# ── 外から動かす入口（Webhookトリガー） ─────────────────────────────

class HookCreateRequest(BaseModel):
    automation_id: str
    label: str = ""


@app.get("/hooks")
async def hooks_list(_auth: None = Depends(require_auth),
                     _db: str = Depends(use_own_database)):
    """自分のトリガー一覧（起動用URLつき）。"""
    loop = asyncio.get_event_loop()
    return {"items": await loop.run_in_executor(None, lambda: hooks_mod.list_hooks())}


@app.post("/hooks")
async def hooks_create(req: HookCreateRequest, user_id: str = Depends(current_user),
                       _auth: None = Depends(require_auth),
                       _store: None = Depends(require_storage)):
    """トリガーを作る。起動できるのは、結びつけた自動化1つだけ。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: hooks_mod.create(user_id, req.automation_id, req.label))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.delete("/hooks/{hook_id}")
async def hooks_delete(hook_id: str, _auth: None = Depends(require_auth),
                       _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: hooks_mod.delete(hook_id))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.post("/hook/{token}")
async def hook_fire(token: str):
    """外部から自動化を1つ起動する。認証はこの合言葉そのもの。

    iOSのショートカット、スプレッドシートのスクリプト、IFTTT、
    各自のSupabase（pg_cron）など、URLを叩けるものなら何でも起動側になれる。
    どれも無料で、こちらは何も足さなくていい。

    合言葉が漏れても、できるのは「その自動化を動かす」ことだけ。
    任意の命令は実行できない（作る時点で1つに結びつけてある）。
    """
    loop = asyncio.get_event_loop()

    row = await loop.run_in_executor(None, lambda: hooks_mod.find_by_token(token))
    if not row:
        # 存在しないのか合言葉が違うのかは区別しない（総当たりの手掛かりを与えない）
        raise HTTPException(status_code=404, detail="このトリガーは見つかりませんでした")

    hook_id = str(row.get("id") or "")
    if hooks_mod.too_soon(hook_id):
        # 連打よけ。1回ごとにAIが動くので、無料枠を守る。
        # 429 を返すのは、叩く側（cronやショートカット）が
        # 「失敗」ではなく「間隔を空けろ」と分かるようにするため。
        raise HTTPException(
            status_code=429,
            detail=f"続けて実行はできません。{int(hooks_mod.MIN_INTERVAL_SEC)}秒ほど空けてください",
        )
    hooks_mod.note_fired(hook_id)

    def _run():
        # その人の保存先と鍵で動かす（外から叩かれるので文脈が無い）
        owner = str(row.get("user_id") or "")
        client = tenancy.client_for(owner) if owner else None
        bound = config.bind_request_client(client) if client is not None else None
        try:
            import automations
            return automations.run_flow(str(row.get("automation_id") or ""))
        finally:
            if bound is not None:
                config.reset_request_client(bound)

    res = await loop.run_in_executor(None, _run)
    await loop.run_in_executor(None, lambda: hooks_mod.mark_used(hook_id))
    if isinstance(res, dict) and res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return {"ok": True, "ran": res}


@app.post("/scheduler/tick")
async def scheduler_tick(authorization: Optional[str] = Header(default=None),
                         x_app_token: Optional[str] = Header(default=None)):
    """外部cron（GitHub Actions / cron-job.org 等）から叩く実行トリガ。

    副作用は「登録済みの定期実行を、時刻を過ぎていれば走らせる」だけで、
    同じ日に二度は走らない。とはいえ、叩かれるたびにAIが動くので、
    URLを知られると無料枠を削られる。共通トークンを設定している場合は
    それを要求する（設定していなければ、これまで通り誰でも叩ける）。

    ここを厳しくしすぎると、cron側の設定漏れで定期実行が丸ごと死ぬ。
    「設定してあるなら守る、していないなら通す」に留める。
    """
    if config.APP_TOKEN:
        bearer = ""
        if authorization and authorization.strip().lower().startswith("bearer "):
            bearer = authorization.strip()[7:].strip()
        if bearer != config.APP_TOKEN and (x_app_token or "").strip() != config.APP_TOKEN:
            raise HTTPException(status_code=401, detail="この入口には共通トークンが必要です")
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, scheduler.tick_everyone)


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


# Google は以前からこのURLで動いており、Google Cloud 側に「承認済みの
# リダイレクトURI」として登録されている。URLを変えると既存の設定が壊れるので、
# 入口はそのまま残し、中身だけ共通の仕組みに寄せる。
@app.get("/google/auth/start")
async def google_auth_start(request: Request, user_id: str = Depends(current_user),
                            claims: dict = Depends(current_claims),
                            _auth: None = Depends(require_auth)):
    """Googleの同意画面へ送る。"""
    res = oauth.start_url("google", _connect_redirect(request, "google"), user_id,
                          owner=is_owner_claims(claims))
    if res.get("error"):
        return _connect_page("連携を始められません", res["error"], ok=False, status=400)
    return RedirectResponse(res["url"])


@app.get("/google/auth/callback")
async def google_auth_callback(request: Request, code: str = "", state: str = "",
                               error: str = ""):
    return await _connect_finish("google", request, code, state, error)


@app.post("/google/disconnect")
async def google_disconnect(_auth: None = Depends(require_auth)):
    return oauth.disconnect("google")


@app.get("/slides/layouts")
async def slides_layouts(_auth: None = Depends(require_auth)):
    """スライド1枚ごとの編集UIが使うレイアウト定義（使うフィールドと表示名）。"""
    return {
        "layouts": [
            {"key": k, "label": slides_mod.LAYOUT_LABELS.get(k, k),
             "fields": slides_mod.LAYOUT_FIELDS.get(k, [])}
            for k in slides_mod.LAYOUTS
        ],
        "themes": slides_mod.THEMES,
    }


@app.post("/slides/revise")
async def slides_revise(req: SlideReviseRequest, _auth: None = Depends(require_auth)):
    """スライド1枚だけをAIで書き直す（他の枚は変えない）。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: slides_mod.revise_slide(
            req.slide, req.instruction, req.deck_title, req.layout, req.context))
    if res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.post("/slides/google")
async def slides_to_google(req: SlidesExportRequest, _auth: None = Depends(require_auth)):
    """スライド構成（title + slides[] + theme）を Google スライドに変換して URL を返す。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: gservice.create_presentation(req.title, req.slides, req.theme))


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
async def evolve_propose(req: EvolveRequest, _auth: None = Depends(require_auth), _own: None = Depends(require_owner)):
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
    """キーを保存/更新する。

    保存先に本当に書けたかどうかを persisted で返す。書けていないのに
    「保存しました」で終わらせると、次の更新で消えたときに理由が分からない。
    """
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: keychain.set_key(req.name, req.value))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=(409 if result.get("needs_storage") else 400),
                            content=result)
    return result


@app.get("/keys/orphans")
async def keys_orphans(_auth: None = Depends(require_auth),
                       _owner: None = Depends(require_owner)):
    """自分のDBを繋ぐ前の保存先に残っている鍵を探す（名前とマスクだけ）。

    持ち主専用。分ける前のDBには他の利用者の鍵も混ざっているため。
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, keychain.orphaned_keys)


@app.post("/keys/rescue")
async def keys_rescue(req: KeyRescueRequest,
                      _auth: None = Depends(require_auth),
                      _owner: None = Depends(require_owner)):
    """前の保存先に残っている鍵を、いまの保存先へ写す。"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: keychain.rescue_keys(req.names))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=409, content=result)
    return result


# ── ルール（AIbouに守らせる決まりごと） ──────────────────────────

@app.get("/rules")
async def rules_status(_auth: None = Depends(require_auth)):
    """取り込み済みのルール一覧。GitHubには触らない（保存済みを読むだけ）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, rules.status)


@app.post("/rules/sync")
async def rules_sync(req: RulesSyncRequest,
                     _auth: None = Depends(require_auth),
                     _store: None = Depends(require_storage)):
    """GitHubのメモを取り込む。GitHubに触るのはここだけ。

    会話のたびに取りに行くと、その往復がそのまま待ち時間になる。
    取り込みは「同期したとき」に限り、ふだんは保存済みから読む。
    """
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: rules.sync(req.repo, req.path))
    if isinstance(result, dict) and result.get("error"):
        return JSONResponse(status_code=400, content=result)
    return result


# ── 見張り（監視して、変わったときだけ報せる） ──────────────────────

@app.get("/watch")
async def watch_report(new_only: bool = False, force: bool = False,
                       _auth: None = Depends(require_auth)):
    """いま気にすべきものと、各対象を読めているかどうか。

    読めなかった対象は省かずに返す。省くと画面が「新着なし」に見えるが、
    実際は見に行けていないだけ、ということが起きる。

    force を付けない限り、外（メール・Slack・カレンダー）へは繋ぎに行かず
    前回の中身を返す。画面を開くたびに繋ぐと、開くだけで数秒待たされる。
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, lambda: watch.report(new_only=new_only, force=force))


@app.post("/watch/check")
async def watch_check(_auth: None = Depends(require_auth)):
    """いますぐ見回って、新着があれば通知する（画面の「今すぐ確認」）。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: watch.tick(force=True))


@app.post("/watch/source")
async def watch_source(req: WatchSourceRequest,
                       _auth: None = Depends(require_auth),
                       _store: None = Depends(require_storage)):
    """対象ごとに見張りを止める/再開する。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: watch.set_enabled(req.source, req.enabled))
    if isinstance(res, dict) and res.get("error"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.get("/watch/inbox")
async def watch_inbox(channel: str = "", limit: int = 50,
                      user_id: str = Depends(current_user),
                      _auth: None = Depends(require_auth)):
    """外から届いたメッセージ（いまはLINE）と、受信の窓口URLの状態。"""
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(
        None, lambda: inbox_mod.list_messages(channel=channel, limit=limit))
    st = await loop.run_in_executor(None, lambda: inbox_mod.status(user_id))
    return {"ok": True, "items": items, **st}


@app.post("/watch/inbox/read")
async def watch_inbox_read(channel: str = "", _auth: None = Depends(require_auth)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: inbox_mod.mark_all_read(channel))


# ── LINE の受信口 ────────────────────────────────────────────────────
# ここだけは認証を付けない。呼ぶのは LINE のサーバーであって、
# ログイン中のブラウザではないため。代わりに、届いた本文そのものを
# チャネルシークレットで署名検証する。検証を通らないものは捨てる。

async def _handle_line_webhook(request: Request, token: str = "") -> JSONResponse:
    raw = await request.body()
    signature = request.headers.get("x-line-signature", "")
    loop = asyncio.get_event_loop()

    def _work() -> dict:
        bound = None
        if token:
            user_id = inbox_mod.resolve_token(token)
            if not user_id:
                return {"status": 404, "body": {"ok": False, "error": "unknown webhook"}}
            client = tenancy.client_for(user_id)
            if client is not None:
                bound = config.bind_request_client(client)
        try:
            secret = (keychain.get_key("LINE_CHANNEL_SECRET") or "").strip()
            if not secret:
                # 検証できない状態で受け入れると、誰でも書き込める口になる。
                # 受け取らないほうが安全なので断る。
                return {"status": 503,
                        "body": {"ok": False, "error": "LINE_CHANNEL_SECRET が未設定です"}}
            if not inbox_mod.verify_line_signature(raw, signature, secret):
                return {"status": 403, "body": {"ok": False, "error": "signature mismatch"}}
            import json as _json
            try:
                payload = _json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                return {"status": 400, "body": {"ok": False, "error": "invalid json"}}
            return {"status": 200, "body": inbox_mod.ingest_line(payload)}
        finally:
            if bound is not None:
                config.reset_request_client(bound)

    res = await loop.run_in_executor(None, _work)
    return JSONResponse(status_code=res["status"], content=res["body"])


@app.post("/line/webhook")
async def line_webhook(request: Request):
    """1人で使っている場合の受信口（サーバー既定の保存先に入る）。"""
    return await _handle_line_webhook(request)


@app.post("/line/webhook/{token}")
async def line_webhook_for_user(token: str, request: Request):
    """利用者ごとの受信口。URLの合言葉で持ち主を割り出して、その人の保存先に入れる。"""
    return await _handle_line_webhook(request, token=token)


@app.delete("/keys/{name}")
async def delete_key(name: str, _auth: None = Depends(require_auth)):
    """キーを削除する。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: keychain.delete_key(name))


# ── 連携が済んだあと、預かった用事に戻る ────────────────────────────

@app.get("/setup/pending")
async def setup_pending(_auth: None = Depends(require_auth)):
    """連携待ちで預かっている用事があるか。

    画面は連携から戻ったときにこれを見て、「さっきの続きをやりますか」を
    出す。ここが無いと、利用者は戻ってきてから同じ頼みごとを言い直す。
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, setup_flow.status)


@app.post("/setup/resume")
async def setup_resume(_auth: None = Depends(require_auth)):
    """預かった用事を取り出して返す（実行はしない）。

    実行までここでやらないのは、取り返しのつかない操作（送信・投稿）を
    「連携したら勝手に動いた」にしないため。画面が受け取って、
    ふつうの指示として投げ直す。そのとき承認の仕組みも通る。
    """
    loop = asyncio.get_event_loop()

    def _work() -> dict:
        row = setup_flow.pending()
        if not row:
            return {"ok": False, "waiting": False,
                    "message": "預かっている用事はありません"}
        taken = setup_flow.take(row.get("provider", ""))
        if not taken:
            return {"ok": False, "waiting": False,
                    "message": "預かっている用事はありません"}
        return {"ok": True, "instruction": taken.get("instruction", ""),
                "provider": taken.get("provider", ""),
                "auto": setup_flow.can_auto_resume(taken)}

    return await loop.run_in_executor(None, _work)


# ── できること（パックと # コマンド） ────────────────────────────────

class PacksRequest(BaseModel):
    packs: List[str] = []


class CommandRequest(BaseModel):
    text: str = ""


@app.get("/risk")
async def risk_table(_auth: None = Depends(require_auth)):
    """道具ごとの危なさ（0 読むだけ〜3 取り返せない）。

    段階3は承認モードに関わらず必ず確認する。画面がそれを説明できるように、
    always_confirm も返す。
    """
    return {"ok": True, "levels": risk.table(), "labels": risk.LABELS}


@app.get("/capabilities")
async def capabilities_status(claims: dict = Depends(current_claims),
                              _auth: None = Depends(require_auth)):
    """パックの状態と、いま使える # コマンドの一覧。"""
    owner = is_owner_claims(claims)
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: capabilities.status(owner))


@app.post("/capabilities/packs")
async def capabilities_set_packs(req: PacksRequest,
                                 _auth: None = Depends(require_auth),
                                 _store: None = Depends(require_storage)):
    """使う機能のかたまりを切り替える。"""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, lambda: capabilities.set_packs(req.packs))
    if isinstance(res, dict) and res.get("error"):
        return JSONResponse(status_code=409, content=res)
    return res


@app.post("/command")
async def run_command(req: CommandRequest, claims: dict = Depends(current_claims),
                      _auth: None = Depends(require_auth)):
    """「#画像 猫の絵」を、AIに考えさせずそのまま実行する。

    ふつうに「猫の絵を描いて」と書けば、AIが道具を選んで同じことをする。
    こちらはその一手を飛ばす近道で、速くて結果が読める。
    どちらでも同じことができるのが大事で、# を覚えないと使えないなら負け。

    知らないコマンドは実行しない。呼び出し側は、ふつうの文としてAIに渡すこと
    （打ち間違いで会話が止まらないように）。
    """
    owner = is_owner_claims(claims)
    loop = asyncio.get_event_loop()
    parsed = await loop.run_in_executor(None, lambda: capabilities.parse(req.text, owner))
    if not parsed:
        return {"ok": False, "unknown": True,
                "message": "知らないコマンドです。ふつうの文としてお使いください"}

    cap = parsed["capability"]
    rest = parsed["rest"]

    # 画面を開くだけのもの（道具ではない）
    if not cap.get("tool"):
        return {"ok": True, "kind": "view", "view": cap.get("view", ""),
                "label": cap["label"]}

    # 引数の要る道具に、引数が無いまま突っ込まない
    if cap.get("arg") and not rest:
        return {"ok": False, "kind": "needs_arg", "cmd": cap["cmd"],
                "arg": cap["arg"], "label": cap["label"],
                "message": f"#{cap['cmd']} のあとに「{cap['arg']}」を書いてください"}

    def _work() -> dict:
        params = _command_params(cap, rest)
        if params is None:
            # 自由文から埋めきれない道具は、AIに任せたほうが早い
            return {"ok": False, "kind": "delegate",
                    "message": "この指示はAIに任せます"}
        out = tools.execute_tool(cap["tool"], params)
        return {"ok": True, "kind": "done", "tool": cap["tool"],
                "label": cap["label"], "view": cap.get("view", ""), "result": out}

    return await loop.run_in_executor(None, _work)


def _command_params(cap: dict, rest: str):
    """# のうしろの自由文を、道具の引数に流し込む。

    ここで埋めきれない道具（宛先と件名と本文、のように複数に割れる物）は
    None を返す。無理に切り分けると取り違えるので、そこはAIに任せる。
    """
    tool = cap["tool"]
    simple = {
        "add_task": "title", "remember": "content", "recall": "query",
        "web_search": "query", "web_read": "url", "notify": "message",
        "generate_image": "prompt", "create_slides": "topic",
        "create_google_slides": "topic", "create_document": "title",
        "create_spreadsheet": "title", "board_add_note": "text",
        "save_note": "content", "notion_add": "title",
        "create_mission": "objective", "enqueue_income": "theme",
        "create_automation": "name", "run_automation": "name",
        "google_doc": "title",
    }
    if tool in simple:
        return {simple[tool]: rest}
    if tool in ("watch_report", "income_status"):
        return {}
    if tool == "email_inbox":
        try:
            return {"limit": int(rest)} if rest else {}
        except ValueError:
            return {}
    if tool == "calendar_list":
        try:
            return {"days": int(rest)} if rest else {}
        except ValueError:
            return {}
    # 予定・メール送信・定期実行・ドライブ等は、1つの文から機械的に割れない
    return None


# ── 押すだけの外部連携（OAuth） ──────────────────────────────────────
# start は本人が押すので認証あり。callback は提供元がブラウザを飛ばして
# くるだけでログイン情報が付かないため、認証を付けられない。
# 代わりに、送り出すときに「誰が始めたか」を署名して state に載せ、
# 戻りで検証してから、その人の保管庫にだけ保存する。
#
# ここを省いていたのが元の不具合だった。利用者を特定できないまま鍵を
# 保存していたので、keychain が「1人運用」とみなして os.environ に書き、
# 誰か1人の連携がサーバー全体の既定値になっていた
# （自分で繋いでいない他の利用者が、その人のアカウントで動いていた）。

def _connect_redirect(request: Request, provider: str) -> str:
    """提供元に登録する戻り先。Googleだけは以前のURLを保つ（登録済みのため）。"""
    base = str(request.base_url).rstrip("/")
    if provider == "google":
        return gservice.redirect_uri(default=f"{base}/google/auth/callback")
    return f"{base}/connect/{provider}/callback"


def _connect_page(title: str, body: str, ok: bool = True,
                  status: int = 200) -> HTMLResponse:
    """連携の結果を出す小さなページ（提供元からの戻りはブラウザで開かれる）。

    失敗のときに 200 を返さないこと。画面には赤く出ているのに、機械から見ると
    成功に見える——という食い違いを作らない。
    """
    mark = "✅" if ok else "⚠️"
    return HTMLResponse(
        f"<!doctype html><meta charset='utf-8'>"
        f"<div style='font-family:system-ui;max-width:34rem;margin:12vh auto;padding:0 1.2rem;"
        f"line-height:1.9;color:#c9ccd2;background:#0a0b0f'>"
        f"<h3 style='color:#fff'>{mark} {title}</h3><p>{body}</p>"
        f"<p style='color:#8b8f97'>このタブは閉じて、AIbouに戻ってください。</p></div>",
        status_code=status if not ok else 200,
    )


@app.get("/connect")
async def connect_status(_auth: None = Depends(require_auth)):
    """連携できる先と、その状態。鍵の値は返さない。"""
    loop = asyncio.get_event_loop()
    items = await loop.run_in_executor(None, oauth.status_all)
    return {"ok": True, "providers": items, "no_oauth": oauth.NO_OAUTH}


@app.get("/connect/{provider}/start")
async def connect_start(provider: str, request: Request,
                        user_id: str = Depends(current_user),
                        claims: dict = Depends(current_claims),
                        _auth: None = Depends(require_auth)):
    """提供元の同意画面へ送る。誰が始めたかを署名して持たせる。"""
    res = oauth.start_url(provider, _connect_redirect(request, provider), user_id,
                          owner=is_owner_claims(claims))
    if res.get("error"):
        return _connect_page("連携を始められません", res["error"], ok=False, status=400)
    return RedirectResponse(res["url"])


async def _connect_finish(provider: str, request: Request, code: str, state: str,
                          error: str) -> HTMLResponse:
    label = (oauth.PROVIDERS.get(provider) or {}).get("label", provider)
    if error:
        return _connect_page("連携に失敗しました", error, ok=False, status=400)

    checked = oauth.verify_state(state, provider)
    if checked.get("error"):
        return _connect_page("連携を確認できませんでした", checked["error"], ok=False, status=400)
    user_id = checked.get("user_id") or ""
    redirect = _connect_redirect(request, provider)

    is_owner = bool(checked.get("owner"))

    def _work() -> dict:
        # 始めた本人の保存先に束ねてから保存する。ここを飛ばすと、その鍵が
        # サーバー全体の既定になり、繋いでいない他の利用者にも使われる。
        #
        # 保存先を持たない人でも「束ねる」ことが要る。束ねずに素通りさせると
        # keychain が「1人運用」とみなしてプロセスへ書き、結局そこから漏れる。
        # 束ねて中身を None にしておけば、keychain が断ってくれる。
        # 持ち主だけは例外で、繋いでいなくてもサーバー既定のDBが自分の物。
        bound = None
        if user_id:
            client = tenancy.client_for(user_id)
            # 保存先が無い人も束ねる（中身 None）。そうすると keychain が断る。
            # 束ねずに素通りさせると「1人運用」とみなされてプロセスへ書かれる。
            # 持ち主だけは、繋いでいなくてもサーバー既定のDBが自分の物なので束ねない。
            if client is not None or not is_owner:
                bound = config.bind_request_client(client)
        try:
            out = oauth.finish(provider, code, redirect)
            # 繋ぐ前に預かった用事があれば、それも一緒に持ち帰る。
            # ここで拾えないと、利用者は戻ってきてから同じ頼みごとを
            # もう一度言うことになる。それが設定でいちばんいらない手間。
            if out.get("ok"):
                try:
                    import setup_flow
                    held = setup_flow.pending(provider)
                    if held:
                        out["resume"] = {
                            "instruction": held.get("instruction", ""),
                            "auto": setup_flow.can_auto_resume(held),
                        }
                except Exception:
                    pass
            return out
        finally:
            if bound is not None:
                config.reset_request_client(bound)

    res = await asyncio.get_event_loop().run_in_executor(None, _work)
    if res.get("error"):
        return _connect_page("連携に失敗しました", res["error"], ok=False, status=502)
    who = f"（{res['account']}）" if res.get("account") else ""
    body = f"{label}{who} と繋がりました。"
    if res.get("warning"):
        body += "<br>" + res["warning"]
    resume = res.get("resume") or {}
    if resume.get("instruction"):
        # 何を続けるのかを、ここで先に見せる。黙って再開すると
        # 「勝手に動いた」に見える。
        cont = ("AIbouに戻ると、続きを進めます。"
                if resume.get("auto") else
                "AIbouに戻ると、続けてよいか確認します。")
        body += (f"<br><br>預かっていた用事:<br>"
                 f"「{resume['instruction'][:120]}」<br>{cont}")
    return _connect_page("連携できました", body, ok=not res.get("warning"))


@app.get("/connect/{provider}/callback")
async def connect_callback(provider: str, request: Request,
                           code: str = "", state: str = "", error: str = ""):
    return await _connect_finish(provider, request, code, state, error)


@app.post("/connect/{provider}/disconnect")
async def connect_disconnect(provider: str, _auth: None = Depends(require_auth),
                             _store: None = Depends(require_storage)):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: oauth.disconnect(provider))


# ローカル実行用エントリ（uvicorn main:app --reload と同等）
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
