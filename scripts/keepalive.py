# scripts/keepalive.py — Supabase 無料枠の自動一時停止(7日)を防ぐジャブ打ち
# 本体Supabase と 記憶用Supabase(別プロジェクト)の両方へ軽いクエリを投げる。
# GitHub Actions から定期実行（依存ゼロ：標準ライブラリのみ）。
#
# 1つでも成功すれば exit 0、全滅なら exit 1
# （以前は常に成功扱いで、実は起こせていないのに気づけなかった）。
import json
import os
import sys
import urllib.request

# 存在する可能性が高いテーブルを順に試す（1つ通れば「活動」になる）。
TABLES = ("keepalive", "api_keys", "tasks", "vault_data", "agent_memory")


def ping(label, url, key):
    if not (url and key):
        return False, f"skip [{label}] (URL/KEY未設定)"
    last = ""
    for table in TABLES:
        # 新しい形式の公開キー（sb_publishable_…）は JWT ではないので、
        # Authorization に入れると弾かれる。旧来の JWT（eyJ…）のときだけ付ける。
        headers = {"apikey": key}
        if key.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {key}"
        req = urllib.request.Request(
            f"{url.rstrip('/')}/rest/v1/{table}?select=*&limit=1",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                if 200 <= r.status < 300:
                    return True, f"OK [{label}] {table} status={r.status}"
                last = f"{table}: status={r.status}"
        except Exception as e:
            last = f"{table}: {e}"
            continue
    return False, f"FAIL [{label}] どのテーブルにも到達できず ({last})"


def main():
    results = [
        ping("main",
             os.environ.get("SUPABASE_URL"),
             os.environ.get("SUPABASE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")),
        ping("memory",
             os.environ.get("MEMORY_SUPABASE_URL"),
             os.environ.get("MEMORY_SUPABASE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")),
    ]
    print(json.dumps([msg for _, msg in results], ensure_ascii=False, indent=2))
    if not any(ok for ok, _ in results):
        print("::error::Supabaseへ到達できませんでした（SUPABASE_URL / SUPABASE_KEY を確認してください）")
        sys.exit(1)


if __name__ == "__main__":
    main()
