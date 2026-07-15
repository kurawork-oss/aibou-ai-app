# test_code_agent.py — CODE モード（差分編集エンジン）のユニットテスト。AI不要。
import code_agent as ca
import llm


def test_generate_without_provider(monkeypatch):
    monkeypatch.setattr(llm, "active_provider", lambda: "none")
    r = ca.generate("Webアプリを作って", [])
    assert "error" in r and "GEMINI_API_KEY" in r["error"]


def test_generate_requires_instruction():
    assert "error" in ca.generate("", [])


def test_safe_path():
    assert ca._safe_path("src/app.py") == "src/app.py"
    assert ca._safe_path("./a/b.txt") == "a/b.txt"
    assert ca._safe_path("../x") is None
    assert ca._safe_path("/etc/passwd") is None
    assert ca._safe_path("a\\b") is None
    assert ca._safe_path("bad name.py") is None


def test_looks_like_path():
    assert ca._looks_like_path("index.html") == "index.html"
    assert ca._looks_like_path("`src/app.py`") == "src/app.py"
    assert ca._looks_like_path("I will update index.html now") is None
    assert ca._looks_like_path("plain text") is None


def test_parse_replace_block():
    text = "まず色を変えます。\n\nindex.html\n<<<<<<< SEARCH\nbackground:#0a0e14;\n=======\nbackground:#101020;\n>>>>>>> REPLACE\n"
    plan, edits = ca.parse_edits(text)
    assert "色を変え" in plan
    assert len(edits) == 1
    assert edits[0]["op"] == "replace" and edits[0]["path"] == "index.html"
    assert edits[0]["search"] == "background:#0a0e14;"
    assert edits[0]["replace"] == "background:#101020;"


def test_parse_new_file_empty_search():
    text = "新規ファイルを作ります。\n\nstyle.css\n<<<<<<< SEARCH\n=======\nbody { margin: 0; }\n>>>>>>> REPLACE\n"
    _, edits = ca.parse_edits(text)
    assert edits[0]["path"] == "style.css" and edits[0]["search"] == "" and "margin" in edits[0]["replace"]


def test_parse_delete_directive():
    _, edits = ca.parse_edits("不要なので消します。\nDELETE: old/util.js")
    assert edits == [{"op": "delete", "path": "old/util.js"}]


def test_parse_multiple_blocks():
    text = ("2箇所直します。\n\na.py\n<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE\n\n"
            "b.py\n<<<<<<< SEARCH\ny = 1\n=======\ny = 2\n>>>>>>> REPLACE\n")
    _, edits = ca.parse_edits(text)
    assert len(edits) == 2 and {e["path"] for e in edits} == {"a.py", "b.py"}


def test_apply_edit_success():
    fm, res = ca.apply_edits({"a.py": "x = 1\nprint(x)\n"},
                             [{"op": "replace", "path": "a.py", "search": "x = 1", "replace": "x = 42"}])
    assert fm["a.py"] == "x = 42\nprint(x)\n" and res[0]["status"] == "applied" and res[0]["action"] == "edit"


def test_apply_edit_search_not_found():
    fm, res = ca.apply_edits({"a.py": "x = 1\n"},
                             [{"op": "replace", "path": "a.py", "search": "z = 9", "replace": "z = 0"}])
    assert res[0]["status"] == "failed" and res[0]["reason"].startswith("SEARCH")
    assert fm["a.py"] == "x = 1\n"


def test_apply_new_file():
    fm, res = ca.apply_edits({}, [{"op": "replace", "path": "new.py", "search": "", "replace": "print('hi')"}])
    assert fm["new.py"] == "print('hi')" and res[0]["action"] == "create"


def test_apply_delete():
    fm, res = ca.apply_edits({"gone.py": "x"}, [{"op": "delete", "path": "gone.py"}])
    assert "gone.py" not in fm and res[0]["action"] == "delete"


def test_apply_unsafe_path_rejected():
    _, res = ca.apply_edits({}, [{"op": "replace", "path": "../evil", "search": "", "replace": "x"}])
    assert res[0]["status"] == "failed"


def test_replace_once_whitespace_tolerant():
    new, ok = ca._replace_once("def f():   \n    return 1\n", "def f():\n    return 1", "def f():\n    return 2")
    assert ok and "return 2" in new


def test_generate_applies_diffs(monkeypatch):
    reply = ("タイトルの色を変え、CSSファイルを追加します。\n\n"
             "index.html\n<<<<<<< SEARCH\n<title>My App</title>\n=======\n<title>My Great App</title>\n>>>>>>> REPLACE\n\n"
             "style.css\n<<<<<<< SEARCH\n=======\nbody { background: #111; }\n>>>>>>> REPLACE\n")
    monkeypatch.setattr(llm, "active_provider", lambda: "huggingface")
    monkeypatch.setattr(llm, "generate_text", lambda prompt, **k: reply)
    r = ca.generate("タイトルを変えてCSSを追加して",
                    [{"path": "index.html", "content": "<title>My App</title>\n<body></body>"}])
    assert "error" not in r
    files = {f["path"]: f for f in r["files"]}
    assert files["index.html"]["content"].startswith("<title>My Great App</title>")
    assert files["index.html"]["action"] == "update" and files["style.css"]["action"] == "create"
    assert "適用 2件" in r["explanation"]


def test_generate_self_repair(monkeypatch):
    monkeypatch.setattr(llm, "active_provider", lambda: "huggingface")
    calls = {"n": 0}
    def fake(prompt, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            return "直します。\n\napp.py\n<<<<<<< SEARCH\nnonexistent_line\n=======\nfixed\n>>>>>>> REPLACE"
        return "実内容に合わせ直します。\n\napp.py\n<<<<<<< SEARCH\nreal = 1\n=======\nreal = 2\n>>>>>>> REPLACE"
    monkeypatch.setattr(llm, "generate_text", fake)
    r = ca.generate("realを2に", [{"path": "app.py", "content": "real = 1\n"}])
    assert calls["n"] == 2
    files = {f["path"]: f for f in r["files"]}
    assert "real = 2" in files["app.py"]["content"]


def test_generate_json_fallback(monkeypatch):
    monkeypatch.setattr(llm, "active_provider", lambda: "gemini")
    payload = '{"explanation":"x","files":[{"path":"a.py","content":"print(1)","action":"create"}]}'
    monkeypatch.setattr(llm, "generate_text", lambda prompt, **k: payload)
    r = ca.generate("作って", [])
    files = {f["path"]: f for f in r["files"]}
    assert files["a.py"]["content"] == "print(1)"


def test_generate_error_caught(monkeypatch):
    monkeypatch.setattr(llm, "active_provider", lambda: "huggingface")
    def boom(prompt, **k):
        raise RuntimeError("quota")
    monkeypatch.setattr(llm, "generate_text", boom)
    r = ca.generate("作って", [])
    assert "error" in r and "generation failed" in r["error"]


def test_scaffold_web():
    assert any(f["path"] == "index.html" for f in ca.scaffold("web")["files"])


def test_scaffold_python():
    paths = [f["path"] for f in ca.scaffold("python")["files"]]
    assert "main.py" in paths and "README.md" in paths


def test_scaffold_empty():
    assert ca.scaffold("empty") == {"files": []}


# ── run_stream: 段階進捗（Claude Code風） ──────────────────────────
def test_run_stream_phases_normal(monkeypatch):
    reply = "計画: タイトル変更。\n\nindex.html\n<<<<<<< SEARCH\nOld\n=======\nNew\n>>>>>>> REPLACE"
    monkeypatch.setattr(llm, "active_provider", lambda: "huggingface")
    monkeypatch.setattr(llm, "code_model", lambda: "Qwen/Qwen2.5-Coder-32B-Instruct")
    monkeypatch.setattr(llm, "generate_text", lambda prompt, **k: reply)
    events = list(ca.run_stream("直して", [{"path": "index.html", "content": "Old"}]))
    phases = [e["phase"] for e in events]
    assert phases[0] == "start"
    assert "editing" in phases and "applying" in phases
    assert phases[-1] == "done"
    done = events[-1]
    assert {f["path"]: f for f in done["files"]}["index.html"]["content"] == "New"


def test_run_stream_deep_has_review(monkeypatch):
    monkeypatch.setattr(llm, "active_provider", lambda: "huggingface")
    monkeypatch.setattr(llm, "code_model", lambda: "coder")
    seq = {"n": 0}

    def fake(prompt, **k):
        seq["n"] += 1
        if seq["n"] == 1:      # plan
            return "計画: xを2に。"
        if seq["n"] == 2:      # implement
            return "app.py\n<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE"
        return "LGTM"          # review: no edits

    monkeypatch.setattr(llm, "generate_text", fake)
    events = list(ca.run_stream("xを2に", [{"path": "app.py", "content": "x = 1"}], depth="deep"))
    phases = [e["phase"] for e in events]
    assert "planning" in phases and "implementing" in phases and "reviewing" in phases
    assert seq["n"] == 3  # plan + implement + review
    assert phases[-1] == "done"
    files = {f["path"]: f for f in events[-1]["files"]}
    assert "x = 2" in files["app.py"]["content"]


def test_run_stream_error(monkeypatch):
    monkeypatch.setattr(llm, "active_provider", lambda: "none")
    events = list(ca.run_stream("作って", []))
    assert events[-1]["phase"] == "error"
