import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro
    locale: "ja-JP",
  },
  projects: [
    {
      name: "chromium",
      use: {
        channel: "chromium",
        launchOptions: {
          executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        },
      },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    port: 3000,
    timeout: 120_000,
    reuseExistingServer: true,
    env: {
      // No real backend — UI tests run with API_URL unset (offline mode)
      NEXT_PUBLIC_API_URL: "",
      NEXT_PUBLIC_API_TOKEN: "",
      NEXT_PUBLIC_GATE_PIN: "",
    },
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
