"""
webpush.py — 端末に通知を届ける（Web Push）。

なぜ要るのか
------------
このアプリは「寝ている間に働く」ことを狙っている。定期実行も、オート
パイロットも、承認待ちもある。ところが**こちらから人を呼ぶ手段**は、
LINE・Discord・Slack の3つしか無く、どれも先に相手方の登録が要る。
つまり何もしていない人には、夜中に何が起きても届かない。

Web Push だけは**他所の登録が要らない**。鍵はこのサーバーが自分で作り、
配送はブラウザが自前で持っている経路を使う。入れた瞬間から届く。

外部ライブラリを足していない
----------------------------
`pywebpush` を入れれば数行で済むが、この機能のために依存を1つ増やすと、
その供給元も背負うことになる（鍵と本文を扱う所なので、なおさら）。
必要な部品（P-256・HKDF・AES-GCM・ES256のJWT）は `cryptography` と
`PyJWT[crypto]` に全部あり、どちらも既に入っている。仕様どおりに
組み立てるだけなので、そちらを取った。

    RFC 8291 … Message Encryption for Web Push（本文の暗号化）
    RFC 8188 … Encrypted Content-Encoding（aes128gcm の並び）
    RFC 8292 … VAPID（送り主の署名）

確かめていないこと（正直に）
----------------------------
**本物の push サービス（FCM等）へは送っていない。** ここには実機の
ブラウザで作った購読が無く、作れないため。確かめてあるのは
「組み立てた物が仕様どおりの形か」と「自分で戻せるか（往復）」まで。
"""

import base64
import json
import os
import struct
import time
from typing import List, Optional
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand
from cryptography.hazmat.primitives.hmac import HMAC

import config
import memstore

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

#: 鍵をしまう名前（keychain 経由で暗号化して保存される）。
VAPID_KEY_NAME = "VAPID_PRIVATE_KEY"
#: 送り主の連絡先。push サービスが問い合わせ先として要求する。
#: 実在のアドレスでなくてよいが、形式は mailto: か https: であること。
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:noreply@aibou.app")

#: 1回の送信で待つ秒数。
TIMEOUT = 10
#: 通知の本文の上限（push サービス側の制限はだいたい 4KB）。
MAX_PAYLOAD = 3500


# ── base64url（パディング無し）──────────────────────────────────────

def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64d(text: str) -> bytes:
    s = (text or "").strip().replace("-", "+").replace("_", "/")
    return base64.b64decode(s + "=" * (-len(s) % 4))


# ── 鍵 ───────────────────────────────────────────────────────────────

def _new_private_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def _load_private_key(raw: bytes) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


def _private_bytes(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.private_numbers().private_value.to_bytes(32, "big")


def public_bytes(key: ec.EllipticCurvePrivateKey) -> bytes:
    """非圧縮形式（0x04 || X || Y）の65バイト。push の世界はこの形で話す。"""
    return key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint)


#: 取り出した鍵を覚えておく（毎回 keychain を読みに行かない）。
_cached: Optional[ec.EllipticCurvePrivateKey] = None
_cache_warned = False


def vapid_key() -> ec.EllipticCurvePrivateKey:
    """このサーバーの署名鍵。無ければ作って保存する。

    **鍵が変わると、既にある購読は全部無効になる**（購読はこの公開鍵に
    紐づいて作られるため）。だから必ず保存して使い回す。保存できない
    環境では、その場限りの鍵で動かしつつ、後で分かるよう印を残す。
    """
    global _cached, _cache_warned
    if _cached is not None:
        return _cached

    # ① 環境変数（いちばん確実。再起動でも変わらない）
    env = os.getenv("VAPID_PRIVATE_KEY", "").strip()
    if env:
        try:
            _cached = _load_private_key(b64d(env))
            return _cached
        except Exception:
            pass

    # ② keychain（暗号化して保存される。設定なしで使えるのはここ）
    try:
        import keychain
        saved = keychain.get_key(VAPID_KEY_NAME)
        if saved:
            _cached = _load_private_key(b64d(saved))
            return _cached
    except Exception:
        pass

    key = _new_private_key()
    try:
        import keychain
        res = keychain.set_key(VAPID_KEY_NAME, b64e(_private_bytes(key)))
        if not (isinstance(res, dict) and res.get("ok")):
            raise RuntimeError(str(res))
    except Exception:
        if not _cache_warned:
            _cache_warned = True
            # 黙って続けない。再起動のたびに通知が止まる状態なので、
            # /diagnose から見えるようにしておく
            print("[webpush] 署名鍵を保存できませんでした。"
                  "再起動すると、いまの購読は使えなくなります。")
    _cached = key
    return key


def public_key_b64() -> str:
    """画面へ渡す applicationServerKey。"""
    return b64e(public_bytes(vapid_key()))


def reset_cache() -> None:
    """テスト用。次の呼び出しで鍵を読み直す。"""
    global _cached
    _cached = None


# ── VAPID の署名（RFC 8292）───────────────────────────────────────────

def vapid_headers(endpoint: str) -> dict:
    """その宛先ぶんの Authorization。

    `aud` は**宛先のスキーム＋ホスト**だけ（パスを入れると弾かれる）。
    `exp` は24時間以内。長すぎると押し返される。
    """
    import jwt

    u = urlparse(endpoint)
    token = jwt.encode(
        {"aud": f"{u.scheme}://{u.netloc}",
         "exp": int(time.time()) + 12 * 3600,
         "sub": VAPID_SUBJECT},
        vapid_key(), algorithm="ES256")
    return {"Authorization": f"vapid t={token},k={public_key_b64()}"}


# ── 本文の暗号化（RFC 8291 / RFC 8188）───────────────────────────────

def _hmac(key: bytes, data: bytes) -> bytes:
    h = HMAC(key, hashes.SHA256())
    h.update(data)
    return h.finalize()


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    """HKDF（抽出→展開）。仕様の式をそのまま置いてある。"""
    prk = _hmac(salt, ikm)
    return HKDFExpand(algorithm=hashes.SHA256(), length=length, info=info).derive(prk)


def encrypt(payload: bytes, ua_public: bytes, auth_secret: bytes,
            *, as_key: Optional[ec.EllipticCurvePrivateKey] = None,
            salt: Optional[bytes] = None, record_size: int = 4096) -> bytes:
    """RFC 8291 の本文を作る。

    出来上がりの並び（RFC 8188 §2.1）:

        salt(16) | rs(4) | idlen(1) | keyid(=送り主の公開鍵 65) | 暗号文

    `as_key` と `salt` を渡せるのは**検算のため**。仕様書の例と同じ鍵を
    入れて、同じ物が出るかを見る。ふだんは毎回作り直す（使い回すと、
    同じ鍵と nonce で2回暗号化することになり、AES-GCM では致命的）。
    """
    as_key = as_key or _new_private_key()
    salt = salt or os.urandom(16)
    as_public = public_bytes(as_key)

    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    shared = as_key.exchange(ec.ECDH(), ua_key)

    # 受け手の鍵と送り手の鍵を混ぜて、この1通ぶんの素をつくる（RFC 8291 §3.3）
    ikm = _hkdf(auth_secret, shared,
                b"WebPush: info\x00" + ua_public + as_public, 32)

    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)

    # 本文の終わりの印（0x02）。これが無いと、受け手が「まだ続く」と読む
    body = payload + b"\x02"
    ciphertext = AESGCM(cek).encrypt(nonce, body, None)

    header = salt + struct.pack("!I", record_size) + bytes([len(as_public)]) + as_public
    return header + ciphertext


def decrypt(block: bytes, ua_private: ec.EllipticCurvePrivateKey,
            auth_secret: bytes) -> bytes:
    """受け手側。**検算のためだけ**に置いてある。

    ブラウザがやることを同じ手順で書いて、自分で戻せるかを見る。
    これが通れば、鍵の作り方・並び・終わりの印が揃っていることになる。
    """
    salt = block[:16]
    idlen = block[20]
    as_public = block[21:21 + idlen]
    ciphertext = block[21 + idlen:]

    ua_public = public_bytes(ua_private)
    as_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
    shared = ua_private.exchange(ec.ECDH(), as_key)

    ikm = _hkdf(auth_secret, shared,
                b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)

    plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
    return plain.rstrip(b"\x00")[:-1]     # 終わりの印を落とす


# ── 購読の保管 ───────────────────────────────────────────────────────

_mem_subs = memstore.TenantList()


def _valid(sub: dict) -> bool:
    try:
        keys = sub.get("keys") or {}
        return bool(sub.get("endpoint")) and bool(keys.get("p256dh")) and bool(keys.get("auth"))
    except Exception:
        return False


def subscribe(sub: dict) -> dict:
    """この端末を登録する。同じ宛先が既にあれば入れ直す。"""
    if not _valid(sub):
        return {"ok": False, "error": "購読の形が正しくありません（endpoint と keys が要ります）"}
    row = {
        "endpoint": sub["endpoint"],
        "p256dh": sub["keys"]["p256dh"],
        "auth": sub["keys"]["auth"],
        "label": (sub.get("label") or "")[:80],
    }
    _forget_mem(row["endpoint"])
    _mem_subs.append(row)

    c = config.get_supabase()
    if c:
        try:
            c.table("push_subscriptions").upsert(row, on_conflict="endpoint").execute()
        except Exception as e:
            # 保存できなくても、この起動の間は届く。黙って成功にはしない
            return {"ok": True, "stored": "memory", "note": f"保存できませんでした（{type(e).__name__}）"}
        return {"ok": True, "stored": "db"}
    return {"ok": True, "stored": "memory"}


def _forget_mem(endpoint: str) -> None:
    """同じ宛先の古い行を落とす（TenantList は「入れ替え」を持たないので、
    後ろから消す。前から消すと添字がずれる）。"""
    try:
        for i in range(len(_mem_subs) - 1, -1, -1):
            if (_mem_subs[i] or {}).get("endpoint") == endpoint:
                del _mem_subs[i]
    except Exception:
        pass


def unsubscribe(endpoint: str) -> dict:
    endpoint = (endpoint or "").strip()
    if not endpoint:
        return {"ok": False, "error": "endpoint が空です"}
    _forget_mem(endpoint)
    c = config.get_supabase()
    if c:
        try:
            c.table("push_subscriptions").delete().eq("endpoint", endpoint).execute()
        except Exception:
            pass
    return {"ok": True}


def list_subscriptions() -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            rows = c.table("push_subscriptions").select("*").execute().data or []
            if rows:
                return rows
        except Exception:
            pass
    return list(_mem_subs)


def status() -> dict:
    """画面と /diagnose に出す状態。**鍵そのものは出さない**。"""
    subs = list_subscriptions()
    return {
        "public_key": public_key_b64(),     # 公開鍵は出してよい（画面が使う）
        "subscriptions": len(subs),
        "key_stored": bool(os.getenv("VAPID_PRIVATE_KEY")) or _key_in_vault(),
    }


def _key_in_vault() -> bool:
    try:
        import keychain
        return bool(keychain.get_key(VAPID_KEY_NAME))
    except Exception:
        return False


# ── 送る ─────────────────────────────────────────────────────────────

def send_one(sub: dict, payload: dict) -> dict:
    """1つの宛先へ送る。失効していたら、その購読を消す。"""
    if requests is None:
        return {"ok": False, "error": "requests が利用できません"}
    endpoint = sub.get("endpoint") or ""
    try:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")[:MAX_PAYLOAD]
        body = encrypt(raw, b64d(sub["p256dh"]), b64d(sub["auth"]))
        headers = {
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": "86400",
            "Urgency": "normal",
            **vapid_headers(endpoint),
        }
        r = requests.post(endpoint, data=body, headers=headers, timeout=TIMEOUT)
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}

    if r.status_code in (404, 410):
        # 端末が通知を切った／アプリを消した。持っていても二度と届かない
        unsubscribe(endpoint)
        return {"ok": False, "gone": True, "status": r.status_code}
    if r.status_code >= 400:
        return {"ok": False, "status": r.status_code, "error": (r.text or "")[:200]}
    return {"ok": True, "status": r.status_code}


def send(title: str, body: str = "", **extra) -> dict:
    """登録済みの端末ぜんぶへ送る。

    届かなくても例外にしない——通知は「おまけ」なので、これが原因で
    本体の処理が止まるのがいちばん困る。
    """
    subs = list_subscriptions()
    if not subs:
        return {"ok": False, "skipped": True, "reason": "通知を受け取る端末がまだありません"}

    payload = {"title": (title or "AIbou")[:120], "body": (body or "")[:400], **extra}
    results = [send_one(s, payload) for s in subs]
    sent = [r for r in results if r.get("ok")]
    return {
        "ok": len(sent) > 0,
        "sent": len(sent),
        "total": len(results),
        "gone": len([r for r in results if r.get("gone")]),
        "results": results,
    }
