# fileread.py — アップロードされたファイルからテキストを抽出する
# =====================================================================
# PDF は pypdf（未インストールでも import 時に落とさない）、それ以外はテキストとして
# デコード。抽出失敗しても crash せず、説明文字列を返す。
# =====================================================================

import io

MAX_CHARS = 40_000


def extract_text(name: str, data: bytes, content_type: str = "") -> str:
    """ファイル名/中身/MIMEからテキストを抽出して返す。"""
    lower = (name or "").lower()
    ctype = (content_type or "").lower()

    if lower.endswith(".pdf") or "pdf" in ctype:
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            parts = []
            for page in reader.pages:
                try:
                    parts.append(page.extract_text() or "")
                except Exception:
                    continue
            text = "\n".join(parts).strip()
            return text[:MAX_CHARS] if text else "(このPDFからはテキストを抽出できませんでした。画像PDFの可能性があります)"
        except Exception as e:
            return f"(PDF読み取りエラー: {e})"

    # テキスト系（.txt / .md / .csv / .json / コード など）
    try:
        return data.decode("utf-8", "ignore")[:MAX_CHARS]
    except Exception:
        try:
            return data.decode("latin-1", "ignore")[:MAX_CHARS]
        except Exception:
            return "(このファイル形式のテキスト抽出には対応していません)"
