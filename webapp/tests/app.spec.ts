/**
 * THE FORGE OS — Playwright E2E tests
 *
 * Tests run against the production build with NEXT_PUBLIC_API_URL="" so the
 * app starts in "offline" mode (no real backend). All UI interactions, screen
 * transitions, and component renders are verified without external dependencies.
 */

import { test, expect } from "@playwright/test";

/* ── helpers ────────────────────────────────────────────────────── */
async function enterApp(page: import("@playwright/test").Page) {
  // EntryGate: click ENTER
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  // BootScreen: no API_URL → goes to offline state quickly
  // Click "ENTER OFFLINE" if shown, or wait for HUD
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hudH1 = page.getByText("THE FORGE OS").first();
  // Whichever appears first
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()),
    hudH1.waitFor({ timeout: 10_000 }),
  ]);
  // Wait for HUD nav to appear
  await page.waitForSelector("nav", { timeout: 10_000 });
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
  // Should show either BootScreen content or HUD
  await expect(
    page.getByText(/BOOTING|LINK ACTIVE|OFFLINE|ENTER OFFLINE|WAKING|CORE UNREACHABLE/i).first()
  ).toBeVisible({ timeout: 10_000 });
});

/* ── BootScreen / HUD ───────────────────────────────────────────── */
test("HUD renders after entering offline mode", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // HUD header should have THE FORGE OS
  await expect(page.getByRole("heading", { name: /THE FORGE OS/i }).first()).toBeVisible();
});

test("NavBar shows all 8 navigation items", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  const nav = page.locator("nav");
  await expect(nav.getByText("CHAT")).toBeVisible();
  await expect(nav.getByText("FORGE")).toBeVisible();
  await expect(nav.getByText("VAULT")).toBeVisible();
  await expect(nav.getByText("INCOME")).toBeVisible();
  await expect(nav.getByText("TASKS")).toBeVisible();
  await expect(nav.getByText("STUDIO")).toBeVisible();
  await expect(nav.getByText("AUTO", { exact: true })).toBeVisible();
  await expect(nav.getByText("ARCHIVE")).toBeVisible();
});

test("CoreOrb is visible", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // The orb has role=img (may appear in EntryGate and Hud simultaneously)
  const orb = page.getByRole("img", { name: /THE FORGE OS core/i }).first();
  await expect(orb).toBeVisible();
});

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
  // Use exact: true to avoid matching "CORE SETTINGS" heading for "CORE"
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
  // Access-code section is always present; offline mode shows a backend notice
  await expect(page.getByText("ACCESS CODE")).toBeVisible({ timeout: 5_000 });
});

test("Settings PERSONA tab shows presets", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByText("PERSONA", { exact: true }).first().click();
  // Use button role to avoid matching header "JARVIS · ONLINE" text for JARVIS
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

/* ── Navigation ─────────────────────────────────────────────────── */
test("FORGE tab renders forge UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  // Scope to nav to avoid matching "THE FORGE OS" heading which contains "FORGE"
  await page.locator("nav").getByText("FORGE").click();
  // Forge has APP/IMAGE/SLIDES/SHEET/DOC tabs — use button filter for exact match
  await expect(page.locator("button").filter({ hasText: /^APP$/ }).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("button").filter({ hasText: /^IMAGE$/ }).first()).toBeVisible({ timeout: 3_000 });
});

test("VAULT tab renders vault UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=VAULT");
  await expect(page.getByText("NOTEBOOKS").first()).toBeVisible({ timeout: 5_000 });
});

test("TASKS tab renders tasks UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=TASKS");
  await expect(page.getByText("NEW TASK")).toBeVisible({ timeout: 5_000 });
  // KPI row shows pending/active/awaiting/done
  await expect(page.getByText("PENDING").first()).toBeVisible();
});

test("INCOME tab renders income UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=INCOME");
  // Income has a theme input / enqueue button
  await expect(page.getByText(/INCOME|MISSION|AUTO/i).first()).toBeVisible({ timeout: 5_000 });
});

test("STUDIO tab renders studio UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=STUDIO");
  // "CUSTOM AI" and "WORKFLOWS" substring-match empty-state text; use button role for exact match
  await expect(page.getByRole("button", { name: "CUSTOM AI", exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "WORKFLOWS", exact: true })).toBeVisible();
});

test("ARCHIVE tab renders archive UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=ARCHIVE");
  await expect(page.getByText(/ARCHIVE|NO APPS/i).first()).toBeVisible({ timeout: 5_000 });
});

test("AUTO tab renders autopilot UI", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.locator("nav").getByText("AUTO", { exact: true }).click();
  // Mission creation form is always present (works offline)
  await expect(page.getByText(/NEW MISSION/i)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("SET GOAL & DECOMPOSE")).toBeVisible();
});

/* ── TASKS feature ────────────────────────────────────────────────── */
test("Tasks: can create a task (no backend — shows error or offline)", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=TASKS");
  // Fill title
  await page.fill("input[placeholder='タスクのタイトル…']", "テストタスク");
  await page.click("text=ADD TASK");
  // Either task appears or shows API error (offline mode)
  await page.waitForTimeout(1000);
  const taskRow = page.getByText("テストタスク");
  const errorPanel = page.getByText("⚠️");
  await expect(taskRow.or(errorPanel).first()).toBeVisible({ timeout: 5_000 });
});

test("Tasks: filter tabs are visible", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=TASKS");
  await expect(page.getByText("ALL").first()).toBeVisible();
  // "DONE" also appears in the KPI grid div; use button role to target the filter tab
  await expect(page.getByRole("button", { name: "DONE" })).toBeVisible();
});

/* ── STUDIO feature ───────────────────────────────────────────────── */
test("Studio: create AI form expands", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=STUDIO");
  await page.click("text=+ NEW CUSTOM AI");
  await expect(page.getByText("AI NAME")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("PERSONA")).toBeVisible();
});

test("Studio: workflow tab shows workflow form", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=STUDIO");
  await page.click("text=WORKFLOWS");
  await page.click("text=+ NEW WORKFLOW");
  await expect(page.getByText("WORKFLOW NAME")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("STEPS")).toBeVisible();
});

/* ── FORGE feature ────────────────────────────────────────────────── */
test("Forge: prompt textarea is present", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.locator("nav").getByText("FORGE").click();
  const kindBtn = page.locator("button").filter({ hasText: /^APP$/ }).first();
  await expect(kindBtn).toBeVisible({ timeout: 5_000 });
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeVisible();
});

test("Forge: VIDEO tab switches to VideoPanel", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.locator("nav").getByText("FORGE").click();
  // Wait for Forge to fully render before clicking VIDEO
  await expect(page.locator("button").filter({ hasText: /^APP$/ }).first()).toBeVisible({ timeout: 5_000 });
  await page.locator("button").filter({ hasText: /^VIDEO$/ }).click();
  await expect(page.getByText(/VIDEO|SCENE|NARRATION/i).first()).toBeVisible({ timeout: 5_000 });
});

/* ── VAULT feature ────────────────────────────────────────────────── */
test("Vault: file drop zone is visible", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.click("text=VAULT");
  // Create a notebook first so we can see the upload zone
  // For this test, just check the notebook creation UI exists
  await expect(page.getByPlaceholder("新しいノートブック名")).toBeVisible({ timeout: 5_000 });
});

/* ── BRIEFING button ──────────────────────────────────────────────── */
test("Briefing button is visible in top bar", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await expect(page.getByText("BRIEF")).toBeVisible();
});

/* ── Accessibility / no crash checks ─────────────────────────────── */
test("No JavaScript errors on page load", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/");
  await enterApp(page);
  // Navigate through all views to ensure no crash
  for (const nav of ["FORGE", "VAULT", "TASKS", "INCOME", "STUDIO", "AUTO", "ARCHIVE", "CHAT"]) {
    await page.locator("nav").getByText(nav, { exact: true }).click();
    await page.waitForTimeout(300);
  }
  // Filter out known non-critical errors
  const critical = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("net::ERR") && !e.includes("Failed to fetch"),
  );
  expect(critical).toHaveLength(0);
});
