/**
 * 顔の照合と「操作してよいか」の門（lib/faceMatch.ts・lib/cameraControl.ts）。
 *
 * 照合の式は Human（@vladmandic/human）と同じにしてある。ライブラリの版を
 * 上げて式が変わったら、ここで気づけるようにする。
 */

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  bestSimilarity, decodeDescriptor, encodeDescriptor, FaceGate, faceSimilarity,
  isFrontal, samplesConsistent, STRICTNESS,
} from "../src/lib/faceMatch";
import {
  cameraErrorMessage, CLICK_MODE_KEYS, DEFAULT_CAMERA_PREFS, readCameraPrefs, SPEED_KEYS,
} from "../src/lib/cameraControl";
import { CLICK_MODES, SPEEDS } from "../src/lib/handGesture";
import { HUMAN_VERSION, MODEL_BASE } from "../src/lib/vision";

const N = 1024;
const vec = (f: (i: number) => number) => Array.from({ length: N }, (_, i) => f(i));

test("同じ顔は 1、少し違う顔は Human と同じ値になる", () => {
  const a = vec(() => 0);
  expect(faceSimilarity(a, a)).toBe(1);
  // 1つずつ 0.2 ずれ → 距離 1024、√ = 32 → (1 - 0.32 - 0.2) / 0.6 = 0.8
  expect(faceSimilarity(a, vec(() => 0.2))).toBe(0.8);
  // 大きくずれれば 0 に貼りつく
  expect(faceSimilarity(a, vec(() => 1))).toBe(0);
  // 長さが違う物とは比べない
  expect(faceSimilarity(a, a.slice(0, 10))).toBe(0);
});

test("照合の式が、入っている Human と同じ（倍率25・0.2〜0.8）", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../node_modules/@vladmandic/human/dist/human.esm.js"), "utf8");
  expect(src).toMatch(/function similarity\(\w+, \w+, \w+ = \{ order: 2, multiplier: 25, min: 0\.2, max: 0\.8 \}\)/);
});

test("モデルの置き場の版が、入っている Human と同じ", () => {
  const pkg = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../node_modules/@vladmandic/human/package.json"), "utf8"));
  expect(pkg.version).toBe(HUMAN_VERSION);
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  expect(app.dependencies["@vladmandic/human"]).toBe(HUMAN_VERSION);
  expect(MODEL_BASE).toContain(`@vladmandic/human@${HUMAN_VERSION}/models/`);
});

test("端末に置く形で出し入れしても、照合の結果が変わらない", () => {
  const d = vec((i) => Math.sin(i) * 0.1);
  const back = decodeDescriptor(encodeDescriptor(d));
  expect(back).toHaveLength(N);
  expect(faceSimilarity(d, back)).toBe(1);
  // 1枚の大きさ（文字にすると 20KB を超えるところ、5.5KB 程度）
  expect(encodeDescriptor(d).length).toBeLessThan(6000);
});

test("何枚か登録して、いちばん近い物で比べる", () => {
  const me = [vec(() => 0), vec(() => 0.05)];
  expect(bestSimilarity(vec(() => 0.02), me)).toBe(1);
  expect(bestSimilarity(vec(() => 1), me)).toBe(0);
});

test("撮った何枚かに別の顔が混ざっていたら、登録しない", () => {
  expect(samplesConsistent([vec(() => 0), vec(() => 0.01), vec(() => 0.02)])).toBe(true);
  expect(samplesConsistent([vec(() => 0), vec(() => 0.01), vec(() => 1)])).toBe(false);
  expect(samplesConsistent([vec(() => 0)])).toBe(false);
});

test("横顔は登録に使わない", () => {
  expect(isFrontal(0.1, -0.1)).toBe(true);
  expect(isFrontal(0.6, 0)).toBe(false);
  expect(isFrontal(0, -0.5)).toBe(false);
});

test("厳しさは、ゆるめ < ふつう < きびしめ", () => {
  expect(STRICTNESS.loose.threshold).toBeLessThan(STRICTNESS.normal.threshold);
  expect(STRICTNESS.normal.threshold).toBeLessThan(STRICTNESS.strict.threshold);
  expect(STRICTNESS.loose.threshold).toBeGreaterThanOrEqual(0.5); // Human の説明の目安
});

test("門: 2回続けて本人だったら開く。1回だけでは開かない", () => {
  const g = new FaceGate(0.56);
  expect(g.observe(0.8, 0)).not.toBe("ok");
  expect(g.observe(0.8, 400)).toBe("ok");
});

test("門: 開いたあと、少し顔をそらした程度では閉めない", () => {
  const g = new FaceGate(0.56);
  g.observe(0.8, 0); g.observe(0.8, 400);
  expect(g.observe(null, 1400)).toBe("ok");
  expect(g.observe(0.3, 2400)).toBe("ok");
  expect(g.observe(0.8, 3400)).toBe("ok");
});

test("門: 本人が5秒見えなければ閉める。別人だけなら「別人」", () => {
  const away = new FaceGate(0.56);
  away.observe(0.8, 0); away.observe(0.8, 400);
  for (let t = 1400; t <= 6400; t += 1000) away.observe(null, t);
  expect(away.state).toBe("absent");

  const swap = new FaceGate(0.56);
  swap.observe(0.8, 0); swap.observe(0.8, 400);
  for (let t = 1400; t <= 6400; t += 1000) swap.observe(0.2, t);
  expect(swap.state).toBe("stranger");
});

test("門: はじめから別人なら開かない", () => {
  const g = new FaceGate(0.56);
  for (let t = 0; t < 10_000; t += 400) g.observe(0.3, t);
  expect(g.state).toBe("stranger");
});

test("設定が読めない所（保存できない端末）では、ふだんの設定で動く", () => {
  expect(readCameraPrefs()).toEqual(DEFAULT_CAMERA_PREFS);
  // 顔の確認は、登録した人には既定で効かせる
  expect(DEFAULT_CAMERA_PREFS.requireFace).toBe(true);
  // 写真を弾くのは試験的なので、既定では切っておく（本人が弾かれうる）
  expect(DEFAULT_CAMERA_PREFS.antiSpoof).toBe(false);
});

test("カメラを開けなかった理由を、次にすることの形で言う", () => {
  expect(cameraErrorMessage({ name: "NotAllowedError" })).toContain("許可");
  expect(cameraErrorMessage({ name: "NotFoundError" })).toContain("見つかりません");
  expect(cameraErrorMessage({ name: "NotReadableError" })).toContain("ほかのアプリ");
  expect(cameraErrorMessage(null)).toContain("開けませんでした");
});

test("設定の選びどころが、手の操作の側と同じ（押し方・速さ）", () => {
  expect([...CLICK_MODE_KEYS].sort()).toEqual(Object.keys(CLICK_MODES).sort());
  expect([...SPEED_KEYS].sort()).toEqual(Object.keys(SPEEDS).sort());
  // 既定は「どちらでも押せる」「ふつう」
  expect(DEFAULT_CAMERA_PREFS.clickMode).toBe("both");
  expect(DEFAULT_CAMERA_PREFS.speed).toBe("normal");
});
