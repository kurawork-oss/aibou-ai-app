#!/usr/bin/env python3
# scripts/run_publisher.py — 配信実行（承認済みジョブの配信／note下書き生成）
# =================================================================
# GitHub Actions の workflow_dispatch（★手動トリガーのみ★）から実行する想定。
# Supabaseの承認キューから status="approved" のジョブを取り出し、publisher で配信する。
#
# 安全方針:
#   - 公式の認証情報(YouTube OAuth / Shutterstock FTP)が設定されている配信先だけ実行。
#   - 未設定/アセット無しは "skipped"。note は規約準拠の下書きを drafts/ に出力するのみ。
#   - 自動投稿・検知回避は実装しない。
#
# 必要な環境変数（GitHub Secrets）:
#   SUPABASE_URL, SUPABASE_KEY
# 任意（設定された配信先のみ有効化）:
#   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN
#   SS_FTP_HOST, SS_FTP_USER, SS_FTP_PASS
#   DISCORD_WEBHOOK
# =================================================================

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import income_engine
import publisher


def _build_supabase():
    url, key = os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_KEY", "")
    if not (url and key):
        return None
    try:
        from supabase import create_client
        return create_client(url, key)
    except Exception as e:
        print(f"[warn] Supabase接続に失敗: {e}")
        return None


def main():
    sb = _build_supabase()
    if sb is None:
        print("[error] SUPABASE_URL / SUPABASE_KEY が必要です。終了します。")
        return 1

    income_engine.register_services(supabase=sb)
    publisher.register_services(set_status=income_engine.set_status)

    jobs = income_engine.list_jobs(status="approved", limit=100)
    print(f"[info] 配信対象（approved）: {len(jobs)}件")
    if not jobs:
        print("[done] 配信対象がありません。")
        return 0

    # レンダラ（動画/画像合成）。現状はスタブで空アセットを返す → 公式UPは安全にskip。
    try:
        import renderer
    except Exception:
        renderer = None

    completed, manual = 0, 0
    for job in jobs:
        # ★ 動画・画像アセットの実体生成（レンダリング）は別工程。実装されれば自動で
        #    publish_job に渡され、YouTube/Shutterstock へ実投入される。
        assets = {}
        if renderer is not None:
            try:
                assets = renderer.build_assets(job) or {}
            except Exception as e:
                print(f"[warn] レンダリングをスキップ: {e}")
        res = publisher.publish_job(job, assets=assets)
        print(f"  - {job.get('theme','')}: {res.get('log','')}")
        if res.get("status") == "completed":
            completed += 1
        else:
            manual += 1

    summary = f"📦 配信実行: 完了 {completed} / 手動対応待ち(note下書き等) {manual}（計{len(jobs)}件）"
    print(f"[done] {summary}")
    publisher.notify(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
