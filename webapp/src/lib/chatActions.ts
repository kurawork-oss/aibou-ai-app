/**
 * chatActions.ts — 会話から呼べる「できること」の一覧と、言葉からの見分け方。
 *
 * ui-r126 で、画面を「会話」1つにした。以前は 実行／管理 の2つのタブと、
 * 管理の中に 今日・ボード・タスク・ファイル、さらに「もっと」の中に10個、
 * 設定の中に5つのタブ……と、行き先を選ばせる入口が何段もあった。
 *
 * いまは、どれも**会話から呼ぶ**。
 *   - 入力欄の「＋」か、先頭に「/」を打つと、この一覧が出る
 *   - 「タスク見せて」「声を変えて」「Gmail とつないで」のように頼んでもいい
 *     （短くて、それだけを頼んでいる文のとき。下の matchAction）
 * 開いた画面は会話の上にかぶさり、「会話に戻る」で閉じる。画面は1つも
 * 消していない（入口を会話1つにまとめただけ）。
 *
 * 言葉の見分けは、わざと狭くしてある
 * ---------------------------------
 * 「タスクを3つ足して」「今日の予定を教えて」は、画面を開く頼みではなく
 * 仕事の頼み。これを横取りすると、AIに頼めなくなる。だから
 *「<名前>（を）（見せて／開いて／変えて／つないで）」だけの文に限る。
 * 少しでも中身がある文は、今まで通りAIへ回す。
 */

import type { ShellView } from "@/lib/shell";

export type SettingsTab = "core" | "look" | "memory" | "connect" | "check";

export type ActionTarget =
  | { kind: "view"; view: ShellView }
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "connect"; service: string }
  | { kind: "camera" };

export interface ChatAction {
  id: string;
  label: string;
  /** 一言。一覧とカードに出る。 */
  hint: string;
  /** 一覧の印（文字1つ）。 */
  mark: string;
  /** この名前で呼ばれたら、これを開く。 */
  keywords: string[];
  target: ActionTarget;
  /** 一覧の見出し。 */
  group: "see" | "make" | "set";
  ownerOnly?: boolean;
  /** 使う機能のかたまり（設定で切ると出ない）。 */
  pack?: string;
}

export const ACTION_GROUPS: { key: ChatAction["group"]; label: string }[] = [
  { key: "see", label: "見る・整える" },
  { key: "make", label: "つくる・進める" },
  { key: "set", label: "つなぐ・設定" },
];

export const ACTIONS: ChatAction[] = [
  { id: "today", label: "今日", hint: "予定・見張り・通知", mark: "☀", group: "see",
    keywords: ["今日", "きょう", "ホーム", "ダッシュボード", "通知"], target: { kind: "view", view: "home" } },
  { id: "tasks", label: "タスク", hint: "やること", mark: "✓", group: "see",
    keywords: ["タスク", "やること", "todo", "やることリスト"], target: { kind: "view", view: "tasks" } },
  { id: "files", label: "ファイル", hint: "作った物", mark: "▤", group: "see",
    keywords: ["ファイル", "作った物", "作ったもの", "成果物"], target: { kind: "view", view: "archive" } },
  { id: "vault", label: "資料", hint: "入れた資料から答える", mark: "▥", group: "see",
    keywords: ["資料", "ドキュメント"], target: { kind: "view", view: "vault" } },
  { id: "me", label: "きろく", hint: "日々のこと", mark: "✎", group: "see",
    keywords: ["きろく", "記録", "日記"], target: { kind: "view", view: "me" } },

  { id: "board", label: "ボード", hint: "考えを広げる", mark: "◫", group: "make",
    keywords: ["ボード", "ホワイトボード"], target: { kind: "view", view: "board" } },
  { id: "studio", label: "つくる", hint: "アプリ・LP・素材", mark: "✦", group: "make", pack: "make",
    keywords: ["つくる", "スタジオ", "ワークショップ"], target: { kind: "view", view: "studio" } },
  { id: "autopilot", label: "ゴール", hint: "分解して進める", mark: "◎", group: "make",
    keywords: ["ゴール", "目標"], target: { kind: "view", view: "autopilot" } },
  { id: "code", label: "コード", hint: "リポジトリを触る", mark: "⌘", group: "make", pack: "dev",
    keywords: ["コード", "リポジトリ"], target: { kind: "view", view: "code" } },
  { id: "sns", label: "SNS", hint: "投稿文を作る", mark: "＃", group: "make", pack: "share",
    keywords: ["sns", "エスエヌエス"], target: { kind: "view", view: "sns" } },
  { id: "capture", label: "録音", hint: "録音・文字起こし", mark: "●", group: "make", pack: "make",
    keywords: ["録音", "文字起こし"], target: { kind: "view", view: "capture" } },
  { id: "income", label: "副業", hint: "収益の自動化", mark: "¥", group: "make", ownerOnly: true, pack: "income",
    keywords: ["副業", "収益"], target: { kind: "view", view: "income" } },

  { id: "extend", label: "連携", hint: "Gmail・LINE・Slack などとつなぐ", mark: "⇄", group: "set",
    keywords: ["連携", "コネクタ", "コネクター", "拡張機能", "外部サービス"], target: { kind: "view", view: "extend" } },
  { id: "settings", label: "設定", hint: "名前・性格・AI・通知", mark: "⚙", group: "set",
    keywords: ["設定", "名前", "性格", "ai", "モデル", "通知の設定"], target: { kind: "settings", tab: "core" } },
  { id: "look", label: "見た目と声", hint: "テーマ・背景・話し方", mark: "◐", group: "set",
    keywords: ["見た目", "テーマ", "声", "話し方", "読み上げ", "背景", "色"], target: { kind: "settings", tab: "look" } },
  { id: "memory", label: "記憶", hint: "覚えていること", mark: "◇", group: "set",
    keywords: ["記憶", "覚えていること", "メモリ"], target: { kind: "settings", tab: "memory" } },
  { id: "pc", label: "手元のPC・使う機能", hint: "ローカル操作・機能のオンオフ・鍵", mark: "⌂", group: "set",
    keywords: ["手元のpc", "ローカル", "使う機能", "鍵", "パソコン操作"], target: { kind: "settings", tab: "connect" } },
  { id: "camera", label: "カメラで操作", hint: "手と顔で操作する", mark: "✋", group: "set",
    keywords: ["カメラ", "カメラ操作", "ジェスチャー", "ハンドジェスチャー"], target: { kind: "camera" } },
  { id: "check", label: "しらべる", hint: "何が使えるか・うまく動かないとき", mark: "?", group: "set",
    keywords: ["しらべる", "診断", "調子"], target: { kind: "settings", tab: "check" } },
  { id: "guide", label: "説明書", hint: "使い方", mark: "▢", group: "set",
    keywords: ["説明書", "使い方", "ヘルプ"], target: { kind: "view", view: "guide" } },
];

/** つなぐ先（lib/extensions.ts の id）と、その呼び名。 */
export const CONNECT_NAMES: { service: string; label: string; names: string[] }[] = [
  { service: "google", label: "Google（Gmail・カレンダー・ドライブ）",
    names: ["google", "グーグル", "gmail", "ジーメール", "カレンダー", "グーグルカレンダー", "googleカレンダー", "ドライブ", "googleドライブ", "グーグルドライブ"] },
  { service: "line", label: "LINE", names: ["line", "ライン"] },
  { service: "slack", label: "Slack", names: ["slack", "スラック"] },
  { service: "discord", label: "Discord", names: ["discord", "ディスコード"] },
  { service: "x", label: "X（旧Twitter）", names: ["x", "twitter", "ツイッター", "エックス"] },
  { service: "github", label: "GitHub", names: ["github", "ギットハブ"] },
  { service: "notion", label: "Notion", names: ["notion", "ノーション"] },
  { service: "email", label: "メール", names: ["メール", "email", "eメール"] },
  { service: "supabase", label: "Supabase", names: ["supabase", "スパベース"] },
  { service: "rules", label: "ルール（Obsidian）", names: ["obsidian", "オブシディアン"] },
  { service: "gemini", label: "Gemini", names: ["gemini", "ジェミニ"] },
  { service: "openai", label: "OpenAI", names: ["openai", "chatgpt", "チャットgpt"] },
  { service: "huggingface", label: "HuggingFace", names: ["huggingface", "ハギングフェイス"] },
];

export function actionById(id: string): ChatAction | undefined {
  return ACTIONS.find((a) => a.id === id);
}

/** 持ち主かどうか・使う機能で、出す物を絞る（分からないうちは絞らない）。 */
export function visibleActions(
  list: ChatAction[] = ACTIONS,
  ctx: { isOwner?: boolean | null; packs?: string[] | null } = {},
): ChatAction[] {
  const { isOwner = null, packs = null } = ctx;
  return list.filter((a) => {
    if (a.ownerOnly && isOwner === false) return false;
    if (a.pack && packs && !packs.includes(a.pack)) return false;
    return true;
  });
}

/** カタカナ→ひらがな（「たす」で「タスク」が出るように）。 */
function toHira(s: string): string {
  return s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 文字の揺れをそろえる（全角英数→半角・大文字→小文字・カタカナ→ひらがな・空白を詰める）。 */
export function normalize(text: string): string {
  return toHira(text.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, ""));
}

/** 一覧の絞り込み（「/たす」「/声」のように打ちながら）。 */
export function filterActions(list: ChatAction[], query: string): ChatAction[] {
  const q = normalize(query);
  if (!q) return list;
  const starts: ChatAction[] = [];
  const has: ChatAction[] = [];
  for (const a of list) {
    const names = [a.label, ...a.keywords].map(normalize);
    if (names.some((n) => n.startsWith(q))) starts.push(a);
    else if (names.some((n) => n.includes(q)) || normalize(a.hint).includes(q)) has.push(a);
  }
  return [...starts, ...has];
}

/** 「/」で始まる入力なら、その後ろ（絞り込みの言葉）を返す。 */
export function readSlashInput(text: string): { active: boolean; query: string } {
  const t = text ?? "";
  if (!(t.startsWith("/") || t.startsWith("／"))) return { active: false, query: "" };
  const rest = t.slice(1);
  if (/[\s　]/.test(rest)) return { active: false, query: "" };
  return { active: true, query: rest };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* 頼み方の終わり。ここに無い言い方は、AIへ回す（狭くしておく）。 */
const TAIL = "(?:ください|下さい|くれる|くれますか|ちょうだい|お願い|おねがい|お願いします|おねがいします)?[。．.!！?？]*$";
const OPEN = "(?:を|の画面を|画面を|の画面|画面|の設定を|設定を|の設定|は)?(?:見せて|みせて|開いて|ひらいて|出して|だして|表示して|見たい|みたい|開く|ひらく|開けて|あけて|見る|みる)?";
const CHANGE = "(?:を|の設定を|の設定|設定を)?(?:変えて|かえて|変更して|変えたい|かえたい|設定して|直して|なおして|変える|いじりたい|調整して)";
const CONNECT = "(?:と|に|を|の)?(?:連携を)?(?:つないで|繋いで|つなぎたい|繋ぎたい|つなげて|繋げて|つなぐ|繋ぐ|連携して|連携したい|連携|接続して|接続したい|使えるようにして)";
const CAMERA_START = "(?:を|で)?(?:始めて|はじめて|開始して|オンにして|つけて|使いたい|起動して|操作したい)";

// 頼み方の言葉も、入力と同じ形（ひらがな）にそろえてから比べる
const re = (head: string, ...rest: string[]) => new RegExp(`^${head}${rest.map(normalize).join("")}`);

export type Matched =
  | { kind: "action"; action: ChatAction }
  | { kind: "connect"; service: string; label: string };

/**
 * 短い頼みが「画面を開く・設定を変える・つなぐ」だけなら、それを返す。
 * 少しでも別の中身があれば null（AIに回す）。
 */
export function matchAction(
  text: string,
  ctx: { isOwner?: boolean | null; packs?: string[] | null } = {},
): Matched | null {
  const t = normalize(text);
  if (!t || t.length > 24) return null;

  for (const c of CONNECT_NAMES) {
    for (const n of c.names) {
      if (re(escape(normalize(n)), CONNECT, TAIL).test(t)) {
        return { kind: "connect", service: c.service, label: c.label };
      }
    }
  }

  const list = visibleActions(ACTIONS, ctx);
  for (const a of list) {
    for (const k of [a.label, ...a.keywords]) {
      const kw = escape(normalize(k));
      if (a.target.kind === "camera") {
        if (re(kw, CAMERA_START, TAIL).test(t)) return { kind: "action", action: a };
        continue;
      }
      if (re(kw, OPEN, TAIL).test(t)) return { kind: "action", action: a };
      if (a.target.kind === "settings" && re(kw, CHANGE, TAIL).test(t)) {
        return { kind: "action", action: a };
      }
    }
  }
  return null;
}

/** カードのボタンの言葉。 */
export function actionVerb(target: ActionTarget): string {
  switch (target.kind) {
    case "view": return "開く";
    case "settings": return "設定を開く";
    case "connect": return "つなぐ";
    case "camera": return "始める";
  }
}
