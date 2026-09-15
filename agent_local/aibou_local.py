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
# サーバーが落ちているときに、どれだけ待ってから掛け直すか。
BACKOFF = (2, 4, 8, 16, 30)


class Guard:
    """触ってよい場所を決める。ここが破られたら、ほかは全部意味が無い。"""

    def __init__(self, roots, vault: str = "", daily: str = "") -> None:
        self.roots = [Path(r).expanduser().resolve() for r in roots]
        self.vault = Path(vault).expanduser().resolve() if vault else None
        self.daily = daily or "日誌"

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
                 log) -> None:
        self.g = guard
        self.allow_open = allow_open
        self.allow_screen = allow_screen
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
    ap.add_argument("--log", default="", help="したことを書き出すファイル")
    args = ap.parse_args(argv)

    logfile = open(args.log, "a", encoding="utf-8") if args.log else None

    def log(line: str) -> None:
        stamp = dt.datetime.now().strftime("%H:%M:%S")
        print(f"[{stamp}] {line}", flush=True)
        if logfile:
            logfile.write(f"[{dt.datetime.now().isoformat()}] {line}\n")
            logfile.flush()

    guard = Guard(args.dir, args.vault, args.daily)
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
        f"画面: {'許可' if args.allow_screen else '切'}")
    log("止めるときは Ctrl-C。")

    runner = Runner(guard, args.allow_open, args.allow_screen, log)
    try:
        loop(args.url.rstrip("/"), args.token, runner, log)
    except KeyboardInterrupt:
        log("止めました。")
    return 0


if __name__ == "__main__":                                  # pragma: no cover
    raise SystemExit(main())
