#!/usr/bin/env python3
"""
aibou_local.py — 手元のパソコンで動く相棒（仕様§29〜§31）。

これは何か
----------
AIbou（ブラウザの中）からは、パソコンの中のファイルを読めない。読めないのが
正しい——読めたら、どのウェブサイトからでも読めることになる。
だから「Obsidianの日誌に足しておいて」「あのフォルダのPDFを読んで」は、
Webだけでは**どうやっても届かない**。

この小さなプログラムが、その橋になる。

    このプログラム ──(外向きに)──▶ AIbouのサーバー「仕事ある？」
                    ◀───────────  「これを読んで」
                    ──────────▶  「読んだ。中身はこれ」

外向きの通信しかしない。ルーターの設定も、ポート開放も要らない。

動かし方
--------
    python aibou_local.py --url https://あなたのAPI --token 合言葉 --dir ~/AIbou

合言葉は AIbou の「設定 → つなぐ →「手元のパソコン」」で作る。
1度しか表示されないので、そこで控える。

**台ごとに1つ。** ノートPCとデスクトップを両方繋いだままにできる
（それぞれで合言葉を作って、それぞれで動かす）。2台以上動いているときは、
AIbou 側が「どちらに頼むか」を名前で聞いてくる。

安全のための決まり（ここが本体）
--------------------------------
1. **触ってよいのは `--dir` で渡したフォルダの中だけ。**
   `..` でその外へ出ようとする道は、実際のパスに直してから弾く。
2. **消さない。** 上書きするときは、元の内容を `.bak` に残す。
   消す仕事は最初から用意していない。
3. **勝手に開かない・撮らない。** アプリを起動する（open）と画面を撮る
   （shot）は、明示的に `--allow-open` / `--allow-screen` を付けたときだけ。
4. **何をしたか全部書き出す。** 画面にも、`--log` を付ければファイルにも。
5. **大きいファイルは読まない。** 1ファイル1MBまで（AIへ渡る物なので）。

サーバーが乗っ取られても、ここから先はこの決まりに縛られる。サーバーは
「読んで」と頼めるだけで、**どこを読めるかは決められない**。

要るもの
--------
Python 3.8 以上と、`requests`。画面を撮るなら `pillow` も。

    pip install requests
    pip install pillow       # --allow-screen を使うときだけ
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import io
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

try:
    import requests
except ImportError:                                        # pragma: no cover
    print("requests が要ります:  pip install requests", file=sys.stderr)
    raise SystemExit(1)

# 1ファイルで読む上限。AIへ渡る物なので、大きい物は渡さない。
MAX_READ = 1_000_000
# 一覧に出す数。
MAX_LIST = 200
# ブラウザ操作の上限。
BROWSE_TIMEOUT_MS = 20000
BROWSE_MAX_CHARS = 6000
MAX_STEPS = 8
# 押す・打つときに使ってよい筋。ここに無い物は動かさない。
# `evaluate`（中のJavaScriptを走らせる）は**入れない**——開けると
# 「AIが書いた任意のコードを、あなたのログイン済みブラウザで走らせる口」
# になる。押す・打つだけなら、できることはページに元からある物に限られる。
BROWSE_ACTIONS = ("goto", "click", "fill", "select", "press", "wait")
# サーバーが落ちているときに、どれだけ待ってから掛け直すか。
BACKOFF = (2, 4, 8, 16, 30)


def find_chrome() -> str:
    """使うブラウザの実体。見つからなければ空文字（playwright に任せる）。

    playwright は自分が入れた版の番号でしか探さない。すでに手元に
    Chromium がある人（開発機など）で「入っていません」と言い出すので、
    **番号を見ずに**探す。`AIBOU_CHROME` で名指しもできる。
    """
    named = (os.environ.get("AIBOU_CHROME", "") or "").strip()
    if named:
        return named if os.path.exists(named) else ""
    import glob
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "") or \
        os.path.expanduser("~/.cache/ms-playwright")
    for pattern in ("chromium-*/chrome-linux*/chrome",
                    "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
                    "chromium-*/chrome-win*/chrome.exe"):
        hits = sorted(glob.glob(os.path.join(root, pattern)))
        if hits:
            return hits[-1]
    return ""


class Guard:
    """触ってよい場所を決める。ここが破られたら、ほかは全部意味が無い。"""

    def __init__(self, roots, vault: str = "", daily: str = "",
                 sites=None) -> None:
        self.roots = [Path(r).expanduser().resolve() for r in roots]
        self.vault = Path(vault).expanduser().resolve() if vault else None
        self.daily = daily or "日誌"
        self.sites = [str(h).strip().lower().lstrip(".")
                      for h in (sites or []) if str(h).strip()]

    def site(self, url: str) -> str:
        """このURLを、あなたのブラウザで開いてよいか。

        **許したサイトだけ。** ここに「全部」という書き方は用意していない。

        理由は、開くのが**あなたがログイン済みのブラウザ**だから。
        サーバー側のブラウザ（誰にもログインしていない）とは危なさの桁が
        違う。会話に紛れ込んだ一文が `https://どこか/` を開かせると、その
        瞬間から先はあなたとして操作されることになる。

        だから「どこを開かれても構わないか」ではなく、「**この3つなら
        開かれても構う**」を先に決めてもらう。
        """
        if not self.sites:
            raise PermissionError(
                "ブラウザで開いてよいサイトを --site で1つも渡していません")
        u = (url or "").strip()
        if not u:
            raise PermissionError("URLが空です")
        try:
            from urllib.parse import urlparse
            p = urlparse(u)
        except Exception:
            raise PermissionError("URLの形が正しくありません")
        if p.scheme.lower() not in ("http", "https"):
            raise PermissionError(f"http(s) 以外は開けません（{p.scheme or '指定なし'}:）")
        host = (p.hostname or "").lower()
        if not host:
            raise PermissionError("URLにホスト名がありません")
        for allowed in self.sites:
            # `example.com` は `www.example.com` も含む。
            # ただし `notexample.com` は含まない（点を見る）。
            if host == allowed or host.endswith("." + allowed):
                return u
        raise PermissionError(f"許したサイトの外です: {host}")

    def resolve(self, rel: str) -> Path:
        """相対の指定を、実際の道に直す。外に出ていたら断る。

        `resolve()` を**先に**通すのが肝心。`メモ/../../.ssh/id_rsa` は
        文字列のままだと「メモの中」に見える。シンボリックリンクも
        同じ手で外へ出られるので、実際の道に直してから比べる。
        """
        rel = (rel or "").strip().replace("\\", "/").lstrip("/")
        if not rel:
            raise PermissionError("どこを触るのか指定がありません")
        for root in self.roots:
            cand = (root / rel).resolve()
            try:
                cand.relative_to(root)
            except ValueError:
                continue                       # このrootの外へ出た
            return cand
        raise PermissionError(f"許したフォルダの外です: {rel}")

    def today_note(self) -> Path:
        """今日の日誌（Obsidian）。vault を渡していなければ断る。"""
        if not self.vault:
            raise PermissionError("Obsidianのvaultを --vault で渡していません")
        name = dt.date.today().strftime("%Y-%m-%d") + ".md"
        path = (self.vault / self.daily / name).resolve()
        try:
            path.relative_to(self.vault)
        except ValueError:
            raise PermissionError("日誌の場所がvaultの外を指しています")
        return path


class Runner:
    def __init__(self, guard: Guard, allow_open: bool, allow_screen: bool,
                 log, allow_browser: bool = False, profile: str = "",
                 headless: Optional[bool] = None) -> None:
        self.g = guard
        self.allow_open = allow_open
        self.allow_screen = allow_screen
        self.allow_browser = allow_browser
        self.profile = Path(profile or "~/.aibou-browser").expanduser()
        """画面を出すか。

        既定は**出す**。自分のパソコンで、自分のログイン済みブラウザが
        動くので、**何をしているかが見えること自体が安全装置**になる。
        画面の無い所（サーバー・CI）では出せないので、そこだけ伏せる。"""
        self._ctx = None
        self._pw = None
        self.headless = (not os.environ.get("DISPLAY")
                         and sys.platform not in ("darwin", "win32")) \
            if headless is None else bool(headless)
        self.log = log

    # ── 仕事ひとつぶん ──────────────────────────────────────────────

    def do(self, job: dict) -> dict:
        kind = str(job.get("kind") or "")
        params = job.get("params") or {}
        self.log(f"▶ {kind} {params.get('path') or params.get('vault') or ''}")
        try:
            fn = getattr(self, f"_{kind}", None)
            if fn is None:
                return {"ok": False, "error": f"「{kind}」は知りません"}
            out = fn(params)
            self.log(f"  ✓ {out.get('message') or 'ok'}")
            return out
        except PermissionError as e:
            self.log(f"  ✗ 断りました: {e}")
            return {"ok": False, "error": str(e)}
        except FileNotFoundError:
            self.log("  ✗ ありません")
            return {"ok": False, "error": "そのファイルはありません"}
        except Exception as e:                              # pragma: no cover
            self.log(f"  ✗ {type(e).__name__}: {e}")
            return {"ok": False, "error": f"できませんでした（{type(e).__name__}）"}

    def _list(self, p: dict) -> dict:
        rel = (p.get("path") or "").strip()
        if rel:
            base = self.g.resolve(rel)
        else:
            base = self.g.roots[0]
        if not base.is_dir():
            return {"ok": False, "error": "フォルダではありません"}
        items = []
        for child in sorted(base.iterdir())[:MAX_LIST]:
            if child.name.startswith("."):
                continue                        # 隠しファイルは出さない
            items.append({"name": child.name, "dir": child.is_dir(),
                          "size": child.stat().st_size if child.is_file() else 0})
        return {"ok": True, "items": items, "message": f"{len(items)}件"}

    def _read(self, p: dict) -> dict:
        path = self.g.resolve(p.get("path") or "")
        if not path.is_file():
            return {"ok": False, "error": "ファイルではありません"}
        size = path.stat().st_size
        if size > MAX_READ:
            return {"ok": False,
                    "error": f"大きすぎます（{size:,}バイト / 上限 {MAX_READ:,}）"}
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            try:
                text = path.read_text(encoding="cp932")
            except Exception:
                return {"ok": False, "error": "文字として読めませんでした"}
        return {"ok": True, "text": text, "message": f"{len(text):,}字"}

    def _write(self, p: dict) -> dict:
        path = self.g.resolve(p.get("path") or "")
        path.parent.mkdir(parents=True, exist_ok=True)
        # 上書きする前に、元の内容を残す。**消さない**のが決まり。
        if path.exists():
            backup = path.with_suffix(path.suffix + ".bak")
            backup.write_bytes(path.read_bytes())
        path.write_text(str(p.get("text") or ""), encoding="utf-8")
        return {"ok": True, "message": f"{path.name} に書きました"}

    def _append(self, p: dict) -> dict:
        # vault="daily" のときは、Obsidianの今日の日誌（§26）
        if (p.get("vault") or "") == "daily":
            path = self.g.today_note()
        else:
            path = self.g.resolve(p.get("path") or "")
        path.parent.mkdir(parents=True, exist_ok=True)
        body = str(p.get("text") or "")
        stamp = dt.datetime.now().strftime("%H:%M")
        with path.open("a", encoding="utf-8") as f:
            if path.stat().st_size:
                f.write("\n")
            f.write(f"- {stamp} {body}\n")
        return {"ok": True, "message": f"{path.name} に書き足しました"}

    def _open(self, p: dict) -> dict:
        if not self.allow_open:
            return {"ok": False,
                    "error": "開く操作は切ってあります（--allow-open で入ります）"}
        path = self.g.resolve(p.get("path") or "")
        if not path.exists():
            return {"ok": False, "error": "そのファイルはありません"}
        if sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False)
        elif os.name == "nt":
            os.startfile(str(path))                        # type: ignore[attr-defined]
        else:
            subprocess.run(["xdg-open", str(path)], check=False)
        return {"ok": True, "message": f"{path.name} を開きました"}

    # ── あなたのブラウザを動かす ────────────────────────────────────

    def _browse(self, p: dict) -> dict:
        """開いて、読む。押さない。"""
        return self._drive(p, act=False)

    def _browse_act(self, p: dict) -> dict:
        """開いて、押す・打ち込む。"""
        return self._drive(p, act=True)

    def _drive(self, p: dict, act: bool) -> dict:
        """あなたがログイン済みのブラウザで、ページを開く。

        サーバー側のブラウザ（api/browser.py）との違いは1つだけ、
        **ログインしているかどうか**。そしてそれが、危なさの全部でもある。
        こちらは「あなたとして」操作するので、

          ・開いてよいサイトは、先に決めてもらう（--site）
          ・押す・打ち込むほうは、AIbou側で必ず確認してから来る
          ・中のJavaScriptを走らせる口は出さない（サーバー側と同じ）
          ・ダウンロードは受け取らない
          ・何をしたかは全部書き出す

        プロフィール（Cookie等）は `--browser-profile` のフォルダに残る。
        一度 `--login` でログインしておけば、次からはそのまま入れる。
        """
        if not self.allow_browser:
            return {"ok": False,
                    "error": "ブラウザ操作は切ってあります（--allow-browser で入ります）"}
        try:
            import playwright.sync_api  # noqa: F401
        except ImportError:
            return {"ok": False,
                    "error": "playwright が要ります（pip install playwright && playwright install chromium）"}

        url = self.g.site(str(p.get("url") or ""))       # 許したサイトだけ
        steps = [x for x in (p.get("steps") or []) if isinstance(x, dict)][:MAX_STEPS] \
            if act else []
        did: List[str] = []

        page = self._page()
        page.goto(url, wait_until="domcontentloaded", timeout=BROWSE_TIMEOUT_MS)
        for step in steps:
            did.append(self._step(page, step))
        try:
            page.wait_for_load_state("networkidle", timeout=3000)
        except Exception:
            pass
        title = (page.title() or "")[:200]
        body = self._visible(page)
        links = self._clickable(page)
        final = page.url

        self.log(f"  ブラウザ: {final}" + (f" / {' → '.join(did)}" if did else ""))
        return {"ok": True, "title": title, "url": final, "text": body,
                "links": links, "did": did,
                "message": f"{title or final} を{'操作' if act else '読み'}ました"}

    def _page(self):
        """開いているブラウザを使い回す。無ければ開く。

        **1回ごとに開き直さない。** 理由が2つある。

          ① 立ち上げに数秒かかる。頼むたびに払うと、待てない長さになる
          ② 閉じるとセッションのCookieが消える。「ログインする」と
             「その先を見る」が別の頼みになった瞬間に、ログインが無かった
             ことになる（実際そうなった）

        画面が出ていれば、何をしているかは見えている。見えていることが、
        この機能の安全装置そのものなので、開いたままでよい。
        """
        if self._ctx is not None:
            try:
                return self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()
            except Exception:
                self.close_browser()          # 人が閉じた等。開き直す
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self._ctx = self._pw.chromium.launch_persistent_context(
            user_data_dir=str(self.profile),
            executable_path=find_chrome() or None,
            headless=self.headless,
            accept_downloads=False,
            locale="ja-JP",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        self._ctx.set_default_timeout(BROWSE_TIMEOUT_MS)
        # 新しいタブは開かせない（許可の網の外へ出る）
        self._ctx.on("page", lambda q: q.close())
        return self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()

    def close_browser(self) -> None:
        """開いていたら閉じる（止めるとき・開き直すとき）。"""
        for obj, stop in ((self._ctx, "close"), (self._pw, "stop")):
            try:
                if obj is not None:
                    getattr(obj, stop)()
            except Exception:
                pass
        self._ctx = None
        self._pw = None

    def _step(self, page, step: dict) -> str:
        """1手ぶん。できなければ理由を返す（例外にしない）。"""
        kind = str(step.get("do") or "").strip().lower()
        target = str(step.get("target") or "").strip()
        value = str(step.get("value") or "")
        if kind not in BROWSE_ACTIONS:
            return f"（{kind or '空'}）は使えません"
        try:
            if kind == "wait":
                page.wait_for_timeout(min(int(value or 1000), 5000))
                return "待ちました"
            if kind == "press":
                page.keyboard.press(target or "Enter")
                return f"{target or 'Enter'} を押しました"
            if kind == "goto":
                page.goto(self.g.site(value or target),
                          wait_until="domcontentloaded", timeout=BROWSE_TIMEOUT_MS)
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
        except PermissionError as e:
            return f"断りました（{e}）"
        except Exception as e:
            return f"できませんでした（{type(e).__name__}）"
        return "何もしませんでした"

    @staticmethod
    def _visible(page) -> str:
        try:
            body = page.locator("body").inner_text(timeout=5000)
        except Exception:
            body = ""
        body = "\n".join(l.strip() for l in (body or "").splitlines() if l.strip())
        return body[:BROWSE_MAX_CHARS]

    @staticmethod
    def _clickable(page, limit: int = 30) -> List[dict]:
        out: List[dict] = []
        try:
            for el in page.locator("a[href], button, input[type=submit]").all()[:limit * 3]:
                try:
                    label = (el.inner_text(timeout=500) or "").strip()
                except Exception:
                    label = ""
                if not label:
                    continue
                out.append({"label": label[:80]})
                if len(out) >= limit:
                    break
        except Exception:
            pass
        return out

    def _shot(self, p: dict) -> dict:
        """画面を撮る（仕様§32の、見る側）。

        **操作する側は入れていない。** 画面のどこでも押せる物を、遠くから
        動かせるようにするのは、これとは別の重さの話なので。
        """
        if not self.allow_screen:
            return {"ok": False,
                    "error": "画面を撮るのは切ってあります（--allow-screen で入ります）"}
        try:
            from PIL import ImageGrab
        except ImportError:
            return {"ok": False, "error": "pillow が要ります（pip install pillow）"}
        img = ImageGrab.grab()
        img.thumbnail((1280, 1280))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return {"ok": True, "image_base64": base64.b64encode(buf.getvalue()).decode(),
                "mime": "image/png", "message": f"{img.width}×{img.height} で撮りました"}


def loop(url: str, token: str, runner: Runner, log, once: bool = False) -> None:
    """仕事を取りに行き続ける。落ちているあいだは間を空けて掛け直す。"""
    session = requests.Session()
    headers = {"X-Local-Token": token}
    miss = 0
    while True:
        try:
            r = session.get(f"{url}/local/jobs", params={"wait": 25},
                            headers=headers, timeout=40)
            if r.status_code == 401:
                log("合言葉が通りませんでした。作り直してください。")
                return
            r.raise_for_status()
            job = (r.json() or {}).get("job")
            miss = 0
        except Exception as e:
            wait = BACKOFF[min(miss, len(BACKOFF) - 1)]
            miss += 1
            log(f"サーバーに繋がりません（{type(e).__name__}）。{wait}秒待ちます。")
            time.sleep(wait)
            if once:
                return
            continue

        if job:
            result = runner.do(job)
            try:
                session.post(f"{url}/local/result",
                             json={"job_id": job["id"], "result": result},
                             headers=headers, timeout=30)
            except Exception as e:
                log(f"結果を返せませんでした（{type(e).__name__}）")
        if once:
            return


def _login_once(runner: "Runner", url: str, log) -> int:
    """一度だけ、自分でログインするためにブラウザを開く。

    AIbou にパスワードを渡す道は**作らない**。二要素認証も、いつもの
    ログイン画面も、あなたが自分の手で通す。通ったCookieはプロフィールの
    フォルダに残るので、次からはそのまま入れる。
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright が要ります（pip install playwright"
              " && playwright install chromium）", file=sys.stderr)
        return 1
    try:
        target = runner.g.site(url)
    except PermissionError as e:
        print(str(e), file=sys.stderr)
        return 1
    log(f"ブラウザを開きます: {target}")
    log("ログインが済んだら、このウィンドウを閉じてください。")
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(runner.profile),
            executable_path=find_chrome() or None,
            headless=False, locale="ja-JP")
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(target, wait_until="domcontentloaded")
            # 閉じられるまで待つ
            while ctx.pages:
                ctx.pages[0].wait_for_timeout(1000)
        except Exception:
            pass
        finally:
            try:
                ctx.close()
            except Exception:
                pass
    log(f"ログイン状態を {runner.profile} に残しました。")
    return 0


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="AIbou の、手元で動く相棒")
    ap.add_argument("--url", required=True, help="AIbou のサーバー（https://…）")
    ap.add_argument("--token", required=True, help="設定 → つなぐ で作った合言葉")
    ap.add_argument("--dir", action="append", required=True,
                    help="触ってよいフォルダ（何度でも指定できる）")
    ap.add_argument("--vault", default="", help="Obsidian の vault（日誌に書くとき）")
    ap.add_argument("--daily", default="日誌", help="vault の中の、日誌のフォルダ名")
    ap.add_argument("--allow-open", action="store_true",
                    help="ファイルを既定のアプリで開くのを許す")
    ap.add_argument("--allow-screen", action="store_true",
                    help="画面を撮るのを許す（pillow が要る）")
    ap.add_argument("--allow-browser", action="store_true",
                    help="あなたのブラウザを動かすのを許す（--site が必須）")
    ap.add_argument("--site", action="append", default=[],
                    help="ブラウザで開いてよいサイト（何度でも指定できる）")
    ap.add_argument("--browser-profile", default="~/.aibou-browser",
                    help="ブラウザのログイン状態を残す場所")
    ap.add_argument("--headless", action="store_true",
                    help="ブラウザの画面を出さない（ふだんは出したほうが安全）")
    ap.add_argument("--login", default="",
                    help="そのURLを開いて、ログインするまで待つ（一度きり）")
    ap.add_argument("--log", default="", help="したことを書き出すファイル")
    args = ap.parse_args(argv)

    logfile = open(args.log, "a", encoding="utf-8") if args.log else None

    def log(line: str) -> None:
        stamp = dt.datetime.now().strftime("%H:%M:%S")
        print(f"[{stamp}] {line}", flush=True)
        if logfile:
            logfile.write(f"[{dt.datetime.now().isoformat()}] {line}\n")
            logfile.flush()

    guard = Guard(args.dir, args.vault, args.daily, args.site)
    for root in guard.roots:
        if not root.is_dir():
            print(f"フォルダがありません: {root}", file=sys.stderr)
            return 1

    log("相棒を始めます。触ってよいのは:")
    for root in guard.roots:
        log(f"  {root}")
    if guard.vault:
        log(f"  Obsidian: {guard.vault} / {guard.daily}")
    log(f"  開く: {'許可' if args.allow_open else '切'}  "
        f"画面: {'許可' if args.allow_screen else '切'}  "
        f"ブラウザ: {'許可' if args.allow_browser else '切'}")
    if args.allow_browser:
        if not args.site:
            print("--allow-browser には --site が要ります"
                  "（開いてよいサイトを決めてください）", file=sys.stderr)
            return 1
        for host in guard.sites:
            log(f"  ブラウザで開いてよい: {host}")
    log("止めるときは Ctrl-C。")

    runner = Runner(guard, args.allow_open, args.allow_screen, log,
                    allow_browser=args.allow_browser,
                    profile=args.browser_profile,
                    headless=args.headless or None)

    if args.login:
        return _login_once(runner, args.login, log)
    try:
        loop(args.url.rstrip("/"), args.token, runner, log)
    except KeyboardInterrupt:
        log("止めました。")
    finally:
        runner.close_browser()
    return 0


if __name__ == "__main__":                                  # pragma: no cover
    raise SystemExit(main())
