#!/usr/bin/env python3
# scripts/nightly_generate.py — 夜間生成cron（要件§2.1のシード注入＋一括生成）
# =================================================================
# GitHub Actions の cron から実行する headless スクリプト。
# テーマを決めて income_engine で各媒体メタデータを生成し、Supabaseの承認キュー
# (income_jobs) に "pending" として積むだけ。★外部配信は一切しない（安全）★
#
# 必要な環境変数（GitHub Secrets で設定）:
#   SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY
# 任意:
#   THEMES="雪のロッジ,集中できるカフェ"   # カンマ区切りで明示指定
#   GEN_COUNT=3                            # THEMES未指定時にAIへ提案させる本数
#   DISCORD_WEBHOOK                        # 完了サマリ通知
# =================================================================

import os
import sys

# リポジトリ直下を import パスに追加（income_engine などを読むため）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import income_engine


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


def _build_ai():
    """夜間生成用キー(GEMINI_API_KEY_NIGHTLY → GEMINI_API_KEY)で直叩きAI関数を返す。"""
    try:
        import key_manager
        key = key_manager.env_key("nightly")
    except Exception:
        key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        return None
    try:
        import google.generativeai as genai
        genai.configure(api_key=key)
    except Exception as e:
        print(f"[warn] Gemini初期化に失敗: {e}")
        return None

    def ai(prompt, model=None):
        try:
            use = model if (model and str(model).startswith("gemini")) else "gemini-2.5-flash"
            return genai.GenerativeModel(use).generate_content(prompt).text
        except Exception as e:
            return f"⚠️ AI呼び出しエラー: {e}"
    return ai


def _notify(msg):
    url = os.environ.get("DISCORD_WEBHOOK", "")
    if not url:
        return
    try:
        import requests
        requests.post(url, json={"content": msg[:1900]}, timeout=30)
    except Exception:
        pass


def main():
    # 暗号化Vault → 環境変数（アプリで設定した鍵をActionsでも使う）
    try:
        import vault_store
        vault_store.hydrate_env()
    except Exception:
        pass
    sb = _build_supabase()
    ai = _build_ai()
    if ai is None:
        print("[error] GEMINI_API_KEY が無いため生成できません。終了します。")
        return 1
    income_engine.register_services(supabase=sb, get_ai_response=ai)
    if sb is None:
        print("[warn] Supabase未接続：生成結果は永続化されません（このプロセス内のみ）。")

    # テーマ決定：明示指定 > AI提案
    themes = [t.strip() for t in os.environ.get("THEMES", "").split(",") if t.strip()]
    if not themes:
        count = max(1, min(int(os.environ.get("GEN_COUNT", "3") or 3), 10))
        print(f"[info] テーマをAIに{count}件提案させます…")
        for _ in range(count):
            t = income_engine.suggest_theme()
            if t and t not in themes:
                themes.append(t)
    if not themes:
        print("[error] テーマを決定できませんでした。")
        return 1

    print(f"[info] 生成対象テーマ: {themes}")
    ok, skipped, failed = 0, 0, 0
    for theme in themes:
        job, msg = income_engine.enqueue_theme(theme)
        print(f"  - {theme}: {msg}")
        if job is None:
            skipped += 1
        elif job.get("status") == "failed":
            failed += 1
        else:
            ok += 1

    summary = f"🌙 夜間生成: 新規 {ok} / 重複skip {skipped} / 失敗 {failed}（計{len(themes)}テーマ）"
    print(f"[done] {summary}")
    _notify(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
