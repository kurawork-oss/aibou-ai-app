"""
localagent.py — 手元のパソコンで動く相棒の、サーバー側（仕様§29〜§31）。

なぜ別プロセスが要るのか
------------------------
ブラウザの中からは、パソコンの中のファイルを読めない。読めないのが正しい
（読めたら、どのウェブサイトでも読めることになる）。だから
「Obsidianの日誌に足しておいて」「あのフォルダのPDFを読んで」は、
Webだけでは**どうやっても届かない**。

どちら向きに繋ぐか
------------------
最初は「サーバーが手元のパソコンを呼ぶ」（`LOCAL_AGENT_URL`）で考えていたが、
これは**家のパソコンでは動かない**。ルーターの内側にあるので、外から呼べない。
ポートを開ける手順を人に踏ませるのは、危ないうえに続かない。

そこで向きを逆にした。**手元から取りに来る。**

    手元の相棒 ──(外向きに)──▶ サーバー「仕事ある？」
                ◀───────────  「これをやって」
                ──────────▶  「やった。結果はこれ」

外向きの通信だけなので、ルーターの設定は要らない。会社のネットワークでも
たいてい通る。

鍵の持ち方
----------
1台ごとに合言葉（トークン）を発行する。手元の相棒はそれを持って取りに来る。
**合言葉はサーバー側にそのままでは置かない**——漏れたときに、そのまま
パソコンの中身を取りに行けることになるので、照合用の形（ハッシュ）で持つ。

何を頼めるか
------------
`JOBS` にある物だけ。増やすときは、ここに足して、手元の相棒にも足す。
どちらか片方だけ知っている仕事は**黙って落とす**（知らない仕事を
「やったことにする」より、できないと言うほうがよい）。

ここに置かないもの
------------------
実際にファイルを触るコードは**1行も無い**。それは手元の相棒（agent_local/）の
仕事で、そちらには「触ってよいフォルダ」の一覧がある。サーバーは
「読んで」と頼むだけで、どこを読めるかは決められない——サーバーが乗っ取られた
ときに、パソコン全体が取られないようにするため。
"""

from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
import uuid
from typing import Dict, List, Optional

# 頼める仕事。手元の相棒（agent_local/aibou_local.py）と同じ顔ぶれにする。
JOBS = ("list", "read", "write", "append", "open", "shot")

# 仕事を預かっておく時間。手元の相棒が落ちていると、ここに溜まる。
JOB_TTL = 600.0
# 結果を待つ側が諦めるまで。
RESULT_TIMEOUT = 60.0
# 手元の相棒が「仕事ある？」と待つ長さ（サーバー側の上限）。
MAX_WAIT = 30.0
# これだけ音沙汰が無ければ「繋がっていない」と見なす。
OFFLINE_AFTER = 90.0


def _now() -> float:
    return time.time()


def _hash(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


class _Store:
    """1つのサーバーの中の、全利用者ぶん。

    プロセスのメモリに置いてある。Renderが眠ると消えるが、消えて困る物は
    入っていない——繋ぎ直せば合言葉は作り直せるし、やりかけの仕事は
    もう一度頼めばよい。**消えて困る物を入れないこと**が決まり。
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)
        # user_id → {"token_hash": str, "name": str, "at": float, "seen": float}
        self.devices: Dict[str, dict] = {}
        # user_id → [job, ...]（手元がまだ取りに来ていない物）
        self.queue: Dict[str, List[dict]] = {}
        # job_id → 結果（取りに来た側が持って帰るまで）
        self.results: Dict[str, dict] = {}


_store = _Store()


def reset() -> None:
    """テスト用。全部忘れる。"""
    global _store
    _store = _Store()


# ── 1台つなぐ ───────────────────────────────────────────────────────

def pair(user_id: str, name: str = "") -> dict:
    """新しい合言葉を発行する。**返すのはこの1回だけ。**

    サーバーには照合用の形でしか残らないので、無くしたらもう一度発行する。
    （見せられない物を「見せられます」と言わないため、ここで言い切る）
    """
    token = secrets.token_urlsafe(32)
    with _store.lock:
        _store.devices[user_id or "local"] = {
            "token_hash": _hash(token),
            "name": (name or "パソコン")[:40],
            "at": _now(),
            "seen": 0.0,
        }
        _store.queue.pop(user_id or "local", None)
    return {"ok": True, "token": token, "name": (name or "パソコン")[:40]}


def unpair(user_id: str) -> dict:
    with _store.lock:
        had = _store.devices.pop(user_id or "local", None)
        _store.queue.pop(user_id or "local", None)
    return {"ok": True, "was_paired": bool(had)}


def whoami(token: str) -> str:
    """合言葉から、どの利用者の相棒かを引く。分からなければ空文字。"""
    want = _hash(token or "")
    if not token:
        return ""
    with _store.lock:
        for user_id, dev in _store.devices.items():
            if secrets.compare_digest(dev["token_hash"], want):
                return user_id
    return ""


def status(user_id: str) -> dict:
    """繋がっているか。**「たぶん繋がっている」とは言わない。**"""
    uid = user_id or "local"
    with _store.lock:
        dev = _store.devices.get(uid)
        waiting = len(_store.queue.get(uid) or [])
    if not dev:
        return {"ok": True, "paired": False, "online": False, "waiting": 0,
                "why": "まだ1台も繋いでいません",
                "next": "設定 → つなぐ →「手元のパソコン」から合言葉を作ります"}
    idle = _now() - (dev["seen"] or 0)
    online = dev["seen"] > 0 and idle < OFFLINE_AFTER
    return {
        "ok": True,
        "paired": True,
        "online": online,
        "name": dev["name"],
        "waiting": waiting,
        "last_seen_ago": int(idle) if dev["seen"] else None,
        "why": "" if online else (
            "合言葉は作ってありますが、手元の相棒が動いていません"
            if dev["seen"] == 0 else
            f"最後に来たのは{int(idle)}秒前です（動いていない可能性があります）"),
        "next": "" if online else "パソコンで `python aibou_local.py` を動かしてください",
    }


# ── 仕事を頼む / 取りに来る ────────────────────────────────────────

def submit(user_id: str, kind: str, params: Optional[dict] = None) -> dict:
    """仕事を1つ預ける。job_id を返す。"""
    uid = user_id or "local"
    if kind not in JOBS:
        return {"ok": False, "error": f"「{kind}」は頼めません"}
    with _store.lock:
        if uid not in _store.devices:
            return {"ok": False, "error": "手元のパソコンを繋いでいません",
                    "next": "設定 → つなぐ →「手元のパソコン」"}
        job = {"id": uuid.uuid4().hex, "kind": kind,
               "params": dict(params or {}), "at": _now()}
        _store.queue.setdefault(uid, []).append(job)
        _store.wake.notify_all()
    return {"ok": True, "job_id": job["id"]}


def take(user_id: str, wait: float = 25.0) -> Optional[dict]:
    """手元の相棒が「仕事ある？」と聞きに来たとき。

    無ければ `wait` 秒まで待つ。ここで待つぶん、頼んでから動き出すまでが
    速くなる（1秒ごとに聞きに来させると、平均0.5秒遅れて、そのあいだ
    ずっと通信が走る）。
    """
    uid = user_id or "local"
    until = _now() + min(max(wait, 0.0), MAX_WAIT)
    with _store.lock:
        dev = _store.devices.get(uid)
        if dev:
            dev["seen"] = _now()
        while True:
            q = _store.queue.get(uid) or []
            # 古すぎる仕事は渡さない（頼んだ人はもう待っていない）
            while q and _now() - q[0]["at"] > JOB_TTL:
                q.pop(0)
            if q:
                return q.pop(0)
            left = until - _now()
            if left <= 0:
                return None
            _store.wake.wait(timeout=min(left, 1.0))
            dev = _store.devices.get(uid)
            if dev:
                dev["seen"] = _now()


def deliver(user_id: str, job_id: str, result: dict) -> dict:
    """手元の相棒が結果を持ってきたとき。"""
    uid = user_id or "local"
    with _store.lock:
        dev = _store.devices.get(uid)
        if dev:
            dev["seen"] = _now()
        _store.results[job_id] = {"at": _now(), "result": dict(result or {})}
        _store.wake.notify_all()
    return {"ok": True}


def collect(job_id: str, timeout: float = RESULT_TIMEOUT) -> dict:
    """結果が来るまで待つ。来なければ、来なかったと返す。"""
    until = _now() + max(timeout, 0.0)
    with _store.lock:
        while True:
            got = _store.results.pop(job_id, None)
            if got:
                return {"ok": True, **got["result"]}
            if _now() >= until:
                return {"ok": False,
                        "error": "手元のパソコンから返事がありませんでした",
                        "next": "パソコンで相棒が動いているか確かめてください"}
            _store.wake.wait(timeout=min(until - _now(), 1.0))


def run(user_id: str, kind: str, params: Optional[dict] = None,
        timeout: float = RESULT_TIMEOUT) -> dict:
    """頼んで、結果まで待つ（道具から使う形）。"""
    sent = submit(user_id, kind, params)
    if not sent.get("ok"):
        return sent
    return collect(sent["job_id"], timeout)
