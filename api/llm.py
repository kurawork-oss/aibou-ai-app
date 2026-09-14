# llm.py — AIプロバイダ抽象化（Gemini / HuggingFace / OpenAI / Claude / Grok /
#          Ollama）＋自動フォールバック。
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
# OpenAI も同じ chat/completions の形なので、同じ読み取りコードを使い回せる。
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"

# Grok(x.ai) と Ollama は、どちらも OpenAI と同じ chat/completions の形で
# 話せる。だから上の読み取りコードをそのまま使い回せて、新しく書くのは
# 「どこへ繋ぐか」だけで済む。
GROK_URL = "https://api.x.ai/v1/chat/completions"
DEFAULT_GROK_MODEL = "grok-2-latest"
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "llama3.1"

# Claude だけは形が違う（/v1/messages・x-api-key・anthropic-version）。
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"
DEFAULT_HF_MODEL = "meta-llama/Llama-3.3-70B-Instruct"
# CODEモード用のコーディング特化モデル（HF）。KEYCHAIN/env の CODE_MODEL で上書き可。
DEFAULT_CODE_MODEL = "Qwen/Qwen2.5-Coder-32B-Instruct"


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


def _openai_token() -> str:
    return _kc("OPENAI_API_KEY")


def _anthropic_token() -> str:
    return _kc("ANTHROPIC_API_KEY")


def _grok_token() -> str:
    return _kc("XAI_API_KEY")


def _ollama_url() -> str:
    """手元のOllamaの居場所。入っていなければ空（＝使わない）。

    ここは鍵ではなくアドレス。既定値を勝手に入れない——入れてしまうと、
    立てていない人のところで毎回1回ぶんの接続待ちが発生する。
    """
    return _kc("OLLAMA_URL")


def anthropic_model() -> str:
    return _kc("ANTHROPIC_MODEL") or DEFAULT_ANTHROPIC_MODEL


def grok_model() -> str:
    return _kc("GROK_MODEL") or DEFAULT_GROK_MODEL


def ollama_model() -> str:
    return _kc("OLLAMA_MODEL") or DEFAULT_OLLAMA_MODEL


def openai_model() -> str:
    return _kc("OPENAI_MODEL") or DEFAULT_OPENAI_MODEL


def hf_model() -> str:
    return _kc("HF_MODEL") or DEFAULT_HF_MODEL


def code_model() -> str:
    """CODEモード用モデル（HF時）。CODE_MODEL 指定 → HF_MODEL → コーディング既定。"""
    return _kc("CODE_MODEL") or _kc("HF_MODEL") or DEFAULT_CODE_MODEL


def _provider_pref() -> str:
    return (_kc("LLM_PROVIDER") or "auto").strip().lower()


def providers_in_order() -> list:
    """使用を試みるプロバイダを優先順で返す（設定済みのもののみ）。

    OpenAI は明示的に選んだときだけ先頭に来る。従量課金なので、
    鍵を入れただけで勝手に使い始めると請求が発生する。
    ただし他が全部落ちたときの最後の受け皿には入れる（無言で止まるよりよい）。
    """
    hf = bool(_hf_token())
    gem = config.gemini_configured()
    oai = bool(_openai_token())
    pref = _provider_pref()
    if pref == "huggingface":
        order = ["huggingface", "gemini", "openai"]
    elif pref == "gemini":
        order = ["gemini", "huggingface", "openai"]
    elif pref == "openai":
        order = ["openai", "gemini", "huggingface"]
    else:  # auto
        order = (["huggingface", "gemini"] if hf else ["gemini", "huggingface"]) + ["openai"]
    avail = {"huggingface": hf, "gemini": gem, "openai": oai}
    out = [p for p in order if avail.get(p)]

    # あとから足した提供元（Claude・Grok・手元のOllama）も拾う。
    # ここを直さないと、**Claudeの鍵しか入れていない人には「AI未設定です」**
    # と出る（active_provider がこの並びを見ているため）。
    # 並べ方は router に任せる——無料が先、課金は最後、という線引きが
    # そちらに書いてあるので、二重に持たない。
    try:
        import router
        for prov in router.order_for("chat"):
            if prov not in out:
                out.append(prov)
    except Exception:
        pass

    return out


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


def _stream_chat_completions(url: str, token: str, model: str, prompt, label: str):
    """OpenAI互換の chat/completions を逐次読む。HFもOpenAIも同じ形。"""
    resp = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"model": model, "messages": _hf_messages(prompt), "stream": True, "max_tokens": 1800},
        stream=True,
        timeout=120,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"{label} {resp.status_code}: {resp.text[:300]}")
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


def _stream_openai(prompt):
    token = _openai_token()
    if not token:
        raise RuntimeError("OPENAI_API_KEY not set")
    yield from _stream_chat_completions(OPENAI_URL, token, openai_model(), prompt, "OpenAI")


def _gen_openai(prompt, max_tokens=2200) -> str:
    token = _openai_token()
    if not token:
        raise RuntimeError("OPENAI_API_KEY not set")
    r = requests.post(
        OPENAI_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"model": openai_model(), "messages": _hf_messages(prompt), "max_tokens": max_tokens},
        timeout=180,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"OpenAI {r.status_code}: {r.text[:300]}")
    return ((r.json().get("choices") or [{}])[0].get("message", {}).get("content")) or ""


# ── Grok / Ollama（どちらも OpenAI 互換） ─────────────────────────
def _stream_grok(prompt):
    token = _grok_token()
    if not token:
        raise RuntimeError("XAI_API_KEY not set")
    yield from _stream_chat_completions(GROK_URL, token, grok_model(), prompt, "Grok")


def _gen_grok(prompt, max_tokens=2200) -> str:
    token = _grok_token()
    if not token:
        raise RuntimeError("XAI_API_KEY not set")
    r = requests.post(
        GROK_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"model": grok_model(), "messages": _hf_messages(prompt), "max_tokens": max_tokens},
        timeout=180,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Grok {r.status_code}: {r.text[:300]}")
    return ((r.json().get("choices") or [{}])[0].get("message", {}).get("content")) or ""


def _ollama_endpoint() -> str:
    base = (_ollama_url() or "").rstrip("/")
    if not base:
        raise RuntimeError("OLLAMA_URL not set")
    return f"{base}/v1/chat/completions"


def _stream_ollama(prompt):
    # 手元で動くので鍵は要らない。OpenAI互換の口に空の鍵を送る。
    yield from _stream_chat_completions(_ollama_endpoint(), "ollama", ollama_model(),
                                        prompt, "Ollama")


def _gen_ollama(prompt, max_tokens=2200) -> str:
    r = requests.post(
        _ollama_endpoint(),
        headers={"Content-Type": "application/json"},
        json={"model": ollama_model(), "messages": _hf_messages(prompt),
              "max_tokens": max_tokens},
        timeout=300,        # 手元のモデルは遅い。待つ側に倒す
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama {r.status_code}: {r.text[:300]}")
    return ((r.json().get("choices") or [{}])[0].get("message", {}).get("content")) or ""


# ── Claude（Anthropic） ───────────────────────────────────────────
# ここだけ形が違う。messages API で、鍵は x-api-key、版の指定が要る。
def _anthropic_headers(token: str) -> dict:
    return {"x-api-key": token, "anthropic-version": ANTHROPIC_VERSION,
            "Content-Type": "application/json"}


def _stream_anthropic(prompt):
    token = _anthropic_token()
    if not token:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    resp = requests.post(
        ANTHROPIC_URL,
        headers=_anthropic_headers(token),
        json={"model": anthropic_model(), "max_tokens": 1800,
              "messages": _hf_messages(prompt), "stream": True},
        stream=True, timeout=120,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Claude {resp.status_code}: {resp.text[:300]}")
    for raw in resp.iter_lines():
        if not raw:
            continue
        line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        if not line.startswith("data:"):
            continue
        try:
            obj = json.loads(line[5:].strip())
        except Exception:
            continue
        # content_block_delta の text だけを拾う（他は制御用の知らせ）
        if obj.get("type") == "content_block_delta":
            piece = (obj.get("delta") or {}).get("text")
            if piece:
                yield piece


def _gen_anthropic(prompt, max_tokens=2200) -> str:
    token = _anthropic_token()
    if not token:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    r = requests.post(
        ANTHROPIC_URL,
        headers=_anthropic_headers(token),
        json={"model": anthropic_model(), "max_tokens": max_tokens,
              "messages": _hf_messages(prompt)},
        timeout=180,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Claude {r.status_code}: {r.text[:300]}")
    blocks = r.json().get("content") or []
    return "".join(b.get("text", "") for b in blocks if isinstance(b, dict))


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


def _gen_hf(prompt, model=None, max_tokens=2200) -> str:
    token = _hf_token()
    if not token:
        raise RuntimeError("HUGGINGFACE_TOKEN not set")
    r = requests.post(
        HF_ROUTER,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"model": model or hf_model(), "messages": _hf_messages(prompt), "max_tokens": max_tokens},
        timeout=180,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"HuggingFace {r.status_code}: {r.text[:300]}")
    return ((r.json().get("choices") or [{}])[0].get("message", {}).get("content")) or ""


# ── 公開API（プロバイダ横断＋フォールバック） ───────────────────────
# 提供元ごとの入口。**関数そのものではなく名前で持つ。**
#
# if を並べていくと、提供元を足すたびに2か所（流す側・1回で返す側）を
# 直すことになり、片方だけ足して静かに落ちる。表にすれば足し忘れが分かる。
#
# 名前で持つ理由: 関数そのものを入れると、この表が import した瞬間の
# 関数を掴んだままになる。テストが `llm._stream_gemini` を差し替えても
# 表は古いほうを呼び続け、**差し替えたつもりで本物が動く**
# （実際、既にあった切り替えのテストがこれで落ちた）。
_STREAMERS = {
    "gemini": "_stream_gemini",
    "huggingface": "_stream_hf",
    "openai": "_stream_openai",
    "anthropic": "_stream_anthropic",
    "grok": "_stream_grok",
    "ollama": "_stream_ollama",
}

_GENERATORS = {
    "gemini": "_gen_gemini",
    "huggingface": "_gen_hf",
    "openai": "_gen_openai",
    "anthropic": "_gen_anthropic",
    "grok": "_gen_grok",
    "ollama": "_gen_ollama",
}


def _fn(table: dict, prov: str):
    """いまの（差し替えられているかもしれない）関数を引く。"""
    name = table.get(prov)
    return globals().get(name) if name else None


# 受け付ける鍵を**全部**並べる。「などを設定してください」で済ませると、
# 何を入れればいいのか分からないまま詰まる。
NO_PROVIDER = ("AIプロバイダ未設定（"
               + " / ".join(["GEMINI_API_KEY", "HUGGINGFACE_TOKEN", "OPENAI_API_KEY",
                             "ANTHROPIC_API_KEY", "XAI_API_KEY", "OLLAMA_URL"])
               + " のいずれかを設定してください）")


def _order(task: str = "") -> list:
    """試す順。仕事が指定されていれば router に任せる。

    指定が無いときは、これまで通りの順を使う。呼び出し側を一斉に
    書き換えずに済ませるため（会話・CODE・要約などが30か所以上ある）。
    """
    if task:
        try:
            import router
            order = router.order_for(task)
            if order:
                return order
        except Exception:
            pass
    return providers_in_order()


def stream_text(prompt, task: str = ""):
    """トークンを逐次 yield する。最初の1トークンが出る前に失敗したら次の
    プロバイダへフォールバックする（例: Gemini 429 → HuggingFace）。

    task を渡すと、仕事の中身で選ぶ（router.py）。**課金される提供元は、
    その仕事に指名されたときだけ**先頭に来る。
    """
    order = _order(task)
    if not order:
        raise RuntimeError(NO_PROVIDER)
    last_err = None
    for prov in order:
        make = _fn(_STREAMERS, prov)
        if make is None:
            continue
        gen = make(prompt)
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


def generate_text(prompt, hf_model_override=None, max_tokens=2200, task: str = "") -> str:
    """非ストリームでテキストを1回生成（フォールバック付き）。
    hf_model_override: HF使用時に使うモデル（CODEモードのコーディング特化等）。
    task: 仕事の中身で選ぶ（router.py）。"""
    order = _order(task)
    if not order:
        raise RuntimeError(NO_PROVIDER)
    last_err = None
    for prov in order:
        run = _fn(_GENERATORS, prov)
        if run is None:
            continue
        try:
            # HF だけ「どのモデルを使うか」を外から渡せる（CODEモード用）
            if prov == "huggingface":
                return run(prompt, model=hf_model_override, max_tokens=max_tokens)
            if prov == "gemini":
                return run(prompt)
            return run(prompt, max_tokens=max_tokens)
        except Exception as e:
            last_err = e
            continue
    raise last_err or RuntimeError("全プロバイダで生成に失敗しました")
