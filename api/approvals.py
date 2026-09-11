"""
approvals.py — 「人に聞いてから実行する」を、その場に居なくても回す。

いま何が起きているか
--------------------
取り返せない操作（メール送信・通知・副業の投入）は、承認モードを切って
いても必ず確認する（risk.py）。画面の前に居るときはそれでよい。

問題は**定期実行**のほう。`scheduler.tick()` は `agent.run_stream()` を
回して `phase == "final"` だけを見ている。承認が要る所へ来ると、
run_stream は `approval` を出して止まるので、final は来ない。つまり:

    深夜3時の定期実行がメールを送ろうとする
      → 承認待ちで止まる
      → 誰も見ていないので final は空のまま
      → 「⏰ 定期実行「…」」という中身の無い通知だけが残る
      → **待っていること自体が、誰にも伝わらない**

ここはその待ち行列。止まった用事を控えておき、通知で知らせて、
通知の上の「実行する／やめる」で答えられるようにする。

答える人をどう確かめるか
------------------------
通知を押したときの通信は、**サービスワーカーから**飛ぶ。そこにアプリの
ログイン情報は載らない（別の実行環境なので、画面が持っている鍵を
そのまま使えない）。

だから1件ごとに使い捨ての合言葉を作り、**暗号化された通知の中に入れて**
渡す。その端末でしか読めないので、合言葉を持っていること自体が
「その端末の持ち主である」ことの証明になる。合言葉は:

  ・1件につき1つ。他の件には使えない
  ・1回使ったら無効
  ・時間が経てば無効（既定 24時間）

保存先も一緒に控える
--------------------
実行するときは、**作られたときと同じ人の保存先**に戻す必要がある。
定期実行は人ごとに保存先を差し替えながら回っているので、ここを忘れると
別の人のDBに対して実行してしまう。
"""

import secrets
import time
import uuid
from typing import List, Optional

import config
import memstore

#: 待ち行列に置いておく時間（秒）。これを過ぎた物は実行しない。
#:
#: 古い承認をあとから通すのは危ない。「3日前の朝に送るはずだったメール」を
#: いま送っても、たいてい状況が変わっている。
TTL = 24 * 3600

#: 一度に持っておく件数の上限（古いものから落とす）。
MAX_PENDING = 50

_mem = memstore.TenantList()


def _now() -> float:
    return time.time()


def _rows() -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            rows = c.table("approvals").select("*").order("created_at", desc=True) \
                    .limit(MAX_PENDING * 2).execute().data
            if rows is not None:
                return rows
        except Exception:
            pass
    return list(_mem)


def _save(row: dict) -> str:
    """どこに入れたかを返す（"db" / "memory"）。"""
    _mem.append(row)
    while len(_mem) > MAX_PENDING:
        del _mem[0]
    c = config.get_supabase()
    if c:
        try:
            c.table("approvals").insert(row).execute()
            return "db"
        except Exception:
            pass
    return "memory"


def _update(approval_id: str, patch: dict) -> None:
    for i in range(len(_mem)):
        if (_mem[i] or {}).get("id") == approval_id:
            _mem[i] = {**_mem[i], **patch}
            break
    c = config.get_supabase()
    if c:
        try:
            c.table("approvals").update(patch).eq("id", approval_id).execute()
        except Exception:
            pass


def create(tool: str, params: dict, *, note: str = "", source: str = "",
           user_id: str = "", why: str = "") -> dict:
    """止まった用事を1件控える。

    返り値の `token` は**通知にだけ**載せる。一覧や画面には出さない
    （出すと、画面を覗ける人が誰でも実行できてしまう）。
    """
    row = {
        "id": str(uuid.uuid4()),
        "tool": (tool or "").strip(),
        "params": params or {},
        "note": (note or "")[:400],
        "why": (why or "")[:200],
        "source": (source or "")[:80],     # どこから来たか（定期実行など）
        "user_id": (user_id or "")[:120],  # 実行するときに戻る保存先
        "token": secrets.token_urlsafe(32),
        "status": "pending",
        "created_at": _now(),
    }
    stored = _save(row)
    return {**row, "stored": stored}


def get(approval_id: str) -> Optional[dict]:
    for r in _rows():
        if (r or {}).get("id") == approval_id:
            return r
    return None


def list_pending() -> List[dict]:
    """待っている物。**合言葉は外して**返す（画面に出る）。"""
    now = _now()
    out = []
    for r in _rows():
        if (r or {}).get("status") != "pending":
            continue
        if now - float(r.get("created_at") or 0) > TTL:
            continue
        out.append({k: v for k, v in r.items() if k != "token"})
    return out


def expire_old() -> int:
    """時間切れに印を付ける。いくつ落としたかを返す。"""
    now = _now()
    n = 0
    for r in _rows():
        if (r or {}).get("status") == "pending" \
                and now - float(r.get("created_at") or 0) > TTL:
            _update(r["id"], {"status": "expired"})
            n += 1
    return n


def _same_token(want: str, got: str) -> bool:
    """合言葉を、時間の差が出ない形で比べる。

    byte に直してから比べるのが肝。`compare_digest` に str を渡すと、
    ASCII 以外が入っていたときに**例外になる**（False ではなく）。
    そのまま外に出ると、でたらめな合言葉を送っただけで 500 が返り、
    「合っていないこと」と「壊れたこと」を外から見分けられてしまう。
    """
    if not want:
        return False
    try:
        return secrets.compare_digest(want.encode("utf-8"), got.encode("utf-8"))
    except Exception:
        return False


def _ready(approval_id: str):
    """答えられる状態か。 (row, 断りの返事)。row が None なら断る。"""
    row = get(approval_id)
    if not row:
        return None, {"ok": False, "error": "その承認は見つかりません（もう処理済みかもしれません）"}
    if row.get("status") != "pending":
        # 二重に押されたとき。エラーにせず、いまの状態を返す
        return None, {"ok": True, "already": True, "status": row.get("status")}
    if _now() - float(row.get("created_at") or 0) > TTL:
        _update(approval_id, {"status": "expired"})
        return None, {"ok": False, "error": "時間が経ちすぎているため実行しませんでした"}
    return row, None


def answer(approval_id: str, decision: str, token: str = "") -> dict:
    """**通知から**答える。

    サービスワーカーにはログイン情報が渡らないので、確かめるのは
    合言葉だけ——ただし1件ごと・1回きり・期限つき。合言葉は暗号化された
    通知の中にしか無いので、持っていること自体が持ち主である証拠になる。
    """
    row, refuse = _ready(approval_id)
    if refuse:
        return refuse

    if not _same_token(str(row.get("token") or ""), str(token or "")):
        # 合言葉が合わない。何が違うかは言わない
        return {"ok": False, "error": "この承認には答えられません"}
    return _apply(row, decision)


def answer_signed_in(approval_id: str, decision: str) -> dict:
    """**アプリの画面から**答える。

    合言葉は要らない。こちらはログイン済みの画面から来るので、
    「誰か」はもう分かっている（合言葉は、ログイン情報を持てない
    サービスワーカーのための代わりの手段）。

    呼ぶ側（main.py）で必ずログインを求めること。ここでは求めない
    ——それをすると、認証の判断が2か所に散る。
    """
    row, refuse = _ready(approval_id)
    if refuse:
        return refuse
    return _apply(row, decision)


def _apply(row: dict, decision: str) -> dict:
    """決まったことを実行する（確認は済んでいる前提）。"""
    approval_id = row["id"]
    if decision not in ("approve", "reject"):
        return {"ok": False, "error": "approve か reject を指定してください"}

    if decision == "reject":
        _update(approval_id, {"status": "rejected", "token": ""})
        return {"ok": True, "status": "rejected"}

    # 実行する。**作られたときと同じ人の保存先**に戻してから。
    # ここを忘れると、別の人のDBに対して実行してしまう。
    bound = None
    try:
        uid = (row.get("user_id") or "").strip()
        if uid:
            import tenancy
            client = tenancy.client_for(uid)
            if client is not None:
                bound = config.bind_request_client(client)
        import tools
        result = tools.execute_tool(row.get("tool") or "", row.get("params") or {})
    except Exception as e:
        _update(approval_id, {"status": "failed", "result": str(e)[:400], "token": ""})
        return {"ok": False, "error": f"実行に失敗しました: {e}"}
    finally:
        if bound is not None:
            config.reset_request_client(bound)

    _update(approval_id, {"status": "done", "result": str(result)[:800], "token": ""})
    return {"ok": True, "status": "done", "result": result}


def ask(tool: str, params: dict, *, note: str = "", source: str = "",
        user_id: str = "", why: str = "", answer_url: str = "") -> dict:
    """控えて、通知する。止まった用事から呼ぶのはこれ1つ。

    通知が飛ばなくても控えは残す（アプリを開けば一覧に出る）。
    「通知が届かなかったから、待っていたことすら分からない」を作らない。
    """
    row = create(tool, params, note=note, source=source, user_id=user_id, why=why)
    body = note or f"{tool} を実行してよいか確認しています"
    try:
        import webpush
        webpush.send(
            "確認してください", body[:180],
            kind="approval", id=row["id"], token=row["token"],
            answer_url=answer_url, url="/",
        )
    except Exception:
        pass
    return row
