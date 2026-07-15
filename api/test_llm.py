# test_llm.py — プロバイダ抽象化（Gemini/HuggingFace + フォールバック）のテスト。
import config
import keychain
import llm


def _no_keys(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "")
    monkeypatch.setattr(config, "gemini_configured", lambda: False)


def test_no_provider(monkeypatch):
    _no_keys(monkeypatch)
    monkeypatch.setattr(config, "_kc", getattr(config, "_kc", None)) if False else None
    assert llm.active_provider() == "none"
    assert llm.providers_in_order() == []


def test_provider_order_auto_prefers_hf_when_token(monkeypatch):
    # HFトークンあり + Gemini設定あり → auto は HF優先
    monkeypatch.setattr(keychain, "get_key", lambda name: "hf_xxx" if name == "HUGGINGFACE_TOKEN" else "")
    monkeypatch.setattr(config, "gemini_configured", lambda: True)
    assert llm.providers_in_order()[0] == "huggingface"
    assert llm.active_provider() == "huggingface"


def test_provider_order_gemini_only(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "")
    monkeypatch.setattr(config, "gemini_configured", lambda: True)
    assert llm.providers_in_order() == ["gemini"]


def test_provider_pref_forces_gemini(monkeypatch):
    def kc(name):
        return {"HUGGINGFACE_TOKEN": "hf_x", "LLM_PROVIDER": "gemini"}.get(name, "")
    monkeypatch.setattr(keychain, "get_key", kc)
    monkeypatch.setattr(config, "gemini_configured", lambda: True)
    assert llm.providers_in_order()[0] == "gemini"


def test_stream_falls_back_gemini_to_hf(monkeypatch):
    # Gemini がストリーム開始前に 429 → HF に切替
    monkeypatch.setattr(keychain, "get_key", lambda name: "hf_x" if name == "HUGGINGFACE_TOKEN" else "")
    monkeypatch.setattr(config, "gemini_configured", lambda: True)
    monkeypatch.setattr(llm, "_provider_pref", lambda: "gemini")  # Gemini優先→失敗→HF

    def boom_gemini(prompt):
        raise RuntimeError("429 limit: 0")
        yield  # noqa
    monkeypatch.setattr(llm, "_stream_gemini", boom_gemini)

    def fake_hf(prompt):
        yield "こんにちは"
        yield "、元気ですか"
    monkeypatch.setattr(llm, "_stream_hf", fake_hf)

    out = "".join(llm.stream_text("test"))
    assert out == "こんにちは、元気ですか"


def test_generate_text_uses_hf(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "hf_x" if name == "HUGGINGFACE_TOKEN" else "")
    monkeypatch.setattr(config, "gemini_configured", lambda: False)
    monkeypatch.setattr(llm, "_gen_hf", lambda prompt: "HF回答")
    assert llm.generate_text("q") == "HF回答"


def test_hf_stream_parses_openai_sse(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "hf_tok" if name == "HUGGINGFACE_TOKEN" else "")

    class _Resp:
        status_code = 200

        def iter_lines(self):
            yield b'data: {"choices":[{"delta":{"content":"Hello"}}]}'
            yield b'data: {"choices":[{"delta":{"content":" world"}}]}'
            yield b'data: [DONE]'

    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: _Resp())
    assert "".join(llm._stream_hf("hi")) == "Hello world"


def test_hf_stream_http_error(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "hf_tok" if name == "HUGGINGFACE_TOKEN" else "")

    class _Resp:
        status_code = 402
        text = "Payment Required"

        def iter_lines(self):
            return iter([])

    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: _Resp())
    try:
        list(llm._stream_hf("hi"))
        assert False, "should raise"
    except RuntimeError as e:
        assert "402" in str(e)


def test_hf_model_default_and_override(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "")
    assert llm.hf_model() == llm.DEFAULT_HF_MODEL
    monkeypatch.setattr(keychain, "get_key", lambda name: "Qwen/Qwen2.5-7B-Instruct" if name == "HF_MODEL" else "")
    assert llm.hf_model() == "Qwen/Qwen2.5-7B-Instruct"
