/**
 * 「パンパン」の聞き分け（lib/clapDetect.ts）。
 *
 * マイクは使わない。音の波を作って、ブラウザの AnalyserNode と同じ形
 * （1024点の窓・Blackman 窓・dB）に直し、60コマ/秒で流す。
 * 拍手だけで動き、声・電子音・机をたたく低い音では動かないことを見張る。
 */

import { test, expect } from "@playwright/test";
import { ClapDetector, measure, type ClapEvent } from "../src/lib/clapDetect";

const SR = 48_000;
const N = 1024;

/** 決まった乱数（毎回同じ音になるように）。 */
function rng(seed = 7) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff * 2 - 1; };
}

type Wave = Float32Array;
const silence = (sec: number) => new Float32Array(Math.round(sec * SR));

function addNoise(w: Wave, level: number, seed = 3) {
  const r = rng(seed);
  for (let i = 0; i < w.length; i++) w[i] += r() * level;
}

/** 拍手: 広い音（雑音）が一気に出て、すぐ消える。 */
function clap(w: Wave, atSec: number, amp = 0.6, seed = 11) {
  const r = rng(seed);
  const start = Math.round(atSec * SR);
  for (let i = 0; i < 0.12 * SR && start + i < w.length; i++) {
    w[start + i] += r() * amp * Math.exp(-i / (0.012 * SR));
  }
}

/** 声っぽい音: 低い音とその倍音が、しばらく続く。 */
function voice(w: Wave, atSec: number, durSec: number, amp = 0.25) {
  const start = Math.round(atSec * SR);
  for (let i = 0; i < durSec * SR && start + i < w.length; i++) {
    const t = i / SR;
    const env = Math.min(1, i / (0.005 * SR)); // 急に始まる（「パ」の頭）
    let v = 0;
    for (let h = 1; h <= 7; h++) v += Math.sin(2 * Math.PI * 180 * h * t) / h;
    w[start + i] += v * amp * env * 0.5;
  }
}

/** 電子音: 1kHz の短いピッ（Chrome の偽マイクが鳴らす音に近い）。 */
function beep(w: Wave, atSec: number, durSec = 0.1, amp = 0.5) {
  const start = Math.round(atSec * SR);
  for (let i = 0; i < durSec * SR && start + i < w.length; i++) {
    w[start + i] += Math.sin(2 * Math.PI * 1000 * i / SR) * amp;
  }
}

/** 机をたたく音: 低くて、すぐ消える。 */
function knock(w: Wave, atSec: number, amp = 0.6) {
  const start = Math.round(atSec * SR);
  for (let i = 0; i < 0.12 * SR && start + i < w.length; i++) {
    w[start + i] += Math.sin(2 * Math.PI * 140 * i / SR) * amp * Math.exp(-i / (0.015 * SR));
  }
}

/* AnalyserNode と同じ形: Blackman 窓 → FFT → dB */
function fftDb(x: Float32Array): Float32Array {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = 0.16;
    const win = (1 - a) / 2 - 0.5 * Math.cos(2 * Math.PI * i / N) + (a / 2) * Math.cos(4 * Math.PI * i / N);
    re[i] = x[i] * win;
  }
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const out = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / N + 1e-12);
  return out;
}

/** 波を 60コマ/秒で聞かせる。 */
function listen(w: Wave, det = new ClapDetector()): ClapEvent[] {
  const out: ClapEvent[] = [];
  const step = SR / 60;
  for (let end = N; end <= w.length; end += step) {
    const e = Math.floor(end);
    const win = w.subarray(e - N, e);
    const { rms, hf } = measure(win, fftDb(win), SR);
    out.push(...det.step({ t: (e / SR) * 1000, rms, hf }));
  }
  return out;
}
const doubles = (e: ClapEvent[]) => e.filter((x) => x.kind === "double");
const claps = (e: ClapEvent[]) => e.filter((x) => x.kind === "clap");

test("音の測り方: 拍手は高い音が多く、ピッという電子音は少ない", () => {
  const c = silence(0.1); clap(c, 0);
  const b = silence(0.1); beep(b, 0);
  const cw = c.subarray(0, N), bw = b.subarray(0, N);
  const cm = measure(cw, fftDb(cw), SR);
  const bm = measure(bw, fftDb(bw), SR);
  expect(cm.hf).toBeGreaterThan(0.4);
  expect(bm.hf).toBeLessThan(0.05);
  expect(cm.rms).toBeGreaterThan(0.05);
});

test("パンパン（2回たたく）で1回だけ動く", () => {
  const w = silence(2); addNoise(w, 0.004);
  clap(w, 0.6); clap(w, 0.95, 0.6, 12);
  const e = listen(w);
  expect(claps(e)).toHaveLength(2);
  expect(doubles(e)).toHaveLength(1);
});

test("1回たたいただけでは動かない", () => {
  const w = silence(2); addNoise(w, 0.004);
  clap(w, 0.6);
  const e = listen(w);
  expect(claps(e)).toHaveLength(1);
  expect(doubles(e)).toHaveLength(0);
});

test("間があきすぎた2回は、別々の1回", () => {
  const w = silence(3); addNoise(w, 0.004);
  clap(w, 0.5); clap(w, 1.6, 0.6, 13);
  expect(doubles(listen(w))).toHaveLength(0);
});

test("3回たたいても、動くのは1回だけ（始めてすぐ止まらない）", () => {
  const w = silence(3); addNoise(w, 0.004);
  clap(w, 0.5); clap(w, 0.85, 0.6, 14); clap(w, 1.2, 0.6, 15);
  expect(doubles(listen(w))).toHaveLength(1);
});

test("少し間をおけば、もう一度パンパンで動く（止める）", () => {
  const w = silence(4); addNoise(w, 0.004);
  clap(w, 0.5); clap(w, 0.85, 0.6, 16);
  clap(w, 2.6, 0.6, 17); clap(w, 2.95, 0.6, 18);
  expect(doubles(listen(w))).toHaveLength(2);
});

test("話し声（「パ」で急に始まって続く音）では動かない", () => {
  const w = silence(3); addNoise(w, 0.004);
  voice(w, 0.4, 0.35); voice(w, 0.9, 0.35); voice(w, 1.5, 0.5);
  expect(doubles(listen(w))).toHaveLength(0);
});

test("ピッという電子音が続けて鳴っても動かない", () => {
  const w = silence(3); addNoise(w, 0.004);
  beep(w, 0.4); beep(w, 0.8); beep(w, 1.2); beep(w, 1.6);
  expect(claps(listen(w))).toHaveLength(0);
});

test("机をトントンたたく低い音では動かない", () => {
  const w = silence(2); addNoise(w, 0.004);
  knock(w, 0.5); knock(w, 0.8);
  expect(doubles(listen(w))).toHaveLength(0);
});

test("小さな物音（遠くの音）では動かない", () => {
  const w = silence(2); addNoise(w, 0.004);
  clap(w, 0.5, 0.03); clap(w, 0.85, 0.03, 19);
  expect(claps(listen(w))).toHaveLength(0);
});

test("話している最中でも、はっきりたたけば聞き分ける", () => {
  const w = silence(3); addNoise(w, 0.004);
  voice(w, 0.2, 2.5, 0.06);
  clap(w, 1.2, 0.9, 20); clap(w, 1.55, 0.9, 21);
  expect(doubles(listen(w))).toHaveLength(1);
});
