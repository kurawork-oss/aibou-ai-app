"""
engines.py — ブラウザを動かす「エンジン」を、役割で使い分ける。

なぜ分けるのか
--------------
ブラウザを動かす道具は2つあり、得意が違う。

    OpenCLI（あなたのChrome）
        ふだん使っているChromeを、そのまま動かす。ログインはもう済んで
        いるので、社内ツールでも会員サイトでも、開けばそのまま中にいる。
        → **AIが画面を見ながら判断して操作する**のに向く

    Playwright（専用ブラウザ）
        あなたのChromeとは別の、専用のブラウザを動かす。ログインは一度
        `--login` で通しておく。動いている最中にあなたがChromeを触っても
        邪魔し合わない。何百回まわしても日常のタブを占有しない。
        → **決まった手順を毎回同じに流す**のに向く／OpenCLIが無いときの代わり

相棒の本体（aibou_local.py の Runner）は、どちらのエンジンかを知らずに
`open → step → read` を呼ぶ。OpenCLIが入っていない・繋がっていないときは、
黙って止まらずに Playwright で続ける（そして**そう言う**）。

エンジンの手前で必ず通すもの
----------------------------
**許可リスト（`--site`）と確認は、エンジンより前にある。** エンジンは
それを知らない。これは大事な線で、特に OpenCLI の拡張機能は

    permissions: debugger, tabs, cookies, downloads
    host_permissions: <all_urls>

を持つ——拡張の層では**どのサイトにも届く**。つまり「このサイトだけ」は
OpenCLI の能力の境界ではなく、**こちらが守る方針**になる。だから Runner は
開く前にURLを見て、動いたあとにも「いまどこにいるか」を見て、許可の外に
出ていたらそこで止める。

OpenCLI に渡さない命令
----------------------
下の `_ALLOWED` にある物しか組み立てない。ソースを読んで、次の物は
**出さない**と決めた:

    eval      … 任意のJavaScriptを、あなたのログイン済みページで走らせる口
    upload    … 手元のファイルをページへ送れる（持ち出しの口）
    bind      … **いまあなたが見ているタブ**を乗っ取る。こちらが開いて
                いないので、許可リストの確認を素通りする
    network   … 通信の中身（認証の見出しを含む）を読める
    screenshot/init/verify/console/drag/dialog/tab …
                いまの用途に要らない。要らない口は開けない
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from typing import Callable, Dict, List, Optional

# 1回の読み取りで返す本文の上限（AIへ渡る物なので）
MAX_CHARS = 6000
# 押す・打つときに使ってよい筋（Runner と同じ顔ぶれ）
ACTIONS = ("goto", "click", "fill", "select", "press", "wait")


class EngineError(Exception):
    """そのエンジンでは動かせなかった。

    `fallback` が真なら「このエンジンが使えないだけ」なので、別のエンジンで
    試してよい（OpenCLIの拡張が繋がっていない等）。偽なら、ページ側の
    失敗なので、エンジンを替えても同じことになる。
    """

    def __init__(self, message: str, fallback: bool = False) -> None:
        super().__init__(message)
        self.fallback = fallback


class BrowserEngine:
    """ブラウザを動かす口。Runner はこれだけを知っている。"""

    name = ""
    label = ""

    def why_unavailable(self) -> str:
        """使えないなら理由。使えるなら空文字。"""
        return ""

    def open(self, url: str) -> None:
        raise NotImplementedError

    def current_url(self) -> str:
        raise NotImplementedError

    def step(self, kind: str, target: str, value: str) -> str:
        """1手ぶん。何をしたかを文で返す（できなければ理由を返す）。"""
        raise NotImplementedError

    def read(self) -> Dict[str, object]:
        """見えている物: {title, url, text, links}"""
        raise NotImplementedError

    def close(self) -> None:
        pass


# ── Playwright（専用ブラウザ） ───────────────────────────────────────

class PlaywrightEngine(BrowserEngine):
    """専用のブラウザ（プロフィールは `--browser-profile`）を動かす。

    **開いたまま使い回す。** 頼むたびに開き直すと数秒かかるうえ、閉じると
    セッションのCookieが消えて「ログインしたのに入れない」が起きる
    （実際に起きて、作りを変えた）。
    """

    name = "playwright"
    label = "専用ブラウザ（Playwright）"

    def __init__(self, profile, headless: bool, find_chrome: Callable[[], str],
                 allowed_host: Callable[[str], bool], timeout_ms: int = 20000) -> None:
        self.profile = profile
        self.headless = headless
        self.find_chrome = find_chrome
        self.allowed_host = allowed_host
        self.timeout_ms = timeout_ms
        self._pw = None
        self._ctx = None
        # 読み込む前に止めた移動先（最後の1つ）。止めたあと Chrome は自前の
        # エラー画面（chrome-error://chromewebdata/）を出すので、URLを見ても
        # 「どこへ行こうとしたか」は分からない。ここで覚えておく。
        self.blocked = ""

    def why_unavailable(self) -> str:
        try:
            import playwright.sync_api  # noqa: F401
        except ImportError:
            return ("playwright が要ります"
                    "（pip install playwright && playwright install chromium）")
        return ""

    def _guard_navigation(self, route, request) -> None:
        """許可の外への**画面の移動**を、読み込む前に止める。

        Playwright なら、ここで先回りできる（OpenCLI ではできないので、
        あちらは「動いたあとに気づいて止める」になる）。部品（画像・CDN）は
        止めない——止めるとページが壊れる。止めるのは、画面そのものが
        別のサイトへ移ろうとしたときだけ。
        """
        try:
            from urllib.parse import urlparse
            is_main = (request.is_navigation_request()
                       and request.frame == request.frame.page.main_frame)
            host = (urlparse(request.url).hostname or "").lower()
            if is_main and host and not self.allowed_host(host):
                self.blocked = host
                route.abort()
                return
        except Exception:
            pass
        route.continue_()

    def _page(self):
        if self._ctx is not None:
            try:
                return self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()
            except Exception:
                self.close()                 # 人が閉じた等。開き直す
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self._ctx = self._pw.chromium.launch_persistent_context(
            user_data_dir=str(self.profile),
            executable_path=self.find_chrome() or None,
            headless=self.headless,
            accept_downloads=False,
            locale="ja-JP",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        self._ctx.set_default_timeout(self.timeout_ms)
        self._ctx.route("**/*", self._guard_navigation)
        # 新しいタブは開かせない（許可の網の外へ出る）
        self._ctx.on("page", lambda q: q.close())
        return self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()

    def open(self, url: str) -> None:
        self._page().goto(url, wait_until="domcontentloaded", timeout=self.timeout_ms)

    def current_url(self) -> str:
        try:
            return self._page().url or ""
        except Exception:
            return ""

    def step(self, kind: str, target: str, value: str) -> str:
        page = self._page()
        try:
            if kind == "wait":
                page.wait_for_timeout(min(int(value or 1000), 5000))
                return "待ちました"
            if kind == "press":
                page.keyboard.press(target or "Enter")
                return f"{target or 'Enter'} を押しました"
            if kind == "goto":
                page.goto(value or target, wait_until="domcontentloaded",
                          timeout=self.timeout_ms)
                return f"{value or target} を開きました"
            if not target:
                return "どこを触るのか分かりません"
            if kind == "click":
                page.get_by_text(target, exact=False).first.click(timeout=5000)
                return f"「{target}」を押しました"
            if kind == "fill":
                page.get_by_label(target).first.fill(value, timeout=5000)
                return f"「{target}」に入力しました"
            if kind == "select":
                page.get_by_label(target).first.select_option(value, timeout=5000)
                return f"「{target}」で{value}を選びました"
        except Exception as e:
            return f"できませんでした（{type(e).__name__}）"
        return "何もしませんでした"

    def read(self) -> Dict[str, object]:
        page = self._page()
        try:
            page.wait_for_load_state("networkidle", timeout=3000)
        except Exception:
            pass
        try:
            body = page.locator("body").inner_text(timeout=5000)
        except Exception:
            body = ""
        text = "\n".join(l.strip() for l in (body or "").splitlines() if l.strip())
        links: List[dict] = []
        try:
            for el in page.locator("a[href], button, input[type=submit]").all()[:90]:
                try:
                    label = (el.inner_text(timeout=500) or "").strip()
                except Exception:
                    label = ""
                if label:
                    links.append({"label": label[:80]})
                if len(links) >= 30:
                    break
        except Exception:
            pass
        return {"title": (page.title() or "")[:200], "url": page.url,
                "text": text[:MAX_CHARS], "links": links}

    def close(self) -> None:
        for obj, stop in ((self._ctx, "close"), (self._pw, "stop")):
            try:
                if obj is not None:
                    getattr(obj, stop)()
            except Exception:
                pass
        self._ctx = None
        self._pw = None


# ── OpenCLI（あなたのChrome） ────────────────────────────────────────

# 組み立ててよい命令。**ここに無い物は、どう頼まれても出さない。**
_ALLOWED = {"open", "state", "click", "fill", "select", "keys", "wait", "close", "get"}
_ALLOWED_GET = {"url", "title", "text"}

# 子のプロセスへ渡してよい環境変数（これ以外は渡さない）。
# APIの鍵やトークンが入っていることがあるので、名前で絞る。
_ENV_KEEP = ("PATH", "HOME", "USER", "USERNAME", "LOGNAME", "LANG", "LC_ALL",
             "LC_CTYPE", "TMP", "TEMP", "TMPDIR", "SYSTEMROOT", "SystemRoot",
             "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
             "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME",
             "XDG_DATA_HOME", "XDG_CACHE_HOME", "NODE_EXTRA_CA_CERTS")
# OpenCLI 自身の設定（`OPENCLI_*`）は渡す。ただし鍵らしい名前は渡さない。
_SECRETISH = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)", re.I)

# OpenCLI の終了コード（src/errors.ts）
_EXIT_SERVICE_UNAVAIL = 69    # 拡張・デーモン・ブラウザに繋がらない
_EXIT_CONFIG = 78
_EXIT_NOPERM = 77


def safe_env(base: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """子に渡す環境変数。鍵を持ち出させない。"""
    src = dict(os.environ if base is None else base)
    out = {k: v for k, v in src.items() if k in _ENV_KEEP}
    for k, v in src.items():
        if k.startswith("OPENCLI_") and not _SECRETISH.search(k):
            out[k] = v
    return out


class OpenCLIEngine(BrowserEngine):
    """ふだんのChromeを、OpenCLI（`opencli browser`）越しに動かす。

    ここで決めていること:
      ・セッション名は固定（`aibou`）。同じタブを使い回すので、ログインも
        そのまま続く。あなたの他のタブには触らない
      ・画面は前に出す（OpenCLIの既定）。見えていることが安全装置
      ・命令は `_ALLOWED` にある物だけ。引数は配列で渡し、シェルを通さない
      ・鍵らしい環境変数は子に渡さない
    """

    name = "opencli"
    label = "あなたのChrome（OpenCLI）"
    SESSION = "aibou"

    def __init__(self, binary: str = "", timeout_s: int = 30,
                 runner: Optional[Callable] = None) -> None:
        self._explicit = binary
        self.timeout_s = timeout_s
        # テストで差し替えられるよう、実際に動かす所を1か所にしておく
        self._runner = runner or subprocess.run

    def binary(self) -> str:
        if self._explicit:
            return self._explicit if os.path.exists(self._explicit) else ""
        found = shutil.which("opencli")
        if not found and sys.platform == "win32":
            found = shutil.which("opencli.cmd") or ""
        return found or ""

    def why_unavailable(self) -> str:
        if not self.binary():
            return "OpenCLI が入っていません（npm install -g @jackwener/opencli）"
        return ""

    # ── 動かす所（ここ以外から opencli を呼ばない） ──────────────────

    def _run(self, args: List[str], timeout: Optional[int] = None):
        """opencli を1回呼ぶ。(終了コード, 出力) を返す。

        **許可した命令以外は、組み立てる前に断る。** 呼ぶ側の書き間違いや、
        どこかから紛れ込んだ命令名が、そのまま OpenCLI に届かないように。
        """
        if not args or args[0] not in _ALLOWED:
            raise PermissionError(f"OpenCLI の「{args[0] if args else '空'}」は使いません")
        if args[0] == "get" and (len(args) < 2 or args[1] not in _ALLOWED_GET):
            raise PermissionError("OpenCLI の get は url / title / text だけ使います")
        exe = self.binary()
        if not exe:
            raise EngineError(self.why_unavailable(), fallback=True)
        argv = [exe, "browser", self.SESSION, *args]
        try:
            done = self._runner(argv, capture_output=True, text=True,
                                timeout=timeout or self.timeout_s,
                                env=safe_env(), shell=False)
        except FileNotFoundError:
            raise EngineError(self.why_unavailable() or "OpenCLI を起動できません",
                              fallback=True)
        except subprocess.TimeoutExpired:
            raise EngineError("OpenCLI から返事がありませんでした（時間切れ）")
        code = int(getattr(done, "returncode", 1) or 0)
        out = (getattr(done, "stdout", "") or "").strip()
        if code == _EXIT_SERVICE_UNAVAIL:
            # 拡張・デーモン・Chrome のどれかに繋がらない。エンジンを替えれば動く
            raise EngineError("OpenCLI がChromeに繋がっていません"
                              "（拡張機能が入っているか、Chromeが開いているか）",
                              fallback=True)
        if code in (_EXIT_CONFIG,):
            raise EngineError("OpenCLI の設定が足りません（opencli doctor で確認できます）",
                              fallback=True)
        return code, out

    @staticmethod
    def _json(out: str):
        try:
            return json.loads(out) if out.startswith(("{", "[")) else None
        except Exception:
            return None

    def _error_text(self, out: str, what: str) -> str:
        data = self._json(out)
        err = (data or {}).get("error") if isinstance(data, dict) else None
        if isinstance(err, dict) and err.get("message"):
            hint = f"（{err['hint']}）" if err.get("hint") else ""
            return f"{what}できませんでした: {err['message']}{hint}"
        return f"{what}できませんでした"

    # ── エンジンの口 ────────────────────────────────────────────────

    def open(self, url: str) -> None:
        code, out = self._run(["open", url], timeout=max(self.timeout_s, 30))
        if code != 0:
            raise EngineError(self._error_text(out, "開くことが"))

    def current_url(self) -> str:
        try:
            code, out = self._run(["get", "url"], timeout=10)
        except EngineError:
            return ""
        return out.splitlines()[-1].strip() if code == 0 and out else ""

    def step(self, kind: str, target: str, value: str) -> str:
        if kind not in ACTIONS:
            return f"（{kind or '空'}）は使えません"
        try:
            if kind == "wait":
                secs = min(max(int(value or 1000), 0), 5000) / 1000
                self._run(["wait", "time", f"{secs:g}"])
                return "待ちました"
            if kind == "press":
                code, _ = self._run(["keys", target or "Enter"])
                return f"{target or 'Enter'} を押しました" if code == 0 else "押せませんでした"
            if kind == "goto":
                self.open(value or target)
                return f"{value or target} を開きました"
            if not target:
                return "どこを触るのか分かりません"
            if kind == "click":
                # 名前（aria-label・ラベル・見えている文字）で探す。AIが CSS を
                # 書くより、人が読む言葉のほうが当たる
                code, out = self._run(["click", "--name", target])
                return f"「{target}」を押しました" if code == 0 else \
                    self._error_text(out, f"「{target}」を押すことが")
            if kind == "fill":
                code, out = self._run(["fill", "--label", target, value])
                data = self._json(out) or {}
                if code == 0 and data.get("verified", True):
                    return f"「{target}」に入力しました"
                return self._error_text(out, f"「{target}」に入力することが")
            if kind == "select":
                code, out = self._run(["select", "--label", target, value])
                return f"「{target}」で{value}を選びました" if code == 0 else \
                    self._error_text(out, f"「{target}」を選ぶことが")
        except EngineError as e:
            return f"できませんでした（{e}）"
        return "何もしませんでした"

    def read(self) -> Dict[str, object]:
        _c, title = self._run(["get", "title"], timeout=10)
        url = self.current_url()
        code, out = self._run(["get", "text", "body"], timeout=20)
        data = self._json(out) or {}
        body = str(data.get("value") or "") if code == 0 else ""
        text = "\n".join(l.strip() for l in body.splitlines() if l.strip())
        links: List[dict] = []
        try:
            _c2, snap = self._run(["state"], timeout=20)
            links = parse_state_links(snap)
        except EngineError:
            links = []
        return {"title": (title.splitlines()[-1] if title else "")[:200],
                "url": url, "text": text[:MAX_CHARS], "links": links}

    def close(self) -> None:
        try:
            self._run(["close"], timeout=10)
        except Exception:
            pass


_STATE_LINE = re.compile(r"\[(\d+)\]<(\w+)[^>]*>([^<]*)")


def parse_state_links(snapshot: str, limit: int = 30) -> List[dict]:
    """`opencli browser state` の出力から、押せる物の名前を拾う。

    行の形（src/browser/dom-snapshot.ts）: `  [12]<button ...>送信</button>`
    読めない行は飛ばす（形が変わっても、落ちずに空になるだけ）。
    """
    out: List[dict] = []
    for line in (snapshot or "").splitlines():
        m = _STATE_LINE.search(line)
        if not m:
            continue
        label = m.group(3).strip()
        if label:
            out.append({"label": label[:80], "ref": int(m.group(1))})
        if len(out) >= limit:
            break
    return out
