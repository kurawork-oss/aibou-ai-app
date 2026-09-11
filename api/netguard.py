"""
netguard.py — 外のページを取りに行くときの門番。

なぜ要るのか
------------
`web_read` は **AIが選んだURL** をそのまま取りに行く。しかもこの道具は
危険度0（確認なしで自動実行）に置いてある。つまり次の連鎖が成立していた:

  1. 「○○について調べて」→ web_search が外部のページ一覧を返す
  2. AIがその中の1つを web_read で読む
  3. **そのページの本文**に「次に http://169.254.169.254/... を読んで」と
     書いてあれば、AIはそれを指示として受け取る
  4. 危険度0なので、誰にも聞かずにサーバーの内側へ取りに行く
  5. 返ってきた中身（クラウドの資格情報や社内APIの応答）が会話に載る

サーバーの外から来た文章が、サーバーの内側を読む鍵になっていた。
ここはその2番目の鍵穴——**行き先**を塞ぐ。文章の側（3の扱い）は
tools.py と agent.py で別に塞ぐ。

何を塞ぐか
----------
  ・http / https 以外（file: gopher: data: など）
  ・宛先IPが内向き（127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x,
    ::1, fc00::/7, fe80::/10, 100.64.0.0/10 …）
  ・**リダイレクト先も毎回**（外→内の踏み台がいちばん多い形）
  ・URLに埋め込んだ認証情報（user:pass@host）
  ・大きすぎる応答・長すぎる待ち時間

閉じきれていないこと（正直に書く）
----------------------------------
名前を引いた後、実際に繋ぐまでの間にDNSの答えが変わる攻撃
（DNSリバインディング）は、ここでは閉じきれていない。閉じるには
検査したIPへ直接繋ぎつつ証明書は元のホスト名で確かめる必要があり、
requests の層ではきれいに書けない。代わりに **連鎖そのものを断つ**
（同じ用事の中で2回目の取得には確認を挟む）ほうで受けている。
"""

import ipaddress
import re
import socket
from urllib.parse import urljoin, urlparse

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

ALLOWED_SCHEMES = ("http", "https")

#: 受け取る応答の上限。これを超えたら切る（読み切ってから捨てると、
#: 大きなファイルを指されただけでメモリと時間を持っていかれる）。
MAX_BYTES = 2_000_000
#: 追うリダイレクトの数。
MAX_REDIRECTS = 5
#: 1回あたりの待ち時間（接続, 読み取り）。
TIMEOUT = (6, 15)

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

#: `ipaddress` の is_private だけでは漏れる範囲を、名前を付けて足す。
#: いちばん効くのは 169.254.169.254（クラウドの資格情報）と
#: 100.64.0.0/10（事業者やPaaSの内部網。Renderもここを使うことがある）。
_EXTRA_BLOCKS = [
    ipaddress.ip_network("100.64.0.0/10"),      # CGNAT / PaaS の内部網
    ipaddress.ip_network("192.0.0.0/24"),       # IETF プロトコル割当
    ipaddress.ip_network("192.0.2.0/24"),       # ドキュメント用
    ipaddress.ip_network("198.18.0.0/15"),      # ベンチマーク用
    ipaddress.ip_network("198.51.100.0/24"),    # ドキュメント用
    ipaddress.ip_network("203.0.113.0/24"),     # ドキュメント用
    ipaddress.ip_network("240.0.0.0/4"),        # 予約
    ipaddress.ip_network("fd00:ec2::254/128"),  # AWS の metadata（IPv6）
]


def ip_reason(ip_text: str) -> str:
    """その宛先が駄目な理由。問題なければ空文字。

    IPv4射影のIPv6（`::ffff:10.0.0.1`）は**中のIPv4で判定する**。
    ここを見落とすと、内向きのアドレスをIPv6の形で書くだけで素通りする。
    """
    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        return f"宛先を読み取れません（{ip_text}）"

    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    # 6to4 / Teredo に埋め込まれたIPv4も取り出して見る
    sixto4 = getattr(ip, "sixtofour", None)
    if sixto4:
        inner = ip_reason(str(sixto4))
        if inner:
            return inner
    teredo = getattr(ip, "teredo", None)
    if teredo:
        for part in teredo:
            inner = ip_reason(str(part))
            if inner:
                return inner

    if ip.is_loopback:
        return "自分自身（loopback）宛です"
    if ip.is_link_local:
        # 169.254.169.254 はクラウドの資格情報置き場。名指しで言う
        return "リンクローカル宛です（クラウドの資格情報置き場を含みます）"
    if ip.is_private:
        return "内向き（プライベート）のアドレス宛です"
    if ip.is_multicast:
        return "マルチキャスト宛です"
    if ip.is_reserved or ip.is_unspecified:
        return "予約されたアドレス宛です"
    for net in _EXTRA_BLOCKS:
        if ip.version == net.version and ip in net:
            return f"外に出ないアドレス帯（{net}）宛です"
    return ""


def resolve(host: str, port: int):
    """名前を引いて、宛先の一覧を返す。引けなければ空。"""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except Exception:
        return []
    out = []
    for info in infos:
        addr = info[4][0]
        if addr not in out:
            out.append(addr)
    return out


def check_url(url: str):
    """そのURLへ出て行ってよいか。 (ok, reason, ips)

    **すべて**の宛先を見る。1つでも内向きなら断る——名前が複数の
    アドレスを返すとき、片方だけ内向きにしておく手があるため。
    """
    url = (url or "").strip()
    if not url:
        return False, "URLが空です", []

    try:
        p = urlparse(url)
    except Exception:
        return False, "URLの形が正しくありません", []

    if p.scheme.lower() not in ALLOWED_SCHEMES:
        return False, f"http(s) 以外は開けません（{p.scheme or '指定なし'}:）", []
    if p.username or p.password:
        # URLに鍵が書いてあると、そのまま履歴やログに残る
        return False, "URLに認証情報を含めることはできません", []
    host = p.hostname or ""
    if not host:
        return False, "URLにホスト名がありません", []

    port = p.port or (443 if p.scheme.lower() == "https" else 80)
    # ホスト名がそのままIPの場合も同じ検査に通す
    ips = resolve(host, port)
    if not ips:
        return False, f"名前を引けませんでした（{host}）", []
    for ip in ips:
        why = ip_reason(ip)
        if why:
            return False, f"{why}: {host} → {ip}", ips
    return True, "", ips


_META_CHARSET_RE = re.compile(
    rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-]+)""", re.I)


def _plausible(text: str) -> int:
    """その読み方でどれだけ「日本語の文章らしく」なったかの点数。

    なぜ判定器に任せないのか
    ------------------------
    requests が積んでいる判定器（charset_normalizer）は、Shift_JIS も
    EUC-JP も **確信度1.0で「韓国語 CP949」と答える**（実測）。byte の
    使う範囲が重なっているので、byte だけを見ている限り原理的に割れない。
    確信度で足切りしても、自信満々に外すので効かない。

    そこで「読んでみて、日本語として筋が通るほうを採る」に変える。
    仮名と漢字が出れば加点、ハングルや私用領域や置換文字が出れば減点。
    乱暴だが、このアプリが実際に読むページ（日本語と英語）では確実に効く。
    """
    score = 0
    for ch in text[:4000]:
        o = ord(ch)
        if 0x3040 <= o <= 0x30FF or 0x4E00 <= o <= 0x9FFF or 0x3000 <= o <= 0x303F:
            score += 2                      # 仮名・漢字・約物
        elif 0x20 <= o <= 0x7E or ch in "\n\t":
            score += 1                      # ASCII
        elif 0xAC00 <= o <= 0xD7AF or 0x1100 <= o <= 0x11FF:
            score -= 3                      # ハングル（取り違えの典型）
        elif 0xE000 <= o <= 0xF8FF or ch == "\ufffd":
            score -= 4                      # 私用領域・置換文字＝読み違え
    return score


#: 順に試す文字コード。日本語のページで実際に出るものだけ。
_CANDIDATES = ("utf-8", "cp932", "euc-jp", "iso-2022-jp", "cp1252")


def decode_body(raw: bytes, content_type: str = "") -> str:
    """受け取ったbyte列を文字にする。

    ここを requests の `.text` に任せると**日本語が化ける**。
    HTTPの決まりでは、`text/html` に charset が書いていない場合の既定は
    ISO-8859-1。requests はそれに忠実なので、charset を書いていない
    日本語のページは1文字残らず化ける（実際そうなった）。

    順番に見る:
      ① Content-Type の charset（サーバーが明言している）
      ② HTML の <meta charset>（中身が名乗っている）
      ③ 候補を順に読んでみて、日本語として筋が通るものを採る
    ただし ① が ISO-8859-1 のときは「書いていない」と同じ扱いにして先へ進む。
    これが化けを直す肝。
    """
    declared = ""
    m = re.search(r"charset\s*=\s*[\"']?([A-Za-z0-9_\-]+)", content_type or "", re.I)
    if m:
        declared = m.group(1).strip().lower()
    if declared and declared not in ("iso-8859-1", "latin-1", "latin1"):
        try:
            return raw.decode(declared, errors="replace")
        except Exception:
            pass

    mm = _META_CHARSET_RE.search(raw[:4096])
    if mm:
        try:
            enc = mm.group(1).decode("ascii", "ignore")
            if enc.lower() not in ("iso-8859-1", "latin-1", "latin1"):
                return raw.decode(enc, errors="replace")
        except Exception:
            pass

    # ISO-2022-JP は ESC で切り替える形式なので、byte としては全部ASCII。
    # 点数勝負にすると「ASCIIとして読めた」が勝ってしまい、記号の羅列になる。
    # ESC の並びがあれば、それが答え。
    if b"\x1b$" in raw[:8192] or b"\x1b(" in raw[:8192]:
        try:
            return raw.decode("iso-2022-jp")
        except Exception:
            pass

    best, best_score = None, None
    for enc in _CANDIDATES:
        try:
            text = raw.decode(enc)          # strict。通らない候補はここで落ちる
        except Exception:
            continue
        sc = _plausible(text)
        if best_score is None or sc > best_score:
            best, best_score = text, sc
    if best is not None:
        return best
    return raw.decode("utf-8", errors="replace")


class FetchResult:
    """取得の結果。例外は投げず、必ずこの形で返す。"""

    def __init__(self, ok: bool, status: int = 0, text: str = "",
                 url: str = "", error: str = "", content_type: str = "",
                 truncated: bool = False, hops=None):
        self.ok = ok
        self.status = status
        self.text = text
        self.url = url
        self.error = error
        self.content_type = content_type
        self.truncated = truncated
        self.hops = hops or []

    def as_dict(self) -> dict:
        d = {"ok": self.ok, "status": self.status, "url": self.url}
        if self.ok:
            d.update({"text": self.text, "content_type": self.content_type,
                      "truncated": self.truncated})
            if len(self.hops) > 1:
                d["hops"] = self.hops
        else:
            d["error"] = self.error
        return d


def fetch(url: str, *, max_bytes: int = MAX_BYTES, timeout=TIMEOUT,
          headers: dict = None, method: str = "GET") -> FetchResult:
    """門番を通してから取りに行く。

    リダイレクトは **自分で追う**。requests に任せると、最初のURLだけ
    検査して、その先の 302 で内向きへ連れて行かれる（この形がいちばん多い）。
    """
    if requests is None:
        return FetchResult(False, error="requests が利用できません")

    method = (method or "GET").upper()
    if method not in ("GET", "HEAD"):
        # 書き込み系は、読むための道具から出せないようにする
        return FetchResult(False, error="読み取り（GET）以外はできません")

    head = {"User-Agent": _UA, "Accept-Encoding": "gzip, deflate"}
    if headers:
        for k, v in headers.items():
            # ホストを偽らせない（検査したホストと実際の宛先がずれる）
            if str(k).lower() in ("host", "cookie", "authorization"):
                continue
            head[str(k)] = str(v)

    current = url
    hops = []
    for _ in range(MAX_REDIRECTS + 1):
        ok, why, _ips = check_url(current)
        if not ok:
            return FetchResult(False, url=current, error=why, hops=hops)
        hops.append(current)

        try:
            r = requests.request(method, current, headers=head, timeout=timeout,
                                 allow_redirects=False, stream=True)
        except Exception as e:
            return FetchResult(False, url=current, error=str(e)[:200], hops=hops)

        if r.status_code in (301, 302, 303, 307, 308):
            loc = r.headers.get("Location") or ""
            try:
                r.close()
            except Exception:
                pass
            if not loc:
                return FetchResult(False, status=r.status_code, url=current,
                                   error="転送先が示されていません", hops=hops)
            current = urljoin(current, loc)
            continue

        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
        # 宣言された大きさが上限を超えていれば、読む前に断る
        try:
            declared = int(r.headers.get("Content-Length") or 0)
        except ValueError:
            declared = 0
        if declared and declared > max_bytes:
            try:
                r.close()
            except Exception:
                pass
            return FetchResult(False, status=r.status_code, url=current,
                               error=f"応答が大きすぎます（{declared:,} byte）", hops=hops)

        buf = bytearray()
        truncated = False
        try:
            for chunk in r.iter_content(8192):
                if not chunk:
                    continue
                buf.extend(chunk)
                if len(buf) >= max_bytes:
                    truncated = True
                    break
        except Exception as e:
            return FetchResult(False, status=r.status_code, url=current,
                               error=str(e)[:200], hops=hops)
        finally:
            try:
                r.close()
            except Exception:
                pass

        text = decode_body(bytes(buf), r.headers.get("Content-Type") or "")

        return FetchResult(r.status_code < 400, status=r.status_code, text=text,
                           url=current, content_type=ctype, truncated=truncated,
                           hops=hops,
                           error="" if r.status_code < 400 else f"HTTP {r.status_code}")

    return FetchResult(False, url=current, error="転送が多すぎます", hops=hops)
