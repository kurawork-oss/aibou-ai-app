# Dockerfile — AIbou Brain API（Cloud Run / Hugging Face Spaces 向け）
# =====================================================================
# python:3.11-slim をベースに ffmpeg を入れて FastAPI を起動する。
# Cloud Run は環境変数 $PORT（既定8080）でリッスンする必要がある。
#
# ビルドはリポジトリ root から行う想定（renderer.py を同梱するため）:
#   docker build -f api/Dockerfile -t aibou-brain .
# =====================================================================
FROM python:3.11-slim

# ffmpeg（/video の動画合成に必須）。--no-install-recommends で軽量に。
# fonts-ipafont-gothic は日本語字幕の焼き込み用（約5MB）。
# これが無いと drawtext が日本語を描けず、字幕が□や空白になる。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-ipafont-gothic \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存を先にインストール（レイヤキャッシュを効かせる）
COPY api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# ── ブラウザ操作（仕様§24）。既定では入れない ──────────────────────
#
# 入れない理由は危なさではなく**大きさ**。playwright と Chromium で
# 400MB近く増え、無料のRender（メモリ512MB）ではページ1枚でAPIごと
# 落ちうる。要る人だけが入れられるようにしてある:
#
#   docker build --build-arg WITH_BROWSER=1 -f api/Dockerfile .
#
# 入れたうえで、実行時に ENABLE_BROWSER=1 を置くと使えるようになる。
# 入れていない置き場では、自己診断（設定 → つなぐ）に理由が出る。
ARG WITH_BROWSER=0
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      pip install --no-cache-dir playwright \
      && playwright install --with-deps chromium ; \
    fi

# アプリ本体（api/ の中身を /app へ）
COPY api/ /app/

# リポジトリ root の renderer.py を再利用するため同梱する。
# main.py は親ディレクトリ(=/) を sys.path に追加して import renderer する。
COPY renderer.py /renderer.py

# 自動マイグレーション（migrate.py）が読むスキーマを同梱する。
COPY supabase_schema.sql /app/supabase_schema.sql
# 土台のあとに流す移行（RLS・意味検索の土台・手順の表など）も同梱する。
# 以前はここが無く、本番の /admin/migrate では土台しか流れていなかった
# （手元とテストはリポジトリから探すので気づけなかった。test_deploy_bundle.py）。
COPY supabase/migrations /app/supabase/migrations

ENV PORT=8080
EXPOSE 8080

# Cloud Run / HF Spaces は $PORT を渡してくる。シェル形式で展開する。
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
