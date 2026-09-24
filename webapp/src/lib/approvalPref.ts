/**
 * approvalPref.ts — 「外に残る操作も、実行前に確認する」の設定。**置き場はここ1つ。**
 *
 * なぜ1つにしたか
 * ----------------
 * 同じ設定が2か所に別々にあった:
 *
 *   会話の画面（実行モードの入力欄の上） … 端末に覚える。会話モードでは見えない
 *   HOMEのエージェント欄                … 覚えない（開き直すと毎回「入」に戻る）
 *
 * しかも会話モードも、この設定を使って確認を出すようになった（大改造A）のに、
 * 会話モードでは切り替えが見えなかった。そして呼び名が中身と合っていなかった
 * （「取り消せない操作は確認する」——取り消せない操作は、この設定に関わらず
 * **いつも**確認する。この設定が決めるのは、その1つ手前の「外に残る操作」）。
 *
 * 設定 →「基本」の1か所で決め、どの画面もここを読む。
 */

import { useEffect, useState } from "react";

/** 以前から会話の画面が使っていた名前。変えると、切っていた人の設定が戻る。 */
const KEY = "forge_chat_approval";
/** 変わったことを、開いている画面に知らせる合図。 */
export const APPROVAL_CHANGED = "forge:approval-changed";

/** 既定は「確認する」。読めない端末でも、確認する側に倒す。 */
export function readApproval(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeApproval(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* 覚えられない端末では、毎回「確認する」に戻るだけ（安全な側） */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(APPROVAL_CHANGED));
}

/** いまの設定。設定画面で変えれば、開いている画面にもすぐ効く。 */
export function useApproval(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const load = () => setOn(readApproval());
    load();
    window.addEventListener(APPROVAL_CHANGED, load);
    window.addEventListener("storage", load);        // 別のタブで変えたとき
    return () => {
      window.removeEventListener(APPROVAL_CHANGED, load);
      window.removeEventListener("storage", load);
    };
  }, []);
  return on;
}
