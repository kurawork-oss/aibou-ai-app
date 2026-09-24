"use client";

/**
 * 設定 →「基本」の「確認の出し方」。この設定の置き場はここだけ（lib/approvalPref.ts）。
 *
 * 呼び名は中身どおりにする。以前の画面の「取り消せない操作は確認する」は、
 * 切っても取り消せない操作の確認は止まらない（止まってはいけない）ので、
 * 押した人の思っていることと違うことが起きていた。
 */

import { readApproval, writeApproval } from "@/lib/approvalPref";
import { useEffect, useState } from "react";

export default function ApprovalSetting() {
  const [on, setOn] = useState(true);
  useEffect(() => { setOn(readApproval()); }, []);

  return (
    <section className="mt-5" aria-label="確認の出し方">
      <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">確認の出し方</div>
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" checked={on}
          onChange={(e) => { setOn(e.target.checked); writeApproval(e.target.checked); }}
          className="mt-0.5 accent-[var(--accent)]" />
        <span className="text-[12px] leading-relaxed text-fg">
          外に残る操作（予定・ドライブ・Notion・手元のファイルなど）も、実行前に確認する
        </span>
      </label>
      <p className="mt-1 pl-6 text-[11px] leading-relaxed text-muted">
        メールの送信・通知・あなたとして押すブラウザ操作など、
        <b className="text-fg-strong">取り消せない操作は、この設定に関わらず毎回確認します。</b>
        会話でも実行モードでも、同じ設定が効きます。
      </p>
    </section>
  );
}
