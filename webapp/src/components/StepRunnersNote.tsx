"use client";

/**
 * StepRunnersNote — 「手順を並べて実行する」3つの違いを説明する。
 *
 * 点検で分かったこと: 同じことをするように見える入口が3つあり、
 * 説明していたのは AUTOPILOT だけだった。ワークフローや自動化から入った人は、
 * なぜ他に2つあるのか分からないまま、どれを使えばいいか決められない。
 *
 * 同じ説明を3か所に書き写すと必ずズレるので、ここに一度だけ書いて、
 * 今いる場所を強調して出す。
 */

export type Runner = "autopilot" | "workflow" | "automation";

const RUNNERS: { key: Runner; name: string; where: string; when: string }[] = [
  {
    key: "autopilot",
    name: "オートパイロット",
    where: "ゴール",
    when: "ゴールだけ決めて、手順はAIに考えさせたいとき（何をすればいいか分からない）",
  },
  {
    key: "workflow",
    name: "ワークフロー",
    where: "つくる › AI STUDIO",
    when: "手順が決まっている作業を、毎回同じ順番で繰り返したいとき",
  },
  {
    key: "automation",
    name: "自動化",
    where: "ボード › AUTOMATION",
    when: "きっかけ（時刻・受信など）から、自分が見ていなくても動かしたいとき",
  },
];

export default function StepRunnersNote({ current, isOwner = null }:
  { current: Runner; isOwner?: boolean | null }) {
  const me = RUNNERS.find((r) => r.key === current)!;
  /* ワークフローは、持ち主だけの AI STUDIO にある（Workshop.tsx が持ち主で
     ない人には隠す）。そこへ案内すると、押した先にタブが無い。
     分からないあいだ（null）は、持ち主の画面と同じに出しておく。 */
  const others = RUNNERS.filter((r) => r.key !== current
    && !(r.key === "workflow" && isOwner === false));

  return (
    <div className="panel p-3">
      <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">
        {me.name} とは
      </div>
      <p className="text-[11px] leading-relaxed text-fg">
        <span className="text-fg-strong">{me.when}</span>に使います。
      </p>
      <div className="mt-2 flex flex-col gap-1 border-t border-panel pt-2 text-[10px] leading-relaxed text-muted">
        {others.map((o) => (
          <div key={o.key}>
            ▸ {o.when} → <span className="text-fg">{o.where} の{o.name}</span>
          </div>
        ))}
        <div className="text-muted/70">
          ※ どれも同じ実行エンジンなので、担当AI・根拠資料・条件分岐は共通で使えます。
        </div>
      </div>
    </div>
  );
}
