/**
 * 自動化の「手順の種類」の見せ方。
 *
 * ここに1つだけ置く理由
 * ---------------------
 * 同じ表（種類→ラベル・色・入力欄）が FlowBuilder と Dashboard に
 * まったく同じ形で2つあった。手順を1つ足したとき、片方だけ直る。
 * 実際、fetch を足した時点で Dashboard 側が型エラーで落ちて気づいた
 * ——気づけたのは型のおかげで、気づけなければ画面に出ないだけだった。
 *
 * サーバー側の定義は api/flow_engine.py の STEP_TYPES。
 * 種類を足すときは、そちらとこのファイルの両方を触る。
 */

import type { StepType } from "@/lib/api";

export interface StepMeta {
  label: string;
  /** 左端の色帯。手順の種類がひと目で分かるように。 */
  color: string;
  /** params のどのキーに入れるか。 */
  field: string;
  placeholder: string;
  /** 入力欄の下に出す補足（要るものだけ）。 */
  hint?: string;
}

export const STEP_META: Record<StepType, StepMeta> = {
  ai_generate: {
    label: "AI生成", color: "#00f3ff", field: "prompt",
    placeholder: "{input}を要約して…",
  },
  // 外の値を読む手順。これが無いと「天気を見て傘の通知」のような、
  // 実データを見てから動く自動化が1つも作れない。
  fetch: {
    label: "外から読む", color: "#c07aff", field: "url",
    placeholder: "https://…（{input} も使えます）",
    hint: "読んだ内容は次の手順に {input} として渡ります。社内・端末内のアドレスは読めません。",
  },
  notify: {
    label: "通知", color: "#60d394", field: "message",
    placeholder: "完了しました: {input}",
  },
  create_task: {
    label: "タスク作成", color: "#ffd060", field: "title",
    placeholder: "タスク名…",
  },
};

export const STEP_TYPES = Object.keys(STEP_META) as StepType[];
