/**
 * blob.ts — サーバーから文字（base64）で届いた物を、画面で扱える形にする。
 *
 * data: URL のままだと数MBの文字列がDOMに乗る。Blob にして参照だけ持つ。
 */

export function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 文字の中身を、ファイルとして保存させる（開かない。保存だけ）。 */
export function downloadText(filename: string, content: string, mime = "text/plain;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** ファイル名に使えない文字を落とす。 */
export function safeName(title: string, fallback: string): string {
  const s = (title || "").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return s || fallback;
}
