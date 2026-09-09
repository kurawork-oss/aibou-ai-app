/**
 * THE FORGE OS — Playwright E2E tests
 *
 * Tests run against the production build with NEXT_PUBLIC_API_URL="" so the
 * app starts in "offline" mode (no real backend). All UI interactions, screen
 * transitions, and component renders are verified without external dependencies.
 */

import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_HIDDEN, DEFAULT_ORDER } from "../src/lib/homeLayout";

/* ── helpers ────────────────────────────────────────────────────── */
async function enterApp(page: Page) {
  // EntryGate: click ENTER
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  // BootScreen: no API_URL → offline state quickly. Click "ENTER OFFLINE" if
  // shown, otherwise wait for the HUD wordmark.
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hudH1 = page.getByText("THE FORGE OS").first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()),
    hudH1.waitFor({ timeout: 10_000 }),
  ]);
  // HUD is ready once the Modes launcher button is present.
  await page.getByLabel("Modes", { exact: true }).waitFor({ timeout: 10_000 });
}

/** Open the Google-apps-style mode launcher and pick a mode by label. */
async function goMode(page: Page, label: string) {
  await page.getByLabel("Modes", { exact: true }).click();
  await page.locator("nav").filter({ hasText: "MODES" }).getByText(label, { exact: true }).click();
}

/** STUDIO mode merges FORGE (生成) + AI STUDIO; open a tab. */
async function goWorkshop(page: Page, tab: "素材" | "AI STUDIO") {
  await goMode(page, "STUDIO");
  await page.getByRole("button", { name: tab === "素材" ? /✦ 素材/ : /AI STUDIO/ }).click();
}

/* ── EntryGate ──────────────────────────────────────────────────── */
/** 設定のKEYCHAINタブで、畳んである「上級者向け：キーを名前で直接編集する」を開く。
 *  ふだんの連携は拡張機能に移したので、生のキー一覧はここに畳まれている。 */
async function openRawKeyEditor(page: Page) {
  await page.getByLabel("Settings").click();
  await page.getByText("KEYCHAIN", { exact: true }).click();
  await page.getByText("上級者向け：キーを名前で直接編集する").click();
}

test("EntryGate renders with THE FORGE OS wordmark", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("THE FORGE OS").first()).toBeVisible({ timeout: 10_000 });
});

test("EntryGate has ENTER button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("ENTER")).toBeVisible({ timeout: 8_000 });
});

test("EntryGate ENTER transitions to BootScreen or HUD", async ({ page }) => {
  await page.goto("/");
  await page.click("text=ENTER");
  await expect(
    page.getByText(/BOOTING|LINK ACTIVE|OFFLINE|ENTER OFFLINE|WAKING|CORE UNREACHABLE/i).first()
  ).toBeVisible({ timeout: 10_000 });
});

/* ── BootScreen / HUD ───────────────────────────────────────────── */
test("HUD renders after entering offline mode", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await expect(page.getByRole("heading", { name: /THE FORGE OS/i }).first()).toBeVisible();
});

test("Mode launcher shows all 10 modes", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Modes", { exact: true }).click();
  const nav = page.locator("nav").filter({ hasText: "MODES" });
  for (const label of ["HOME", "CHAT", "CAPTURE", "VAULT", "INCOME", "TASKS", "STUDIO", "BOARD", "ARCHIVE"]) {
    await expect(nav.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(nav.getByText("AUTO", { exact: true })).toBeVisible();
});

test("Mode panel opens downward, not upward", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  const btn = page.getByLabel("Modes", { exact: true });
  const bb = await btn.boundingBox();
  await btn.click();
  const panel = page.locator("nav").filter({ hasText: "MODES" });
  await expect(panel).toBeVisible({ timeout: 5_000 });
  const pb = await panel.boundingBox();
  // The panel's top must sit below the button's top (it opens downward).
  expect(pb!.y).toBeGreaterThanOrEqual(bb!.y);
});

test("CHAT is the default view; HOME shows the cockpit", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // Default landing is CHAT — its message placeholder is unique to that view
  await expect(page.getByPlaceholder("AIbou にメッセージ…")).toBeVisible({ timeout: 5_000 });
  // Navigating to HOME renders the cockpit
  await goMode(page, "HOME");
  await expect(page.getByText("PERSONAL COCKPIT")).toBeVisible({ timeout: 5_000 });
  // 会話欄はここには置かない。実行タブに1つだけある（同じ物を2か所に
  // 置くと、どちらで話したか分からなくなる）。隠しただけなので戻せる。
  await expect(page.getByText(/AGENT CONSOLE/i)).toHaveCount(0);
  await expect(page.getByText("INSTRUMENT CLUSTER")).toBeVisible();
  await expect(page.getByText("予定 — AGENDA")).toBeVisible();
});

test("CoreOrb is visible and renders its 3D canvas", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  const orb = page.getByRole("img", { name: /THE FORGE OS core/i }).first();
  await expect(orb).toBeVisible();
  // ui-r11: the core is a true-3D canvas (particle sphere + orbit rings).
  await expect(orb.locator("canvas")).toBeAttached();
  // The 3D backdrop (starfield + perspective grid) is mounted behind the HUD.
  await expect(page.locator("canvas.fixed.inset-0").first()).toBeAttached();
});

test("Chat: history toggle opens the panel", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // Bottom-left toggle opens the full-height history panel.
  await page.getByLabel("Chat history").click();
  await expect(page.getByText("＋ 新しいチャット")).toBeVisible({ timeout: 5_000 });
});


/* ── 見た目（スキン）の切り替え ─────────────────────────────────── */
test("Settings CORE has the theme picker with both skins", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("見た目（テーマ）")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /FORGE（ダーク）/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /AIbou（ライト）/ })).toBeVisible();
});

test("Switching to the AIbou skin repaints the app light", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // 既定はダーク
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe("forge");
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: /AIbou（ライト）/ }).click();
  const after = await page.evaluate(() => ({
    skin: document.documentElement.dataset.skin,
    bg: getComputedStyle(document.documentElement).backgroundColor,
    theme: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
  }));
  expect(after.skin).toBe("aibou");
  expect(after.bg).toBe("rgb(244, 245, 253)");   // 明るい背景に変わっている
  expect(after.theme).toBe("#f4f5fd");           // ブラウザのUI色も合わせる
  // 戻せる
  await page.getByRole("button", { name: /FORGE（ダーク）/ }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe("forge");
});

test("The chosen skin survives a reload and is applied before React mounts", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("forge_skin", "aibou"));
  await page.reload({ waitUntil: "commit" });
  // <head> のスクリプトで立てているので、ハイドレーション前から aibou
  await expect.poll(async () =>
    page.evaluate(() => document.documentElement.dataset.skin), { timeout: 5_000 }).toBe("aibou");
});

test("A broken saved skin falls back to the default", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("forge_skin", "nonsense"));
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe("forge");
});


test("Settings CORE has the core-shape picker and it persists", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("コアの形")).toBeVisible({ timeout: 5_000 });
  // 見本は実物のコアを小さく描いている（静止画ではない）
  await expect(page.getByRole("button", { name: "ピラミッド" })).toBeVisible();
  await page.getByRole("button", { name: "クリスタル" }).click();
  expect(await page.evaluate(() => localStorage.getItem("forge_core_type"))).toBe("crystal");
  // 再読込しても選んだ形のまま
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByRole("button", { name: "クリスタル" })).toHaveAttribute("aria-pressed", "true");
});

test("A broken saved core shape falls back to the default", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("forge_core_type", "nonsense"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByRole("button", { name: "コア", exact: true })).toHaveAttribute("aria-pressed", "true");
});


test("Focus mode hides the core but always offers a labelled way back", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await expect(page.getByRole("img", { name: /core/i }).first()).toBeVisible();
  await page.getByLabel("Fullscreen").click();
  // コアは消えるが、戻し方が文字で出ている（アイコンだけにしない）
  await expect(page.getByRole("img", { name: /core/i })).toHaveCount(0);
  const back = page.getByRole("button", { name: /コアを表示/ });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.getByRole("img", { name: /core/i }).first()).toBeVisible();
});


/* ── 使い方ガイド ───────────────────────────────────────────────── */
test("GUIDE mode opens and shows how to start even without a backend", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "GUIDE");
  await expect(page.getByRole("heading", { name: /の説明書/ })).toBeVisible({ timeout: 5_000 });
  // 未接続でも、はじめる手順は最後まで読める（繋ぎ方の案内を、繋がないと
  // 読めない場所に置かない）。詳細は tests/setup.spec.ts。
  await expect(page.getByText("はじめる手順")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(4);
});

test("GUIDE is reachable from the mode launcher and survives a reload", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "GUIDE");
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await expect(page.getByRole("heading", { name: /の説明書/ })).toBeVisible({ timeout: 8_000 });
});


test("KEYCHAIN sends you to the one place where connections live", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openRawKeyEditor(page);
  // 同じ設定が2か所にあると、どちらが本物か分からなくなる。
  // ふだんの連携は拡張機能に一本化し、ここからはそこへ送る。
  await expect(page.getByText("「拡張機能」")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "拡張機能をひらく" })).toBeVisible();
});

/* ── Settings ───────────────────────────────────────────────────── */
test("Settings gear icon is clickable and opens panel", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible({ timeout: 5_000 });
});

test("Settings panel has 5 tabs", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("PERSONA", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("KEYCHAIN", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "HF" })).toBeVisible();
  await expect(page.getByText("DIAGNOSTICS", { exact: true })).toBeVisible();
});

test("Settings HF tab explains it needs the backend when offline", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "HF" }).click();
  // 会話・コード・画像・文字起こしに割り当てる、という説明が出る
  await expect(page.getByText(/会話・コード・画像生成・文字起こし/)).toBeVisible({ timeout: 5_000 });
  // バックエンド未接続なら、その理由をはっきり出す（黙って空にしない）
  await expect(page.getByText(/バックエンド接続後に使えます/)).toBeVisible();
});

test("Settings tab bar does not overflow at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible({ timeout: 5_000 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // 5つ目のタブも押せる（幅が潰れて隠れていない）
  await page.getByRole("button", { name: "HF" }).click();
  await expect(page.getByText(/バックエンド接続後に使えます/)).toBeVisible({ timeout: 5_000 });
});

test("Settings CORE tab shows voice + talk speed controls", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE VOICE")).toBeVisible();
  await expect(page.getByText("TALK SPEED")).toBeVisible();
  await expect(page.getByLabel("Talk speed")).toBeVisible();
});

test("Settings KEYCHAIN tab shows API key vault", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openRawKeyEditor(page);
  await expect(page.getByText("ACCESS CODE")).toBeVisible({ timeout: 5_000 });
});

test("KEYCHAIN: encrypted vault stores a key offline (ciphertext at rest)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openRawKeyEditor(page);

  // 1) Create the master passcode (setup phase) — works with no backend
  await expect(page.getByText("SET ACCESS CODE")).toBeVisible({ timeout: 5_000 });
  await page.getByPlaceholder("パスコード（4文字以上）").fill("test-pass");
  await page.getByPlaceholder("確認のためもう一度").fill("test-pass");
  await page.getByRole("button", { name: "CREATE VAULT" }).click();

  // 2) Vault unlocks and shows the preset keys (offline draft mode)
  await expect(page.getByText("オフライン下書き · UNLOCKED")).toBeVisible({ timeout: 5_000 });
  const geminiRow = page.locator("div.rounded-forge").filter({ hasText: "Gemini API Key" });
  await geminiRow.getByPlaceholder("キーを貼り付け…").fill("SECRET-GEMINI-123");
  await geminiRow.getByRole("button", { name: "SAVE" }).click();
  await expect(page.getByText(/SET · SE••••23/)).toBeVisible({ timeout: 5_000 });

  // 3) At rest it is ciphertext only — the plaintext key is NOT in localStorage
  const raw = await page.evaluate(() => localStorage.getItem("forge_vault_v1"));
  expect(raw).toBeTruthy();
  expect(raw).not.toContain("SECRET-GEMINI-123");
  expect(raw).toContain("\"ct\"");

  // 4) Re-lock and unlock with the passcode restores it
  await page.getByRole("button", { name: /LOCK/ }).click();
  await expect(page.getByText("ENTER ACCESS CODE")).toBeVisible();
  await page.getByPlaceholder("••••").fill("test-pass");
  await page.getByRole("button", { name: "UNLOCK" }).click();
  await expect(page.getByText(/SET · SE••••23/)).toBeVisible({ timeout: 5_000 });
});

test("Settings PERSONA tab shows presets", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByText("PERSONA", { exact: true }).first().click();
  await expect(page.getByRole("button", { name: "JARVIS" })).toBeVisible();
  await expect(page.getByText("FRIENDLY")).toBeVisible();
  await expect(page.getByText("SECRETARY")).toBeVisible();
  await expect(page.getByText("TACTICAL")).toBeVisible();
});

test("Settings DIAGNOSTICS tab shows connection status", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  // Scope to the tab button — the CORE tab's AI-provider note also mentions
  // "DIAGNOSTICS", so a plain getByText would match two elements.
  await page.getByRole("button", { name: "DIAGNOSTICS" }).click();
  await expect(page.getByText("LINK STATUS")).toBeVisible();
  await expect(page.getByText("FRONTEND")).toBeVisible();
});

test("Settings close button works", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible();
  // The backdrop fills the screen but its centre is under the panel; click a
  // top corner so the close isn't intercepted by the modal content.
  await page.getByLabel("Close settings").click({ position: { x: 8, y: 8 } });
  await expect(page.getByText("CORE SETTINGS")).not.toBeVisible({ timeout: 3_000 });
});

/* ── Navigation (via mode launcher) ─────────────────────────────── */
test("STUDIO のタブは「何を作るか」で並ぶ（アプリの入口は1つだけ）", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "STUDIO");
  // 以前は FORGE の中にも APP があり、隣の「アプリ」タブと重なっていた
  await expect(page.getByRole("button", { name: /▣ アプリ/ })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /◫ LP・ホームページ/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /✦ 素材/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /AI STUDIO/ })).toBeVisible();
  // 既定は「アプリ」。その場で動くものが作れる入口を最初に見せる
  // （オフラインでは中身の代わりに案内が出る）
  await expect(page.getByText(/Webアプリ作成は/)).toBeVisible({ timeout: 3_000 });
  // APP という別入口は無い
  await expect(page.locator("button").filter({ hasText: /^APP$/ })).toHaveCount(0);
});

/* ── SNS mode + LP builder (ui-r37) ── */
test("SNS mode renders the post-support UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "SNS");
  // Offline → the panel explains it needs the backend
  await expect(page.getByText(/SNSサポートはバックエンド接続後/)).toBeVisible({ timeout: 5_000 });
});

test("STUDIO has an LP/HP builder tab", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "STUDIO");
  await page.getByRole("button", { name: /LP・ホームページ/ }).click();
  await expect(page.getByText(/LP \/ HP作成はバックエンド接続後/)).toBeVisible({ timeout: 5_000 });
  // 素材タブにも戻れる
  await page.getByRole("button", { name: /✦ 素材/ }).click();
  await expect(page.locator("button").filter({ hasText: /^IMAGE$/ }).first()).toBeVisible({ timeout: 5_000 });
});

/* ── ① Web app builder / ② image studio (ui-r38) ── */
test("STUDIO has a Web app builder tab", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "STUDIO");
  await page.getByRole("button", { name: /▣ アプリ/ }).click();
  await expect(page.getByText(/Webアプリ作成はバックエンド接続後/)).toBeVisible({ timeout: 5_000 });
});

test("STUDIO workshop tab persists across reload", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "STUDIO");
  await page.getByRole("button", { name: /▣ アプリ/ }).click();
  await expect(page.getByText(/Webアプリ作成はバックエンド接続後/)).toBeVisible({ timeout: 5_000 });
  await page.reload();
  await enterApp(page);
  await expect(page.getByText(/Webアプリ作成はバックエンド接続後/)).toBeVisible({ timeout: 8_000 });
});

test("素材タブの IMAGE は専用の画像スタジオを開く", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "STUDIO");
  await page.getByRole("button", { name: /✦ 素材/ }).click();
  await page.locator("button").filter({ hasText: /^IMAGE$/ }).first().click();
  await expect(page.getByText(/画像作成はバックエンド接続後/)).toBeVisible({ timeout: 5_000 });
});

/* ④ スライドの1枚ごと編集は生成物ビューア内にあり、生成物パネル自体が
   バックエンド接続時のみ表示されるため、この offline スイートでは到達できない。
   実UIの検証はモックバックエンドを使ったスクショ検証で行っている。 */

/* ── CAPTURE: 文字起こし/ナレーションはバックエンド接続後（offlineでも案内は出る） ── */
test("CAPTURE explains that transcription needs the backend", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "CAPTURE");
  await expect(page.getByText("画面録画・録音")).toBeVisible({ timeout: 5_000 });
  // 録る前はAIパネルを出さない（対象が無いのにボタンだけあるのを避ける）
  await expect(page.getByText(/AI — 文字起こし/)).toHaveCount(0);
});

/* ── ⑪ HOME: ウィジェットの並べ替え・表示切替（ロック画面のようなカスタム性） ── */
test("HOME widgets can be reordered, hidden, restored and remembered", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "HOME");
  const ids = () => page.locator("[data-widget]").evaluateAll(
    (els) => els.map((e) => e.getAttribute("data-widget")));
  await expect(page.locator("[data-widget]").first()).toBeVisible({ timeout: 8_000 });
  // 先頭は「既定の並びのうち、隠れていない最初の物」。ウィジェットが
  // 増減しても壊れないよう、名前を直書きしない。
  const firstShown = DEFAULT_ORDER.filter((id) => !DEFAULT_HIDDEN.includes(id))[0];
  expect((await ids())[0]).toBe(firstShown);

  // カスタマイズに入る
  await page.getByRole("button", { name: /カスタマイズ/ }).click();
  await expect(page.getByText("非表示（タップで戻す）")).toBeVisible({ timeout: 5_000 });

  // 計器盤を先頭へ（間に何個あっても届くよう、先頭に来るまで押す）
  for (let i = 0; i < 8 && (await ids())[0] !== "dials"; i++) {
    await page.getByLabel("計器盤を前へ").click();
  }
  await expect.poll(async () => (await ids())[0]).toBe("dials");

  // 通知を隠す → トレイから戻すと元の位置に返る
  const before = await ids();
  await page.getByLabel("通知を隠す").click();
  await expect.poll(async () => (await ids()).includes("notifications")).toBe(false);
  await page.getByLabel("通知を表示する").click();
  await expect.poll(async () => await ids()).toEqual(before);

  // 完了すると操作バーは消える
  await page.getByRole("button", { name: /✓ 完了/ }).click();
  await expect(page.getByLabel("計器盤を前へ")).toHaveCount(0);

  // 再読込しても並びは残る
  await page.reload();
  await enterApp(page);
  await expect.poll(async () => (await ids())[0], { timeout: 10_000 }).toBe("dials");

  // 既定に戻せる
  await page.getByRole("button", { name: /カスタマイズ/ }).click();
  await page.getByRole("button", { name: /既定の並びに戻す/ }).click();
  await expect.poll(async () => (await ids())[0]).toBe(firstShown);
});

/* ── ⑩ CHAT: 会話 / 司令塔（実行）の切替（offlineでも切替とヒントは確認できる） ── */
test("CHAT can switch between conversation and agent (司令塔) mode", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // 既定は会話モード（エージェントの説明は出ていない）
  await expect(page.getByRole("button", { name: "💬 会話" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/30種の道具/)).toBeHidden();

  // 司令塔モードにすると、何ができるかと承認の設定が出る
  await page.getByRole("button", { name: /実行（司令塔）/ }).click();
  await expect(page.getByText(/30種の道具/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("取り消せない操作は確認する")).toBeVisible();
  await expect(page.getByPlaceholder(/やってほしいことを指示/)).toBeVisible();

  // 選んだモードは記憶される
  await page.reload();
  await enterApp(page);
  await expect(page.getByText(/30種の道具/)).toBeVisible({ timeout: 8_000 });
});

/* ── ⑨ BOARD: multi-select + edge styles (works offline) ──
   既定のビューポートはスマホ幅なのでキャンバスが狭く、座標指定が枠外に出る。
   範囲選択の検証にはPC幅が必要なのでここだけ広げる。 */
test.describe("board on desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("BOARD multi-selects stickies and acts on them together", async ({ page }) => {
    await page.goto("/");
    await enterApp(page);
    await goMode(page, "BOARD");
    // モード選択パネルの全面backdropが残っていると最初のクリックを吸われるので、
    // 閉じきるのを待ってからキャンバスを触る。
    await expect(page.locator("nav").filter({ hasText: "MODES" })).toBeHidden({ timeout: 8_000 });
    const canvas = page.locator("[data-board-canvas]");
    await expect(canvas).toBeVisible({ timeout: 8_000 });
    // ボードが読み込み終わるまで待つ（未読込だとダブルクリックが空振りする）。
    // 座標はレイアウトが落ち着いた後に取る（先に取ると枠外を叩いてしまう）。
    // 併用技の案内は loaded のときだけ、かつ広い画面でだけ出るので、合図に使える。
    await expect(page.getByText(/Shift\+ドラッグで範囲選択/)).toBeVisible({ timeout: 8_000 });
    const box = (await canvas.boundingBox())!;

    // 付箋を3つ作る。連続ダブルクリックは3連打として扱われることがあるので間を置く
    for (const [x, y] of [[220, 180], [430, 180], [640, 340]]) {
      await page.mouse.dblclick(box.x + x, box.y + y);
      await page.waitForTimeout(250);
    }
    await expect(page.locator("[data-note]")).toHaveCount(3);

    // Shift+ドラッグの範囲選択で左の2つだけを掴む
    await page.keyboard.down("Shift");
    await page.mouse.move(box.x + 100, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 220, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(page.locator('[data-note][data-selected="1"]')).toHaveCount(2);
    await expect(page.getByText("2件選択")).toBeVisible();

    // まとめて削除すると残り1件
    await page.getByLabel("選択中をまとめて削除").click();
    await expect(page.locator("[data-note]")).toHaveCount(1);
  });
});

/* ── CODE: cross-file search (works offline) ── */
test("CODE searches across the workspace files", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "CODE");
  await page.getByText("WEBアプリ (index.html)").click();
  await expect(page.getByText("index.html").first()).toBeVisible({ timeout: 8_000 });

  // 別ファイルを足して、その中身を検索で引く
  page.once("dialog", (d) => void d.accept("notes.js"));
  await page.getByLabel("Add file").click();
  await page.locator('textarea[aria-label^="Edit"]').fill("const marker = 'findMeHere';");

  await page.getByLabel("ファイルを検索").fill("findMeHere");
  await expect(page.getByText(/notes\.js:1/)).toBeVisible({ timeout: 5_000 });
  // 見つからない語では正直に伝える
  await page.getByLabel("ファイルを検索").fill("zzz-not-present");
  await expect(page.getByText("見つかりません")).toBeVisible();
});

/* ── ⑧ CODE: run + test in a browser sandbox (works offline) ── */
test("CODE can run the workspace and execute tests in the sandbox", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "CODE");
  // Webスターターでワークスペースを用意
  await page.getByText("WEBアプリ (index.html)").click();
  await expect(page.getByText("index.html").first()).toBeVisible({ timeout: 8_000 });

  // 実行 → CONSOLE パネルが開く
  await page.getByRole("button", { name: /▶ 実行/ }).click();
  await expect(page.getByText(/CONSOLE/)).toBeVisible({ timeout: 8_000 });

  // *.test.js を足すとテストが実行できるようになる
  const testBtn = page.getByRole("button", { name: /✓ テスト/ });
  await expect(testBtn).toBeDisabled();
  page.once("dialog", (d) => void d.accept("calc.test.js"));
  await page.getByLabel("Add file").click();
  await page.locator('textarea[aria-label^="Edit"]').fill(
    'test("通る", function(){ expect(1+1).toBe(2); });\n'
    + 'test("落ちる", function(){ expect(1+1).toBe(3); });',
  );
  await expect(testBtn).toBeEnabled();
  await testBtn.click();
  // 本当に実行され、成功/失敗が出る
  await expect(page.getByText(/1\/2 成功/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/期待 3 \/ 実際 2/)).toBeVisible();
});

/* ⑦ VAULT の資料取り込み（PDFはサーバー抽出）・出典表示・資料削除は、
   ノートブックが1つ以上ある状態でしか画面に出ない＝バックエンド接続が前提。
   この offline スイートでは到達できないため、モックバックエンドを使った
   スクショ検証で確認している（PDFの実抽出・出典の番号一致・削除後の再採番）。 */

/* ── ⑥ AUTO mode explains itself and points at the other two builders ── */
test("AUTO mode explains what AUTOPILOT is and when to use the others", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "AUTO");
  await expect(page.getByText("オートパイロット とは")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/ゴールだけ決めて/)).toBeVisible();
  // 3つの「手順を並べる」機能の使い分けを示す（同じ説明を3画面で共有している）
  await expect(page.getByText(/STUDIO › AI STUDIO の ?ワークフロー/)).toBeVisible();
  await expect(page.getByText(/BOARD › AUTOMATION の ?自動化/)).toBeVisible();
});

/* ── ⑤ AI STUDIO: per-step AI / knowledge / condition (ui-r41) ── */
test("AI STUDIO workflow steps can be assigned an AI, knowledge and a condition", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "AI STUDIO");
  await page.getByRole("button", { name: "WORKFLOWS" }).click();
  await page.getByRole("button", { name: /\+ NEW WORKFLOW/ }).click();
  // Each step exposes the three Dify-like controls (offline → selectors are empty
  // but present, so a workflow can still be composed).
  await expect(page.getByLabel("ステップ1の担当AI")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel("ステップ1の根拠資料")).toBeVisible();
  await expect(page.getByLabel("ステップ1の条件")).toBeVisible();
  // Adding a step gives the new one its own controls
  await page.getByRole("button", { name: /\+ ADD STEP/ }).click();
  await expect(page.getByLabel("ステップ2の条件")).toBeVisible({ timeout: 5_000 });
});

/* ── ③ Video (storyboard-based) ── */
test("素材の VIDEO は絵コンテの動画パネルを開く", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "素材");
  await page.locator("button").filter({ hasText: /^VIDEO$/ }).first().click();
  await expect(page.getByText(/動画作成はバックエンド接続後/)).toBeVisible({ timeout: 5_000 });
});

/* ── CAPTURE mode (screen / audio recording) ── */
test("CAPTURE mode renders the recorder UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "CAPTURE");
  await expect(page.getByText("画面録画・録音")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "録画開始" })).toBeVisible();
  await expect(page.getByText("音声のみ")).toBeVisible();
});

test("VAULT renders vault UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "VAULT");
  await expect(page.getByText("NOTEBOOKS").first()).toBeVisible({ timeout: 5_000 });
});

test("TASKS renders tasks UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "TASKS");
  await expect(page.getByText("NEW TASK")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("PENDING").first()).toBeVisible();
});

test("INCOME has a SEO tab with the programmatic-SEO builder", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "INCOME");
  await page.getByRole("button", { name: /SEOページ/ }).click();
  // Offline (no API_URL) → the panel explains it needs the backend.
  await expect(page.getByText(/Programmatic SEO/)).toBeVisible({ timeout: 5_000 });
  // Back to the approval queue
  await page.getByRole("button", { name: /承認キュー/ }).click();
  await expect(page.getByText("NEW THEME")).toBeVisible({ timeout: 5_000 });
});

test("INCOME has a newsletter tab", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "INCOME");
  await page.getByRole("button", { name: /ニュースレター/ }).click();
  // Offline → the panel explains it needs the backend
  await expect(page.getByText(/ニュースレターはバックエンド接続後/)).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: /承認キュー/ }).click();
  await expect(page.getByText("NEW THEME")).toBeVisible({ timeout: 5_000 });
});

test("INCOME renders income UI + setup guide", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "INCOME");
  await expect(page.getByText("NEW THEME")).toBeVisible({ timeout: 5_000 });
  // Setup guide ("what you need to do") is shown and collapsible
  await expect(page.getByText(/副業自動化セットアップ/)).toBeVisible();
  await expect(page.getByText("基盤をつなぐ（必須）")).toBeVisible();
  await page.getByText(/副業自動化セットアップ/).click();
  await expect(page.getByText("基盤をつなぐ（必須）")).not.toBeVisible({ timeout: 3_000 });
});

test("STUDIO renders studio UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "AI STUDIO");
  await expect(page.getByRole("button", { name: "CUSTOM AI", exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "WORKFLOWS", exact: true })).toBeVisible();
});

test("ARCHIVE renders archive UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "ARCHIVE");
  await expect(page.getByText(/ARCHIVE|NO APPS/i).first()).toBeVisible({ timeout: 5_000 });
});

test("AUTO renders autopilot UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "AUTO");
  await expect(page.getByText(/NEW MISSION/i)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("SET GOAL & DECOMPOSE")).toBeVisible();
});

test("BOARD opens the Miro whiteboard by default; AUTOMATION tab keeps the builder", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "BOARD");
  // Whiteboard toolbar (default tab)
  await expect(page.getByRole("button", { name: "＋ 付箋" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/何もない所をダブルクリック/)).toBeVisible();
  // Switch to the automation tab — Zapier-copilot hero + manual builder
  await page.getByRole("button", { name: "⚡ AUTOMATION" }).click();
  await expect(page.getByText("AUTOMATION COPILOT")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("何を自動化しますか？")).toBeVisible();
  await page.getByText(/手動ビルダー/).click();
  await expect(page.getByText("AUTOMATION NAME")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("+ ADD STEP")).toBeVisible();
});

test("BOARD whiteboard: add a sticky, type, and it persists across reload", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "BOARD");
  await page.getByRole("button", { name: "＋ 付箋" }).click();
  // The new sticky opens in edit mode — type and commit by blurring.
  const ta = page.getByPlaceholder("メモを書く…");
  await expect(ta).toBeVisible({ timeout: 5_000 });
  await ta.fill("アイデア：新機能X");
  await page.locator("[data-board-canvas]").click({ position: { x: 10, y: 10 } });
  await expect(page.getByText("アイデア：新機能X")).toBeVisible();
  // Offline (no API_URL) → saved to localStorage; survives a reload.
  await page.waitForTimeout(1200);
  await page.reload();
  await enterApp(page);
  await goMode(page, "BOARD");
  await expect(page.getByText("アイデア：新機能X")).toBeVisible({ timeout: 8_000 });
});

test("BOARD supports multiple boards (create, switch, isolate, persist)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "BOARD");
  // Default board tab exists
  await expect(page.getByRole("button", { name: /メインボード/ })).toBeVisible({ timeout: 5_000 });

  // Create a second board (prompt → accept with a name)
  page.once("dialog", (d) => void d.accept("企画ボード"));
  await page.getByRole("button", { name: "＋ ボード" }).click();
  await expect(page.getByRole("button", { name: /企画ボード/ })).toBeVisible({ timeout: 5_000 });

  // Add a sticky on board 2
  await page.getByRole("button", { name: "＋ 付箋" }).click();
  const ta = page.getByPlaceholder("メモを書く…");
  await ta.fill("B2だけのメモ");
  await page.locator("[data-board-canvas]").click({ position: { x: 10, y: 10 } });
  await expect(page.getByText("B2だけのメモ")).toBeVisible();

  // Switch to board 1 → the note is NOT there; switch back → it is
  await page.getByRole("button", { name: /メインボード/ }).click();
  await expect(page.getByText("B2だけのメモ")).toBeHidden({ timeout: 5_000 });
  await page.getByRole("button", { name: /企画ボード/ }).click();
  await expect(page.getByText("B2だけのメモ")).toBeVisible({ timeout: 5_000 });

  // Persists across reload (offline → localStorage multi-board store)
  await page.waitForTimeout(1200);
  await page.reload();
  await enterApp(page);
  await goMode(page, "BOARD");
  await expect(page.getByText("B2だけのメモ")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("button", { name: /メインボード/ })).toBeVisible();
});

test("BOARD whiteboard undo removes the last change (Ctrl+Z)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "BOARD");
  await page.getByRole("button", { name: "＋ 付箋" }).click();
  const ta = page.getByPlaceholder("メモを書く…");
  await ta.fill("取り消される運命のメモ");
  await page.locator("[data-board-canvas]").click({ position: { x: 10, y: 10 } });
  await expect(page.getByText("取り消される運命のメモ")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(page.getByText("取り消される運命のメモ")).toBeHidden({ timeout: 5_000 });
});

test("TASKS kanban view shows status columns with drop zones", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "TASKS");
  await page.getByRole("button", { name: "⊞ KANBAN" }).click();
  await expect(page.locator("[data-col='pending']")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("[data-col='completed']")).toBeVisible();
  await expect(page.getByText("IN PROGRESS")).toBeVisible();
  // 戻す（他テストは list ビュー前提）
  await page.getByRole("button", { name: "☰ LIST" }).click();
  await expect(page.getByRole("button", { name: "DONE" })).toBeVisible();
});

/* ── TASKS feature ────────────────────────────────────────────────── */
test("Tasks: can create a task (no backend — shows error or offline)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "TASKS");
  await page.fill("input[placeholder='タスクのタイトル…']", "テストタスク");
  await page.click("text=ADD TASK");
  await page.waitForTimeout(1000);
  const taskRow = page.getByText("テストタスク");
  const errorPanel = page.getByText("⚠️");
  await expect(taskRow.or(errorPanel).first()).toBeVisible({ timeout: 5_000 });
});

test("Tasks: filter tabs are visible", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "TASKS");
  await expect(page.getByText("ALL").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "DONE" })).toBeVisible();
});

/* ── STUDIO feature ───────────────────────────────────────────────── */
test("Studio: create AI form expands", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "AI STUDIO");
  await page.click("text=+ NEW CUSTOM AI");
  await expect(page.getByText("AI NAME")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("PERSONA")).toBeVisible();
});

test("Studio: workflow tab shows workflow form", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "AI STUDIO");
  await page.click("text=WORKFLOWS");
  await page.click("text=+ NEW WORKFLOW");
  await expect(page.getByText("WORKFLOW NAME")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("STEPS")).toBeVisible();
});

test("Studio: EVOLVE tab shows self-evolution mode", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "AI STUDIO");
  await page.getByRole("button", { name: "EVOLVE", exact: true }).click();
  await expect(page.getByText(/SELF-EVOLVE/i)).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("PROPOSE EVOLUTION")).toBeVisible();
});

/* ── FORGE feature ────────────────────────────────────────────────── */
test("素材: 指示を書く欄がある", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "素材");
  // 既定は IMAGE。APP は「アプリ」タブに一本化したのでここには無い
  await expect(page.locator("button").filter({ hasText: /^IMAGE$/ }).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("button").filter({ hasText: /^APP$/ })).toHaveCount(0);
  // 画像は専用スタジオなので、素の生成フォームは他の種類で見る
  await page.locator("button").filter({ hasText: /^DOC$/ }).first().click();
  await expect(page.locator("textarea").first()).toBeVisible();
});

test("Forge: shows the artifact placeholder before generating", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "素材");
  await page.locator("button").filter({ hasText: /^DOC$/ }).first().click();
  await expect(page.getByText("ここに生成結果が表示されます")).toBeVisible({ timeout: 5_000 });
});

test("素材: VIDEO タブは動画パネルに切り替わる", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "素材");
  await expect(page.locator("button").filter({ hasText: /^IMAGE$/ }).first()).toBeVisible({ timeout: 5_000 });
  await page.locator("button").filter({ hasText: /^VIDEO$/ }).click();
  await expect(page.getByText(/VIDEO|SCENE|NARRATION/i).first()).toBeVisible({ timeout: 5_000 });
});

/* ── VAULT feature ────────────────────────────────────────────────── */
test("Vault: file drop zone is visible", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "VAULT");
  await expect(page.getByPlaceholder("新しいノートブック名")).toBeVisible({ timeout: 5_000 });
});

/* ── BRIEFING button ──────────────────────────────────────────────── */
test("Briefing button is visible in top bar", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await expect(page.getByText("BRIEF")).toBeVisible();
});

test("Briefing opens a panel and closes again", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByText("BRIEF").click();
  await expect(page.getByText("BRIEFING")).toBeVisible({ timeout: 5_000 });
  await page.getByLabel("Close").click();
  await expect(page.getByText("BRIEFING")).not.toBeVisible({ timeout: 3_000 });
});

/* ── Functional: Forge generate enables after typing ──────────────── */
test("素材: 指示を書くと生成ボタンが押せるようになる", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goWorkshop(page, "素材");
  await page.locator("button").filter({ hasText: /^DOC$/ }).first().click();
  const genBtn = page.getByRole("button", { name: /GENERATE DOC/i });
  await expect(genBtn).toBeDisabled();
  await page.locator("textarea").first().fill("家計簿アプリ");
  await expect(genBtn).toBeEnabled();
});

/* ── Functional: Home cockpit panels present ──────────────────────── */
test("HOME shows agenda + notifications panels", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "HOME");
  await expect(page.getByText("予定 — AGENDA")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("通知 — NOTIFICATIONS")).toBeVisible();
});

/* ── Desktop layout (wide viewport) ─────────────────────────────── */
test.describe("desktop layout", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Chat history opens as a full-height left panel", async ({ page }) => {
    await page.goto("/");
    await enterApp(page);
    await page.getByLabel("Chat history").click();
    const newChat = page.getByText("＋ 新しいチャット");
    await expect(newChat).toBeVisible({ timeout: 5_000 });
    const panelBox = await newChat.boundingBox();
    const inputBox = await page.getByPlaceholder("AIbou にメッセージ…").boundingBox();
    // Panel hugs the left edge (well left of the centred conversation) and is tall
    expect(panelBox!.x).toBeLessThan(inputBox!.x);
    expect(panelBox!.x).toBeLessThan(120);
  });

  test("Tasks uses a two-column layout on desktop", async ({ page }) => {
    await page.goto("/");
    await enterApp(page);
    await goMode(page, "TASKS");
    // NEW TASK (left column) and the list area both render
    await expect(page.getByText("NEW TASK")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "DONE" })).toBeVisible();
  });
});

/* ── Accessibility / no crash checks ─────────────────────────────── */
/* ── ME mode (ui-r18): life partner with the experience box ── */
test("ME mode renders life partner intro + experience box", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "ME");
  await expect(page.getByText("LIFE PARTNER")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("📦 経験の箱")).toBeVisible();
  // Offline → the box explains it needs the backend
  await expect(page.getByText(/バックエンド未接続のため箱は使えません/)).toBeVisible();
  // data-mode retint
  await expect(page.locator("main[data-mode='me']")).toBeAttached();
});

test("ME: consultation send fails gracefully offline", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "ME");
  await page.getByPlaceholder(/なんでも相談/).fill("お金の相談をしたい");
  await page.keyboard.press("Enter");
  await expect(page.getByText("お金の相談をしたい")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("text=⚠").first()).toBeVisible({ timeout: 8_000 });
});

/* ── GitHub integration (ui-r17): open a repo, code, push ── */
test("CODE: GitHub section offers repo list and errors gracefully offline", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "CODE");
  await expect(page.getByText("GITHUBから開く")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("GITHUB_TOKEN")).toBeVisible(); // setup hint
  await page.getByRole("button", { name: "リポジトリ一覧を取得" }).click();
  // Offline → requireApiUrl error surfaces inline, no crash
  await expect(page.locator("text=⚠").first()).toBeVisible({ timeout: 8_000 });
});

/* ── Phase B (ui-r16): markdown rendering + mode theme colors ── */
test("CHAT renders assistant markdown with highlighted code + copy", async ({ page }) => {
  // Seed a saved conversation whose assistant reply contains rich markdown.
  await page.addInitScript(() => {
    const convo = {
      id: "seed-1",
      title: "markdown test",
      updatedAt: Date.now(),
      messages: [
        { id: "m1", role: "user", content: "コード例を見せて" },
        {
          id: "m2",
          role: "assistant",
          content: "# 見出し\n\n- 箇条書き1\n- **太字**項目\n\n```python\nprint('hello forge')\n```",
        },
      ],
    };
    localStorage.setItem("forge_chat_convos", JSON.stringify([convo]));
  });
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Chat history").click();
  await page.getByText("markdown test").click();
  // Markdown structures render as real elements (not literal symbols)
  await expect(page.locator(".md h1", { hasText: "見出し" })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".md li strong", { hasText: "太字" })).toBeVisible();
  await expect(page.locator(".md-codeblock code")).toContainText("print");
  await expect(page.locator(".md-codebar button")).toBeVisible(); // copy button
});

test("Mode switch retints the accent (data-mode)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await expect(page.locator("main[data-mode='chat']")).toBeAttached();
  await goMode(page, "CAPTURE");
  await expect(page.locator("main[data-mode='capture']")).toBeAttached({ timeout: 5_000 });
  const accent = await page.evaluate(() =>
    getComputedStyle(document.querySelector("main")!).getPropertyValue("--accent").trim(),
  );
  expect(accent).toBe("#ff7a7a");
});

/* ── 下のナビ：実行 / 管理 / 設定 の3つだけ ──
 *
 * 以前は4モード＋⋯で、⋯の中に14タイルが並んでいた。行き先が15個あって、
 * 開くたびに「どこへ行くか」を決めさせていた。いまは2つに畳んで、残りは
 * 管理タブの「もっと」からたどる。画面は1つも消していないので、
 * ここでは「畳んだ先に本当に届くか」を見る。 */
test("下のナビは実行と管理の2つで、残りは管理の「もっと」から届く", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await enterApp(page);
  const nav = page.getByLabel("Mobile navigation");
  await expect(nav).toBeVisible();

  // 行き先は3つ（実行・管理・設定）だけ
  await expect(nav.locator("button")).toHaveCount(3);
  await expect(nav.getByText("実行", { exact: true })).toBeVisible();
  await expect(nav.getByText("管理", { exact: true })).toBeVisible();

  // 実行タブは会話。会話欄はアプリ全体でここ1つ。
  await expect(page.getByPlaceholder("AIbou にメッセージ…")).toBeVisible({ timeout: 5_000 });

  // 管理タブ → 「今日」から始まり、切り替えでタスクへ行ける
  await nav.getByText("管理", { exact: true }).click();
  await expect(page.getByText("PERSONAL COCKPIT")).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "タスク", exact: true }).click();
  await expect(page.getByText("NEW TASK")).toBeVisible({ timeout: 5_000 });

  // ナビから消した画面も、「もっと」で行き止まりにならない
  await page.getByRole("button", { name: /もっと/ }).click();
  await page.getByRole("button", { name: /録音/ }).click();
  await expect(page.getByText("画面録画・録音")).toBeVisible({ timeout: 5_000 });
});

/* ── CODE deep mode + AI provider settings (ui-r21) ── */
test("CODE has a 深く考える toggle", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "CODE");
  await page.getByText("WEBアプリ (index.html)").click();
  await expect(page.getByText("🧠 深く考える")).toBeVisible({ timeout: 5_000 });
  await page.getByText("🧠 深く考える").click();
  await expect(page.getByText("計画→実装→自己レビュー")).toBeVisible();
});

test("Settings CORE shows AI provider section (offline note)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  // Offline → the AI provider panel explains it needs the backend
  await expect(page.getByText(/AIプロバイダ.*モデルの選択は、バックエンド接続後/)).toBeVisible({ timeout: 5_000 });
});

/* ── Google + DB integrations (ui-r24) ── */
test("Settings CORE shows Google/DB integration note (offline)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText(/Google連携・DB永続化は、バックエンド接続後/)).toBeVisible({ timeout: 5_000 });
});

test("KEYCHAIN includes a Google key with its issuance guide", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openRawKeyEditor(page);
  await expect(page.getByText("SET ACCESS CODE")).toBeVisible({ timeout: 5_000 });
  await page.getByPlaceholder("パスコード（4文字以上）").fill("test-pass");
  await page.getByPlaceholder("確認のためもう一度").fill("test-pass");
  await page.getByRole("button", { name: "CREATE VAULT" }).click();
  await expect(page.getByText("オフライン下書き · UNLOCKED")).toBeVisible({ timeout: 5_000 });
  const gRow = page.locator("div.rounded-forge").filter({ hasText: "Google Client ID" });
  await gRow.getByLabel("発行手順").first().click();
  await expect(page.getByRole("link", { name: /Google Cloud/ })).toBeVisible({ timeout: 5_000 });
});

test("KEYCHAIN includes an email key with its issuance guide", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openRawKeyEditor(page);
  await expect(page.getByText("SET ACCESS CODE")).toBeVisible({ timeout: 5_000 });
  await page.getByPlaceholder("パスコード（4文字以上）").fill("test-pass");
  await page.getByPlaceholder("確認のためもう一度").fill("test-pass");
  await page.getByRole("button", { name: "CREATE VAULT" }).click();
  await expect(page.getByText("オフライン下書き · UNLOCKED")).toBeVisible({ timeout: 5_000 });
  const mailRow = page.locator("div.rounded-forge").filter({ hasText: "メール アプリパスワード" });
  await mailRow.getByLabel("発行手順").first().click();
  await expect(page.getByRole("link", { name: /アプリパスワード/ })).toBeVisible({ timeout: 5_000 });
});

/* ── HOME cockpit: agent console + instrument cluster (ui-r22) ──
 *
 * エージェント欄は既定で隠している（会話は実行タブに1つ）。ただし
 * **消してはいない**ので、戻した人にはこれまで通り出る必要がある。
 * ここはその「戻せる」ことの担保も兼ねる。 */
async function showAgentWidget(page: Page) {
  await goMode(page, "HOME");
  await page.getByRole("button", { name: /カスタマイズ/ }).click();
  await page.getByLabel("エージェントを表示する").click();
  await page.getByRole("button", { name: /✓ 完了/ }).click();
}

test("HOME agent console renders with action suggestions", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await showAgentWidget(page);
  await expect(page.getByText("AGENT CONSOLE · 手足となって動く")).toBeVisible({ timeout: 5_000 });
  // Suggestion chips are visible (they drive the agent when connected)
  await expect(page.getByText("新規事業の提案スライドを作って")).toBeVisible();
});

/* ── Attachments: screenshot paste + file attach (ui-r26) ── */
test("CHAT composer hints screenshot paste", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // Default view is CHAT; the composer's hint line mentions Ctrl+V paste.
  // (It lives under the input, not in the placeholder — a long placeholder
  //  wraps and gets clipped on phone widths.)
  await expect(page.getByText(/画像はCtrl\+V/)).toBeVisible({ timeout: 5_000 });
});

test("HOME agent console has a file-attach button", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await showAgentWidget(page);
  await expect(page.getByTitle("ファイルを添付（PDF/テキスト）")).toBeVisible({ timeout: 5_000 });
});

/* ── Realtime voice conversation mode (ui-r27) ── */
test("CHAT voice mode opens a fullscreen overlay and exits", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // Chromium exposes webkitSpeechRecognition → the 会話モード button renders.
  const btn = page.getByLabel("会話モード");
  await expect(btn).toBeVisible({ timeout: 5_000 });
  await btn.click();
  await expect(page.getByText("VOICE MODE · 会話モード")).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: /終了/ }).click();
  await expect(page.getByText("VOICE MODE · 会話モード")).toBeHidden();
});

/* ── Fullscreen (focus) mode for any view ── */
test("Fullscreen toggle hides the CORE header and restores it", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  const orb = page.getByRole("img", { name: /THE FORGE OS core/i }).first();
  await expect(orb).toBeVisible();
  await page.getByLabel("Fullscreen").click();
  await expect(orb).toBeHidden();
  // The control now offers restore; clicking it brings the core back.
  await page.getByLabel("Restore").click();
  await expect(orb).toBeVisible();
});

/* ── KEYCHAIN per-key issuance guide ── */
test("KEYCHAIN: a key's ? button reveals its issuance guide", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openRawKeyEditor(page);
  // Create the offline vault so the preset key rows render.
  await expect(page.getByText("SET ACCESS CODE")).toBeVisible({ timeout: 5_000 });
  await page.getByPlaceholder("パスコード（4文字以上）").fill("test-pass");
  await page.getByPlaceholder("確認のためもう一度").fill("test-pass");
  await page.getByRole("button", { name: "CREATE VAULT" }).click();
  await expect(page.getByText("オフライン下書き · UNLOCKED")).toBeVisible({ timeout: 5_000 });
  // Open the Gemini key's step-by-step guide.
  const geminiRow = page.locator("div.rounded-forge").filter({ hasText: "Gemini API Key" });
  await geminiRow.getByLabel("発行手順").first().click();
  // The guide panel exposes the official issuance link (unique to the guide).
  await expect(page.getByRole("link", { name: /Google AI Studio/ })).toBeVisible({ timeout: 5_000 });
});

/* ── Notion key + guide (ui-r23 agent tools) ── */
test("KEYCHAIN includes a Notion key with its issuance guide", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openRawKeyEditor(page);
  await expect(page.getByText("SET ACCESS CODE")).toBeVisible({ timeout: 5_000 });
  await page.getByPlaceholder("パスコード（4文字以上）").fill("test-pass");
  await page.getByPlaceholder("確認のためもう一度").fill("test-pass");
  await page.getByRole("button", { name: "CREATE VAULT" }).click();
  await expect(page.getByText("オフライン下書き · UNLOCKED")).toBeVisible({ timeout: 5_000 });
  const notionRow = page.locator("div.rounded-forge").filter({ hasText: "Notion Token" });
  await notionRow.getByLabel("発行手順").first().click();
  await expect(page.getByRole("link", { name: /My integrations/ })).toBeVisible({ timeout: 5_000 });
});

/* ── CODE mode (ui-r14): Claude Code-like coding agent ── */
test("CODE mode renders start screen with templates", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "CODE");
  await expect(page.getByText("AI CODING AGENT")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("WEBアプリ (index.html)")).toBeVisible();
});

test("CODE: web starter creates workspace with live preview and editor", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "CODE");
  await page.getByText("WEBアプリ (index.html)").click();
  // Workspace opens: file tree + preview iframe (starter is HTML)
  await expect(page.getByText("index.html").first()).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("iframe[title='preview']")).toBeAttached();
  // Toggle to CODE view → editor textarea with the file content
  await page.getByText("⌨ CODE", { exact: true }).click();
  await expect(page.getByLabel("Edit index.html")).toBeVisible();
  // Agent run offline → error turn appears in the log
  await page.getByPlaceholder("エージェントへの指示…（Enterで実行）").fill("タイマーアプリにして");
  await page.getByLabel("Run agent").click();
  await expect(page.locator("text=⚠").first()).toBeVisible({ timeout: 8_000 });
});

/* ── Quality pass (ui-r13): message actions / refresh / view persistence ── */
test("CHAT: failed send shows error bubble with 再生成 (retry)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.locator("textarea").first().fill("テストメッセージ");
  await page.keyboard.press("Enter");
  // Offline → the turn fails into an error bubble; ↻ 再生成 offers retry
  // (the typed message is preserved in the user bubble above it).
  await expect(page.getByText("テストメッセージ").first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("↻ 再生成")).toBeVisible({ timeout: 8_000 });
});

test("INCOME: queue has a manual refresh button", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "INCOME");
  await expect(page.getByRole("button", { name: /Refresh jobs/i })).toBeVisible({ timeout: 5_000 });
});

test("Active mode persists across reload", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "TASKS");
  await expect(page.getByText("NEW TASK")).toBeVisible({ timeout: 5_000 });
  await page.reload();
  await enterApp(page);
  await expect(page.getByText("NEW TASK")).toBeVisible({ timeout: 8_000 });
});

test("No JavaScript errors navigating all modes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/");
  await enterApp(page);
  for (const mode of ["CAPTURE", "VAULT", "TASKS", "INCOME", "STUDIO", "AUTO", "BOARD", "ARCHIVE", "HOME", "CHAT"]) {
    await goMode(page, mode);
    await page.waitForTimeout(300);
  }
  const critical = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("net::ERR") && !e.includes("Failed to fetch"),
  );
  expect(critical).toHaveLength(0);
});
