# llm.py — AIプロバイダ抽象化（Gemini / HuggingFace）＋自動フォールバック。
# どのモード(chat/me/forge/code/…)も、Geminiに固定せずここ経由でテキスト生成する。
# Geminiが429(無料枠0)等で失敗したら、HuggingFace(設定があれば)へ自動で切替える。
#
# HuggingFace は OpenAI 互換ルーター(router.huggingface.co)を使用。
#   - トークン: KEYCHAIN の HUGGINGFACE_TOKEN（または環境変数）
#   - モデル:   KEYCHAIN/env の HF_MODEL（既定 Llama-3.3-70B-Instruct）
#   - プロバイダ選択: LLM_PROVIDER = gemini | huggingface | auto(既定)
#     auto は「HFトークンがあればHF優先(ユーザーが意図的に入れたため)、無ければGemini」。
#   - 多くのHFプロバイダは入力を学習に使わない（プライバシー用途に向く）。
import json
import os

import requests

import config
import keychain

HF_ROUTER = "https://router.huggingface.co/v1/chat/completions"
DEFAULT_HF_MODEL = "meta-llama/Llama-3.3-70B-Instruct"


def _kc(name: str) -> str:
    """KEYCHAIN → 環境変数 の順で設定値を取る。"""
    try:
        v = keychain.get_key(name)
        if v:
            return v
    except Exception:
        pass
    return os.environ.get(name, "").strip()


def _hf_token() -> str:
    return _kc("HUGGINGFACE_TOKEN")


def hf_model() -> str:
    return _kc("HF_MODEL") or DEFAULT_HF_MODEL


def _provider_pref() -> str:
    return (_kc("LLM_PROVIDER") or "auto").strip().lower()


def providers_in_order() -> list:
    """使用を試みるプロバイダを優先順で返す（設定済みのもののみ）。"""
    hf = bool(_hf_token())
    gem = config.gemini_configured()
    pref = _provider_pref()
    if pref == "huggingface":
        order = ["huggingface", "gemini"]
    elif pref == "gemini":
        order = ["gemini", "huggingface"]
    else:  # auto
        order = ["huggingface", "gemini"] if hf else ["gemini", "huggingface"]
    avail = {"huggingface": hf, "gemini": gem}
    return [p for p in order if avail.get(p)]


def active_provider() -> str:
    order = providers_in_order()
    return order[0] if order else "none"


# ── Gemini ────────────────────────────────────────────────────────
def _stream_gemini(prompt):
    stream = config.generate_resilient(prompt, stream=True)
    if stream is None:
        raise RuntimeError("gemini not configured")
    for chunk in stream:
        t = getattr(chunk, "text", None)
        if t:
            yield t


def _gen_gemini(prompt) -> str:
    resp = config.generate_resilient(prompt)
    if resp is None:
        raise RuntimeError("gemini not configured")
    return getattr(resp, "text", "") or ""


# ── HuggingFace (OpenAI互換ルーター) ──────────────────────────────
def _hf_messages(prompt):
    return [{"role": "user", "content": prompt if isinstance(prompt, str) else str(prompt)}]


def _stream_hf(prompt):
    token = _hf_token()
    if not token:
        raise RuntimeError("HUGGINGFACE_TOKEN not set")
    resp = requests.post(
        HF_ROUTER,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"model": hf_model(), "messages": _hf_messages(prompt), "stream": True, "max_tokens": 1800},
        stream=True,
        timeout=120,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"HuggingFace {resp.status_code}: {resp.text[:300]}")
    for raw in resp.iter_lines():
        if not raw:
            continue
        line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            obj = json.loads(data)
            delta = (obj.get("choices") or [{}])[0].get("delta", {}).get("content")
            if delta:
                yield delta
        except Exception:
            continue


def _gen_hf(prompt) -> str:
    token = _hf_token()
    if not token:
        raise RuntimeError("HUGGINGFACE_TOKEN not set")
    r = requests.post(
        HF_ROUTER,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"model": hf_model(), "messages": _hf_messages(prompt), "max_tokens": 2200},
        timeout=120,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"HuggingFace {r.status_code}: {r.text[:300]}")
    return ((r.json().get("choices") or [{}])[0].get("message", {}).get("content")) or ""


# ── 公開API（プロバイダ横断＋フォールバック） ───────────────────────
def stream_text(prompt):
    """トークンを逐次 yield する。最初の1トークンが出る前に失敗したら次の
    プロバイダへフォールバックする（例: Gemini 429 → HuggingFace）。"""
    order = providers_in_order()
    if not order:
        raise RuntimeError("AIプロバイダ未設定（GEMINI_API_KEY か HUGGINGFACE_TOKEN を設定してください）")
    last_err = None
    for prov in order:
        gen = _stream_gemini(prompt) if prov == "gemini" else _stream_hf(prompt)
        try:
            first = next(gen)
        except StopIteration:
            return
        except Exception as e:
            last_err = e
            continue  # このプロバイダは開始前に失敗 → 次へ
        yield first
        for tok in gen:
            yield tok
        return
    raise last_err or RuntimeError("全プロバイダで生成に失敗しました")


def generate_text(prompt) -> str:
    """非ストリームでテキストを1回生成（フォールバック付き）。"""
    order = providers_in_order()
    if not order:
        raise RuntimeError("AIプロバイダ未設定（GEMINI_API_KEY か HUGGINGFACE_TOKEN を設定してください）")
    last_err = None
    for prov in order:
        try:
            return _gen_gemini(prompt) if prov == "gemini" else _gen_hf(prompt)
        except Exception as e:
            last_err = e
            continue
    raise last_err or RuntimeError("全プロバイダで生成に失敗しました")
