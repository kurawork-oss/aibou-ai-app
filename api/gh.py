# gh.py — CODE モードの GitHub 連携（リポジトリ一覧 / インポート / プッシュ+PR）。
# トークンは KEYCHAIN の GITHUB_TOKEN（Fernet暗号化でSupabase保管）または環境変数。
# トークンがフロントに出ることは無い（全てバックエンド経由）。絶対に crash しない。
import base64

import requests

import keychain

API = "https://api.github.com"

# ワークスペースはブラウザ内に展開するため、取り込みは控えめに制限する。
MAX_FILES = 60
MAX_FILE_BYTES = 200_000

# テキストとして扱う拡張子（それ以外の blob はスキップ）
_TEXT_EXT = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".html", ".htm",
    ".css", ".scss", ".md", ".txt", ".yml", ".yaml", ".toml", ".ini", ".cfg",
    ".sh", ".bash", ".sql", ".xml", ".svg", ".vue", ".svelte", ".go", ".rs",
    ".rb", ".php", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".env.example",
    ".gitignore", ".dockerignore", "dockerfile", "makefile", ".prisma", ".graphql",
}


def _token() -> str:
    return keychain.get_key("GITHUB_TOKEN")


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _get(token: str, url: str, **params) -> requests.Response:
    return requests.get(url, headers=_headers(token), params=params or None, timeout=30)


def _is_text_path(path: str) -> bool:
    """拡張子（または既知の無拡張ファイル名）でテキストらしさを判定する。"""
    name = path.rsplit("/", 1)[-1].lower()
    if name in ("dockerfile", "makefile", "procfile", "license", "readme"):
        return True
    for ext in _TEXT_EXT:
        if name.endswith(ext):
            return True
    return False


def _no_token_error() -> dict:
    return {"error": "GITHUB_TOKEN が未設定です。GitHubでFine-grained PAT（Contents / Pull requests 権限）を作成し、Settings → KEYCHAIN に GITHUB_TOKEN として保存してください。"}


def list_repos() -> dict:
    """アクセス可能なリポジトリ一覧（更新順・最大50件）。"""
    token = _token()
    if not token:
        return _no_token_error()
    try:
        r = _get(token, f"{API}/user/repos", sort="updated", per_page=50)
        if r.status_code == 401:
            return {"error": "GITHUB_TOKEN が無効です（401）。トークンを確認してください。"}
        r.raise_for_status()
        items = [
            {
                "full_name": x.get("full_name"),
                "private": bool(x.get("private")),
                "default_branch": x.get("default_branch") or "main",
                "description": (x.get("description") or "")[:120],
                "pushed_at": x.get("pushed_at") or "",
            }
            for x in (r.json() or [])
        ]
        return {"items": items}
    except Exception as e:
        return {"error": f"GitHub API error: {e}"}


def import_repo(repo: str, ref: str = "", path: str = "") -> dict:
    """repo（owner/name）のツリーを取得し、テキストファイル群を返す。
    path を指定するとそのフォルダ以下だけを取り込む。"""
    token = _token()
    if not token:
        return _no_token_error()
    repo = (repo or "").strip()
    if "/" not in repo:
        return {"error": "repo は owner/name 形式で指定してください"}
    prefix = (path or "").strip().strip("/")
    try:
        if not ref:
            info = _get(token, f"{API}/repos/{repo}")
            if info.status_code == 404:
                return {"error": f"リポジトリが見つかりません: {repo}（トークンの対象リポジトリ設定を確認）"}
            info.raise_for_status()
            ref = info.json().get("default_branch") or "main"

        tree_res = _get(token, f"{API}/repos/{repo}/git/trees/{ref}", recursive=1)
        if tree_res.status_code == 404:
            return {"error": f"ブランチが見つかりません: {ref}"}
        tree_res.raise_for_status()
        tree = tree_res.json().get("tree") or []

        candidates = []
        skipped = 0
        for node in tree:
            if node.get("type") != "blob":
                continue
            p = node.get("path") or ""
            if prefix and not (p == prefix or p.startswith(prefix + "/")):
                continue
            if not _is_text_path(p) or (node.get("size") or 0) > MAX_FILE_BYTES:
                skipped += 1
                continue
            candidates.append(p)
        candidates.sort()
        overflow = max(0, len(candidates) - MAX_FILES)
        skipped += overflow
        candidates = candidates[:MAX_FILES]

        files = []
        for p in candidates:
            fr = _get(token, f"{API}/repos/{repo}/contents/{p}", ref=ref)
            if fr.status_code != 200:
                skipped += 1
                continue
            data = fr.json()
            if data.get("encoding") == "base64":
                try:
                    content = base64.b64decode(data.get("content") or "").decode("utf-8")
                except Exception:
                    skipped += 1
                    continue
            else:
                content = data.get("content") or ""
            files.append({"path": p, "content": content})

        return {"repo": repo, "ref": ref, "files": files, "skipped": skipped}
    except Exception as e:
        return {"error": f"GitHub import error: {e}"}


def push_files(
    repo: str,
    base: str,
    branch: str,
    message: str,
    files: list,
    create_pr: bool = True,
    pr_title: str = "",
) -> dict:
    """files を新ブランチに1コミットでプッシュし、任意でPRを作成する。
    （削除は v1 では非対応 — 変更/追加のみ）"""
    token = _token()
    if not token:
        return _no_token_error()
    repo = (repo or "").strip()
    branch = (branch or "").strip() or "forge-os-edit"
    message = (message or "").strip() or "Update via THE FORGE OS / CODE mode"
    if not files:
        return {"error": "プッシュするファイルがありません"}
    try:
        # base ブランチの先頭コミット
        rr = _get(token, f"{API}/repos/{repo}/git/ref/heads/{base}")
        rr.raise_for_status()
        base_sha = rr.json()["object"]["sha"]
        cc = _get(token, f"{API}/repos/{repo}/git/commits/{base_sha}")
        cc.raise_for_status()
        base_tree = cc.json()["tree"]["sha"]

        headers = _headers(token)
        # 新ブランチ（既存なら先頭を親にして積む）
        parent = base_sha
        mk = requests.post(
            f"{API}/repos/{repo}/git/refs",
            headers=headers,
            json={"ref": f"refs/heads/{branch}", "sha": base_sha},
            timeout=30,
        )
        if mk.status_code == 422:  # already exists
            br = _get(token, f"{API}/repos/{repo}/git/ref/heads/{branch}")
            br.raise_for_status()
            parent = br.json()["object"]["sha"]
            pc = _get(token, f"{API}/repos/{repo}/git/commits/{parent}")
            pc.raise_for_status()
            base_tree = pc.json()["tree"]["sha"]
        elif mk.status_code >= 300:
            return {"error": f"ブランチ作成に失敗 ({mk.status_code}): {mk.text[:200]}"}

        # 1コミットのツリーを構築
        entries = [
            {"path": f["path"], "mode": "100644", "type": "blob", "content": f.get("content") or ""}
            for f in files[:MAX_FILES]
        ]
        tr = requests.post(
            f"{API}/repos/{repo}/git/trees",
            headers=headers,
            json={"base_tree": base_tree, "tree": entries},
            timeout=60,
        )
        tr.raise_for_status()
        cm = requests.post(
            f"{API}/repos/{repo}/git/commits",
            headers=headers,
            json={"message": message, "tree": tr.json()["sha"], "parents": [parent]},
            timeout=30,
        )
        cm.raise_for_status()
        new_sha = cm.json()["sha"]
        up = requests.patch(
            f"{API}/repos/{repo}/git/refs/heads/{branch}",
            headers=headers,
            json={"sha": new_sha},
            timeout=30,
        )
        up.raise_for_status()

        out = {"ok": True, "branch": branch, "commit": new_sha[:7]}
        if create_pr:
            pr = requests.post(
                f"{API}/repos/{repo}/pulls",
                headers=headers,
                json={
                    "title": (pr_title or message)[:120],
                    "head": branch,
                    "base": base,
                    "body": "🤖 THE FORGE OS / CODE モードからのプッシュ",
                },
                timeout=30,
            )
            if pr.status_code < 300:
                out["pr_url"] = pr.json().get("html_url", "")
            elif pr.status_code == 422:
                # 既にPRがある等 — プッシュ自体は成功しているので注記だけ
                out["note"] = "PRは既に存在するか作成できませんでした（プッシュは成功）"
        return out
    except Exception as e:
        return {"error": f"GitHub push error: {e}"}
