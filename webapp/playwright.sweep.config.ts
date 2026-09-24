import { defineConfig } from "@playwright/test";

/**
 * 点検（sweep）用の設定。ふだんのテストとは別に、**開発サーバー**で回す。
 *
 * なぜ開発サーバーか
 * ------------------
 * 本番のビルド（テストが見ている物）は、React の警告を全部消してある。
 * 一覧の key の重複・入れ子にできない要素（<button> の中の <button>）・
 * 描き直しの食い違い——どれも本番では黙って通り、見た目がおかしくなるか、
 * 押しても反応しないだけになる。開発サーバーなら、その場で警告が出る。
 *
 *   npx playwright test -c playwright.sweep.config.ts
 *
 * 結果は audit/sweep-offline.json と audit/sweep-linked.json に書き出す（合格・不合格は決めない。数えるだけ）。
 * ふだんのテストと同時に流さないこと（どちらも重い）。
 */

const CHROME = {
  channel: "chromium",
  launchOptions: {
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
};

export default defineConfig({
  testDir: "./tests/audit",
  testMatch: "**/sweep.spec.ts",
  timeout: 900_000,
  retries: 0,
  workers: 1,
  use: {
    viewport: { width: 390, height: 844 },
    locale: "ja-JP",
  },
  projects: [
    {
      /* 繋いでいるとき（接続先は page.route で受ける。tests/linked/backend.ts） */
      name: "sweep-linked",
      use: { ...CHROME, baseURL: "http://localhost:3200" },
    },
    {
      /* 繋いでいないとき（はじめて開いた人が見る姿） */
      name: "sweep-offline",
      use: { ...CHROME, baseURL: "http://localhost:3201" },
    },
  ],
  webServer: [
    {
      command: "npx next dev -p 3200",
      port: 3200,
      timeout: 240_000,
      reuseExistingServer: false,
      env: {
        NEXT_PUBLIC_API_URL: "http://127.0.0.1:8099",
        NEXT_PUBLIC_API_TOKEN: "",
        NEXT_PUBLIC_GATE_PIN: "",
        NEXT_DIST_DIR: ".next-dev",
      },
    },
    {
      command: "npx next dev -p 3201",
      port: 3201,
      timeout: 240_000,
      reuseExistingServer: false,
      env: {
        NEXT_PUBLIC_API_URL: "",
        NEXT_PUBLIC_API_TOKEN: "",
        NEXT_PUBLIC_GATE_PIN: "",
        NEXT_DIST_DIR: ".next-dev-offline",
      },
    },
  ],
  reporter: [["list"]],
});
