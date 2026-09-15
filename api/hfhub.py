# hfhub.py — Hugging Face のモデルを「好きなだけ登録して、機能に割り当てる」台帳
# =====================================================================
# これまで HF は「会話用のテキストモデル1つ」にしか使えなかった（llm.py）。
# HF には音声認識・画像生成・翻訳・分類など多種のモデルがあるので、
#   1. モデルを台帳に登録する（Hub検索 or ID直打ち）
#   2. 実際に1回叩いて動くか確かめる（verified）
#   3. アプリの役割（会話 / コード / 画像 / 文字起こし）に割り当てる
# という流れで差し替えられるようにする。
#
# 呼び出し先
#   ・text          … OpenAI互換ルーター /v1/chat/completions（llm.py と同じ経路）
#   ・それ以外      … 推論API POST {base}/models/{model}
#                     ルーター(router.huggingface.co/hf-inference) を先に試し、
#                     ダメなら従来の api-inference.huggingface.co に落とす。
#                     どちらで通ったかは呼び出し結果に含める（隠さない）。
#
# 設計方針（他モジュールと同じ）
#   ・絶対に raise しない。失敗は {"error": 日本語} で返す。
#   ・HFの生の英語エラーを丸投げしない（401/404/429/503 は原因を日本語で言う）。
#   ・モデルの起動待ち(503)は「失敗」ではなく「待てば動く」ものとして区別する。
#   ・保存は Supabase、無ければプロセス内メモリ（外部サービス無しでも動く）。
#   ・トークンの値は絶対に返さない（set かどうかだけ）。
# =====================================================================

import base64
import hashlib
import hmac
import os
import re
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import requests

import config
import memstore
import keychain

ROUTER_BASE = "https://router.huggingface.co/hf-inference"
LEGACY_BASE = "https://api-inference.huggingface.co"
HUB_API = "https://huggingface.co/api/models"

TIMEOUT = 120
MAX_IMAGE_BYTES = 12_000_000      # 生成画像の保存上限
MAX_AUDIO_BYTES = 25_000_000      # 文字起こしに送る音声の上限
MEM_IMAGE_KEEP = 24               # Supabase未設定時にメモリで持つ枚数
MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][\w.\-]*(/[\w.\-]+)?$")

# ── 扱えるタスク ───────────────────────────────────────────────────
# wired が空文字のものは「お試し実行だけ」＝まだ機能には組み込まれていない。
# ここで嘘をつくと「登録したのに何も変わらない」になるので、正直に持つ。
TASKS = {
    "text": {
        "label": "文章生成・会話", "hf_task": "text-generation",
        "input": "text", "output": "text",
        "wired": "CHAT・各モードの文章生成", "note": "指示応答(Instruct)モデル",
    },
    "image": {
        "label": "画像生成", "hf_task": "text-to-image",
        "input": "text", "output": "image",
        "wired": "IMAGE STUDIO", "note": "文章から画像を作る",
    },
    "asr": {
        "label": "音声の文字起こし", "hf_task": "automatic-speech-recognition",
        "input": "audio", "output": "text",
        "wired": "CAPTURE の文字起こし", "note": "Geminiキー無しでも文字起こしできる",
    },
    "translate": {
        "label": "翻訳", "hf_task": "translation",
        "input": "text", "output": "text",
        "wired": "", "note": "言語間の翻訳に特化したモデル",
    },
    "summarize": {
        "label": "要約", "hf_task": "summarization",
        "input": "text", "output": "text",
        "wired": "", "note": "長文の圧縮に特化したモデル",
    },
    "classify": {
        "label": "分類・感情判定", "hf_task": "text-classification",
        "input": "text", "output": "labels",
        "wired": "", "note": "ラベルとスコアを返す",
    },
    "embed": {
        "label": "ベクトル化", "hf_task": "feature-extraction",
        "input": "text", "output": "vector",
        "wired": "", "note": "意味検索用の数値ベクトル",
    },
    "tts": {
        "label": "読み上げ音声", "hf_task": "text-to-speech",
        "input": "text", "output": "audio",
        "wired": "", "note": "文章から音声を作る",
    },
}

# 台帳が空のときに提示する候補（ネットに繋がらなくても選べるように内蔵）。
SUGGESTED = {
    "text": [
        "meta-llama/Llama-3.3-70B-Instruct",
        "Qwen/Qwen2.5-72B-Instruct",
        "deepseek-ai/DeepSeek-V3-0324",
        "Qwen/Qwen2.5-Coder-32B-Instruct",
        "mistralai/Mistral-Small-24B-Instruct-2501",
    ],
    "image": [
        "black-forest-labs/FLUX.1-schnell",
        "black-forest-labs/FLUX.1-dev",
        "stabilityai/stable-diffusion-xl-base-1.0",
    ],
    "asr": [
        "openai/whisper-large-v3-turbo",
        "openai/whisper-large-v3",
        "kotoba-tech/kotoba-whisper-v2.0",
    ],
    "translate": ["facebook/nllb-200-distilled-600M", "Helsinki-NLP/opus-mt-ja-en"],
    "summarize": ["facebook/bart-large-cnn"],
    "classify": ["facebook/bart-large-mnli", "cardiffnlp/twitter-xlm-roberta-base-sentiment"],
    "embed": ["intfloat/multilingual-e5-large", "sentence-transformers/all-MiniLM-L6-v2"],
    "tts": ["espnet/kan-bayashi_ljspeech_vits"],
}

# 役割 → 保存先キー。chat/code は既存の llm.py がそのまま読む名前を使う
# （新設せず合わせることで、割り当てた瞬間から既存の生成に効く）。
ROLES = {
    "chat": {"store_key": "HF_MODEL", "task": "text", "label": "会話・文章生成",
             "where": "CHAT / 各モードの生成"},
    "code": {"store_key": "CODE_MODEL", "task": "text", "label": "コード生成",
             "where": "CODEモード"},
    "image": {"store_key": "HF_IMAGE_MODEL", "task": "image", "label": "画像生成",
              "where": "IMAGE STUDIO"},
    "asr": {"store_key": "HF_ASR_MODEL", "task": "asr", "label": "文字起こし",
            "where": "CAPTURE"},
}

_mem_models = memstore.TenantList()
_mem_images = memstore.TenantList()
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _kc(name: str) -> str:
    """KEYCHAIN → 環境変数（llm.py と同じ読み方）。"""
    try:
        v = keychain.get_key(name)
        if v:
            return v
    except Exception:
        pass
    return os.environ.get(name, "").strip()


def token() -> str:
    return _kc("HUGGINGFACE_TOKEN")


def token_ready() -> bool:
    return bool(token())


def _headers(extra: Optional[dict] = None) -> dict:
    h = {"Authorization": f"Bearer {token()}"} if token() else {}
    if extra:
        h.update(extra)
    return h


# ── エラーの日本語化 ───────────────────────────────────────────────
def _explain(resp) -> dict:
    """HFの応答から「何が起きたか」を日本語で返す。

    retry=True は「モデルの起動待ち」で、時間を置けば成功する類のもの。
    """
    code = getattr(resp, "status_code", 0)
    body = ""
    detail = ""
    wait = None
    try:
        body = (resp.text or "")[:400]
    except Exception:
        pass
    try:
        j = resp.json()
        if isinstance(j, dict):
            detail = str(j.get("error") or j.get("message") or "")[:300]
            wait = j.get("estimated_time")
    except Exception:
        pass

    if code in (401, 403):
        return {"error": "HuggingFaceのトークンが無効か、このモデルへの権限がありません"
                         "（KEYCHAIN の HUGGINGFACE_TOKEN を確認。"
                         "Llama等はHubでライセンス同意が必要です）",
                "status": code, "detail": detail or body}
    if code == 404:
        return {"error": "モデルが見つかりません（IDのつづり、または公開状態を確認してください）",
                "status": code, "detail": detail or body}
    if code == 429:
        return {"error": "HuggingFaceの利用上限に達しました（時間を置くか、有料枠が必要です）",
                "status": code, "detail": detail or body}
    if code == 503:
        sec = ""
        try:
            if wait:
                sec = f"（約{int(float(wait))}秒）"
        except Exception:
            sec = ""
        return {"error": f"モデルの起動中です{sec}。少し待ってもう一度実行してください",
                "status": code, "retry": True, "detail": detail or body}
    if code == 400 and "task" in (detail or "").lower():
        return {"error": f"このモデルはそのタスクに対応していません（{detail}）",
                "status": code, "detail": detail}
    return {"error": f"HuggingFace がエラーを返しました（{code}）"
                     + (f"：{detail}" if detail else ""),
            "status": code, "detail": detail or body}


def _post(url: str, *, json_body=None, data=None, content_type: str = ""):
    extra = {"Content-Type": content_type} if content_type else None
    return requests.post(url, headers=_headers(extra), json=json_body,
                         data=data, timeout=TIMEOUT)


def _call_pipeline(model: str, *, json_body=None, data=None,
                   content_type: str = "") -> Tuple[Optional[object], Optional[dict], str]:
    """推論APIを叩く。(resp, error, base) を返す。

    ルーター → 旧ホスト の順に試す。「そのモデルがそのホストに無い(404)」の時だけ
    次を試し、権限や上限の失敗はそこで確定させる（無駄打ちしない）。
    """
    if not token():
        return None, {"error": "HuggingFaceのトークンが未設定です（設定 →「つなぐ」 の HUGGINGFACE_TOKEN）"}, ""
    last: Optional[dict] = None
    for base in (ROUTER_BASE, LEGACY_BASE):
        url = f"{base}/models/{model}"
        try:
            resp = _post(url, json_body=json_body, data=data, content_type=content_type)
        except Exception as e:
            last = {"error": f"HuggingFace に接続できませんでした: {e}"}
            continue
        if resp.status_code < 400:
            return resp, None, base
        last = _explain(resp)
        if resp.status_code != 404:
            return None, last, base
    return None, last or {"error": "HuggingFace の呼び出しに失敗しました"}, ""


# ── タスク別の呼び出し ─────────────────────────────────────────────
def run_text(model: str, prompt: str, max_tokens: int = 800) -> dict:
    """会話/文章生成（OpenAI互換ルーター経由 = llm.py と同じ実績のある経路）。"""
    try:
        import llm
        out = llm._gen_hf(prompt, model=model or None, max_tokens=max_tokens)
    except Exception as e:
        return {"error": f"生成に失敗しました: {e}"}
    if not (out or "").strip():
        return {"error": "モデルが空の応答を返しました"}
    return {"ok": True, "kind": "text", "text": out.strip()}


def run_image(model: str, prompt: str, width: int = 0, height: int = 0) -> dict:
    """画像生成。{ok, kind:'image', data, mime, bytes} / {error}。"""
    if not (prompt or "").strip():
        return {"error": "画像の指示(prompt)が空です"}
    params = {}
    if width and height:
        params = {"width": int(width), "height": int(height)}
    body = {"inputs": prompt[:1000]}
    if params:
        body["parameters"] = params
    resp, err, base = _call_pipeline(model, json_body=body)
    if err:
        return err
    mime = (resp.headers.get("content-type") or "image/png").split(";")[0].strip()
    raw = resp.content or b""
    if not raw:
        return {"error": "画像が空で返ってきました"}
    if not mime.startswith("image/"):
        # 画像のはずがJSONで返る＝タスク違い。中身を見せて原因を分かるようにする。
        return {"error": "このモデルは画像を返しませんでした（タスクが text-to-image か確認してください）",
                "detail": raw[:200].decode("utf-8", "replace")}
    if len(raw) > MAX_IMAGE_BYTES:
        return {"error": f"画像が大きすぎます（上限 {MAX_IMAGE_BYTES // 1_000_000}MB）"}
    return {"ok": True, "kind": "image", "data": raw, "mime": mime,
            "bytes": len(raw), "endpoint": base}


def run_asr(model: str, audio: bytes, mime: str = "audio/mpeg") -> dict:
    """音声の文字起こし。音声バイト列をそのままbodyに載せる。"""
    if not audio:
        return {"error": "音声データが空です"}
    if len(audio) > MAX_AUDIO_BYTES:
        return {"error": f"音声が大きすぎます（上限 {MAX_AUDIO_BYTES // 1_000_000}MB）"}
    resp, err, base = _call_pipeline(model, data=audio,
                                    content_type=mime or "audio/mpeg")
    if err:
        return err
    try:
        j = resp.json()
    except Exception:
        return {"error": "文字起こしの応答を解釈できませんでした"}
    text = ""
    if isinstance(j, dict):
        text = str(j.get("text") or "")
    elif isinstance(j, list) and j:
        text = str((j[0] or {}).get("text") or "")
    text = text.strip()
    if not text:
        return {"error": "音声から文字を取り出せませんでした（無音の可能性があります）"}
    return {"ok": True, "kind": "text", "text": text, "endpoint": base}


def run_audio_out(model: str, text: str) -> dict:
    """読み上げ（text-to-speech）。音声バイト列を返す。"""
    if not (text or "").strip():
        return {"error": "読み上げる文章が空です"}
    resp, err, base = _call_pipeline(model, json_body={"inputs": text[:1000]})
    if err:
        return err
    mime = (resp.headers.get("content-type") or "audio/flac").split(";")[0].strip()
    raw = resp.content or b""
    if not raw or not mime.startswith("audio/"):
        return {"error": "このモデルは音声を返しませんでした（タスクが text-to-speech か確認してください）"}
    return {"ok": True, "kind": "audio", "data": raw, "mime": mime,
            "bytes": len(raw), "endpoint": base}


def _flatten_labels(j) -> List[dict]:
    """分類の応答は [[{label,score}...]] / [{...}] / {labels,scores} と揺れる。"""
    if isinstance(j, dict) and isinstance(j.get("labels"), list):
        scores = j.get("scores") or []
        return [{"label": str(l), "score": float(scores[i]) if i < len(scores) else 0.0}
                for i, l in enumerate(j["labels"])]
    items = j
    if isinstance(items, list) and items and isinstance(items[0], list):
        items = items[0]
    out = []
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict) and "label" in it:
                try:
                    out.append({"label": str(it["label"]), "score": float(it.get("score") or 0.0)})
                except Exception:
                    continue
    return out


def run_labels(model: str, text: str, candidate_labels: Optional[List[str]] = None) -> dict:
    """分類。candidate_labels を渡すと zero-shot として扱う。"""
    if not (text or "").strip():
        return {"error": "分類する文章が空です"}
    body: dict = {"inputs": text[:4000]}
    if candidate_labels:
        body["parameters"] = {"candidate_labels": [str(x) for x in candidate_labels][:20]}
    resp, err, base = _call_pipeline(model, json_body=body)
    if err:
        return err
    try:
        labels = _flatten_labels(resp.json())
    except Exception:
        return {"error": "分類の応答を解釈できませんでした"}
    if not labels:
        return {"error": "分類結果が空でした"}
    return {"ok": True, "kind": "labels", "labels": labels[:10], "endpoint": base}


def run_seq2seq(model: str, task: str, text: str) -> dict:
    """翻訳・要約。応答キーがタスクごとに違うので両方見る。"""
    if not (text or "").strip():
        return {"error": "入力が空です"}
    resp, err, base = _call_pipeline(model, json_body={"inputs": text[:8000]})
    if err:
        return err
    try:
        j = resp.json()
    except Exception:
        return {"error": "応答を解釈できませんでした"}
    out = ""
    if isinstance(j, list) and j and isinstance(j[0], dict):
        d = j[0]
        out = str(d.get("translation_text") or d.get("summary_text")
                  or d.get("generated_text") or "")
    elif isinstance(j, dict):
        out = str(j.get("translation_text") or j.get("summary_text")
                  or j.get("generated_text") or "")
    out = out.strip()
    if not out:
        return {"error": "結果が空でした（モデルのタスクが合っているか確認してください）"}
    return {"ok": True, "kind": "text", "text": out, "endpoint": base}


def run_embed(model: str, text: str) -> dict:
    """ベクトル化。長さと先頭数値だけ返す（全部返すと重いので要約して見せる）。"""
    if not (text or "").strip():
        return {"error": "入力が空です"}
    resp, err, base = _call_pipeline(model, json_body={"inputs": text[:4000]})
    if err:
        return err
    try:
        j = resp.json()
    except Exception:
        return {"error": "応答を解釈できませんでした"}
    vec = j
    while isinstance(vec, list) and vec and isinstance(vec[0], list):
        vec = vec[0]
    if not (isinstance(vec, list) and vec and isinstance(vec[0], (int, float))):
        return {"error": "ベクトルを取り出せませんでした"}
    return {"ok": True, "kind": "vector", "dim": len(vec),
            "head": [round(float(x), 4) for x in vec[:8]], "endpoint": base}


def run(task: str, model: str, text: str = "", audio: Optional[bytes] = None,
        audio_mime: str = "", labels: Optional[List[str]] = None,
        width: int = 0, height: int = 0) -> dict:
    """タスク名で振り分けて実行する（お試し実行 / 各機能から共用）。"""
    task = (task or "").strip()
    model = (model or "").strip()
    if task not in TASKS:
        return {"error": f"未知のタスクです: {task}"}
    if not model:
        return {"error": "モデルIDが空です"}
    if task == "text":
        return run_text(model, text)
    if task == "image":
        return run_image(model, text, width, height)
    if task == "asr":
        return run_asr(model, audio or b"", audio_mime or "audio/mpeg")
    if task == "tts":
        return run_audio_out(model, text)
    if task == "classify":
        return run_labels(model, text, labels)
    if task == "embed":
        return run_embed(model, text)
    return run_seq2seq(model, task, text)


# ── 動作確認（登録前/後に1回だけ叩く） ─────────────────────────────
def _probe_audio() -> bytes:
    """ASR確認用の短い無音mp3を作る（ffmpegが無ければ空）。"""
    import shutil
    import subprocess
    import tempfile
    ff = shutil.which("ffmpeg")
    if not ff:
        return b""
    work = tempfile.mkdtemp(prefix="hfp_")
    try:
        out = os.path.join(work, "p.mp3")
        subprocess.run([ff, "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                        "-t", "1", "-b:a", "32k", out], capture_output=True, timeout=60)
        with open(out, "rb") as f:
            return f.read()
    except Exception:
        return b""
    finally:
        shutil.rmtree(work, ignore_errors=True)


def test_model(model: str, task: str) -> dict:
    """実際に小さな入力で1回叩いて、使えるかを確かめる。

    「登録できた」ではなく「本当に動いた」を見せるための関数。
    無音の文字起こしのように“正しく空”になる場合は成功扱いにする。
    """
    model = (model or "").strip()
    task = (task or "").strip()
    if not valid_model_id(model):
        return {"error": "モデルIDの形式が正しくありません（例: openai/whisper-large-v3）"}
    if task not in TASKS:
        return {"error": f"未知のタスクです: {task}"}
    if not token():
        return {"error": "HuggingFaceのトークンが未設定です（設定 →「つなぐ」 の HUGGINGFACE_TOKEN）"}

    if task == "asr":
        audio = _probe_audio()
        if not audio:
            return {"error": "確認用の音声を作れませんでした（サーバーに ffmpeg がありません）"}
        res = run_asr(model, audio, "audio/mpeg")
        if res.get("error") and "無音" in res["error"]:
            res = {"ok": True, "kind": "text", "text": "（無音のため文字なし）"}
    elif task == "image":
        res = run_image(model, "a red apple on a white table", 512, 512)
    elif task == "embed":
        res = run_embed(model, "テスト")
    elif task == "classify":
        res = run_labels(model, "これはとても良い一日です", ["positive", "negative"])
    elif task == "tts":
        res = run_audio_out(model, "テストです")
    elif task == "text":
        res = run_text(model, "「準備完了」とだけ返してください。", max_tokens=20)
    else:
        res = run_seq2seq(model, task, "これはテストです。")

    if res.get("error"):
        return {"ok": False, "error": res["error"], "retry": bool(res.get("retry")),
                "detail": res.get("detail", "")}
    sample = ""
    if res.get("kind") == "text":
        sample = (res.get("text") or "")[:120]
    elif res.get("kind") == "image":
        sample = f"画像 {res.get('bytes', 0) // 1000}KB ({res.get('mime')})"
    elif res.get("kind") == "audio":
        sample = f"音声 {res.get('bytes', 0) // 1000}KB ({res.get('mime')})"
    elif res.get("kind") == "labels":
        sample = ", ".join(x["label"] for x in res.get("labels", [])[:3])
    elif res.get("kind") == "vector":
        sample = f"{res.get('dim')}次元"
    return {"ok": True, "sample": sample, "endpoint": res.get("endpoint", "")}


# ── Hub 検索（トークン不要の公開API） ─────────────────────────────
def search(query: str = "", task: str = "", limit: int = 12) -> dict:
    """HF Hub からモデルを探す。{ok, models:[{id, downloads, likes, task}]}。"""
    task = (task or "").strip()
    hf_task = TASKS.get(task, {}).get("hf_task", "")
    params = {"limit": max(1, min(int(limit or 12), 30)), "sort": "downloads",
              "direction": -1, "full": "false"}
    if (query or "").strip():
        params["search"] = query.strip()[:80]
    if hf_task:
        params["filter"] = hf_task
    try:
        r = requests.get(HUB_API, params=params, headers=_headers(), timeout=30)
    except Exception as e:
        return {"error": f"HuggingFace Hub に接続できませんでした: {e}",
                "suggested": SUGGESTED.get(task, [])}
    if r.status_code >= 400:
        return {"error": f"Hub 検索に失敗しました（{r.status_code}）",
                "suggested": SUGGESTED.get(task, [])}
    try:
        rows = r.json() or []
    except Exception:
        return {"error": "Hub の応答を解釈できませんでした",
                "suggested": SUGGESTED.get(task, [])}
    models = []
    for row in rows if isinstance(rows, list) else []:
        mid = (row.get("id") or row.get("modelId") or "").strip()
        if not mid:
            continue
        models.append({
            "id": mid,
            "downloads": int(row.get("downloads") or 0),
            "likes": int(row.get("likes") or 0),
            "task": row.get("pipeline_tag") or hf_task or "",
        })
    return {"ok": True, "models": models, "query": query, "task": task}


# ── 台帳（登録モデル） ─────────────────────────────────────────────
def valid_model_id(model: str) -> bool:
    m = (model or "").strip()
    return bool(m) and len(m) <= 120 and bool(MODEL_ID_RE.match(m))


def _persist(row: dict) -> None:
    c = config.get_supabase()
    if not c:
        return
    try:
        c.table("hf_models").upsert(row).execute()
    except Exception:
        pass


def list_models(limit: int = 100) -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("hf_models").select("*")
                    .order("created_at", desc=True).limit(limit).execute().data)
            if rows is not None:
                return rows
        except Exception:
            pass
    return list(reversed(_mem_models))[:limit]


def get_model(model_row_id: str) -> Optional[dict]:
    for m in _mem_models:
        if m.get("id") == model_row_id:
            return m
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("hf_models").select("*")
                    .eq("id", model_row_id).limit(1).execute().data) or []
            if rows:
                return rows[0]
        except Exception:
            pass
    return None


def add_model(model: str, task: str, label: str = "", note: str = "") -> dict:
    """台帳に1件追加する。同じ（モデル,タスク）の重複は作らない。"""
    model = (model or "").strip()
    task = (task or "").strip()
    if not valid_model_id(model):
        return {"error": "モデルIDの形式が正しくありません（例: openai/whisper-large-v3）"}
    if task not in TASKS:
        return {"error": f"未知のタスクです: {task}"}
    for m in list_models():
        if m.get("model") == model and m.get("task") == task:
            return {"error": "そのモデルは同じタスクで既に登録されています", "existing": m}
    row = {
        "id": str(uuid.uuid4()),
        "model": model,
        "task": task,
        "label": (label or "").strip()[:80] or model.split("/")[-1],
        "note": (note or "").strip()[:300],
        "verified": False,
        "last_error": "",
        "checked_at": None,
        "created_at": _now(),
    }
    _mem_models.append(row)
    _persist(row)
    return {"ok": True, "model": row}


def update_check(model_row_id: str, ok: bool, message: str = "") -> Optional[dict]:
    """テスト結果を台帳に書き戻す（動いたのかどうかを残す）。"""
    row = get_model(model_row_id)
    if not row:
        return None
    row = dict(row)
    row["verified"] = bool(ok)
    row["last_error"] = "" if ok else (message or "")[:300]
    row["checked_at"] = _now()
    for i, m in enumerate(_mem_models):
        if m.get("id") == model_row_id:
            _mem_models[i] = row
            break
    else:
        _mem_models.append(row)
    _persist(row)
    return row


def delete_model(model_row_id: str) -> dict:
    """台帳から削除する。割り当て中だった役割は外す（幽霊参照を残さない）。"""
    row = get_model(model_row_id)
    # 入れ物ごと置き換えると、保存先ごとに分けている意味が消える。
    # その場で削る。
    for _i in range(len(_mem_models) - 1, -1, -1):
        m = _mem_models[_i]
        if not (m.get("id") != model_row_id):
            del _mem_models[_i]
    c = config.get_supabase()
    if c:
        try:
            c.table("hf_models").delete().eq("id", model_row_id).execute()
        except Exception:
            pass
    cleared = []
    if row:
        for role, meta in ROLES.items():
            if _kc(meta["store_key"]) == row.get("model"):
                try:
                    keychain.set_key(meta["store_key"], "")
                except Exception:
                    pass
                cleared.append(role)
    return {"ok": True, "cleared_roles": cleared}


# ── 役割の割り当て ─────────────────────────────────────────────────
def assignments() -> dict:
    out = {}
    for role, meta in ROLES.items():
        out[role] = _kc(meta["store_key"])
    return out


def assign(role: str, model: str) -> dict:
    """役割にモデルを割り当てる（空文字で解除）。"""
    role = (role or "").strip()
    if role not in ROLES:
        return {"error": f"未知の役割です: {role}"}
    model = (model or "").strip()
    if model and not valid_model_id(model):
        return {"error": "モデルIDの形式が正しくありません"}
    try:
        keychain.set_key(ROLES[role]["store_key"], model)
    except Exception as e:
        return {"error": f"保存に失敗しました: {e}"}
    return {"ok": True, "role": role, "model": model, "assignments": assignments()}


def assigned(role: str) -> str:
    """役割に割り当てられたモデル（未設定なら空文字）。"""
    meta = ROLES.get((role or "").strip())
    return _kc(meta["store_key"]) if meta else ""


# ── 生成画像の保管（URLで配れるようにする） ─────────────────────────
# 画像はバイト列で返ってくるが、フロントや「生成物」履歴はURLを前提にしている。
# data: URL を履歴に入れると一覧が数MBになるので、ここに置いてURLで配る。
def save_image(data: bytes, mime: str = "image/png", prompt: str = "") -> str:
    """画像を保管してIDを返す。IDは推測できないUUID。"""
    img_id = str(uuid.uuid4())
    row = {
        "id": img_id,
        "mime": (mime or "image/png").split(";")[0].strip(),
        "data": base64.b64encode(data).decode("ascii"),
        "prompt": (prompt or "")[:300],
        "created_at": _now(),
    }
    _mem_images.append(row)
    del _mem_images[:-MEM_IMAGE_KEEP]
    c = config.get_supabase()
    if c:
        try:
            c.table("hf_images").insert(row).execute()
        except Exception:
            pass
    return img_id


def get_image(img_id: str) -> Tuple[Optional[bytes], str]:
    """保管した画像を返す。(bytes, mime) / (None, "")。"""
    img_id = (img_id or "").strip()
    if not img_id:
        return None, ""
    for row in reversed(_mem_images):
        if row.get("id") == img_id:
            try:
                return base64.b64decode(row["data"]), row.get("mime") or "image/png"
            except Exception:
                return None, ""
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("hf_images").select("data,mime")
                    .eq("id", img_id).limit(1).execute().data) or []
            if rows:
                return base64.b64decode(rows[0]["data"]), rows[0].get("mime") or "image/png"
        except Exception:
            pass
    return None, ""


def image_url(img_id: str) -> str:
    """フロントが <img src> に使えるURL。API_BASE が分かればフルURLにする。"""
    base = (os.environ.get("PUBLIC_API_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "").strip().rstrip("/")
    return f"{base}/hf/image/{img_id}" if base else f"/hf/image/{img_id}"


# ── 画像を「どのDBから読むか」の手形 ────────────────────────────
#
# <img src> はヘッダを付けられないので、画像を配る入口は認証を通していない。
# ところが保存先は人によって違う（各自のSupabase）。認証が無いということは
# 「誰の保存先を見ればいいか」も分からないということで、自分のDBに保存した
# 画像が読めなかった（「画像が読み込めない」の正体）。
#
# そこでURLに、署名した短い手形を載せる。中身は利用者IDだけで、
# 署名があるので他人のIDを騙れない。

def _sign_secret() -> bytes:
    import config as _c
    raw = (os.environ.get("KEYCHAIN_SECRET") or getattr(_c, "SUPABASE_SERVICE_KEY", "")
           or getattr(_c, "SUPABASE_URL", "") or "aibou-local")
    return hashlib.sha256(str(raw).encode("utf-8")).digest()


def sign_owner(user_id: str) -> str:
    """利用者IDから手形を作る。空なら空（既定のDBを見る）。"""
    uid = (user_id or "").strip()
    if not uid:
        return ""
    body = base64.urlsafe_b64encode(uid.encode("utf-8")).decode("ascii").rstrip("=")
    sig = hmac.new(_sign_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()[:16]
    return f"{body}.{sig}"


def verify_owner(token: str) -> str:
    """手形から利用者IDを取り出す。壊れていれば空（既定のDBを見る）。"""
    t = (token or "").strip()
    if not t or "." not in t:
        return ""
    body, _, sig = t.partition(".")
    want = hmac.new(_sign_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(sig, want):
        return ""
    try:
        pad = "=" * (-len(body) % 4)
        return base64.urlsafe_b64decode(body + pad).decode("utf-8")
    except Exception:
        return ""


# ── 状態（UIが「何ができるか」を判断するため） ─────────────────────
def status() -> dict:
    models = list_models()
    by_task: dict = {}
    for m in models:
        by_task.setdefault(m.get("task"), []).append(m.get("model"))
    return {
        "token_ready": token_ready(),
        "tasks": [{"key": k, **v} for k, v in TASKS.items()],
        "roles": [{**v, "key": k, "model": _kc(v["store_key"])} for k, v in ROLES.items()],
        "assignments": assignments(),
        "registered": len(models),
        "by_task": by_task,
        "suggested": SUGGESTED,
    }
