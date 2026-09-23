"use client";

/**
 * AgentTrace — AIbouが「いま何をしているか」を出す経過表示。
 *
 * これまで HOME と CHAT が同じものを別々に書いていた。片方だけ直すと
 * ずれるので、1つにまとめる。
 *
 * 時間を出す理由:
 *   これまでは「考えています…」としか出せず、遅いと感じたときに
 *   どこが遅いのか画面から分からなかった。準備が重いのか、生成が重いのか、
 *   ツールが重いのかで打ち手はまったく違う。
 *
 *   とくに準備（記憶やルールの読み込み）は返事が始まる前に終わらせる必要が
 *   あるので、重くなるとそのまま待ち時間になる。そこを見えるようにしておくと、
 *   連携を足したときに「足したせいで遅くなったか」を自分で判断できる。
 */

import { AnimatePresence, motion } from "framer-motion";

/** ツール名を、人が読める言葉にする。HOMEとCHATで同じ言葉を出すためここに置く。
 *  載っていないツールは、その名前のまま出す（黙って隠すより分かる）。 */
export const TOOL_LABELS: Record<string, string> = {
  add_task: "タスクを追加",
  add_agenda: "予定を追加",
  list_state: "現在の状況を確認",
  create_document: "ドキュメントを作成",
  create_spreadsheet: "スプレッドシートを作成",
  create_slides: "スライドを作成",
  create_google_slides: "Googleスライドを作成",
  google_sheet: "Googleスプレッドシート作成",
  google_doc: "Googleドキュメント作成",
  drive_upload: "Googleドライブに作成",
  notion_add: "Notionに追記",
  create_automation: "自動化フローを作成",
  run_automation: "自動化を実行",
  create_mission: "ミッションを作成",
  calendar_add: "カレンダーに追加",
  calendar_list: "カレンダーを確認",
  send_email: "メールを送信",
  email_inbox: "受信メールを確認",
  web_search: "Webを検索",
  web_read: "ページを読む",
  generate_image: "画像を生成",
  schedule_add: "定期実行を登録",
  schedule_list: "定期実行を確認",
  remember: "記憶する",
  recall: "記憶を思い出す",
  enqueue_income: "副業ジョブを投入",
  income_status: "副業の状況を確認",
  notify: "通知を送信",
  save_note: "ノートに保存",
  complete_task: "タスクを完了",
  board_add_note: "ボードに付箋を貼る",
  draw_diagram: "図を描く",
  watch_report: "見張りの結果を確認",
  self_check: "できることを確認",
  // ブラウザ。どこで開くか（手元の台か、サーバーか）はサーバーが決めて、結果に書く
  browser_open: "ページを開いて読む",
  browser_act: "ページを操作する",
  recipe_run: "保存した手順を流す",
  recipe_save: "手順を保存",
  recipe_list: "保存した手順を確認",
  recipe_delete: "手順を消す",
  local_list: "手元のフォルダを見る",
  local_read: "手元のファイルを読む",
  local_write: "手元のファイルに書く",
  local_append: "手元のファイルに書き足す",
  obsidian_note: "今日の日誌に書き足す",
};

export type AgentStep =
  | { kind: "prepare"; what: string; detail?: string; ms?: number }
  | { kind: "thinking"; ms?: number }
  | { kind: "tool"; tool: string; note?: string; ms?: number }
  | { kind: "observation"; result: string; ms?: number }
  | { kind: "error"; detail: string; ms?: number };

/** 経過時間の表示。速いときは出さない（速いことは伝える必要がない）。 */
const QUIET_MS = 400;

export function formatMs(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < QUIET_MS) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}秒`;
}

function Took({ ms }: { ms?: number }) {
  const t = formatMs(ms);
  if (!t) return null;
  // 遅い工程ほど目に入るようにする（3秒を超えたら色を変える）
  const slow = (ms ?? 0) >= 3000;
  return (
    <span className="ml-1.5 text-[10px] label-mono"
          style={{ color: slow ? "#ffd07f" : "var(--muted)" }}>
      {t}
    </span>
  );
}

/** 1行ぶんの中身。HOMEとCHATで見た目を揃える。 */
export function AgentStepLine({ step, toolLabel }: {
  step: AgentStep;
  toolLabel?: (name: string) => string;
}) {
  if (step.kind === "prepare") {
    return (
      <span className="text-muted">
        <span className="text-[var(--accent)]">·</span> {step.what}
        {step.detail ? <span className="text-muted/70"> （{step.detail}）</span> : null}
        <Took ms={step.ms} />
      </span>
    );
  }
  if (step.kind === "thinking") {
    return (
      <span className="flex items-center gap-1.5 text-[var(--accent)]">
        <motion.span animate={{ opacity: [0.3, 1, 0.3] }}
                     transition={{ duration: 1.2, repeat: Infinity }}>◈</motion.span>
        <span className="text-muted">考えています…</span>
      </span>
    );
  }
  if (step.kind === "tool") {
    return (
      <span className="text-fg">
        <span className="text-[var(--accent)]">→</span>{" "}
        {toolLabel ? toolLabel(step.tool) : (TOOL_LABELS[step.tool] || step.tool)}
        {step.note ? <span className="text-muted"> — {step.note}</span> : null}
        <Took ms={step.ms} />
      </span>
    );
  }
  if (step.kind === "observation") {
    return (
      <span className="block whitespace-pre-wrap pl-4 text-[10px] text-muted">
        ✓ {step.result}
      </span>
    );
  }
  return <span className="text-[#ff9b9b]">⚠ {step.detail}</span>;
}

export default function AgentTrace({ steps, toolLabel, animate = true, totalMs }: {
  steps: AgentStep[];
  toolLabel?: (name: string) => string;
  /** HOMEは1行ずつ流れて出る。CHATは確定した履歴なので動かさない。 */
  animate?: boolean;
  /** 全体でかかった時間。終わったターンにだけ出す。 */
  totalMs?: number;
}) {
  if (steps.length === 0) return null;

  const rows = steps.map((step, i) => (
    <div key={i} className="text-[11px] leading-relaxed">
      <AgentStepLine step={step} toolLabel={toolLabel} />
    </div>
  ));

  const total = formatMs(totalMs);
  const foot = total ? (
    <div className="text-[10px] text-muted/70 label-mono">合計 {total}</div>
  ) : null;

  if (!animate) {
    return <div className="flex flex-col gap-1">{rows}{foot}</div>;
  }

  return (
    <div className="flex flex-col gap-1.5 py-1">
      <AnimatePresence initial={false}>
        {steps.map((step, i) => (
          <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                      className="text-[11px] leading-relaxed">
            <AgentStepLine step={step} toolLabel={toolLabel} />
          </motion.div>
        ))}
      </AnimatePresence>
      {foot}
    </div>
  );
}
