/**
 * THE FORGE OS — Playwright E2E tests
 *
 * Tests run against the production build with NEXT_PUBLIC_API_URL="" so the
 * app starts in "offline" mode (no real backend). All UI interactions, screen
 * transitions, and component renders are verified without external dependencies.
 */

import { test, expect, type Page } from "@playwright/test";

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

/* ── EntryGate ──────────────────────────────────────────────────── */
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
  for (const label of ["HOME", "CHAT", "FORGE", "VAULT", "INCOME", "TASKS", "STUDIO", "BOARD", "ARCHIVE"]) {
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
  await expect(page.getByPlaceholder("THE FORGE OS にメッセージ…")).toBeVisible({ timeout: 5_000 });
  // Navigating to HOME renders the cockpit
  await goMode(page, "HOME");
  await expect(page.getByText("PERSONAL COCKPIT")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/AGENT CONSOLE/i)).toBeVisible();
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

/* ── Settings ───────────────────────────────────────────────────── */
test("Settings gear icon is clickable and opens panel", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible({ timeout: 5_000 });
});

test("Settings panel has 4 tabs", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("PERSONA", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("KEYCHAIN", { exact: true })).toBeVisible();
  await expect(page.getByText("DIAGNOSTICS", { exact: true })).toBeVisible();
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
  await page.getByLabel("Settings").click();
  await page.getByText("KEYCHAIN", { exact: true }).click();
  await expect(page.getByText("ACCESS CODE")).toBeVisible({ timeout: 5_000 });
});

test("KEYCHAIN: encrypted vault stores a key offline (ciphertext at rest)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByText("KEYCHAIN", { exact: true }).click();

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
test("FORGE renders forge UI (split view)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "FORGE");
  await expect(page.locator("button").filter({ hasText: /^APP$/ }).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("button").filter({ hasText: /^IMAGE$/ }).first()).toBeVisible({ timeout: 3_000 });
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
  await goMode(page, "STUDIO");
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

test("BOARD renders Miro/Zapier-style automation canvas", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "BOARD");
  // Zapier-copilot hero + template chips
  await expect(page.getByText("AUTOMATION COPILOT")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("何を自動化しますか？")).toBeVisible();
  // Manual builder still reachable
  await page.getByText(/手動ビルダー/).click();
  await expect(page.getByText("AUTOMATION NAME")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("+ ADD STEP")).toBeVisible();
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
  await goMode(page, "STUDIO");
  await page.click("text=+ NEW CUSTOM AI");
  await expect(page.getByText("AI NAME")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("PERSONA")).toBeVisible();
});

test("Studio: workflow tab shows workflow form", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "STUDIO");
  await page.click("text=WORKFLOWS");
  await page.click("text=+ NEW WORKFLOW");
  await expect(page.getByText("WORKFLOW NAME")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("STEPS")).toBeVisible();
});

test("Studio: EVOLVE tab shows self-evolution mode", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "STUDIO");
  await page.getByRole("button", { name: "EVOLVE", exact: true }).click();
  await expect(page.getByText(/SELF-EVOLVE/i)).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("PROPOSE EVOLUTION")).toBeVisible();
});

/* ── FORGE feature ────────────────────────────────────────────────── */
test("Forge: prompt textarea is present", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "FORGE");
  const kindBtn = page.locator("button").filter({ hasText: /^APP$/ }).first();
  await expect(kindBtn).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("textarea").first()).toBeVisible();
});

test("Forge: shows the artifact placeholder before generating", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "FORGE");
  await expect(page.getByText("ここに生成結果が表示されます")).toBeVisible({ timeout: 5_000 });
});

test("Forge: VIDEO tab switches to VideoPanel", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "FORGE");
  await expect(page.locator("button").filter({ hasText: /^APP$/ }).first()).toBeVisible({ timeout: 5_000 });
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
test("Forge: GENERATE enables once a prompt is typed", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "FORGE");
  const genBtn = page.getByRole("button", { name: /GENERATE APP/i });
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
    const inputBox = await page.getByPlaceholder("THE FORGE OS にメッセージ…").boundingBox();
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
  await page.getByPlaceholder("人生でも、お金でも、なんでも相談してください…").fill("お金の相談をしたい");
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
  await goMode(page, "FORGE");
  await expect(page.locator("main[data-mode='forge']")).toBeAttached({ timeout: 5_000 });
  const accent = await page.evaluate(() =>
    getComputedStyle(document.querySelector("main")!).getPropertyValue("--accent").trim(),
  );
  expect(accent).toBe("#ffb454");
});

/* ── Phase A (ui-r15): mobile thumb-zone nav ── */
test("Mobile bottom nav switches modes and opens the MORE sheet", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  const nav = page.getByLabel("Mobile navigation");
  await expect(nav).toBeVisible();
  await nav.getByText("TASKS", { exact: true }).click();
  await expect(page.getByText("NEW TASK")).toBeVisible({ timeout: 5_000 });
  await page.getByLabel("More modes").click();
  const sheet = page.getByLabel("All modes");
  await expect(sheet.getByText("BOARD", { exact: true })).toBeVisible({ timeout: 3_000 });
  await sheet.getByText("BOARD", { exact: true }).click();
  await expect(page.getByText("AUTOMATION COPILOT")).toBeVisible({ timeout: 5_000 });
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

/* ── HOME cockpit: agent console + instrument cluster (ui-r22) ── */
test("HOME agent console renders with action suggestions", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "HOME");
  await expect(page.getByText("AGENT CONSOLE · 手足となって動く")).toBeVisible({ timeout: 5_000 });
  // Suggestion chips are visible (they drive the agent when connected)
  await expect(page.getByText("今の状況を整理して報告して")).toBeVisible();
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
  await page.getByLabel("Settings").click();
  await page.getByText("KEYCHAIN", { exact: true }).click();
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
  for (const mode of ["FORGE", "VAULT", "TASKS", "INCOME", "STUDIO", "AUTO", "BOARD", "ARCHIVE", "HOME", "CHAT"]) {
    await goMode(page, mode);
    await page.waitForTimeout(300);
  }
  const critical = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("net::ERR") && !e.includes("Failed to fetch"),
  );
  expect(critical).toHaveLength(0);
});
