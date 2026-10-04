/**
 * Enter の扱い（日本語入力と、指で打つ端末）。
 *
 * 日本語は、変換を確定するのにも Enter を押す。その Enter で送ったり保存したり
 * すると、書きかけ（「こうかくるい」のまま）が入ってしまう。
 *
 *   ・変換中の Enter は isComposing が付いてくる——ほとんどのブラウザ
 *   ・Safari は、確定の Enter を compositionend の**後**に送ってくるので
 *     isComposing が付かない。代わりに keyCode が 229 になる
 *
 * 両方を見ないと、Safari（Mac・iPhone）でだけ書きかけが送られる。
 * これを欄ごとに書き写すと、見る所が1つ抜けた欄が必ず出る（実際、覚えて
 * ほしいこと・手順の名前・台の名前の欄は、isComposing すら見ていなかった）。
 * だから、ここ1か所で決める。
 */

import { isTouchTyping } from "@/lib/usePhone";

/** React の KeyboardEvent でも、ふつうの KeyboardEvent でも受け取れる形。 */
export interface KeyLike {
  key: string;
  keyCode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

/** 変換中（または変換を確定している）キーか。このキーでは何もしない。 */
export function isComposingKey(e: KeyLike): boolean {
  return Boolean(e.isComposing || e.nativeEvent?.isComposing) || e.keyCode === 229;
}

/** 1行の欄で、Enter を「決定」として扱うか（変換の確定は除く）。 */
export function enterSubmits(e: KeyLike): boolean {
  return e.key === "Enter" && !isComposingKey(e);
}

/**
 * 複数行の会話欄で、Enter を「送る」として扱うか。
 *   ・Ctrl/Cmd+Enter は、どの端末でも送る
 *   ・Shift+Enter は改行
 *   ・指で打つ端末（画面のキーボード）では Enter も改行。Shift+Enter が
 *     無いので、Enter で送ると2行以上を書けない。送るのはボタンで
 */
export function enterSends(e: KeyLike): boolean {
  if (!enterSubmits(e)) return false;
  if (e.metaKey || e.ctrlKey) return true;
  if (e.shiftKey || isTouchTyping()) return false;
  return true;
}
