/**
 * カメラ操作のテストで使い回す道具（偽のカメラ・マイク、モデルの配り方）。
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { MODEL_BASE } from "../src/lib/vision";

const MODELS_DIR = path.join(__dirname, "../node_modules/@vladmandic/human/models");

export async function serveModels(page: Page) {
  await page.route(`${MODEL_BASE}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const file = path.join(MODELS_DIR, name);
    if (!name || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    await route.fulfill({
      status: 200,
      body: fs.readFileSync(file),
      contentType: name.endsWith(".json") ? "application/json" : "application/octet-stream",
    });
  });
}

/** 開いたカメラを覚えておく（止めたあと、本当に消えたかを見るため）。テストの中だけの仕掛け。 */
export async function trackStreams(page: Page) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const orig = md.getUserMedia.bind(md);
    (window as unknown as { __streams: MediaStream[] }).__streams = [];
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await orig(c);
      (window as unknown as { __streams: MediaStream[] }).__streams.push(s);
      return s;
    };
  });
}

export const liveTracks = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __streams?: MediaStream[] }).__streams ?? [])
    .flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);

export async function enterApp(page: Page) {
  await page.goto("/");
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hud = page.locator('nav[aria-label="Mobile navigation"], nav[aria-label="画面の切り替え"]')
    .getByRole("button", { name: "管理", exact: true }).first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()).catch(() => {}),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await hud.waitFor({ timeout: 10_000 });
}
