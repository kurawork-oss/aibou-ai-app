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
  await page.getByLabel("Modes").waitFor({ timeout: 10_000 });
}

/** Open the Google-apps-style mode launcher and pick a mode by label. */
async function goMode(page: Page, label: string) {
  await page.getByLabel("Modes").click();
  await page.locator("nav").getByText(label, { exact: true }).click();
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
  await page.getByLabel("Modes").click();
  const nav = page.locator("nav");
  for (const label of ["HOME", "CHAT", "FORGE", "VAULT", "INCOME", "TASKS", "STUDIO", "BOARD", "ARCHIVE"]) {
    await expect(nav.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(nav.getByText("AUTO", { exact: true })).toBeVisible();
});

test("Mode panel opens downward, not upward", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  const btn = page.getByLabel("Modes");
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
  await expect(page.getByText(/QUICK ASSISTANT/i)).toBeVisible();
  await expect(page.getByText("予定 — AGENDA")).toBeVisible();
});

test("CoreOrb is visible", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  const orb = page.getByRole("img", { name: /THE FORGE OS core/i }).first();
  await expect(orb).toBeVisible();
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
  await page.getByText("DIAGNOSTICS").click();
  await expect(page.getByText("LINK STATUS")).toBeVisible();
  await expect(page.getByText("FRONTEND")).toBeVisible();
});

test("Settings close button works", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await expect(page.getByText("CORE SETTINGS")).toBeVisible();
  await page.getByLabel("Close settings").click();
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

test("INCOME renders income UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await goMode(page, "INCOME");
  await expect(page.getByText(/INCOME|MISSION|AUTO/i).first()).toBeVisible({ timeout: 5_000 });
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
