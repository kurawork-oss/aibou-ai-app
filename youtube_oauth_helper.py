#!/usr/bin/env python3
# youtube_oauth_helper.py — YouTube の refresh token を取得するローカル用ヘルパー
# =================================================================
# YouTube公式アップロードの最難関「refresh token」を、手元で一度だけ取得するための補助。
# （これはアプリ/Actionsでは動かさない。あなたのPCで1回実行するだけ。）
#
# 手順:
#   1) Google Cloud Console で OAuth クライアントID（種類: デスクトップ アプリ）を作成。
#   2) その client_id / client_secret を環境変数に設定：
#        export YT_CLIENT_ID="..."   export YT_CLIENT_SECRET="..."
#   3) このスクリプトを実行：  python youtube_oauth_helper.py
#      ブラウザが開くので、投稿先のGoogleアカウントで承認する。
#   4) 表示された refresh token を、アプリの Settings → Secure Vault →
#      「YouTube refresh token」に貼り付けて保存する。
# =================================================================

import os
import sys

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]


def main():
    cid = os.environ.get("YT_CLIENT_ID", "").strip()
    csec = os.environ.get("YT_CLIENT_SECRET", "").strip()
    if not (cid and csec):
        print("❌ 環境変数 YT_CLIENT_ID / YT_CLIENT_SECRET を設定してください。")
        return 1
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except Exception:
        print("❌ google-auth-oauthlib が必要です:  pip install google-auth-oauthlib")
        return 1

    client_config = {
        "installed": {
            "client_id": cid,
            "client_secret": csec,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }
    try:
        flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
        creds = flow.run_local_server(port=0)
    except Exception as e:
        print(f"❌ 認証フローに失敗しました: {e}")
        return 1

    if not creds.refresh_token:
        print("⚠️ refresh_token が取得できませんでした。Google側の権限同意画面で"
              "「同意」して再実行してください（既に承認済みの場合は一度アクセス権を解除）。")
        return 1

    print("\n=== ✅ あなたの YT_REFRESH_TOKEN ===")
    print(creds.refresh_token)
    print("====================================")
    print("これを Settings → Secure Vault →「YouTube refresh token」に保存してください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
