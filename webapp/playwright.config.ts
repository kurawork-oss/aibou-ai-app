import { defineConfig } from "@playwright/test";

/**
 * テストは2組ある。
 *
 *   chromium         接続先なし（オフライン）。ふだんのUIはこちらで見る。
 *   chromium-linked  接続先ありのビルド。バックエンドは page.route で
 *                    差し替える（tests/linked/backend.ts）。
 *
 * 分けている理由: NEXT_PUBLIC_API_URL はビルド時に埋まるので、
 * 1つのビルドで両方は見られない。そして「繋がっているときの画面」——
 * `#` の候補、預かった用事、機能の入り切り、開くたびの往復の数——は、
 * オフラインのビルドでは1つも通らない。ここが長いあいだ手作業でしか
 * 確かめられておらず、実際そこにバグが残っていた。
 *
 * 実行時に接続先を差し替える口（window に生やす等）は作らない。
 * XSSや拡張機能に、鍵つきの通信をまるごと横取りされる口になるため。
 * ビルドを2つ作るほうを取る（+約1分）。
 */

const CHROME = {
  channel: "chromium",
  launchOptions: {
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
};

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  use: {
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro
    locale: "ja-JP",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/linked/**",
      use: { ...CHROME, baseURL: "http://localhost:3000" },
    },
    {
      name: "chromium-linked",
      testMatch: "**/linked/**/*.spec.ts",
      use: { ...CHROME, baseURL: "http://localhost:3100" },
    },
  ],
  webServer: [
    {
      command: "npm run build && npm run start",
      port: 3000,
      timeout: 180_000,
      reuseExistingServer: true,
      env: {
        // No real backend — UI tests run with API_URL unset (offline mode)
        NEXT_PUBLIC_API_URL: "",
        NEXT_PUBLIC_API_TOKEN: "",
        NEXT_PUBLIC_GATE_PIN: "",
      },
    },
    {
      // 繋がっているときの画面用。接続先は page.route で受けるので、
      // このアドレスに本物が居る必要はない（居ないほうが確実）。
      command: "npx next build && npx next start -p 3100",
      port: 3100,
      timeout: 180_000,
      reuseExistingServer: true,
      env: {
        NEXT_PUBLIC_API_URL: "http://127.0.0.1:8099",
        NEXT_PUBLIC_API_TOKEN: "",
        NEXT_PUBLIC_GATE_PIN: "",
        NEXT_DIST_DIR: ".next-linked",
      },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
});
