"use client";

/**
 * ClapListener —「パンパン」（手を2回たたく）でカメラ操作を始める・止める耳。
 *
 * 設定 →「基本」→ カメラで操作 の「手を2回たたいて始める・止める」を
 * 入れたときだけ、ここが置かれる（page.tsx）。置かれている間は、
 * **このアプリを開いているあいだマイクを開いて**、手をたたく音だけを
 * 聞き分ける（lib/clapDetect.ts）。
 *
 * 音は、どこにも保存しない・送らない。1コマごとに「大きさ」と「高い音の
 * 割合」の2つの数にして、その場で捨てる。言葉を聞き取る仕組みは無い。
 *
 * ブラウザは、画面に一度も触れていないうちは音の処理を止めておく
 * （勝手に音を扱わせない決まり）。開き直した直後はそうなるので、最初に
 * どこかを押した／キーを打ったときに動かし始める。
 */

import { useEffect, useState } from "react";
import {
  cameraAvailability, isCameraControlRunning, micErrorMessage, setClapStatus, toggleCameraControl,
} from "@/lib/cameraControl";
import { ClapDetector, measure } from "@/lib/clapDetect";

export default function ClapListener() {
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    const det = new ClapDetector();
    const resume = () => { void ctx?.resume().catch(() => undefined); };

    const say = (msg: string) => {
      setToast(msg);
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setToast(null), 2400);
    };

    setClapStatus({ state: "starting" });
    (async () => {
      const avail = cameraAvailability();
      if (!avail.ok) { setClapStatus({ state: "error", message: avail.reason.replace("カメラ", "マイク") }); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          // 拍手の「立ち上がり」を消さないよう、声向けの整え（雑音消し・
          // 音量の自動調整）は切る
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e) {
        if (alive) setClapStatus({ state: "error", message: micErrorMessage(e) });
        return;
      }
      if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }

      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      const time = new Float32Array(an.fftSize);
      const freq = new Float32Array(an.frequencyBinCount);

      if (ctx.state !== "running") {
        window.addEventListener("pointerdown", resume);
        window.addEventListener("keydown", resume);
      }
      setClapStatus({ state: "listening", lastClapAt: null });

      const loop = () => {
        if (!alive || !ctx) return;
        if (ctx.state === "running") {
          an.getFloatTimeDomainData(time);
          an.getFloatFrequencyData(freq);
          const m = measure(time, freq, ctx.sampleRate);
          for (const e of det.step({ t: performance.now(), rms: m.rms, hf: m.hf })) {
            if (e.kind === "clap") {
              setClapStatus({ state: "listening", lastClapAt: Date.now() });
            } else {
              const was = isCameraControlRunning();
              toggleCameraControl();
              say(was ? "👏 パンパン → カメラ操作を止めました" : "👏 パンパン → カメラ操作を始めます");
            }
          }
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      if (toastTimer) clearTimeout(toastTimer);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      setClapStatus({ state: "off" });
    };
  }, []);

  if (!toast) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 z-[90] flex justify-center px-4"
      style={{ top: "calc(max(env(safe-area-inset-top), 0.75rem) + 56px)" }}
    >
      <div className="rounded-full border border-panel bg-[var(--chrome)] px-3 py-1.5 text-[12px] text-fg-strong backdrop-blur-md">
        {toast}
      </div>
    </div>
  );
}
