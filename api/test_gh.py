# test_gh.py — GitHub連携（gh.py）のユニットテスト。実APIは呼ばない。
import base64

import gh
import keychain


def test_no_token_errors(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "")
    assert "GITHUB_TOKEN" in gh.list_repos()["error"]
    assert "GITHUB_TOKEN" in gh.import_repo("a/b")["error"]
    assert "GITHUB_TOKEN" in gh.push_files("a/b", "main", "br", "msg", [{"path": "x", "content": "y"}])["error"]


def test_import_requires_owner_name(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "tok")
    assert "owner/name" in gh.import_repo("not-a-repo")["error"]


def test_push_requires_files(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "tok")
    assert "ファイル" in gh.push_files("a/b", "main", "br", "msg", [])["error"]


def test_is_text_path():
    assert gh._is_text_path("src/app.py")
    assert gh._is_text_path("index.html")
    assert gh._is_text_path("Dockerfile")
    assert gh._is_text_path("README")
    assert not gh._is_text_path("logo.png")
    assert not gh._is_text_path("video.mp4")
    assert not gh._is_text_path("bin/tool.exe")


class _Resp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload or {}
        self.text = ""

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_import_filters_and_caps(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "tok")
    tree = [
        {"type": "blob", "path": "src/app.py", "size": 10},
        {"type": "blob", "path": "docs/guide.md", "size": 10},
        {"type": "blob", "path": "img/logo.png", "size": 10},   # 拡張子で除外
        {"type": "blob", "path": "big.py", "size": 999_999},     # サイズで除外
        {"type": "tree", "path": "src"},
    ]

    def fake_get(token, url, **params):
        if url.endswith("/repos/o/r"):
            return _Resp(200, {"default_branch": "main"})
        if "/git/trees/" in url:
            return _Resp(200, {"tree": tree})
        if "/contents/" in url:
            return _Resp(200, {"encoding": "base64",
                               "content": base64.b64encode("print('hi')".encode()).decode()})
        return _Resp(404, {})

    monkeypatch.setattr(gh, "_get", fake_get)
    r = gh.import_repo("o/r")
    assert r["ref"] == "main"
    paths = [f["path"] for f in r["files"]]
    assert "src/app.py" in paths and "docs/guide.md" in paths
    assert "img/logo.png" not in paths and "big.py" not in paths
    assert r["skipped"] == 2
    assert r["files"][0]["content"] == "print('hi')"


def test_import_path_prefix(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "tok")
    tree = [
        {"type": "blob", "path": "webapp/src/a.ts", "size": 5},
        {"type": "blob", "path": "api/main.py", "size": 5},
    ]

    def fake_get(token, url, **params):
        if "/git/trees/" in url:
            return _Resp(200, {"tree": tree})
        if "/contents/" in url:
            return _Resp(200, {"encoding": "base64", "content": base64.b64encode(b"x").decode()})
        return _Resp(200, {"default_branch": "main"})

    monkeypatch.setattr(gh, "_get", fake_get)
    r = gh.import_repo("o/r", ref="main", path="webapp")
    assert [f["path"] for f in r["files"]] == ["webapp/src/a.ts"]


def test_list_repos_shapes_items(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "tok")

    def fake_get(token, url, **params):
        return _Resp(200, [
            {"full_name": "me/app", "private": True, "default_branch": "main",
             "description": "my app", "pushed_at": "2026-07-01T00:00:00Z"},
        ])

    monkeypatch.setattr(gh, "_get", fake_get)
    r = gh.list_repos()
    assert r["items"][0]["full_name"] == "me/app"
    assert r["items"][0]["private"] is True


def test_list_repos_bad_token(monkeypatch):
    monkeypatch.setattr(keychain, "get_key", lambda name: "tok")
    monkeypatch.setattr(gh, "_get", lambda token, url, **p: _Resp(401, {}))
    assert "401" in gh.list_repos()["error"]
