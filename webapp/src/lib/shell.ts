/**
 * shell.ts — 画面（View）の一覧と、「使う機能」が変わった合図。
 *
 * 画面は「会話」1つ（ui-r126）。ほかの画面は会話から呼んで、会話の上に開く。
 *
 * それでも画面を残す理由
 * ----------------------
 * チャットが得意なのは**出来事**、苦手なのは**状態**。
 *
 *   「画像を作って」        → 一度きりの出来事。会話で完結する
 *   「付箋を動かす」        → いま何があるかを見ながら触る物。
 *                            会話の吹き出しに入れた瞬間に使えなくなる
 *
 * だから「見て触る物」は画面のまま残し、**行き先を選ばせる入口だけ**を
 * 無くした（下のナビ・管理の切り替え・「もっと」）。呼べる物の一覧は
 * lib/chatActions.ts の ACTIONS の1か所。
 */

import type { WidgetId } from "@/lib/homeLayout";
import { forgetCapabilities } from "@/lib/api";

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
  if (typeof window === "undefined") return;
  /* 覚えている「できること」を**ここで1回だけ**捨てる。
     受け側それぞれに捨てさせると、受け手の数だけ取り直すことになる
     （実際、2か所が捨ててから取り直して往復が2回になった）。

     動的 import にしていたら、捨て終わる前にイベントが飛んで、受け側が
     古い物を掴んだ——**切ったはずの機能が候補に残る**。同期で捨てる。 */
  forgetCapabilities();
  window.dispatchEvent(new Event(PACKS_CHANGED));
}

/*
 * ui-r126 で、行き先を選ばせる入口（下のナビ「実行・管理」、管理の中の
 * 切り替え、「もっと」）を無くした。画面は「会話」1つで、ほかの画面は
 * 会話から呼んで、会話の上に開く。呼べる物の一覧は lib/chatActions.ts の
 * ACTIONS の1か所（ナビの一覧と二重に持たない）。
 */

export const TODAY_WIDGETS: WidgetId[] = [
  "watch", "dials", "agenda", "notifications", "artifacts", "connect",
];

/** 重い作業場（会話から呼んで、会話の上にかぶせる）。 */
export const OVERLAY_VIEWS: ShellView[] = ["code", "board", "studio"];
