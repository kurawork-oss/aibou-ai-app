"use client";

/**
 * FirstRun — 初めて開いた人に「あと何をすれば使えるのか」を出す。
 *
 * 配布して分かったこと: 設定が済んでいなくても、開いた直後の画面は一見ふつうに
 * 動く。だから利用者は「もう終わった」と思ってしまい、記憶が残らないまま使い続けて、
 * あとで「保存されていない」と気づく。
 * （実際に「なにもしてないのにデータベース接続になってる」と言われた。）
 *
 * 推測ではなく実際の状態を聞いて、済んでいない項目だけを残す。
 * 3つ全部そろったら、以後は二度と出さない。判定は lib/firstRun.ts。
 */

import { useCallback, useEffect, useState } from "react";
import { API_URL, dbStatus, listKeys } from "@/lib/api";
import {
  firstRunComplete, firstRunSteps, shouldShowFirstRun, type FirstRunStep,
} from "@/lib/firstRun";

const LS_DISMISSED = "forge_firstrun_dismissed";  // 「あとで」を押した／全部済んだ
const LS_GUIDE_DONE = "forge_guide_done";         // Guide 側の進捗（手順のid）

/** Guide の「はじめる」を一度でも進めたか。手順idが1つでもあれば読んだとみなす。 */
function guideTouched(): boolean {
  try {
    const d: unknown = JSON.parse(localStorage.getItem(LS_GUIDE_DONE) || "[]");
    return Array.isArray(d) && d.length > 0;
  } catch {
    return false;
  }
}

export default function FirstRun({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [steps, setSteps] = useState<FirstRunStep[] | null>(null);  // null の間は出さない

  const check = useCallback(async () => {
    if (!API_URL) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(LS_DISMISSED) === "1"; }
    catch { /* localStorage が使えない環境ではそのまま表示する */ }
    if (dismissed) return;

    // 片方が落ちても、もう片方の結果は使う。
    const [db, keys] = await Promise.all([
      dbStatus().catch(() => null),
      listKeys().catch(() => null),
    ]);
    const input = { db, keys, guideTouched: guideTouched() };

    if (firstRunComplete(input)) {
      try { localStorage.setItem(LS_DISMISSED, "1"); } catch { /* ignore */ }
      return;
    }
    if (shouldShowFirstRun(input, false)) setSteps(firstRunSteps(input));
  }, []);

  useEffect(() => { void check(); }, [check]);

  const dismiss = () => {
    try { localStorage.setItem(LS_DISMISSED, "1"); } catch { /* ignore */ }
    setSteps(null);
  };

  if (!steps) return null;
  const remaining = steps.filter((s) => !s.done).length;

  return (
    <div className="panel mb-3 p-3">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] tracking-[0.2em] text-muted label-mono">はじめての設定</div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg">
            あと <span className="text-fg-strong">{remaining}つ</span> で、
            会話やタスクが消えずに残るようになります。
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 text-[10px] text-muted underline"
        >
          あとで
        </button>
      </div>

      <div className="mt-2 grid gap-1.5">
        {steps.map((s) => (
          <div key={s.key} className="flex items-start gap-2">
            <span
              className="mt-[1px] shrink-0 text-[11px]"
              style={{ color: s.done ? "#60d394" : "var(--muted)" }}
            >
              {s.done ? "✓" : "□"}
            </span>
            <div className="min-w-0">
              <div className="text-[11px] text-fg-strong">
                {s.title}
                {s.done && <span className="ml-1.5 text-[10px] text-muted">済み</span>}
              </div>
              {!s.done && (
                <>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{s.hint}</p>
                  {s.key === "guide" && (
                    <button
                      type="button"
                      onClick={onOpenGuide}
                      className="mt-1 text-[10px] text-[var(--accent)] underline"
                    >
                      説明書をひらく
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-2 border-t border-panel pt-2 text-[10px] leading-relaxed text-muted/70">
        分からなくなったら、会話で「使い方教えて」と聞いても答えます。
      </p>
    </div>
  );
}
