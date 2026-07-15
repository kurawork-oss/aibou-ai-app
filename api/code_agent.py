# code_agent.py — CODE モード（Claude Code / Codex 級のAIコーディングエージェント）。
#
# 品質と API 容量の両立のため、全文JSONではなく **SEARCH/REPLACE 差分編集** を使う:
#   - 変更箇所だけを出力 → トークン激減（＝APIの無料枠を長持ちさせる）
#   - 大きな JSON 文字列に巨大コードを詰めない → 途切れ・エスケープ崩れを回避
#   - 変更前後が明示され、精度が高い（外科的な編集）
#
# フロー: プロンプト（プロジェクト全体像＋関連ファイル＋指示）→ モデルが
#   「短い計画」＋SEARCH/REPLACE群を出力 → 適用 → 失敗ブロックは自動リペア1回。
# コーディング特化モデル（HF: Qwen2.5-Coder 等）を優先使用。
import json
import re

import config  # noqa: F401  (後方互換・他所からの参照用)
import llm

# ── 入出力の上限 ──────────────────────────────────────────────────
MAX_INPUT_FILES = 40          # 受け取るワークスペースのファイル数
MAX_FILE_CHARS = 16_000       # プロンプトに載せる1ファイルの最大文字数
MAX_TOTAL_CHARS = 80_000      # プロンプトに載せる本文合計の最大文字数
MAX_OUTPUT_FILES = 30         # 応答で変更できるファイル数
MAX_OUTPUT_CHARS = 200_000    # 応答1ファイルの最大文字数
MAX_HISTORY = 6               # 会話履歴の最大ターン数
CODE_MAX_TOKENS = 6000        # 生成トークン上限（差分なので長すぎなくてよい）

_SYSTEM = """あなたは世界最高峰のソフトウェアエンジニア兼コーディングエージェントです（Claude Code / Codex 相当）。
ユーザーの指示に従い、与えられたワークスペースを的確に編集します。

# 進め方
1. まず1〜4文で「何をなぜ行うか」の短い計画を日本語で述べる。
2. 次に、変更を **SEARCH/REPLACE ブロック** で出力する。
3. 完全で、そのまま動く高品質なコードにする。エラー処理・命名・既存コードの様式に合わせる。

# SEARCH/REPLACE ブロックの厳密な書式
各ブロックは「対象ファイルの相対パスだけの行」の直後に、次を厳密に置く:

path/to/file.ext
<<<<<<< SEARCH
（ファイル内に現存する、変更したい既存コードを“そのまま完全に”コピー）
=======
（置き換え後のコード）
>>>>>>> REPLACE

規則:
- SEARCH には、対象ファイルに **今実際に存在するテキスト** を一字一句正確に（インデント含め）書く。想像で書かない。
- 変更は小さく。1ブロック=1つの意味のある変更。関数全体を貼らず、必要な範囲だけ。
- **新規ファイル**は SEARCH を空にして、REPLACE にファイル全文を書く:
  path/to/new.ext
  <<<<<<< SEARCH
  =======
  （新規ファイルの全文）
  >>>>>>> REPLACE
- **ファイル削除**は、その行だけを書く: DELETE: path/to/file.ext
- パスは英数字と . _ / - のみの相対パス。
- 変更が無ければブロックを出さず、計画だけ書く。
- SEARCH/REPLACE 以外の説明文（計画）は最初にまとめ、ブロックの間に散らさない。
"""

# ── パス安全化 ────────────────────────────────────────────────────
def _safe_path(path: str):
    p = (path or "").strip().strip("`").strip()
    if p.startswith("./"):
        p = p[2:]
    if not p or len(p) > 120:
        return None
    if p.startswith("/") or "\\" in p or ".." in p:
        return None
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", p):
        return None
    if p.count("/") > 6:
        return None
    return p


def _looks_like_path(line: str):
    """行全体が「ファイルパスだけ」ならそのパスを返す（説明文と区別）。"""
    st = (line or "").strip().strip("`").strip()
    if not st or " " in st or "\t" in st:
        return None
    if "." not in st and "/" not in st:
        return None
    return _safe_path(st)


# ── SEARCH/REPLACE パーサ ─────────────────────────────────────────
_SEARCH_RE = re.compile(r"^<{3,}\s*SEARCH\s*$")
_DIVIDER_RE = re.compile(r"^={3,}\s*$")
_REPLACE_RE = re.compile(r"^>{3,}\s*REPLACE\s*$")
_DELETE_RE = re.compile(r"^DELETE:\s*(.+)$")


def parse_edits(text: str):
    """モデル出力から (計画テキスト, edits) を取り出す。
    edits: {"op":"replace","path","search","replace"} / {"op":"delete","path"}"""
    lines = (text or "").split("\n")
    plan_lines = []
    edits = []
    last_path = None
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        # DELETE 指示
        md = _DELETE_RE.match(line.strip())
        if md:
            sp = _safe_path(md.group(1))
            if sp:
                edits.append({"op": "delete", "path": sp})
            i += 1
            continue
        # SEARCH ブロック開始
        if _SEARCH_RE.match(line.strip()):
            path = last_path
            i += 1
            search = []
            while i < n and not _DIVIDER_RE.match(lines[i].strip()):
                search.append(lines[i])
                i += 1
            i += 1  # skip =======
            replace = []
            while i < n and not _REPLACE_RE.match(lines[i].strip()):
                replace.append(lines[i])
                i += 1
            i += 1  # skip >>>>>>> REPLACE
            edits.append({
                "op": "replace",
                "path": path,
                "search": "\n".join(search),
                "replace": "\n".join(replace),
            })
            continue
        # パス候補 or 計画テキスト
        cand = _looks_like_path(line)
        if cand:
            last_path = cand
        elif line.strip():
            plan_lines.append(line)
        i += 1
    return "\n".join(plan_lines).strip(), edits


# ── 差分の適用 ────────────────────────────────────────────────────
def _norm(s: str) -> str:
    return "\n".join(ln.rstrip() for ln in (s or "").replace("\r\n", "\n").split("\n"))


def _replace_once(content: str, search: str, replace: str):
    """search を content 内で1回だけ replace に置換。返り値 (新content, 成功bool)。
    完全一致 → 末尾空白正規化一致 → の順で寛容にマッチさせる。"""
    if search in content:
        return content.replace(search, replace, 1), True
    nc, ns, nr = _norm(content), _norm(search), _norm(replace)
    if ns and ns in nc:
        return nc.replace(ns, nr, 1), True
    return content, False


def apply_edits(file_map: dict, edits: list):
    """file_map（path→content）に edits を適用。file_map を変更し results を返す。"""
    results = []
    for e in edits:
        path = _safe_path(e.get("path") or "")
        if not path:
            results.append({"path": e.get("path"), "status": "failed", "reason": "unsafe/missing path"})
            continue
        if e.get("op") == "delete":
            if path in file_map:
                del file_map[path]
                results.append({"path": path, "status": "applied", "action": "delete"})
            else:
                results.append({"path": path, "status": "failed", "reason": "file not found"})
            continue
        search = e.get("search") or ""
        replace = e.get("replace") or ""
        if search.strip() == "":
            existed = path in file_map
            file_map[path] = replace
            results.append({"path": path, "status": "applied", "action": "rewrite" if existed else "create"})
            continue
        cur = file_map.get(path)
        if cur is None:
            results.append({"path": path, "status": "failed", "reason": "file not found for edit", "search": search[:160]})
            continue
        new, ok = _replace_once(cur, search, replace)
        if ok:
            file_map[path] = new
            results.append({"path": path, "status": "applied", "action": "edit"})
        else:
            results.append({"path": path, "status": "failed", "reason": "SEARCH text not found", "search": search[:160]})
    return file_map, results


# ── プロンプト構築 ────────────────────────────────────────────────
def _manifest(files: list) -> str:
    rows = []
    for f in files[:MAX_INPUT_FILES]:
        p = f.get("path")
        if not p:
            continue
        lines = str(f.get("content") or "").count("\n") + 1
        rows.append(f"- {p} ({lines} 行)")
    return "\n".join(rows) if rows else "（空）"


def _relevance(path: str, instruction: str) -> int:
    """指示文に出てくるファイルほど優先（本文を確実に載せる）。"""
    base = path.rsplit("/", 1)[-1].lower()
    score = 0
    ins = (instruction or "").lower()
    if path.lower() in ins or base in ins:
        score += 100
    if base in ("index.html", "main.py", "app.py", "app.js", "app.tsx", "readme.md"):
        score += 5
    return score


def _build_prompt(instruction: str, files: list, history) -> str:
    parts = [_SYSTEM, ""]
    for h in (history or [])[-MAX_HISTORY:]:
        role = "ユーザー" if (h.get("role") == "user") else "エージェント"
        content = str(h.get("content") or "")[:1500]
        if content:
            parts.append(f"【これまでの{role}】{content}")

    fs = [f for f in (files or [])[:MAX_INPUT_FILES] if f.get("path")]
    parts.append("【プロジェクト構成】\n" + _manifest(fs))

    # 関連度が高い→小さい順に、合計上限まで本文を載せる
    ordered = sorted(fs, key=lambda f: (-_relevance(f["path"], instruction), len(str(f.get("content") or ""))))
    listed, total, omitted = [], 0, []
    for f in ordered:
        content = str(f.get("content") or "")[:MAX_FILE_CHARS]
        if total + len(content) > MAX_TOTAL_CHARS:
            omitted.append(f["path"])
            continue
        total += len(content)
        listed.append(f"===== FILE: {f['path']} =====\n{content}")
    parts.append("【現在のファイル内容】\n" + ("\n\n".join(listed) if listed else "（空）"))
    if omitted:
        parts.append("（容量上限のため本文省略: " + ", ".join(omitted[:12]) + "）")

    parts.append(f"【指示】\n{(instruction or '').strip()}")
    parts.append("上の書式に厳密に従い、まず短い計画、続けて SEARCH/REPLACE ブロックを出力してください。")
    return "\n\n".join(parts)


def _repair_prompt(instruction: str, file_map: dict, failed: list) -> str:
    """SEARCHが一致しなかったブロックを、現在の実ファイルを見せて直させる。"""
    blocks = []
    for r in failed:
        p = r.get("path")
        cur = file_map.get(p, "")
        blocks.append(f"===== 対象: {p}（現在の実内容）=====\n{cur[:MAX_FILE_CHARS]}")
    return (
        _SYSTEM
        + "\n\n直前の編集で、いくつかの SEARCH ブロックが「ファイル内に見つからず」適用できませんでした。"
        "下に各対象ファイルの**現在の実内容**を示します。これを見て、実在するテキストに合わせた "
        "SEARCH/REPLACE ブロックを**再出力**してください（成功した変更は繰り返さない）。\n\n"
        + "\n\n".join(blocks)
        + f"\n\n【元の指示】\n{instruction}"
    )


# ── 生成本体 ──────────────────────────────────────────────────────
def _diff_files(before: dict, after: dict) -> list:
    """before/after を比較し、変更/新規/削除のファイル一覧を返す（フロント表示用）。"""
    out = []
    for path, content in after.items():
        if path not in before:
            out.append({"path": path, "content": content[:MAX_OUTPUT_CHARS], "action": "create"})
        elif content != before[path]:
            out.append({"path": path, "content": content[:MAX_OUTPUT_CHARS], "action": "update"})
    for path in before:
        if path not in after:
            out.append({"path": path, "content": "", "action": "delete"})
    return out[:MAX_OUTPUT_FILES]


def generate(instruction: str, files: list, history: list = None) -> dict:
    """AIコーディングエージェント本体（差分編集＋自動リペア）。
    成功: {"explanation", "files":[{path,content,action}], "edits":[...]}
    失敗: {"error"}"""
    if not (instruction or "").strip():
        return {"error": "instruction is required"}
    if llm.active_provider() == "none":
        return {"error": "AI未設定です。Settings → KEYCHAIN で GEMINI_API_KEY か HUGGINGFACE_TOKEN を設定してください。"}

    before = {f["path"]: str(f.get("content") or "") for f in (files or []) if f.get("path")}

    try:
        text = llm.generate_text(
            _build_prompt(instruction, files or [], history),
            hf_model_override=llm.code_model(),
            max_tokens=CODE_MAX_TOKENS,
        )
    except Exception as e:
        return {"error": f"generation failed: {e}"}

    plan, edits = parse_edits(text)

    # 後方互換: 旧JSON形式で返ってきた場合も受ける
    if not edits:
        obj = _extract_json(text)
        if obj and isinstance(obj.get("files"), list):
            return _from_json(obj, before)

    file_map = dict(before)
    _, results = apply_edits(file_map, edits)

    # 自動リペア（SEARCH不一致を1回だけ直す）
    failed = [r for r in results if r["status"] == "failed" and r.get("reason", "").startswith("SEARCH")]
    if failed:
        try:
            text2 = llm.generate_text(
                _repair_prompt(instruction, file_map, failed),
                hf_model_override=llm.code_model(),
                max_tokens=CODE_MAX_TOKENS,
            )
            _, edits2 = parse_edits(text2)
            if edits2:
                _, results2 = apply_edits(file_map, edits2)
                results += results2
        except Exception:
            pass

    out_files = _diff_files(before, file_map)
    applied = [r for r in results if r["status"] == "applied"]
    still_failed = [r for r in results if r["status"] == "failed"]

    summary = f"\n\n📝 適用 {len(applied)}件"
    if still_failed:
        paths = ", ".join(sorted({r["path"] for r in still_failed if r.get("path")}))
        summary += f" / 未適用 {len(still_failed)}件（{paths[:120]} — 該当箇所が見つからず。もう一度具体的に指示すると直せます）"
    explanation = (plan + summary).strip() if plan else ("変更を適用しました。" + summary).strip()
    return {"explanation": explanation, "files": out_files, "edits": results}


# ── 旧JSON形式フォールバック ──────────────────────────────────────
def _extract_json(text: str):
    if not text:
        return None
    s = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", s, re.DOTALL)
    if m:
        s = m.group(1).strip()
    start = s.find("{")
    if start < 0:
        return None
    depth, in_str, esc, end = 0, False, False, -1
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end < 0:
        return None
    frag = s[start:end]
    for cand in (frag, re.sub(r",\s*([}\]])", r"\1", frag)):
        try:
            obj = json.loads(cand)
            return obj if isinstance(obj, dict) else None
        except Exception:
            continue
    return None


def _from_json(obj: dict, before: dict) -> dict:
    file_map = dict(before)
    skipped = []
    for f in (obj.get("files") or [])[:MAX_OUTPUT_FILES]:
        if not isinstance(f, dict):
            continue
        path = _safe_path(str(f.get("path") or ""))
        if not path:
            skipped.append(str(f.get("path") or "?"))
            continue
        action = str(f.get("action") or "update").lower()
        if action == "delete":
            file_map.pop(path, None)
        else:
            file_map[path] = str(f.get("content") or "")[:MAX_OUTPUT_CHARS]
    expl = str(obj.get("explanation") or "").strip() or "変更を適用しました。"
    if skipped:
        expl += f"\n（不正なパスをスキップ: {', '.join(skipped[:5])}）"
    return {"explanation": expl, "files": _diff_files(before, file_map), "edits": []}


# ── スターター（Gemini 不要・即時） ─────────────────────────────────
_WEB_STARTER = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My App</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0a0e14; color:#e8eef5; font-family:system-ui,sans-serif; }
  .card { text-align:center; padding:2.5rem 3rem; border:1px solid #223;
          border-radius:16px; background:#101722; box-shadow:0 0 40px #0af2; }
  h1 { margin:0 0 .5rem; font-size:1.6rem; }
  p  { margin:0; color:#9ab; }
  button { margin-top:1.2rem; padding:.6rem 1.4rem; border-radius:10px;
           border:1px solid #345; background:#16202e; color:#cde; cursor:pointer; }
  button:hover { border-color:#0af; }
</style>
</head>
<body>
  <div class="card">
    <h1>⚡ My App</h1>
    <p>ここから作り始めましょう。</p>
    <button onclick="this.textContent='clicked! ' + (++window.n||(window.n=1))">Click</button>
  </div>
</body>
</html>
"""

_PY_STARTER = '''"""main.py — スターター。"""


def main() -> None:
    print("Hello from THE FORGE OS / CODE mode!")


if __name__ == "__main__":
    main()
'''


def scaffold(kind: str) -> dict:
    """スターターワークスペースを返す。kind: web | python | empty"""
    k = (kind or "empty").lower()
    if k == "web":
        return {"files": [{"path": "index.html", "content": _WEB_STARTER, "action": "create"}]}
    if k == "python":
        return {"files": [
            {"path": "main.py", "content": _PY_STARTER, "action": "create"},
            {"path": "README.md", "content": "# My Project\n\nCODEモードで生成したプロジェクト。\n", "action": "create"},
        ]}
    return {"files": []}
