# 連携を「押すだけ」にする（持ち主が1回だけやる作業）

ClaudeなどがGoogleアカウントだけで繋がるのは、**提供元にアプリを一度だけ登録してあり、
その登録情報をアプリ側のサーバーが持っているから**です。利用者が鍵を持たないのではなく、
アプリの作り手が代わりに持っています。

AIbouも同じにしてあります。ここに書いた作業を**あなたが1回だけ**やれば、
以後は自分も含めて誰も鍵を貼らずに「連携する」を押すだけになります。

置き場所は **Render の環境変数**です（利用者の保管庫ではありません）。

---

## Google —— カレンダー・ドライブ・ドキュメント・**メール**

いちばん効きます。ここを済ませると、メールの
「2段階認証 → アプリパスワード → 16文字を貼る」という手順が丸ごと要らなくなります。

1. [console.cloud.google.com](https://console.cloud.google.com) でプロジェクトを作る
2. 「APIとサービス」→ ライブラリ で有効にする:
   **Google Calendar / Sheets / Docs / Slides / Drive / Gmail**
3. 「OAuth同意画面」を作る
   - ユーザーの種類: 外部
   - テストユーザーに、使う人のGoogleアドレスを入れる
4. 「認証情報」→「OAuth クライアント ID」→ **ウェブアプリケーション**
5. 「承認済みのリダイレクト URI」に、次を**完全一致**で入れる:
   ```
   https://<あなたのAPIのドメイン>/google/auth/callback
   ```
6. できた2つを Render の環境変数に置く:
   | 名前 | 値 |
   |---|---|
   | `GOOGLE_CLIENT_ID` | …apps.googleusercontent.com |
   | `GOOGLE_CLIENT_SECRET` | GOCSPX-… |

> **審査について**
> 審査を受けるまでは、同意画面に「このアプリは確認されていません」と出て、
> 使える人数が**100人まで**に制限されます。自分と身内で使うぶんには、
> そのまま「詳細」→「安全ではないページに移動」で進んで問題ありません。
> 一般公開するなら審査が要り、Gmailの読み取りのような強い権限は
> 有料のセキュリティ審査を求められます。

---

## Slack —— チャンネルの発言を見張る / 結果を流す

1. [api.slack.com/apps](https://api.slack.com/apps) →「Create New App」→ From scratch
2. 「OAuth & Permissions」→ **Redirect URLs** に追加:
   ```
   https://<あなたのAPIのドメイン>/connect/slack/callback
   ```
3. 同じ画面の **Bot Token Scopes** に追加:
   `channels:history` `channels:read` `groups:history` `groups:read`
   `im:history` `im:read` `mpim:history` `mpim:read` `users:read` `chat:write`
4. 「Basic Information」の Client ID / Client Secret を Render へ:
   | 名前 | 値 |
   |---|---|
   | `SLACK_CLIENT_ID` | 数字.数字 |
   | `SLACK_CLIENT_SECRET` | 英数字 |

> 連携したあと、**読ませたいチャンネルで `/invite` してBotを入れてください。**
> Botが入っていないチャンネルは読めません（読めない理由は画面に出ます）。

---

## Notion —— 決めたページにメモを書き足す

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → 新しいインテグレーション
2. 種類を **Public**（公開）にする
3. Redirect URI に追加:
   ```
   https://<あなたのAPIのドメイン>/connect/notion/callback
   ```
4. OAuth client ID / client secret を Render へ:
   | 名前 | 値 |
   |---|---|
   | `NOTION_CLIENT_ID` | UUID |
   | `NOTION_CLIENT_SECRET` | secret_… |

---

## GitHub —— リポジトリの読み書き（CODEモード・ルールの取り込み）

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App
2. Authorization callback URL:
   ```
   https://<あなたのAPIのドメイン>/connect/github/callback
   ```
3. Client ID と、生成した Client secret を Render へ:
   | 名前 | 値 |
   |---|---|
   | `GITHUB_CLIENT_ID` | Iv1.… |
   | `GITHUB_CLIENT_SECRET` | 英数字 |

---

## OAuth にできないもの（理由つき）

| | なぜ手入力のままか |
|---|---|
| **Gemini / OpenAI / HuggingFace** | **AIの利用料の請求先そのもの**です。OAuthは「代理でアクセスする」仕組みなので、請求先の肩代わりには使えません。あなたが全員分を払う（サーバーに置く）か、各自が自分の鍵を入れるかの二択です。 |
| **LINE** | 公式アカウント（Messaging APIチャネル）は1人に1つで、代理で作れません。 |
| **X（旧Twitter）** | 開発者アカウントの申請が要り、無料枠の投稿数にも上限があります。 |

サーバーに `GEMINI_API_KEY` を置けば、利用者は自分で鍵を用意しなくても使えます
（その場合、利用料はあなたに来ます）。

---

## 確認のしかた

1. デプロイ後、AIbou の **管理 → もっと →「連携」** を開く
2. Google を開くと「**GOOGLE と連携する**」ボタンが出ていること
   - 出ずに「持ち主がアプリ登録をまだ済ませていません」と出るなら、環境変数が届いていません
3. 押して許可し、戻ってきたら**繋がったアカウント名**が出ること
4. HOMEの見張りで、メールが「読めています」になること

うまくいかないときは、**Renderのログ**と、**リダイレクトURIが完全一致しているか**を
先に確認してください。ここの食い違いがいちばん多い原因です。
