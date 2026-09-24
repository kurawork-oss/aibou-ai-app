/**
 * extensions — 「連携できるサービス」の台帳。
 *
 * これまで設定のKEYCHAINは、鍵の名前が縦にずらっと並ぶだけだった。
 * GITHUB_TOKEN と書いてあっても、入れると何ができるようになるのかが
 * 分からない。だから誰も入れない。
 *
 * ここではサービス単位でまとめる。「LINEを連携する → こういうことが
 * できるようになる → 必要なのはこの値 → 取り方はこう」。
 *
 * 大事なのは、できないことを書かないこと。実装が無い機能を
 * unlocks に並べると、入れたのに動かない＝いちばん不親切になる。
 */

export type ExtField = {
  name: string;            // 鍵の保管庫に保存する名前
  label: string;
  placeholder?: string;
  /** true なら入力を伏せる（画面にも履歴にも残さない） */
  secret?: boolean;
  /** 空でも連携できる（任意項目） */
  optional?: boolean;
  /**
   * このアプリ自身の登録情報（利用者が入れる物ではない）。
   *
   * 持ち主がサーバーに1回置けば、利用者は誰も触らなくてよい。全員に見せると
   * 「自分が取ってこないといけない値」に見えてしまうので、畳んでおく。
   */
  appOnly?: boolean;
};

export type Extension = {
  id: string;
  name: string;
  /** 一言。カードに出る */
  tagline: string;
  /** 連携すると何ができるようになるか。実装があるものだけ書く */
  unlocks: string[];
  /** つなぎ方。keys=値を貼る / oauth=ボタンで許可 / database=専用画面 */
  kind: "keys" | "oauth" | "database";
  /**
   * 押すだけで繋げる提供元の名前（api/oauth.py の PROVIDERS と対応）。
   *
   * これが付いていると、鍵の入力欄ではなく「◯◯と連携」ボタンを先に出す。
   * 入力欄は残してあるが畳んである——すでに手で貼って使っている人や、
   * アプリ登録がまだの環境でも詰まらないようにするため。
   */
  oauth?: "google" | "slack" | "notion" | "github";
  fields: ExtField[];
  /** 値のとり方。番号付きで出す */
  howto: string[];
  /** 注意書き（料金・終了予定・権限の強さなど） */
  warning?: string;
  /** 持ち主だけに出す */
  ownerOnly?: boolean;
  /** 分類。カードのグループ分けに使う */
  group: "ai" | "notify" | "post" | "work" | "data";
};

export const EXTENSIONS: Extension[] = [
  /* ── AI（頭脳） ───────────────────────────────────────────── */
  {
    id: "gemini",
    name: "Gemini",
    tagline: "会話と生成の頭脳（これが無いと何も喋りません）",
    group: "ai",
    kind: "keys",
    unlocks: [
      "会話、音声での応答",
      "資料の要約・文章生成・画像の説明",
      "ゴールを手順に分解する（ゴールの画面）",
    ],
    fields: [{ name: "GEMINI_API_KEY", label: "API キー", placeholder: "AIza…", secret: true }],
    howto: [
      "aistudio.google.com/app/apikey を開く",
      "Googleアカウントでログインする",
      "「APIキーを作成」を押す",
      "出てきた AIza… で始まる文字列をコピーして、ここに貼る",
    ],
    warning: "無料枠があります。使いすぎると一時的に止まりますが、料金は発生しません。",
  },
  {
    id: "huggingface",
    name: "HuggingFace",
    tagline: "無料の代替AI。画像生成や文字起こしも",
    group: "ai",
    kind: "keys",
    unlocks: [
      "Geminiが混んでいるときの代わりの返答",
      "画像生成（FLUX など）",
      "音声の文字起こし（Whisper など）",
    ],
    fields: [{ name: "HUGGINGFACE_TOKEN", label: "アクセストークン", placeholder: "hf_…", secret: true }],
    howto: [
      "huggingface.co でアカウントを作る",
      "右上のアイコン → Settings → Access Tokens",
      "「New token」で Read 権限のトークンを作る",
      "hf_ で始まる文字列をコピーして、ここに貼る",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    tagline: "GPT系を使いたいとき（任意）",
    group: "ai",
    kind: "keys",
    unlocks: [
      "GPT系で会話・生成する（設定 →「基本」→ どのAIに任せるか、で選べます）",
      "Gemini も HuggingFace も落ちているときの最後の受け皿になる",
    ],
    fields: [
      { name: "OPENAI_API_KEY", label: "API キー", placeholder: "sk-…", secret: true },
      { name: "OPENAI_MODEL", label: "モデル名（空でOK）", placeholder: "gpt-4o-mini", optional: true },
    ],
    howto: [
      "platform.openai.com/api-keys を開く",
      "「Create new secret key」を押す",
      "sk- で始まる文字列をコピーして、ここに貼る",
    ],
    warning: "無料枠はありません。使った分だけ課金されます。"
      + "そのため、鍵を入れただけでは先頭では使いません（他が落ちたときの控えになります）。",
  },

  /* ── 通知（スマホに届く） ─────────────────────────────────── */
  {
    id: "line",
    name: "LINE",
    tagline: "終わったこと・失敗したことをLINEに届ける",
    group: "notify",
    kind: "keys",
    unlocks: [
      "自動実行が終わったらLINEに通知",
      "失敗したときにLINEに通知",
      "毎朝のブリーフィングをLINEに送る",
      "見張りが新しい動きを見つけたらLINEに通知",
      "LINEに届いたメッセージをAIbouが見張る（チャネルシークレットが要る）",
    ],
    fields: [
      { name: "LINE_CHANNEL_TOKEN", label: "チャネルアクセストークン", placeholder: "長い英数字", secret: true },
      { name: "LINE_TO_USER_ID", label: "宛先ユーザーID（空でOK）", placeholder: "U… ／ 空なら友だち全員", optional: true },
      // 受信は送信と別物。送るだけなら要らないので、任意にしてある
      // （必須にすると、これまで通知だけ使っていた人が突然「未接続」になる）。
      { name: "LINE_CHANNEL_SECRET", label: "チャネルシークレット（受信する場合）", secret: true, optional: true },
    ],
    howto: [
      "developers.line.biz にLINEアカウントでログインする",
      "プロバイダーを作り、その中に「Messaging API」チャネルを作る",
      "できた公式アカウントを、自分のLINEで友だち追加する",
      "チャネル設定 → Messaging API → 「チャネルアクセストークン（長期）」を発行",
      "その文字列をコピーして、ここに貼る",
      "（受信もするなら）チャネル基本設定 → チャネルシークレット をコピーして貼る",
      "（受信もするなら）Messaging API → Webhook URL に、「今日」の見張りに出ているURLを貼り、"
        + "「Webhookの利用」をONにする",
    ],
    warning:
      "以前の「LINE Notify」は2025年3月末で終了しました。古いトークンでは届きません。"
      + "上の手順で作り直してください。",
  },
  {
    id: "slack",
    oauth: "slack",
    name: "Slack",
    tagline: "チームのチャンネルに結果を流す",
    group: "notify",
    kind: "keys",
    unlocks: [
      "自動実行の結果をSlackチャンネルに投稿",
      "失敗したときにSlackに通知",
      "Slackの新しい発言をAIbouが見張る（Botトークンが要る）",
    ],
    fields: [
      { name: "SLACK_WEBHOOK", label: "Incoming Webhook URL", placeholder: "https://hooks.slack.com/services/…", secret: true },
      // Webhookは投稿しかできない仕組み。読むには別物のトークンが要る。
      { name: "SLACK_BOT_TOKEN", label: "Botトークン（読む場合）", placeholder: "xoxb-…", secret: true, optional: true },
      { name: "SLACK_CHANNELS", label: "見るチャンネル（空なら全部）", placeholder: "C0123ABCD,C0456EFGH", optional: true },
    ],
    howto: [
      "api.slack.com/apps で「Create New App」→ From scratch",
      "使うワークスペースを選ぶ",
      "左メニューの「Incoming Webhooks」をONにする",
      "「Add New Webhook to Workspace」で投稿先チャンネルを選ぶ",
      "できた https://hooks.slack.com/… をコピーして、ここに貼る",
      "（読むなら）「OAuth & Permissions」→ Bot Token Scopes に "
        + "channels:history / channels:read / groups:history / im:history / users:read を追加",
      "（読むなら）「Install to Workspace」して、xoxb- で始まるトークンをここに貼る",
      "（読むなら）読ませたいチャンネルで /invite してBotを入れる",
    ],
    warning: "このURLを知っている人は誰でもそのチャンネルに投稿できます。共有しないでください。"
      + "なお、Webhookは投稿専用です。読むには別途Botトークンが要ります。",
  },
  {
    id: "discord",
    name: "Discord",
    tagline: "Discordのチャンネルに結果を流す",
    group: "notify",
    kind: "keys",
    unlocks: ["自動実行の結果をDiscordに投稿", "失敗したときにDiscordに通知"],
    fields: [
      { name: "DISCORD_WEBHOOK", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", secret: true },
    ],
    howto: [
      "投稿したいチャンネルの「⚙ 編集」を開く",
      "「連携サービス」→「ウェブフック」→「新しいウェブフック」",
      "「ウェブフックURLをコピー」を押す",
      "コピーしたURLをここに貼る",
    ],
  },

  /* ── 発信する ─────────────────────────────────────────────── */
  {
    id: "x",
    name: "X（旧Twitter）",
    tagline: "作った投稿文を、そのままXに投稿する",
    group: "post",
    kind: "keys",
    unlocks: [
      "SNSモードで作った文案を「𝕏 に投稿」で送る",
      "文字数はXの数え方で先に出る（日本語は1文字が2つ分）",
    ],
    fields: [
      { name: "X_API_KEY", label: "API Key", secret: true },
      { name: "X_API_SECRET", label: "API Key Secret", secret: true },
      { name: "X_ACCESS_TOKEN", label: "Access Token", secret: true },
      { name: "X_ACCESS_SECRET", label: "Access Token Secret", secret: true },
    ],
    howto: [
      "developer.x.com でアプリを作る（Free プランでも投稿はできます）",
      "アプリ設定 → User authentication settings で権限を Read and write にする",
      "「Keys and tokens」タブを開く",
      "API Key / API Key Secret をコピーして、上の2つに貼る",
      "Access Token / Access Token Secret を発行して、下の2つに貼る",
      "※ 権限を Read and write にしたのが後なら、Access Token を作り直す",
    ],
    warning:
      "投稿は取り消せません。押したときだけ送り、自動実行からは投稿しません。"
      + "Freeプランは1か月あたりの投稿数に上限があります。",
  },

  /* ── 仕事の道具 ───────────────────────────────────────────── */
  {
    id: "google",
    oauth: "google",
    name: "Google",
    tagline: "カレンダー・スプレッドシート・ドキュメント・スライド",
    group: "work",
    kind: "oauth",
    unlocks: [
      "予定をGoogleカレンダーに登録する",
      "今後の予定をアプリ内のカレンダーで見る",
      "表をスプレッドシートとして書き出す",
      "文章をGoogleドキュメントにする",
      "スライドをGoogleスライドにする",
      "ドライブにファイルをそのまま作る（作った直後に実在を確認します）",
      "受信メールを読む（アプリパスワードを作る手順が要らなくなります）",
    ],
    fields: [
      { name: "GOOGLE_CLIENT_ID", label: "クライアントID", placeholder: "…apps.googleusercontent.com", appOnly: true },
      { name: "GOOGLE_CLIENT_SECRET", label: "クライアントシークレット", secret: true, appOnly: true },
    ],
    howto: [
      "（この手順はアプリの持ち主が1回だけ行います。ふだんは「連携する」を押すだけです）",
      "console.cloud.google.com でプロジェクトを作る",
      "「APIとサービス」→ ライブラリ で Calendar / Sheets / Docs / Slides / Gmail を有効にする",
      "「OAuth同意画面」を作る（テストユーザーに使う人のアドレスを入れる）",
      "「認証情報」→「OAuth クライアントID」→ ウェブアプリケーション",
      "できたIDとシークレットを、サーバー（Render）の環境変数 GOOGLE_CLIENT_ID / "
        + "GOOGLE_CLIENT_SECRET に置く",
    ],
    warning: "「連携する」を押して許可すれば使えます。"
      + " メールもこの連携で読めるので、アプリパスワードを作る必要はありません。"
      + " YouTubeへの投稿には対応していません。",
  },
  {
    id: "github",
    oauth: "github",
    name: "GitHub",
    tagline: "自分のリポジトリを読み書きする（コードの画面）",
    group: "work",
    kind: "keys",
    unlocks: [
      "自分のリポジトリを取り込んで編集する",
      "変更をコミットして push する",
    ],
    fields: [{ name: "GITHUB_TOKEN", label: "アクセストークン", placeholder: "github_pat_…", secret: true }],
    howto: [
      "github.com → 右上のアイコン → Settings",
      "左下 Developer settings → Personal access tokens → Fine-grained tokens",
      "「Generate new token」で対象リポジトリを選ぶ",
      "Repository permissions で Contents を Read and write にする",
      "できたトークンをコピーして、ここに貼る（一度しか表示されません）",
    ],
  },
  {
    id: "rules",
    name: "ルール（Obsidian）",
    tagline: "守ってほしいことをメモに書いておくと、AIbouが従う",
    group: "work",
    kind: "keys",
    unlocks: [
      "「Xに投稿するときは絵文字を使わない」のような約束を、メモに書いて守らせる",
      "投稿・送信のような取り消せない操作の直前に、必ずルールを読ませる",
      "メモを直せば、AIbouの振る舞いがその場で変わる（作り直し不要）",
    ],
    warning: "GitHubのトークンが先に必要です。リポジトリは必ず private にしてください。"
           + "AIbouはこのメモを読むだけで、書き換えません。",
    fields: [
      { name: "RULES_REPO", label: "置き場（owner/name）", placeholder: "yourname/aibou-rules" },
      { name: "RULES_PATH", label: "フォルダ（空ならリポジトリ全体）", placeholder: "ルール", optional: true },
    ],
    howto: [
      "GitHubで private のリポジトリを1つ作る（例: aibou-rules）",
      "Obsidianの保管庫をそこに置く（Obsidian Git プラグインが楽です）",
      "メモの先頭に「---」で囲んで 適用: ツール / 対象: x_post のように書く",
      "適用は 常時・ツール・モード・話題 の4つ。書かなければ常時になる",
      "ここに置き場を保存して、「ルールを同期」を押す",
      "同期したときだけGitHubを読むので、ふだんの返事は遅くなりません",
    ],
  },
  {
    id: "notion",
    oauth: "notion",
    name: "Notion",
    tagline: "決まったページにメモを書き足す",
    group: "work",
    kind: "keys",
    unlocks: ["会話や結果をNotionのページに追記する"],
    fields: [
      { name: "NOTION_TOKEN", label: "インテグレーションのトークン", placeholder: "ntn_…", secret: true },
      { name: "NOTION_PARENT_ID", label: "書き込み先のページID", placeholder: "32桁の英数字" },
    ],
    howto: [
      "notion.so/my-integrations で「New integration」を作る",
      "Internal Integration Token をコピーする",
      "書き込みたいページを開き、「…」→ 接続 から作ったものを追加する",
      "そのページのURL末尾の32桁をコピーして、ページIDに貼る",
    ],
  },
  {
    id: "email",
    name: "メール",
    tagline: "エージェントがメールを送る",
    group: "work",
    kind: "keys",
    unlocks: [
      "下書きを作ってメールで送る（送信前に確認あり）",
      "受信箱の新着を読んで要約する",
    ],
    fields: [
      { name: "EMAIL_ADDRESS", label: "メールアドレス", placeholder: "you@gmail.com" },
      { name: "EMAIL_PASSWORD", label: "アプリパスワード", secret: true },
      { name: "EMAIL_SMTP_HOST", label: "送信サーバー（Gmailなら空でOK）", placeholder: "smtp.gmail.com", optional: true },
      { name: "EMAIL_IMAP_HOST", label: "受信サーバー（Gmailなら空でOK）", placeholder: "imap.gmail.com", optional: true },
    ],
    howto: [
      "Googleアカウント → セキュリティ → 2段階認証プロセス をONにする",
      "同じ画面の「アプリ パスワード」を開く",
      "アプリ名を入れて作成し、出てきた16文字をコピーする",
      "ふだんのログインパスワードではなく、その16文字をここに貼る",
    ],
    warning: "ふだんのパスワードは絶対に入れないでください。アプリパスワードを使います。",
  },

  /* ── 保存先 ───────────────────────────────────────────────── */
  {
    id: "supabase",
    name: "Supabase",
    tagline: "自分専用のデータベースに保存する",
    group: "data",
    kind: "database",
    unlocks: [
      "タスク・予定・ノート・会話が自分のDBに残る",
      "端末を変えても続きから使える",
    ],
    fields: [],
    howto: [
      "supabase.com で無料のプロジェクトを作る",
      "Project Settings → API の Project URL と service_role をコピー",
      "Connect → Session pooler の postgresql://… をコピー",
      "上の欄に貼って「接続テスト」→「接続する」→「テーブルを作成」",
    ],
    warning: "service_role キーは全権限を持ちます。他の人には渡さないでください。",
  },

  /* ── 持ち主だけ ───────────────────────────────────────────── */
  {
    id: "note",
    name: "note",
    tagline: "記事の下書きを作る（任意）",
    group: "work",
    kind: "keys",
    ownerOnly: true,
    unlocks: ["生成した記事をnoteの下書きにする"],
    fields: [{ name: "NOTE_TOKEN", label: "トークン", secret: true }],
    howto: ["noteにログインした状態のセッション値を使います", "自動投稿は既定でOFFです"],
    warning: "非公式の方法です。自動投稿は既定でOFFのままにしてください。",
  },
];

/** その人に見せてよい拡張だけ返す。 */
export function visibleExtensions(isOwner: boolean | null): Extension[] {
  return EXTENSIONS.filter((e) => !e.ownerOnly || isOwner === true);
}

/** この拡張は「つながっている」か。必須項目が全部入っていれば連携済み。 */
export function isConnected(ext: Extension, keysSet: Set<string>): boolean {
  const required = ext.fields.filter((f) => !f.optional);
  if (required.length === 0) return false;      // database/oauth は別途判定
  return required.every((f) => keysSet.has(f.name));
}

/** 連携済みの数（進み具合の表示に使う）。 */
export function connectedCount(exts: Extension[], keysSet: Set<string>): number {
  return exts.filter((e) => isConnected(e, keysSet)).length;
}

export const GROUP_LABEL: Record<Extension["group"], string> = {
  ai: "AI（頭脳）",
  notify: "通知を受け取る",
  post: "発信する",
  work: "仕事の道具",
  data: "保存先",
};

export const GROUP_ORDER: Extension["group"][] = ["ai", "notify", "post", "work", "data"];

/**
 * 鍵を入れなくても使えるもの。
 *
 * 「画像や動画のAPIが拡張機能に無いけど大丈夫？」と聞かれた。
 * 答えは「要りません、もう動きます」なのだが、画面のどこにもそう書いていなかった。
 * 一覧に無い＝できない、と読めてしまうので、無いことの意味をはっきり書く。
 */
export const NO_KEY_FEATURES: { title: string; detail: string; where: string }[] = [
  {
    title: "画像を作る",
    detail: "鍵を入れなくても作れます。HuggingFaceを繋ぐと、モデルを選べるようになります。",
    where: "つくる › 素材 › IMAGE",
  },
  {
    title: "動画を作る",
    detail: "絵コンテから動画を組み立てます。サーバー側で処理するのでAPIは要りません。",
    where: "つくる › 素材 › VIDEO",
  },
  {
    title: "スライド・表・文書を作る",
    detail: "AIの鍵（Gemini）だけで作れます。Googleを繋ぐと、そのまま書き出せます。",
    where: "つくる › 素材",
  },
  {
    title: "Webを調べる",
    detail: "検索用のAPIは要りません。会話で「〜を調べて」と頼めます。",
    where: "実行 › 会話",
  },
];
