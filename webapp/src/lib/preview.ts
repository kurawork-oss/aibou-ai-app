/**
 * preview.ts — 生成HTMLを iframe で「実際に動かして」確認するための下ごしらえ.
 *
 * 生成されたアプリは操作できないと意味がない（入力→保存→一覧に出る、が確認したい）。
 * そのため iframe には allow-scripts を与えてJSを動かす。ただし allow-same-origin は
 * 与えない ＝ iframe は不透明オリジンになるので、
 *   ・親（このアプリ）のDOM・localStorage・Cookie には一切触れない
 *   ・代わりに iframe 内の localStorage が SecurityError を投げる
 * という状態になる。後者を埋めるため、メモリ実装の localStorage を注入する。
 *
 * さらに meta CSP で「1ファイル完結・外部通信なし」をブラウザ側でも強制する
 * （生成物が外部へ送信することを構造的に防ぐ）。
 *
 * 注入するのはプレビュー用のコピーだけ。ダウンロード・保存・修正には
 * 元のHTMLをそのまま使うので、成果物にこのコードは混ざらない。
 */

/** 不透明オリジンで localStorage が使えないときに差し替えるメモリ実装＋CSP。 */
const SHIM = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'">
<script>(function(){function mem(){var m=Object.create(null);return{getItem:function(k){k=String(k);return k in m?m[k]:null},setItem:function(k,v){m[String(k)]=String(v)},removeItem:function(k){delete m[String(k)]},clear:function(){m=Object.create(null)},key:function(i){var s=Object.keys(m);return i<s.length?s[i]:null},get length(){return Object.keys(m).length}}}
["localStorage","sessionStorage"].forEach(function(n){var ok=false;try{window[n].setItem("__p__","1");window[n].removeItem("__p__");ok=true}catch(e){}
if(!ok){try{Object.defineProperty(window,n,{value:mem(),configurable:true,writable:true})}catch(e){}}});})();</script>`;

/**
 * プレビュー用HTMLを作る（<head> の先頭にシムとCSPを差し込む）。
 * 空文字なら空文字を返す（呼び出し側の分岐を単純に保つ）。
 */
export function previewDoc(html: string): string {
  if (!html) return "";
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + SHIM + html.slice(at);
  }
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + SHIM + html.slice(at);
  }
  return SHIM + html;
}

/** iframe の sandbox 値。allow-same-origin は付けない（親を守るため）。
 *
 *  allow-forms が無いと <form onsubmit> の submit がブラウザに握り潰され、
 *  「入力→追加」が動かない（生成アプリで最も多い書き方なので必須）。
 *  外部への送信は上のCSPの form-action 'none' で止めているので、
 *  許可されるのはJSで処理する送信だけ。
 */
export const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups";

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 別タブで開くときの外枠。**生成物を、このアプリと同じ出どころで動かさない。**
 *
 * 以前は生成HTMLをそのまま blob: にして別タブで開いていた。blob: のURLは
 * 作ったページ（このアプリ）と同じ出どころになるので、生成物の中の
 * スクリプトは、このアプリのログイン情報（localStorage のセッション）や
 * 設定を読めた。opener を切っていない入口では、元のタブの画面まで触れた。
 * 生成物はAIが書いた物で、人が中身を確かめてから開くわけではない。
 *
 * そこで外枠にはスクリプトを1行も置かず、生成物はその中の sandbox の枠
 * （allow-same-origin 無し＝不透明な出どころ）で動かす。プレビューと同じ条件。
 * 枠の中の localStorage はメモリ版（previewDoc）なので、保存は再読込で消える。
 * 残したいときはダウンロードして、手元で開く。
 */
export function sandboxedTabDoc(html: string, title = "プレビュー"): string {
  const t = escAttr(title);
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${t}</title>`
    + `<style>html,body{margin:0;height:100%;background:#fff}`
    + `iframe{display:block;border:0;width:100%;height:100%}</style></head>`
    + `<body><iframe title="${t}" sandbox="${PREVIEW_SANDBOX}" srcdoc="${escAttr(previewDoc(html))}"></iframe>`
    + `</body></html>`;
}

/** 生成したHTMLを別タブで開く（外枠＋sandbox の枠。opener も渡さない）。 */
export function openSandboxedTab(html: string, title = "プレビュー"): void {
  if (typeof window === "undefined" || !html) return;
  const url = URL.createObjectURL(new Blob([sandboxedTabDoc(html, title)],
    { type: "text/html;charset=utf-8" }));
  window.open(url, "_blank", "noopener,noreferrer");
  // すぐ捨てると開く前に消える。読み込む余裕をとってから捨てる
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
