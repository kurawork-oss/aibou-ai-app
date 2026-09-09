/**
 * shell.ts — 画面を「実行」と「管理」の2つに畳む対応表。
 *
 * なぜ2つなのか
 * -------------
 * チャットが得意なのは**出来事**、苦手なのは**状態**。
 *
 *   「画像を作って」        → 一度きりの出来事。会話で完結する
 *   「付箋を動かす」        → いま何があるかを見ながら触る物。
 *                            会話の吹き出しに入れた瞬間に使えなくなる
 *
 * だからこの線引きは、好みではなく構造から出てくる。あとから破綻しない。
 *
 *   実行 … AIが判断してやる（会話）
 *   管理 … 人が見て触る（残っている物）
 *
 * 流れは「実行 → 成果物 → 管理」。スライドは作るのが実行、直すのが管理。
 * 同じ機能が両側に顔を出すのは自然で、矛盾しない。
 *
 * 大事なこと
 * ----------
 * 画面（View）は1つも消していない。**ナビが案内する数を減らしただけ。**
 * 消すと機能が失われるが、案内を減らすだけなら、`#` からも「もっと」からも
 * たどり着ける。15タブが15個の判断を迫っていたのが問題だった。
 */

import type { WidgetId } from "@/lib/homeLayout";

/**
 * 画面の一覧。**ここが唯一の定義**（page.tsx はこれを読む）。
 *
 * 以前は page.tsx にも同じ並びが書いてあり、片方だけ増えても型では
 * 気づけなかった。実行時にも要る（サーバーから来た飛び先が実在するか
 * 確かめる）ので、型ではなく配列で持つ。
 */
export const VIEWS = [
  "chat", "me", "sns", "capture", "code", "vault", "income", "tasks",
  "studio", "autopilot", "board", "archive", "home", "guide", "extend",
] as const;

export type ShellView = (typeof VIEWS)[number];

/** 文字列が実在する画面名か（サーバーから来た値の受け口）。 */
export function isView(v: string): v is ShellView {
  return (VIEWS as readonly string[]).includes(v);
}

/**
 * 「使う機能」が変わったことを、開いている画面に知らせる合図。
 *
 * `#` の候補は会話を開いたときに1回だけ取っている。設定で「開発」を
 * 切っても、そのまま `#コード` が候補に残っていた——押せば通るので
 * 壊れてはいないが、切ったのに残っているのは分かりにくい。
 *
 * 設定と会話は親子ではないので、間に props を通すよりも
 * この1本で済ませる（受け側は無ければ何もしない）。
 */
export const PACKS_CHANGED = "forge:packs-changed";

export function announcePacksChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PACKS_CHANGED));
  }
}

/** 下のナビ。ここは2つだけにする。 */
export const TABS = [
  { key: "run" as const, label: "実行", hint: "話して、やってもらう" },
  { key: "manage" as const, label: "管理", hint: "残っている物を見る・触る" },
];

export type TabKey = (typeof TABS)[number]["key"];

/** 実行タブが開く画面。会話がここ1つに集まる。 */
export const RUN_VIEW: ShellView = "chat";

/**
 * 管理タブの中身。よく開く順に並べる。
 *
 * 「タスク・予定」「ファイル・資料」のように束ねてあるのは、どちらも
 * 同じ問い（いつ何をするか／どこに置いてあるか）に答える物だから。
 * 別々のタブにすると、毎回どちらか選ぶ手間が増える。
 */
export const MANAGE_SURFACES: {
  key: string; label: string; view: ShellView; hint: string;
}[] = [
  { key: "today", label: "今日", view: "home", hint: "見張り・予定・通知" },
  { key: "board", label: "ボード", view: "board", hint: "考えを広げる" },
  { key: "tasks", label: "タスク", view: "tasks", hint: "やること" },
  { key: "files", label: "ファイル", view: "archive", hint: "作った物" },
];

/**
 * 「もっと」に入れる残り。
 *
 * ここに置くのは「たまにしか開かないが、開くときは画面が要る」物。
 * 会話から `#` でも呼べるが、`#` を知らない人の行き止まりを作らないため、
 * 一覧としても残す。
 */
export const MORE_SURFACES: {
  key: string; label: string; view: ShellView; hint: string; ownerOnly?: boolean;
}[] = [
  { key: "studio", label: "つくる", view: "studio", hint: "アプリ・LP・素材" },
  { key: "code", label: "コード", view: "code", hint: "リポジトリを触る" },
  { key: "sns", label: "SNS", view: "sns", hint: "投稿文を作る" },
  { key: "capture", label: "録音", view: "capture", hint: "録音・文字起こし" },
  { key: "vault", label: "資料", view: "vault", hint: "入れた資料から答える" },
  { key: "me", label: "きろく", view: "me", hint: "日々のこと" },
  { key: "autopilot", label: "ゴール", view: "autopilot", hint: "分解して進める" },
  { key: "income", label: "副業", view: "income", hint: "収益の自動化", ownerOnly: true },
  { key: "extend", label: "連携", view: "extend", hint: "外のサービスと繋ぐ" },
  { key: "guide", label: "説明書", view: "guide", hint: "使い方" },
];

/** その画面が、どちらのタブに属するか。 */
export function tabOf(view: ShellView): TabKey {
  return view === RUN_VIEW ? "run" : "manage";
}

/** 管理タブの中で、いまどれが選ばれているか（「もっと」の物は null）。 */
export function surfaceOf(view: ShellView): string | null {
  const hit = MANAGE_SURFACES.find((s) => s.view === view);
  return hit ? hit.key : null;
}

/**
 * 「今日」に出すウィジェット。
 *
 * エージェントの欄は入れない。会話は実行タブに1つだけ置く。
 * これまでHOMEにもチャット欄があり、CHATにも司令塔モードがあって、
 * 同じことを2か所でやっていた。
 */
export const TODAY_WIDGETS: WidgetId[] = [
  "watch", "dials", "agenda", "notifications", "artifacts", "connect",
];

/** 実行タブから開ける、重い作業場（会話の上にかぶせる）。 */
export const OVERLAY_VIEWS: ShellView[] = ["code", "board", "studio"];
