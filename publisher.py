# publisher.py — AIbou 配信レイヤ（Phase 2 / GitHub Actions 側で実行）
# =================================================================
# 承認済み(approved)ジョブを各プラットフォームへ配信する。重い処理・外部I/Oを
# 常駐Streamlitから分離し、GitHub Actions などのバッチ側で実行する想定。
#
# 【コンプライアンス方針（厳守）】
#   - 公式手段のみを使う：YouTube Data API v3 / Shutterstock 公式コントリビューターFTPS。
#   - note は「非公式API自動投稿」も「ボット検知回避(BAN回避)」も実装しない。
#     代わりに記事Markdown＋アイキャッチ画像を生成して “下書きパッケージ” を出力し、
#     最後の投稿だけ人間がワンタップで行う（規約準拠の代替）。
#   - 認証情報・アセットが無い配信先は必ず "skipped" を返し、勝手な外部送信はしない。
#
# すべての関数は絶対にraiseしない（結果dictかskippedを返す）。
# =================================================================

import os
import io
import json
import time
import datetime

try:
    import requests
except Exception:
    requests = None

try:
    import asset_engine
    ASSET_AVAILABLE = True
except Exception:
    ASSET_AVAILABLE = False


# === 外部サービス注入（任意） ===============================================
_SERVICES = {}


def register_services(**kwargs):
    """supabase / set_status(income_engine) などを注入できる（任意）。"""
    _SERVICES.update(kwargs)


def _secret(*names):
    """環境変数 → 注入されたcreds dict の順でキーを探す。"""
    for n in names:
        if os.environ.get(n):
            return os.environ[n]
    creds = _SERVICES.get("creds") or {}
    for n in names:
        if creds.get(n):
            return creds[n]
    return ""


# === 信頼性：ネットワーク呼び出しの指数バックオフ・リトライ（要件§3.1） =====
RETRY_DELAYS = [5, 10, 20, 40, 60]


def with_retry(fn, max_attempts=5, label="task"):
    """fn() を実行し、例外が出たら指数バックオフで再試行する。
    returns: (ok: bool, result_or_error)。"""
    last = None
    for attempt in range(max_attempts):
        try:
            return True, fn()
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
            if attempt < max_attempts - 1:
                time.sleep(RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)])
    return False, f"❌ {label} が{max_attempts}回失敗しました: {last}"


# === Discord 通知（任意） ===================================================
def notify(message):
    url = _secret("DISCORD_WEBHOOK", "discord_webhook")
    if not url or requests is None:
        return False
    try:
        requests.post(url, json={"content": message[:1900]}, timeout=30)
        return True
    except Exception:
        return False


# === note：規約準拠の“下書きパッケージ”生成（自動投稿はしない） =============
def prepare_note_draft(job, out_dir="drafts"):
    """note記事のMarkdown＋アイキャッチ画像を出力する。投稿は人間が手動で行う。"""
    payload = job.get("payload", {}) or {}
    note = payload.get("note", {}) or {}
    title = note.get("title") or job.get("theme") or "untitled"
    md = note.get("markdown") or ""
    if not md:
        return {"platform": "note", "status": "skipped", "reason": "note本文が未生成です。"}
    try:
        os.makedirs(out_dir, exist_ok=True)
        safe = "".join(c for c in title if c.isalnum() or c in " 　-_")[:40].strip() or "note"
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        base = os.path.join(out_dir, f"{stamp}_{safe}")
        md_path = base + ".md"
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(f"# {title}\n\n{md}\n")
        img_path = None
        if ASSET_AVAILABLE:
            png = asset_engine.generate_thumbnail(title, subtitle="note eyecatch")
            if png:
                img_path = base + "_eyecatch.png"
                with open(img_path, "wb") as f:
                    f.write(png)
        return {"platform": "note", "status": "draft_ready",
                "markdown_path": md_path, "eyecatch_path": img_path,
                "note": "規約準拠：自動投稿はしません。生成された下書きを手動で投稿してください。"}
    except Exception as e:
        return {"platform": "note", "status": "error", "reason": str(e)}


# === YouTube Data API v3：本人コンテンツの公式アップロード ===================
def publish_youtube(job, video_path=None):
    """YouTube公式APIで動画をアップロードする。creds/動画が無ければ skipped。"""
    cid = _secret("YT_CLIENT_ID", "youtube_client_id")
    csec = _secret("YT_CLIENT_SECRET", "youtube_client_secret")
    rtok = _secret("YT_REFRESH_TOKEN", "youtube_refresh_token")
    if not (cid and csec and rtok):
        return {"platform": "youtube", "status": "skipped", "reason": "YouTube OAuth認証情報が未設定です。"}
    if not (video_path and os.path.exists(video_path)):
        return {"platform": "youtube", "status": "skipped",
                "reason": "アップロードする動画ファイルがありません（動画レンダリングは別工程）。"}
    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
    except Exception:
        return {"platform": "youtube", "status": "skipped",
                "reason": "google-api-python-client が未インストールです。"}

    payload = job.get("payload", {}) or {}
    yt = payload.get("youtube", {}) or {}

    def _do():
        creds = Credentials(
            token=None, refresh_token=rtok, client_id=cid, client_secret=csec,
            token_uri="https://oauth2.googleapis.com/token",
            scopes=["https://www.googleapis.com/auth/youtube.upload"],
        )
        youtube = build("youtube", "v3", credentials=creds)
        body = {
            "snippet": {
                "title": (yt.get("title") or job.get("theme") or "Untitled")[:100],
                "description": (yt.get("description") or "") + "\n\n" + " ".join(yt.get("hashtags", []) or []),
                "tags": [h.lstrip("#") for h in (yt.get("hashtags", []) or [])][:15],
                "categoryId": "22",
            },
            "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False},
        }
        media = MediaFileUpload(video_path, chunksize=-1, resumable=True)
        req = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
        resp = req.execute()
        return resp.get("id")

    ok, res = with_retry(_do, label="YouTube upload")
    if ok:
        return {"platform": "youtube", "status": "published", "video_id": res,
                "url": f"https://youtu.be/{res}"}
    return {"platform": "youtube", "status": "error", "reason": res}


# === Shutterstock：公式コントリビューターFTPS アップロード ===================
def publish_shutterstock(job, image_paths=None):
    """Shutterstock公式FTPSへ素材をアップロードする。creds/画像が無ければ skipped。
    ※ タイトル/タグ(メタデータ)はアップロード後にコントリビューター管理画面で紐付ける運用。"""
    host = _secret("SS_FTP_HOST", "shutterstock_ftp_host")
    user = _secret("SS_FTP_USER", "shutterstock_ftp_user")
    pw = _secret("SS_FTP_PASS", "shutterstock_ftp_pass")
    if not (host and user and pw):
        return {"platform": "shutterstock", "status": "skipped", "reason": "Shutterstock FTP認証情報が未設定です。"}
    image_paths = [p for p in (image_paths or []) if p and os.path.exists(p)]
    if not image_paths:
        return {"platform": "shutterstock", "status": "skipped", "reason": "アップロードする画像がありません。"}
    try:
        from ftplib import FTP_TLS
    except Exception:
        return {"platform": "shutterstock", "status": "skipped", "reason": "ftplib が利用できません。"}

    def _do():
        uploaded = []
        ftps = FTP_TLS(host)
        ftps.login(user, pw)
        ftps.prot_p()
        try:
            for p in image_paths:
                with open(p, "rb") as f:
                    ftps.storbinary(f"STOR {os.path.basename(p)}", f)
                uploaded.append(os.path.basename(p))
        finally:
            try:
                ftps.quit()
            except Exception:
                pass
        return uploaded

    ok, res = with_retry(_do, label="Shutterstock FTP")
    if ok:
        return {"platform": "shutterstock", "status": "published", "uploaded": res}
    return {"platform": "shutterstock", "status": "error", "reason": res}


# === ディスパッチャ ==========================================================
def publish_job(job, assets=None):
    """1ジョブを各プラットフォームへ配信し、結果を集約して返す。
    assets = {"video": path, "images": [path, ...]}（無ければ各配信は安全にskip）。
    income_engine.set_status が注入されていれば、成功時に completed へ更新する。"""
    assets = assets or {}
    if not isinstance(job, dict) or not job.get("id"):
        return {"status": "error", "reason": "ジョブが不正です。"}
    if job.get("status") == "completed":
        return {"status": "skipped", "reason": "既に完了済み（冪等性）。", "job_id": job["id"]}

    results = []
    results.append(prepare_note_draft(job))
    results.append(publish_youtube(job, video_path=assets.get("video")))
    results.append(publish_shutterstock(job, image_paths=assets.get("images")))

    published = [r for r in results if r.get("status") == "published"]
    errored = [r for r in results if r.get("status") == "error"]

    # 公式アップロードが1つでも成功したら completed に。それ以外は approved のまま据え置く。
    new_status = "completed" if published else None
    log = "; ".join(f"{r['platform']}:{r['status']}" for r in results)

    set_status = _SERVICES.get("set_status")
    if new_status and callable(set_status):
        try:
            set_status(job["id"], new_status, log=log)
        except Exception:
            pass

    theme = job.get("theme", "")
    if published:
        notify(f"✅ 配信完了: {theme}\n{log}")
    elif errored:
        notify(f"⚠️ 配信エラー: {theme}\n{log}")

    return {"status": new_status or "pending_manual", "job_id": job["id"],
            "results": results, "log": log}
