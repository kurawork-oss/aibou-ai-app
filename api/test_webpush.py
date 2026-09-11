"""
Web Push の検証。

ここで見ているもの
------------------
暗号は「だいたい合っている」が無い。1バイト違えば、相手のブラウザは
黙って捨てる——エラーも返らないので、実機で試しても原因が分からない。
だから**外の実装と突き合わせた結果**を、そのまま定数として置いてある。

下の EXPECTED は、RFC 8291 §5 の鍵と salt を使って作った本文で、
参照実装（http_ece 1.2.1）が出す物と**バイト単位で一致**することを
確認したうえで貼っている。手順を1つでも間違えると、ここが落ちる。

  ・鍵の作り方（auth_secret で抽出 → "WebPush: info" で展開）
  ・並び（salt16 | rs4 | idlen1 | 送り主の公開鍵65 | 暗号文）
  ・平文の終わりの印（0x02）

確かめていないこと
------------------
**本物の push サービス（FCM等）へは送っていない。** 実機のブラウザで
作った購読がここには無く、作れないため。ここで担保できるのは
「正しい形の物を作れている」ところまで。
"""

import os
import time

import pytest

import webpush as w


# RFC 8291 §5 の例に出てくる、公開されている検算用の鍵
UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
AUTH = "BTBZMqHH6r4Tts7J_aSIgg"
AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
SALT = "DGv6ra1nlYgDOPHLmdOQEw"
PLAINTEXT = b"When I grow up, I want to be a watermelon"

#: 上の材料から出るべき本文。参照実装と一致することを確認済み。
EXPECTED = (
    "DGv6ra1nlYgDOPHLmdOQEwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8ABcH6_ZN9UzSj"
    "z-gvxxzVNjLwDxwHIuuJCpTInSJkQGJIcRJv80oBdigODS0grTVBlC1R49lvswcf"
)


def test_仕様書の例と1バイトも違わない():
    block = w.encrypt(PLAINTEXT, w.b64d(UA_PUBLIC), w.b64d(AUTH),
                      as_key=w._load_private_key(w.b64d(AS_PRIVATE)),
                      salt=w.b64d(SALT))
    assert w.b64e(block) == EXPECTED


def test_並びが仕様どおり():
    """先頭の86バイトの意味が決まっている（RFC 8188 §2.1）。

    ここがずれると、ブラウザは中身を見る前に捨てる。
    """
    import struct
    block = w.encrypt(PLAINTEXT, w.b64d(UA_PUBLIC), w.b64d(AUTH),
                      as_key=w._load_private_key(w.b64d(AS_PRIVATE)),
                      salt=w.b64d(SALT))
    assert block[:16] == w.b64d(SALT)
    assert struct.unpack("!I", block[16:20])[0] == 4096
    assert block[20] == 65
    assert block[21:86] == w.b64d(AS_PUBLIC)
    # 平文 + 終わりの印1 + GCMのタグ16
    assert len(block) - 86 == len(PLAINTEXT) + 1 + 16


def test_受け手の手順で戻せる():
    ua = w._load_private_key(w.b64d(UA_PRIVATE))
    block = w.encrypt(PLAINTEXT, w.b64d(UA_PUBLIC), w.b64d(AUTH))
    assert w.decrypt(block, ua, w.b64d(AUTH)) == PLAINTEXT


def test_毎回ちがう鍵とsaltになる():
    """同じ鍵と nonce で2回暗号化すると、AES-GCM では中身が割れる。

    使い回しは「動くけれど危ない」形なので、必ずここで見る。
    """
    seen_salt, seen_key = set(), set()
    for _ in range(12):
        block = w.encrypt(b"x", w.b64d(UA_PUBLIC), w.b64d(AUTH))
        seen_salt.add(block[:16])
        seen_key.add(block[21:86])
    assert len(seen_salt) == 12, "salt を使い回している"
    assert len(seen_key) == 12, "送り主の鍵を使い回している"


def test_日本語も長い本文も通る():
    ua = w._load_private_key(w.b64d(UA_PRIVATE))
    msg = ("承認が必要な操作があります。メールの送信先は a@example.com です。" * 20).encode()
    block = w.encrypt(msg, w.b64d(UA_PUBLIC), w.b64d(AUTH))
    assert w.decrypt(block, ua, w.b64d(AUTH)) == msg


# ── VAPID（送り主の署名）────────────────────────────────────────────

def test_署名が公開鍵で検証できる():
    """こちらが出す Authorization を、受け取る側と同じ手順で検算する。"""
    import jwt
    from cryptography.hazmat.primitives.asymmetric import ec

    head = w.vapid_headers("https://fcm.googleapis.com/fcm/send/abc123?x=1")
    assert head["Authorization"].startswith("vapid t=")
    token = head["Authorization"].split("t=")[1].split(",")[0]
    kb64 = head["Authorization"].split("k=")[1]

    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), w.b64d(kb64))
    claims = jwt.decode(token, pub, algorithms=["ES256"],
                        audience="https://fcm.googleapis.com")
    # aud は「スキーム＋ホスト」だけ。パスを入れると push サービスが弾く
    assert claims["aud"] == "https://fcm.googleapis.com"
    assert claims["sub"].startswith(("mailto:", "https:"))
    # 24時間を超える有効期限は受け付けられない
    assert 0 < claims["exp"] - time.time() <= 24 * 3600


def test_宛先ごとにaudが変わる():
    a = w.vapid_headers("https://fcm.googleapis.com/fcm/send/x")
    b = w.vapid_headers("https://updates.push.services.mozilla.com/wpush/v2/y")
    assert a["Authorization"] != b["Authorization"]


def test_公開鍵は65バイトの非圧縮形式():
    raw = w.b64d(w.public_key_b64())
    assert len(raw) == 65 and raw[0] == 0x04


# ── 購読の出し入れ ───────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clean():
    w._mem_subs.clear()
    yield
    w._mem_subs.clear()


def test_同じ端末を2回登録しても1つ():
    sub = {"endpoint": "https://push.example/aaa",
           "keys": {"p256dh": UA_PUBLIC, "auth": AUTH}}
    w.subscribe(sub)
    w.subscribe(sub)
    assert len(w.list_subscriptions()) == 1


def test_形が足りない購読はことわる():
    for bad in [{}, {"endpoint": "x"}, {"endpoint": "x", "keys": {}},
                {"endpoint": "x", "keys": {"p256dh": "a"}}]:
        res = w.subscribe(bad)
        assert res["ok"] is False and res["error"]


def test_解除すると消える():
    w.subscribe({"endpoint": "https://push.example/bbb",
                 "keys": {"p256dh": UA_PUBLIC, "auth": AUTH}})
    assert w.unsubscribe("https://push.example/bbb")["ok"] is True
    assert w.list_subscriptions() == []


def test_端末が無いときは送らずにそう言う():
    res = w.send("お知らせ", "本文")
    assert res["ok"] is False and res["skipped"] is True
    assert "端末" in res["reason"]


def test_失効した購読は自動で捨てる(monkeypatch):
    """404/410 は「もう届かない」の意味。持ち続けると毎回無駄に叩く。"""
    w.subscribe({"endpoint": "https://push.example/gone",
                 "keys": {"p256dh": UA_PUBLIC, "auth": AUTH}})

    class Resp:
        status_code = 410
        text = ""

    monkeypatch.setattr(w.requests, "post", lambda *a, **k: Resp())
    res = w.send("題", "本文")
    assert res["ok"] is False and res["gone"] == 1
    assert w.list_subscriptions() == [], "失効した購読が残っている"


def test_送信に失敗しても例外にしない(monkeypatch):
    """通知はおまけ。ここで落ちて本体の処理が止まるのがいちばん困る。"""
    w.subscribe({"endpoint": "https://push.example/err",
                 "keys": {"p256dh": UA_PUBLIC, "auth": AUTH}})

    def boom(*a, **k):
        raise RuntimeError("ネットワークが落ちている")

    monkeypatch.setattr(w.requests, "post", boom)
    res = w.send("題", "本文")
    assert res["ok"] is False
    assert w.list_subscriptions() != [], "通信の失敗で購読を捨てている"


def test_状態に秘密の鍵を出さない():
    """/diagnose にも画面にも出る所。公開鍵はよいが、署名鍵は出さない。"""
    st = w.status()
    secret = w.b64e(w._private_bytes(w.vapid_key()))
    import json
    assert secret not in json.dumps(st)
    assert st["public_key"] == w.public_key_b64()


def test_大きすぎる本文は切る(monkeypatch):
    """push サービスの上限（だいたい4KB）を超えると、まるごと拒否される。"""
    w.subscribe({"endpoint": "https://push.example/big",
                 "keys": {"p256dh": UA_PUBLIC, "auth": AUTH}})
    sizes = []

    class Resp:
        status_code = 201
        text = ""

    def capture(url, data=None, headers=None, timeout=None):
        sizes.append(len(data))
        return Resp()

    monkeypatch.setattr(w.requests, "post", capture)
    w.send("題", "あ" * 5000)
    assert sizes and sizes[0] < 4096, f"本文が {sizes[0]} byte ある"


# ── エンドポイント ───────────────────────────────────────────────────

def test_公開鍵は認証なしで取れる():
    """ログイン前の画面からも「通知を使えるか」を出せるようにする。

    公開鍵は秘密ではない（購読を作るのに、そもそも相手へ渡す物）。
    ここを閉じると、設定画面が開く前に何も言えなくなる。
    """
    from fastapi.testclient import TestClient
    from main import app

    r = TestClient(app).get("/push/key")
    assert r.status_code == 200
    raw = w.b64d(r.json()["key"])
    assert len(raw) == 65 and raw[0] == 0x04


def test_購読の登録と解除がエンドポイント越しに通る():
    from fastapi.testclient import TestClient
    from main import app

    c = TestClient(app)
    sub = {"endpoint": "https://push.example/ep1",
           "keys": {"p256dh": UA_PUBLIC, "auth": AUTH}}
    assert c.post("/push/subscribe", json=sub).json()["ok"] is True
    assert c.get("/push/status").json()["subscriptions"] >= 1
    assert c.post("/push/unsubscribe", json={"endpoint": sub["endpoint"]}).json()["ok"] is True


def test_壊れた購読はエンドポイントでも断る():
    from fastapi.testclient import TestClient
    from main import app

    r = TestClient(app).post("/push/subscribe", json={"endpoint": "x"})
    assert r.json()["ok"] is False


def test_通知の経路に押し込まれている(monkeypatch):
    """既にある通知（定期実行の結果など）が、そのまま端末へ届くこと。

    ここが繋がっていないと、せっかく作った道に誰も乗らない。
    """
    import notify

    w.subscribe({"endpoint": "https://push.example/route",
                 "keys": {"p256dh": UA_PUBLIC, "auth": AUTH}})

    class Resp:
        status_code = 201
        text = ""

    hits = []
    monkeypatch.setattr(w.requests, "post",
                        lambda url, **k: hits.append(url) or Resp())
    res = notify.notify_all("要約ができました\n本文です")
    channels = [r.get("channel") for r in res["results"]]
    assert "push" in channels
    assert hits == ["https://push.example/route"]
