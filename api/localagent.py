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

何台でも繋げる
--------------
最初は**1人1台**で作ってしまっていた。`devices[user_id]` が1件の辞書で、
2台目を繋ぐと1台目の合言葉が死ぬ（テストでその挙動を固定してすらいた）。

「スマホとノートPCとデスクトップで使いたい」で、そこが即詰まった。
スマホにはそもそも相棒が要らない（ブラウザだけ）が、**ノートとデスクトップは
両方繋いだままにしたい**——これは1台設計では表せない。

いまは台ごとに、合言葉・名前・仕事の列を持つ。

どの台に頼むか
--------------
ファイルは台ごとに違う。だから「読んで」だけでは足りない。

    動いている台が0台 … 動いていないと言う
    1台             … その台に頼む
    2台以上         … **勝手に選ばず、名前を並べて聞く**

2台以上のときに黙って選ぶと、「ノートのファイルを読んだつもりがデスク
トップのを読んでいた」が起きる。読み違いは分かりにくく、書き違いは
取り返しがつかない。ここは聞くほうを取る。

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
import secrets
import threading
import time
import uuid
from typing import Dict, List, Optional, Tuple

# 頼める仕事。手元の相棒（agent_local/aibou_local.py）と同じ顔ぶれにする。
# recipe … 保存した手順を、専用ブラウザで決まった通りに流す（recipes.py）
JOBS = ("list", "read", "write", "append", "open", "shot",
        "browse", "browse_act", "recipe")

# 仕事を預かっておく時間。手元の相棒が落ちていると、ここに溜まる。
JOB_TTL = 600.0
# 結果を待つ側が諦めるまで。
RESULT_TIMEOUT = 60.0
# 手元の相棒が「仕事ある？」と待つ長さ（サーバー側の上限）。
MAX_WAIT = 30.0
# これだけ音沙汰が無ければ「繋がっていない」と見なす。
OFFLINE_AFTER = 90.0
# 1人が繋げる台数の上限。増やしすぎても管理できないだけ。
MAX_DEVICES = 8


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
        # user_id → device_id → {"token_hash", "name", "at", "seen", "queue"}
        self.users: Dict[str, Dict[str, dict]] = {}
        # job_id → 結果（取りに来た側が持って帰るまで）
        self.results: Dict[str, dict] = {}


_store = _Store()


def reset() -> None:
    """テスト用。全部忘れる。"""
    global _store
    _store = _Store()


def _devices(user_id: str) -> Dict[str, dict]:
    return _store.users.setdefault(user_id or "local", {})


def _online(dev: dict) -> bool:
    return dev["seen"] > 0 and (_now() - dev["seen"]) < OFFLINE_AFTER


def _label(dev: dict, device_id: str) -> str:
    return dev.get("name") or device_id[:8]


# ── 1台つなぐ ───────────────────────────────────────────────────────

def pair(user_id: str, name: str = "") -> dict:
    """新しい台を足す。**合言葉を返すのはこの1回だけ。**

    すでに繋いである台は**そのまま**。ノートPCを繋いだあとにデスクトップを
    繋いでも、ノートは切れない。

    サーバーには照合用の形でしか残らないので、無くしたらその台だけ作り直す。
    （見せられない物を「見せられます」と言わないため、ここで言い切る）
    """
    token = secrets.token_urlsafe(32)
    device_id = uuid.uuid4().hex
    label = (name or "パソコン").strip()[:40] or "パソコン"
    with _store.lock:
        devices = _devices(user_id)
        if len(devices) >= MAX_DEVICES:
            return {"ok": False,
                    "error": f"繋げる台数の上限（{MAX_DEVICES}台）です",
                    "next": "使っていない台の繋ぎを切ってください"}
        # 同じ名前が並ぶと、どちらに頼んだか分からなくなる
        if any(d.get("name") == label for d in devices.values()):
            label = f"{label}2"
        devices[device_id] = {
            "token_hash": _hash(token),
            "name": label,
            "at": _now(),
            "seen": 0.0,
            "queue": [],
        }
    return {"ok": True, "token": token, "device": device_id, "name": label}


def unpair(user_id: str, device: str = "") -> dict:
    """繋ぎを切る。`device` を渡さなければ**全部**。"""
    with _store.lock:
        devices = _devices(user_id)
        if not device:
            n = len(devices)
            devices.clear()
            return {"ok": True, "removed": n}
        found = _resolve_locked(devices, device)
        if not found:
            return {"ok": False, "error": f"「{device}」という台はありません"}
        devices.pop(found)
        return {"ok": True, "removed": 1}


def rename(user_id: str, device: str, name: str) -> dict:
    """台に名前を付ける。どちらに頼むかを言葉で指せるようにするため。"""
    label = (name or "").strip()[:40]
    if not label:
        return {"ok": False, "error": "名前が空です"}
    with _store.lock:
        devices = _devices(user_id)
        found = _resolve_locked(devices, device)
        if not found:
            return {"ok": False, "error": f"「{device}」という台はありません"}
        devices[found]["name"] = label
    return {"ok": True, "device": found, "name": label}


def whoami(token: str) -> Tuple[str, str]:
    """合言葉から (利用者, 台) を引く。分からなければ ("", "")。"""
    if not token:
        return "", ""
    want = _hash(token)
    with _store.lock:
        for user_id, devices in _store.users.items():
            for device_id, dev in devices.items():
                if secrets.compare_digest(dev["token_hash"], want):
                    return user_id, device_id
    return "", ""


def _resolve_locked(devices: Dict[str, dict], name: str) -> str:
    """名前でもIDでも引けるようにする（人は名前で言う）。"""
    key = (name or "").strip()
    if not key:
        return ""
    if key in devices:
        return key
    low = key.lower()
    for device_id, dev in devices.items():
        if (dev.get("name") or "").lower() == low:
            return device_id
    # 前方一致（IDの頭だけ言われたとき）
    for device_id in devices:
        if device_id.startswith(key):
            return device_id
    return ""


def status(user_id: str) -> dict:
    """何台繋がっていて、どれが動いているか。

    **「たぶん繋がっている」とは言わない。** 合言葉を作っただけの台と、
    いま動いている台を分けて出す。
    """
    with _store.lock:
        devices = dict(_devices(user_id))
        rows = []
        for device_id, dev in devices.items():
            idle = _now() - dev["seen"] if dev["seen"] else None
            rows.append({
                "device": device_id,
                "name": dev["name"],
                "online": _online(dev),
                "waiting": len(dev["queue"]),
                "last_seen_ago": int(idle) if idle is not None else None,
                "engines": list(dev.get("engines") or []),
                "sites": list(dev.get("sites") or []),
                # 手順を流せるか（相棒が新しく、専用ブラウザが入っている）
                "recipes": _can_run_recipes(dev),
            })
    rows.sort(key=lambda r: (not r["online"], r["name"]))
    live = [r for r in rows if r["online"]]

    if not rows:
        return {"ok": True, "paired": False, "online": False, "devices": [],
                "why": "まだ1台も繋いでいません",
                "next": "設定 → つなぐ →「手元のパソコン」から合言葉を作ります"}
    if live:
        return {"ok": True, "paired": True, "online": True, "devices": rows,
                "why": "", "next": ""}
    never = all(r["last_seen_ago"] is None for r in rows)
    return {
        "ok": True, "paired": True, "online": False, "devices": rows,
        "why": ("合言葉は作ってありますが、手元の相棒が動いていません" if never
                else "どの台も、しばらく音沙汰がありません"),
        "next": "パソコンで `python aibou_local.py` を動かしてください",
    }


# ── どの台に頼むか ──────────────────────────────────────────────────

def pick(user_id: str, device: str = "") -> dict:
    """頼み先を1台に決める。決められなければ、理由と選択肢を返す。

    **2台以上動いているときに勝手に選ばない。** ファイルは台ごとに違うので、
    黙って選ぶと「ノートを読んだつもりがデスクトップだった」が起きる。
    読み違いは気づきにくく、書き違いは取り返しがつかない。
    """
    with _store.lock:
        devices = _devices(user_id)
        if not devices:
            return {"ok": False, "error": "手元のパソコンを繋いでいません",
                    "next": "設定 → つなぐ →「手元のパソコン」"}
        if device:
            found = _resolve_locked(devices, device)
            if not found:
                names = ", ".join(_label(d, i) for i, d in devices.items())
                return {"ok": False,
                        "error": f"「{device}」という台はありません（あるのは: {names}）"}
            if not _online(devices[found]):
                return {"ok": False,
                        "error": f"「{_label(devices[found], found)}」は動いていません",
                        "next": "そのパソコンで相棒を動かしてください"}
            return {"ok": True, "device": found,
                    "name": _label(devices[found], found)}

        live = [(i, d) for i, d in devices.items() if _online(d)]
        if not live:
            return {"ok": False, "error": "動いている台がありません",
                    "next": "パソコンで `python aibou_local.py` を動かしてください"}
        if len(live) == 1:
            return {"ok": True, "device": live[0][0],
                    "name": _label(live[0][1], live[0][0])}
        names = " / ".join(_label(d, i) for i, d in live)
        return {"ok": False, "choose": [_label(d, i) for i, d in live],
                "error": f"どのパソコンに頼むか決めてください（{names}）",
                "next": "台の名前を言ってもらえれば、そこへ頼みます"}


# ── 仕事を頼む / 取りに来る ────────────────────────────────────────

def submit(user_id: str, kind: str, params: Optional[dict] = None,
           device: str = "") -> dict:
    """仕事を1つ、1台に預ける。job_id を返す。"""
    if kind not in JOBS:
        return {"ok": False, "error": f"「{kind}」は頼めません"}
    chosen = pick(user_id, device)
    if not chosen.get("ok"):
        return chosen
    job = {"id": uuid.uuid4().hex, "kind": kind,
           "params": dict(params or {}), "at": _now()}
    with _store.lock:
        dev = _devices(user_id).get(chosen["device"])
        if dev is None:                      # 選んだ直後に切られた
            return {"ok": False, "error": "その台は繋ぎが切れました"}
        dev["queue"].append(job)
        _store.wake.notify_all()
    return {"ok": True, "job_id": job["id"], "device": chosen["device"],
            "name": chosen["name"]}


# 相棒が知らせてくるブラウザのエンジン名。知らない名前は捨てる
# （画面にそのまま出すので、何でも受け取ると表示が汚される）。
ENGINES = ("opencli", "playwright")


def note_engines(user_id: str, device_id: str, engines) -> None:
    """その台で使えるブラウザのエンジンを覚える（自己診断で出す）。"""
    names = [e for e in (engines or []) if e in ENGINES]
    with _store.lock:
        dev = _devices(user_id).get(device_id)
        if dev is not None:
            dev["engines"] = names


_HOST = __import__("re").compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")


def note_sites(user_id: str, device_id: str, sites) -> None:
    """その台が開いてよいサイト（相棒の `--site`）を覚える。

    **これはサーバーが「どの台で開くか」を決めるための手がかりで、許可では
    ない。** 許すかどうかを決めるのは、いつも手元の相棒のほう（こちらが
    何を覚えていても、相棒は自分の `--site` の外を開かない）。

    ホスト名の形をしていない物は捨てる（画面にそのまま出すので）。
    """
    names = []
    for raw in (sites or [])[:50]:
        h = str(raw or "").strip().lower().lstrip(".")
        if h and _HOST.match(h):
            names.append(h)
    with _store.lock:
        dev = _devices(user_id).get(device_id)
        if dev is not None:
            dev["sites"] = names


def note_jobs(user_id: str, device_id: str, jobs) -> None:
    """その台の相棒が引き受けられる仕事（`X-Local-Jobs`）を覚える。

    相棒は手元で動いている物なので、サーバーより古いことがある。古い相棒に
    知らない仕事を渡すと「知りません」で返ってくるだけだが、それだと
    **頼んでから**分かる。先に知っていれば、頼む前に「新しくしてください」と
    言える。知らせてこない相棒（この仕組みより前の物）は、何も覚えない。
    """
    names = [j for j in (jobs or []) if j in JOBS]
    with _store.lock:
        dev = _devices(user_id).get(device_id)
        if dev is not None:
            dev["jobs"] = names


def _can_run_recipes(dev: dict) -> bool:
    """手順を流せる台か。専用ブラウザ（Playwright）と、recipe を知っている相棒が要る。"""
    return "playwright" in (dev.get("engines") or []) and "recipe" in (dev.get("jobs") or [])


def _covers(sites, host: str) -> bool:
    h = (host or "").strip().lower().rstrip(".")
    return bool(h) and any(h == a or h.endswith("." + a) for a in (sites or []))


def devices_for_host(user_id: str, host: str, need: str = "") -> List[dict]:
    """そのサイトを開ける台（動いていて、ブラウザがあり、`--site` に入っている）。

    need="recipe" なら、そのうち手順を流せる台だけ（専用ブラウザがあり、
    相棒が recipe を知っている）。
    """
    out = []
    with _store.lock:
        for device_id, dev in _devices(user_id).items():
            if not _online(dev) or not dev.get("engines"):
                continue
            if need == "recipe" and not _can_run_recipes(dev):
                continue
            if _covers(dev.get("sites"), host):
                out.append({"device": device_id, "name": _label(dev, device_id),
                            "engines": list(dev.get("engines") or [])})
    return out


def take(user_id: str, device_id: str, wait: float = 25.0) -> Optional[dict]:
    """手元の相棒が「仕事ある？」と聞きに来たとき。

    無ければ `wait` 秒まで待つ。ここで待つぶん、頼んでから動き出すまでが
    速くなる（1秒ごとに聞きに来させると、平均0.5秒遅れて、そのあいだ
    ずっと通信が走る）。
    """
    until = _now() + min(max(wait, 0.0), MAX_WAIT)
    with _store.lock:
        while True:
            dev = _devices(user_id).get(device_id)
            if dev is None:
                return None                  # 繋ぎを切られた
            dev["seen"] = _now()
            q = dev["queue"]
            # 古すぎる仕事は渡さない（頼んだ人はもう待っていない）
            while q and _now() - q[0]["at"] > JOB_TTL:
                q.pop(0)
            if q:
                return q.pop(0)
            left = until - _now()
            if left <= 0:
                return None
            _store.wake.wait(timeout=min(left, 1.0))


def deliver(user_id: str, device_id: str, job_id: str, result: dict) -> dict:
    """手元の相棒が結果を持ってきたとき。"""
    with _store.lock:
        dev = _devices(user_id).get(device_id)
        if dev is not None:
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
        timeout: float = RESULT_TIMEOUT, device: str = "") -> dict:
    """頼んで、結果まで待つ（道具から使う形）。"""
    sent = submit(user_id, kind, params, device)
    if not sent.get("ok"):
        return sent
    got = collect(sent["job_id"], timeout)
    # どの台がやったのかを添える。2台あるときに、これが無いと分からない
    if got.get("ok") and sent.get("name"):
        got["device_name"] = sent["name"]
    return got
