# scripts/keepalive.py — Supabase 無料枠の自動一時停止(7日)を防ぐジャブ打ち
# 本体Supabase と 記憶用Supabase(別プロジェクト)の両方へ軽いクエリを投げる。
# GitHub Actions から定期実行（依存ゼロ：標準ライブラリのみ）。
import os
import json
import urllib.request


def ping(url, key, table):
    if not (url and key):
        return f"skip [{table}] (URL/KEY未設定)"
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/{table}?select=*&limit=1",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return f"OK [{table}] status={r.status}"
    except Exception as e:
        # 401等でもAPIゲートウェイには到達するが、確実な活動には有効キー＋存在テーブルが望ましい
        return f"WARN [{table}] {e}"


def main():
    results = [
        ping(os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_KEY"), "vault_data"),
        ping(
            os.environ.get("MEMORY_SUPABASE_URL"),
            os.environ.get("MEMORY_SUPABASE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY"),
            "agent_memory",
        ),
    ]
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
