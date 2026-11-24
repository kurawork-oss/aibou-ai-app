/**
 * 「パンパン」で、本当にカメラ操作が始まるか（本物のブラウザで）。
 *
 * Chrome の偽マイクに、作った音（静か → パン → パン → 静か）を流す
 * （--use-file-for-fake-audio-capture）。マイクから AnalyserNode を通って
 * lib/clapDetect.ts が聞き分け、カメラ操作の小窓が出るまでを通しで見る。
 * 音は1回だけ流す（%noloop）。繰り返すと始まって止まってを繰り返すので。
 */

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enterApp, serveModels } from "./cameraHelpers";

const SR = 48_000;

/** 16bit・1ch の WAV を作る。 */
function wav(samples: Float32Array): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return b;
}

function claps(atSec: number[], totalSec: number): Float32Array {
  const w = new Float32Array(totalSec * SR);
  let s = 5;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff * 2 - 1; };
  for (let i = 0; i < w.length; i++) w[i] = r() * 0.003;
  for (const at of atSec) {
    const start = Math.round(at * SR);
    for (let i = 0; i < 0.12 * SR; i++) w[start + i] += r() * 0.7 * Math.exp(-i / (0.012 * SR));
  }
  return w;
}

// マイクを開いてから 1.5秒後・1.85秒後にたたく
const FILE = path.join(os.tmpdir(), "forge-double-clap.wav");
fs.writeFileSync(FILE, wav(claps([1.5, 1.85], 8)));

test.use({
  launchOptions: [async ({ launchOptions }, use) => {
    await use({
      ...launchOptions,
      args: [
        ...(launchOptions.args ?? []),
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${FILE}%noloop`,
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
      ],
    });
  }, { scope: "worker" }],
  permissions: ["camera", "microphone"],
});

test("パンパンと聞こえたら、カメラ操作が始まる（1回だけ）", async ({ page }) => {
  test.setTimeout(60_000);
  await serveModels(page);
  await enterApp(page);
  await page.getByLabel("Settings").click();
  const section = page.getByRole("region", { name: "カメラで操作" });
  const box = section.getByRole("checkbox", { name: /手を2回たたいて/ });
  await box.scrollIntoViewIfNeeded();
  await box.check();

  const panel = page.getByRole("complementary", { name: "カメラ操作" });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("👏 パンパン → カメラ操作を始めます")).toBeVisible();
  // 3回目は無いので、始めてすぐ止まったりしない
  await page.waitForTimeout(3000);
  await expect(panel).toBeVisible();
});
