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
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存を先にインストール（レイヤキャッシュを効かせる）
COPY api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# アプリ本体（api/ の中身を /app へ）
COPY api/ /app/

# リポジトリ root の renderer.py を再利用するため同梱する。
# main.py は親ディレクトリ(=/) を sys.path に追加して import renderer する。
COPY renderer.py /renderer.py

ENV PORT=8080
EXPOSE 8080

# Cloud Run / HF Spaces は $PORT を渡してくる。シェル形式で展開する。
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
