/**
 * vision.ts — カメラの映像から、手の21点と顔の特徴を取り出す。
 *
 * 使っている物（どれも無料・利用料なし）
 * ----------------------------------------
 * - Human（@vladmandic/human, MIT）… 顔の検出・顔の特徴（本人の確認）・
 *   手の21点。中に TensorFlow.js が入っていて、**ブラウザの中で動く**。
 *   映像をどこかのサーバーに送って判定する仕組みではない。
 * - モデル（学習済みの重み）… 初回だけ jsDelivr（npm の無料の配信元）から
 *   取り、ブラウザ（IndexedDB）に残す。2回目からは取りに行かない。
 *   自分で置きたいときは NEXT_PUBLIC_VISION_MODEL_URL に置き場を書く
 *   （node_modules/@vladmandic/human/models/ の中身をそのまま置けばよい）。
 *
 * 重い物は、ここを import しただけでは読み込まない。モードを始めたときに
 * 初めて `import("@vladmandic/human")` する（最初の画面を重くしない）。
 */

import type { Pt } from "@/lib/handGesture";

/** package.json と同じ版。違うと、モデルの置き場の版とずれる（テストが見張る）。 */
export const HUMAN_VERSION = "3.3.6";

export const MODEL_BASE = (
  process.env.NEXT_PUBLIC_VISION_MODEL_URL
  || `https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}/models/`
).replace(/\/?$/, "/");

/** 初回に取りに行く量のめやす（顔5種＋手2種の重み）。画面の案内に使う。 */
export const MODEL_DOWNLOAD_MB = 15;

export interface FaceSeen {
  /** 顔の特徴（1024個）。取れなかったら null。 */
  embedding: number[] | null;
  score: number;
  /** 顔の向き（ラジアン）。 */
  yaw?: number;
  pitch?: number;
  /** 写真ではなさそうか（0..1）。写真を弾く設定のときだけ入る。 */
  real?: number;
  live?: number;
}

export interface VisionFrame {
  /** 手の21点（画像の座標 0..1）。見えなければ null。 */
  hand: Pt[] | null;
  faces: FaceSeen[];
}

type HumanLib = typeof import("@vladmandic/human");
type HumanT = InstanceType<HumanLib["Human"]>;
type HumanConfig = NonNullable<ConstructorParameters<HumanLib["Human"]>[0]>;

const CONFIG: HumanConfig = {
  modelBasePath: MODEL_BASE,
  debug: false,
  // 起動時の空回し（数秒かかる）はしない。最初の1コマが少し遅いだけ。
  warmup: "none",
  filter: { enabled: true, return: false },
  gesture: { enabled: false },
  body: { enabled: false },
  object: { enabled: false },
  segmentation: { enabled: false },
  face: {
    enabled: false,
    // 顔は1秒に1回ほどしか見ない。前の結果を使い回すと、いなくなった人を
    // 「まだいる」と言うので、毎回計算し直す。
    detector: { rotation: true, maxDetected: 3, minConfidence: 0.5, skipFrames: 0, skipTime: 0 },
    mesh: { enabled: true },
    iris: { enabled: false },
    attention: { enabled: false },
    emotion: { enabled: false },
    gear: { enabled: false },
    description: { enabled: true, skipFrames: 0, skipTime: 0 },
    antispoof: { enabled: false, skipFrames: 0, skipTime: 0 },
    liveness: { enabled: false, skipFrames: 0, skipTime: 0 },
  },
  hand: {
    enabled: true,
    maxDetected: 1,
    minConfidence: 0.55,
    rotation: true,
    landmarks: true,
    // 手の位置（箱）は少し使い回してよい。指の21点は毎コマ取る。
    skipFrames: 99,
    skipTime: 800,
  },
};

let loading: Promise<HumanT> | null = null;
let loadedAntiSpoof = false;
/** 呼び出しを1列に並べる（会話の上の操作と、設定の顔登録が同時に来ても混ぜない）。 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * 認識の部品を用意する。2回目以降は同じ物を返す。
 * 失敗したら次に呼ばれたときにやり直す（電波が戻ったら使えるように）。
 */
export function loadVision(opts: { antiSpoof?: boolean } = {}): Promise<HumanT> {
  if (!loading) {
    loading = (async () => {
      const lib = await import("@vladmandic/human");
      const human = new lib.Human(CONFIG);
      // 顔も手も、最初にまとめて取ってくる（使う瞬間に取りに行くと、
      // 本人の確認が数秒止まる）。
      await human.load({ face: { enabled: true }, hand: { enabled: true } });
      return human;
    })().catch((e) => { loading = null; throw e; });
  }
  const ready = loading;
  if (!opts.antiSpoof || loadedAntiSpoof) return ready;
  return ready.then(async (human) => {
    await human.load({ face: { enabled: true, antispoof: { enabled: true }, liveness: { enabled: true } } });
    loadedAntiSpoof = true;
    return human;
  });
}

/** 1コマ読む。want で、手・顔のどちらを見るかを決める。 */
export function detect(
  video: HTMLVideoElement,
  want: { hand: boolean; face: boolean; antiSpoof?: boolean },
): Promise<VisionFrame> {
  const run = queue.then(async (): Promise<VisionFrame> => {
    const human = await loadVision({ antiSpoof: want.antiSpoof });
    const anti = Boolean(want.antiSpoof);
    const r = await human.detect(video, {
      face: { enabled: want.face, antispoof: { enabled: anti }, liveness: { enabled: anti } },
      hand: { enabled: want.hand },
    });
    const w = r.width || video.videoWidth || 1;
    const h = r.height || video.videoHeight || 1;
    const kp = want.hand ? r.hand[0]?.keypoints : undefined;
    return {
      hand: kp && kp.length >= 21 ? kp.map((p) => ({ x: p[0] / w, y: p[1] / h })) : null,
      faces: want.face
        ? r.face.map((f) => ({
            embedding: f.embedding && f.embedding.length >= 64 ? Array.from(f.embedding) : null,
            score: f.score,
            yaw: f.rotation?.angle.yaw,
            pitch: f.rotation?.angle.pitch,
            real: f.real,
            live: f.live,
          }))
        : [],
    };
  });
  queue = run.catch(() => undefined);
  return run;
}

/** 前のカメラ（自分を映す側）を、認識に足りる大きさで開く。 */
export function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
  });
}

export function stopStream(s: MediaStream | null | undefined): void {
  s?.getTracks().forEach((t) => t.stop());
}

/** video に流して、1コマ目が出るまで待つ。 */
export async function attachStream(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => undefined);
  if (video.readyState >= 2) return;
  await new Promise<void>((resolve) => {
    const done = () => { video.removeEventListener("loadeddata", done); resolve(); };
    video.addEventListener("loadeddata", done);
    setTimeout(done, 3000);
  });
}
