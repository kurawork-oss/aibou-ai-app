#!/usr/bin/env python3
# scripts/morning_briefing.py — 朝のブリーフィングcron（headless / GitHub Actions）
# =================================================================
# 毎朝 07:00 JST に GitHub Actions の cron から実行する headless スクリプト。
# api/proactive.build_briefing() でブリーフィング本文を作り、
#   * DISCORD_WEBHOOK が設定されていれば Discord に投稿
#   * 標準出力にも必ず表示（Actionsログ / ローカル確認用）
# する。Supabase / Gemini が未設定でも build_briefing() は最低限の挨拶を返すため、
# このスクリプトも crash しない。
#
# 必要な環境変数（GitHub Secrets で設定）:
#   GEMINI_API_KEY          ブリーフィングを秘書口調にまとめる（無くても可）
#   SUPABASE_URL            承認待ち件数・記憶ハイライトの取得（無くても可）
#   SUPABASE_SERVICE_KEY    同上
# 任意:
#   DISCORD_WEBHOOK         ブリーフィングの通知先
# =================================================================

import os
import sys

# リポジトリ root と api/ を import パスに追加（proactive などを読むため）
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_API_DIR = os.path.join(_REPO_ROOT, "api")
for _p in (_REPO_ROOT, _API_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import proactive


def _notify_discord(message: str) -> None:
    """DISCORD_WEBHOOK があれば Discord に投稿する（best-effort・失敗しても無視）。"""
    url = os.environ.get("DISCORD_WEBHOOK", "").strip()
    if not url:
        return
    try:
        import requests
        # Discord の content は 2000 文字上限。安全側で 1900 に切る。
        requests.post(url, json={"content": message[:1900]}, timeout=30)
    except Exception as e:
        print(f"[warn] Discord通知に失敗: {e}")


def main() -> int:
    briefing = proactive.build_briefing()

    # 標準出力には必ず表示（Actionsログ / ローカル実行）
    print(briefing)

    _notify_discord(briefing)
    return 0


if __name__ == "__main__":
    sys.exit(main())
