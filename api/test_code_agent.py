# test_code_agent.py — CODE モード（api/code_agent.py）のユニットテスト。Gemini 不要。
import config
import code_agent as code_mod


# ── generate: 設定なし ────────────────────────────────────────────
def test_generate_without_gemini_returns_error(monkeypatch):
    monkeypatch.setattr(config, "get_gemini_model", lambda *a, **k: None)
    r = code_mod.generate("Webアプリを作って", [])
    assert "error" in r and "GEMINI_API_KEY" in r["error"]


def test_generate_requires_instruction():
    r = code_mod.generate("", [])
    assert "error" in r


# ── _extract_json ─────────────────────────────────────────────────
def test_extract_json_plain():
    assert code_mod._extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_fenced():
    assert code_mod._extract_json('```json\n{"a": "b"}\n```') == {"a": "b"}


def test_extract_json_with_prose_around():
    text = 'はい、変更しました。\n{"explanation": "x", "files": []}\n以上です。'
    assert code_mod._extract_json(text) == {"explanation": "x", "files": []}


def test_extract_json_trailing_comma():
    assert code_mod._extract_json('{"a": [1, 2,], }') == {"a": [1, 2]}


def test_extract_json_braces_inside_strings():
    obj = code_mod._extract_json('{"code": "if (x) { y() }"}')
    assert obj == {"code": "if (x) { y() }"}


def test_extract_json_garbage_returns_none():
    assert code_mod._extract_json("こんにちは") is None
    assert code_mod._extract_json("") is None


# ── _safe_path ────────────────────────────────────────────────────
def test_safe_path_ok():
    assert code_mod._safe_path("index.html") == "index.html"
    assert code_mod._safe_path("src/app.py") == "src/app.py"
    assert code_mod._safe_path("./a/b.txt") == "a/b.txt"


def test_safe_path_rejects():
    assert code_mod._safe_path("../x") is None
    assert code_mod._safe_path("/etc/passwd") is None
    assert code_mod._safe_path("a\\b") is None
    assert code_mod._safe_path("a" * 200) is None
    assert code_mod._safe_path("d/" * 8 + "f.txt") is None
    assert code_mod._safe_path("bad|name") is None
    assert code_mod._safe_path("") is None


# ── scaffold ──────────────────────────────────────────────────────
def test_scaffold_web_has_index_html():
    r = code_mod.scaffold("web")
    paths = [f["path"] for f in r["files"]]
    assert "index.html" in paths
    assert "<!doctype html>" in r["files"][0]["content"]


def test_scaffold_python():
    r = code_mod.scaffold("python")
    paths = [f["path"] for f in r["files"]]
    assert "main.py" in paths and "README.md" in paths


def test_scaffold_empty():
    assert code_mod.scaffold("empty") == {"files": []}
    assert code_mod.scaffold("unknown") == {"files": []}


# ── generate: フェイクモデルで正常系 ────────────────────────────────
class _FakeResp:
    def __init__(self, text):
        self.text = text


class _FakeModel:
    def __init__(self, text):
        self._text = text

    def generate_content(self, prompt, **kwargs):
        assert "指示" in prompt  # プロンプトが組めていること
        return _FakeResp(self._text)


def test_generate_with_fake_model(monkeypatch):
    payload = (
        '{"explanation": "index.html を更新し、util を削除しました。", "files": ['
        '{"path": "index.html", "content": "<h1>ok</h1>", "action": "update"},'
        '{"path": "../evil.sh", "content": "rm -rf /", "action": "create"},'
        '{"path": "old/util.js", "content": "", "action": "delete"}]}'
    )
    monkeypatch.setattr(config, "get_gemini_model", lambda *a, **k: _FakeModel(payload))
    r = code_mod.generate("直して", [{"path": "index.html", "content": "<h1>old</h1>"}])
    assert "error" not in r
    paths = [f["path"] for f in r["files"]]
    assert "index.html" in paths and "old/util.js" in paths
    assert "../evil.sh" not in paths          # 不正パスは落ちる
    assert "スキップ" in r["explanation"]      # スキップの注記
    delete = next(f for f in r["files"] if f["action"] == "delete")
    assert delete["content"] == ""


def test_generate_model_error_is_caught(monkeypatch):
    class _Boom:
        def generate_content(self, prompt, **kwargs):
            raise RuntimeError("quota")
    monkeypatch.setattr(config, "get_gemini_model", lambda *a, **k: _Boom())
    r = code_mod.generate("作って", [])
    assert "error" in r and "generation failed" in r["error"]
