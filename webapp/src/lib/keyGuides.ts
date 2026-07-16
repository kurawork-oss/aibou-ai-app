/**
 * keyGuides — 各APIキーの「発行手順」データ.
 *
 * KEYCHAIN の各キー欄の「?」ボタンから開く説明パネルで使う。
 * 手順はできるだけ具体的・最新に。リンクは公式の発行ページへ直接。
 */

export interface KeyGuide {
  /** 何に使うか（1行） */
  purpose: string;
  /** 具体的な取得手順（順番） */
  steps: string[];
  /** 公式の発行ページ */
  url?: string;
  urlLabel?: string;
  /** 注意・補足 */
  note?: string;
  /** 無料で使えるか */
  free?: boolean;
}

export const KEY_GUIDES: Record<string, KeyGuide> = {
  GEMINI_API_KEY: {
    purpose: "コアAI（会話・CODE・各種生成）。最も重要なキー。",
    free: true,
    url: "https://aistudio.google.com/apikey",
    urlLabel: "Google AI Studio",
    steps: [
      "上のリンクを開き、Googleアカウントでログイン",
      "「Create API key（APIキーを作成）」をクリック",
      "プロジェクトを選択（無ければ新規作成）",
      "「AIza…」で始まるキーをコピー",
      "この欄に貼り付けて SAVE",
    ],
    note: "無料枠あり。ただし無料枠の入力は学習に使われる場合があります。機密な相談は HuggingFace の利用を推奨。",
  },
  HUGGINGFACE_TOKEN: {
    purpose: "学習に使われない無料の推論API。チャット/CODEの代替AIとして自動フォールバック。",
    free: true,
    url: "https://huggingface.co/settings/tokens",
    urlLabel: "HuggingFace › Access Tokens",
    steps: [
      "huggingface.co で無料アカウントを作成（未登録の場合）",
      "上のリンク（Settings › Access Tokens）を開く",
      "「Create new token」をクリック",
      "Token type は「Read」を選択して作成",
      "「hf_…」で始まるトークンをコピーして貼り付け",
    ],
    note: "設定すると AI PROVIDER で HUGGINGFACE を選べるようになり、Geminiの無料枠が0でも動きます。",
  },
  GITHUB_TOKEN: {
    purpose: "CODEモードでリポジトリを読み書き・コミット・PR作成する連携。",
    free: true,
    url: "https://github.com/settings/personal-access-tokens/new",
    urlLabel: "GitHub › Fine-grained token",
    steps: [
      "上のリンクを開く（Settings › Developer settings › Fine-grained tokens）",
      "Token name と Expiration（有効期限）を設定",
      "Repository access で対象リポジトリ（または All repositories）を選ぶ",
      "Permissions › Repository permissions の「Contents」を Read and write に",
      "（PRを作るなら「Pull requests」も Read and write に）",
      "「Generate token」→「github_pat_…」をコピーして貼り付け",
    ],
    note: "Contents 権限が無いと push できません。fine-grained（推奨）または classic PAT でも可。",
  },
  NOTION_TOKEN: {
    purpose: "エージェントが Notion のページ/DBにメモ（新規ページ）を追記するための連携。",
    free: true,
    url: "https://www.notion.so/my-integrations",
    urlLabel: "Notion › My integrations",
    steps: [
      "上のリンクで「New integration（新しいインテグレーション）」を作成",
      "Type は Internal、対象ワークスペースを選んで送信",
      "「Internal Integration Secret」（secret_… / ntn_…）をコピー",
      "この欄に貼り付けて SAVE",
      "★重要：追記先の Notion ページ/データベースを開き、右上「•••」→「＋接続（Connections）」で今作ったインテグレーションを追加（共有）する",
    ],
    note: "共有を忘れると 401/403 で追記できません。次の NOTION 追記先ID も設定してください。",
  },
  NOTION_PARENT_ID: {
    purpose: "メモを追加する先（親）の Notion ページ or データベースのID。",
    free: true,
    url: "https://www.notion.so/help/create-integrations-with-the-notion-api",
    urlLabel: "Notion API ヘルプ",
    steps: [
      "追記先にしたい Notion のページ（またはデータベース）を開く",
      "ブラウザのURL末尾の32桁の英数字がID（例 …so/メモ-1a2b3c4d5e6f7080a1b2c3d4e5f60718）",
      "その32桁（ハイフンあり/なしどちらでも可）をコピーして貼り付け",
    ],
    note: "データベースIDでもページIDでもOK（自動判別）。NOTION_TOKEN のインテグレーションに、その対象を『共有』しておくこと。",
  },
  OPENAI_API_KEY: {
    purpose: "任意。GPT系モデルを使う場合のみ。",
    url: "https://platform.openai.com/api-keys",
    urlLabel: "OpenAI › API keys",
    steps: [
      "platform.openai.com にログイン",
      "「Create new secret key」をクリック",
      "「sk-…」をコピー（再表示できないので必ず今コピー）",
      "この欄に貼り付けて SAVE",
    ],
    note: "従量課金（クレジット購入が必要）。無くてもアプリは動きます。",
  },
  LINE_NOTIFY_TOKEN: {
    purpose: "完了/失敗などをLINEに通知（※提供終了済み）。",
    steps: [
      "※ LINE Notify は 2025年3月末で公式に終了しました。",
      "現在は Discord Webhook または Slack Webhook の利用を推奨します。",
      "（下の DISCORD_WEBHOOK / SLACK_WEBHOOK の「?」を参照）",
    ],
    note: "LINEへ送りたい場合は LINE Messaging API 等への移行が必要です。",
  },
  DISCORD_WEBHOOK: {
    purpose: "ジョブ結果やエージェントの通知を Discord チャンネルへ。",
    free: true,
    url: "https://support.discord.com/hc/ja/articles/228383668",
    urlLabel: "Discord Webhook ヘルプ",
    steps: [
      "通知したいサーバーの「サーバー設定」→「連携サービス（Integrations）」",
      "「ウェブフック」→「新しいウェブフック」",
      "投稿先チャンネルを選び、「ウェブフックURLをコピー」",
      "https://discord.com/api/webhooks/… をそのまま貼り付け",
    ],
    note: "サーバーの管理権限が必要です。設定は無料。",
  },
  SLACK_WEBHOOK: {
    purpose: "ジョブ結果やエージェントの通知を Slack チャンネルへ。",
    free: true,
    url: "https://api.slack.com/apps",
    urlLabel: "Slack › Your Apps",
    steps: [
      "上のリンクで「Create New App」→「From scratch」",
      "アプリ名とワークスペースを選んで作成",
      "左メニュー「Incoming Webhooks」を On にする",
      "「Add New Webhook to Workspace」→ 投稿先チャンネルを許可",
      "発行された https://hooks.slack.com/services/… をコピーして貼り付け",
    ],
  },
  LEONARDO_API_KEY: {
    purpose: "任意。画像生成（Leonardo.Ai）。",
    url: "https://app.leonardo.ai/settings/api-access",
    urlLabel: "Leonardo › API Access",
    steps: [
      "app.leonardo.ai でアカウント作成・ログイン",
      "Settings › API Access を開く",
      "「Create New Key」で発行してコピー",
      "この欄に貼り付けて SAVE",
    ],
    note: "API利用は有料プラン（API subscription）が必要な場合があります。",
  },
  YOUTUBE_API_KEY: {
    purpose: "任意。YouTube Data API v3 連携（アップロード・検索など）。",
    url: "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
    urlLabel: "Google Cloud › YouTube Data API",
    steps: [
      "Google Cloud Console でプロジェクトを作成/選択",
      "上のリンクから「YouTube Data API v3」を有効化",
      "「APIとサービス」→「認証情報」→「認証情報を作成」→「APIキー」",
      "発行されたキーをコピーして貼り付け",
    ],
    note: "アップロード等の書き込みには OAuth 認証が別途必要な場合があります。",
  },
  NOTE_TOKEN: {
    purpose: "任意・上級者向け。note への自動投稿。",
    steps: [
      "note には公式の公開APIがありません。",
      "ブラウザのログインCookie/内部トークンを用いる高度な用途向けです。",
      "通常は空のままで問題ありません。",
    ],
    note: "仕様変更で動かなくなる可能性があります（非公式）。",
  },
  SUPABASE_URL: {
    purpose: "データ保存先（DB）のプロジェクトURL。",
    free: true,
    url: "https://supabase.com/dashboard",
    urlLabel: "Supabase › Dashboard",
    steps: [
      "supabase.com でプロジェクトを開く",
      "「Project Settings」→「API」",
      "「Project URL」（https://xxxx.supabase.co）をコピーして貼り付け",
    ],
  },
  SUPABASE_SERVICE_KEY: {
    purpose: "サーバー側でDBに読み書きするための秘密鍵。",
    url: "https://supabase.com/dashboard",
    urlLabel: "Supabase › Dashboard",
    steps: [
      "「Project Settings」→「API」を開く",
      "「Project API keys」の「service_role」で Reveal（表示）",
      "表示された秘密鍵をコピーして貼り付け",
    ],
    note: "⚠ これは秘密鍵です。第三者やチャットに絶対に貼らないでください。サーバー側専用（フロントに露出させない）。",
  },
  SHUTTERSTOCK_FTP: {
    purpose: "任意・上級者向け。Shutterstock への素材アップロード（FTP）。",
    steps: [
      "Shutterstock Contributor のアップロード設定でFTP情報を確認",
      "user:pass@host のような形式で貼り付け",
    ],
    note: "非必須。使わない場合は空のままでOK。",
  },
};

export function keyGuide(name: string): KeyGuide | undefined {
  return KEY_GUIDES[name];
}
