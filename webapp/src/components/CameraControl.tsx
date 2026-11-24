"use client";

/**
 * CameraControl — カメラ操作モード。どの画面の上にもかぶさる。
 *
 * パソコンのカメラで手の形を読み、マウスの代わりにこのアプリを動かす。
 * 顔を登録してあれば、**登録した人が映っている間だけ**動く
 * （lib/faceMatch.ts の FaceGate）。
 *
 * 2巡目（ui-r125）:「反応しにくい・分かりにくい」への答え
 * -------------------------------------------------------
 * - **カーソル自身が、いま何をするかを言う。** 押せる物に乗ると枠が付き、
 *   カーソルの横にその名前が出る。止めていると輪が満ちていき、満ちたら押す。
 *   つまみかけると中の点が大きくなる。✌・👍 を止めている間も輪が満ちる。
 * - **近くのボタンに吸い付く。** 小さな ✕ のすぐ脇で止まって押せない、を無くす。
 * - **小窓が「次にすること」を言う。** 手が遠い・近い・端にある、も言う。
 * - **はじめての練習。** 最初に始めたとき、手を映す → 合わせる → 押す →
 *   スクロール → 閉じる、を1つずつ実際にやってもらう（スキップできる）。
 *   小窓の「？」からいつでもやり直せる。
 *
 * 1コマごとの描き直しは React を通さない（カーソルは ref で直接動かす）。
 * 30コマ/秒で画面全体を描き直すと、会話の画面が重くなる。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailability, cameraErrorMessage, markTutorialDone, readCameraPrefs,
  readFaceProfile, stopCameraControl, tutorialDone,
} from "@/lib/cameraControl";
import { bestSimilarity, FaceGate, STRICTNESS, type GateState } from "@/lib/faceMatch";
import {
  CLICK_MODES, GESTURE_HELP, GestureController, SPEEDS,
  type ClickMode, type ControllerView, type Effect, type Hover, type Pt,
} from "@/lib/handGesture";
import { findTarget, pressAt, pressEscape, scrollAt, type Target } from "@/lib/pointerDom";
import {
  attachStream, detect, loadVision, MODEL_DOWNLOAD_MB, openCamera, stopStream,
} from "@/lib/vision";

type Phase =
  | { kind: "camera" }
  | { kind: "loading" }
  | { kind: "running" }
  | { kind: "error"; message: string };

/** 指の骨の並び（小窓に手の形を描く用）。 */
const BONES = [
  [0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20], [5, 9, 13, 17],
];

/** 練習の段。順にやってもらう。 */
const PRACTICE = [
  { id: "hand", title: "手を映す" },
  { id: "aim", title: "合わせる" },
  { id: "press", title: "押す" },
  { id: "scroll", title: "スクロール" },
  { id: "close", title: "閉じる" },
] as const;
const PRACTICE_DONE = PRACTICE.length;

/** カーソルの輪の長さ（r=15 の円周）。 */
const RING = 2 * Math.PI * 15;

export default function CameraControl() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const arcRef = useRef<SVGCircleElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  const practiceBtnRef = useRef<HTMLButtonElement>(null);
  const ctlRef = useRef<GestureController | null>(null);

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "camera" });
  const [gate, setGate] = useState<GateState | "off">("off");
  const [handSeen, setHandSeen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hint, setHint] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [small, setSmall] = useState(false);
  const [prefs] = useState(() => readCameraPrefs());
  // 練習: はじめての人だけ自動で出す。PRACTICE_DONE なら出さない。
  const [step, setStep] = useState(() => (tutorialDone() ? PRACTICE_DONE : 0));
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const advance = useCallback((from: number) => {
    setStep((s) => {
      if (s !== from) return s;
      const next = s + 1;
      if (next >= PRACTICE_DONE) markTutorialDone();
      return next;
    });
  }, []);
  const endPractice = useCallback(() => { markTutorialDone(); setStep(PRACTICE_DONE); }, []);

  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    let raf = 0;
    const video = videoRef.current;
    const ctl = new GestureController({
      clickMode: prefs.clickMode,
      region: SPEEDS[prefs.speed].region,
    });
    ctlRef.current = ctl;
    const profile = readFaceProfile();
    const faceGate = profile && prefs.requireFace
      ? new FaceGate(STRICTNESS[prefs.strictness].threshold)
      : null;
    setGate(faceGate ? "checking" : "off");
    setPaused(false);
    setPhase({ kind: "camera" });

    let lastGate: GateState | "off" = faceGate ? "checking" : "off";
    let lastHand = false;
    let lastHint = "";
    let nextFaceAt = 0;
    let handSince = 0;
    let scrolled = 0;
    let hover: Hover | null = null;
    let target: Target | null = null;
    let cursorPx = { x: 0, y: 0 };
    let cursorShown = false;

    const ripple = (x: number, y: number) => {
      const r = rippleRef.current;
      if (!r) return;
      r.style.transform = `translate(${x}px, ${y}px)`;
      r.firstElementChild?.animate(
        [{ transform: "scale(0.3)", opacity: 0.9 }, { transform: "scale(1.6)", opacity: 0 }],
        { duration: 420, easing: "ease-out" });
    };

    const apply = (effects: Effect[]) => {
      for (const e of effects) {
        if (e.kind === "cursor") {
          cursorPx = { x: e.x * window.innerWidth, y: e.y * window.innerHeight };
          cursorShown = e.visible;
          target = e.visible ? findTarget(cursorPx.x, cursorPx.y) : null;
          hover = target ? { key: target.key, blocked: target.blocked } : null;
        } else if (e.kind === "click") {
          const x = e.x * window.innerWidth;
          const y = e.y * window.innerHeight;
          const res = pressAt(x, y);
          ripple(target?.x ?? x, target?.y ?? y);
          if (!res.done && res.why) say(res.why);
        } else if (e.kind === "scroll") {
          scrolled += Math.abs(e.dy);
          scrollAt(cursorPx.x, cursorPx.y, e.dy * window.innerHeight);
          if (stepRef.current === 3 && scrolled > 0.12) advance(3);
        } else if (e.kind === "command") {
          // 練習の最後の段では、閉じる＝練習の終わり（画面の窓は閉じない）
          if (stepRef.current < PRACTICE_DONE) {
            if (stepRef.current === 4) advance(4);
          } else {
            pressEscape();
            say("✌ 閉じる（Esc）");
          }
        } else if (e.kind === "paused") {
          setPaused(e.paused);
          say(e.paused ? "一時停止しました（👍 を少し止めると再開）" : "再開しました");
        }
      }
    };

    /** カーソルと枠を、いまの状態に合わせて描く（React を通さない）。 */
    const paint = (view: ControllerView) => {
      const c = cursorRef.current;
      const ring = ringRef.current;
      // 一時停止中でも、再開の 👍 を止めている間は輪を見せる
      const show = cursorShown || (view.paused && view.hold !== null);
      if (c) {
        c.style.opacity = show ? (view.paused ? "0.6" : "1") : "0";
        c.style.transform = `translate(${cursorPx.x}px, ${cursorPx.y}px)`;
      }
      const progress = view.hold ? view.hold.progress : view.dwell;
      if (arcRef.current) arcRef.current.style.strokeDashoffset = String(RING * (1 - progress));
      if (dotRef.current) {
        const s = 0.45 + 0.75 * view.pinch;
        dotRef.current.style.transform = `translate(-50%, -50%) scale(${s})`;
        dotRef.current.style.background = view.pinch >= 1 ? "var(--accent)" : "#ffffff";
      }
      if (labelRef.current) {
        const text = cursorLabel(view, show ? target : null);
        labelRef.current.textContent = text;
        labelRef.current.style.opacity = text ? "1" : "0";
        labelRef.current.dataset.warn = target?.blocked && !view.hold ? "1" : "0";
      }
      if (ring) {
        if (show && target && !view.paused) {
          const r = target.el.getBoundingClientRect();
          ring.style.opacity = "1";
          ring.style.transform = `translate(${r.left - 4}px, ${r.top - 4}px)`;
          ring.style.width = `${r.width + 8}px`;
          ring.style.height = `${r.height + 8}px`;
          ring.dataset.blocked = target.blocked ? "1" : "0";
        } else {
          ring.style.opacity = "0";
        }
      }
    };

    const drawHand = (hand: Pt[] | null) => {
      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (!hand) return;
      // 映像は鏡にしているので、点も左右を入れ替えて描く
      const X = (p: Pt) => (1 - p.x) * cv.width;
      const Y = (p: Pt) => p.y * cv.height;
      ctx.strokeStyle = "rgba(0,243,255,0.9)";
      ctx.lineWidth = 2;
      for (const bone of BONES) {
        ctx.beginPath();
        bone.forEach((i, k) => (k ? ctx.lineTo(X(hand[i]), Y(hand[i])) : ctx.moveTo(X(hand[i]), Y(hand[i]))));
        ctx.stroke();
      }
      ctx.fillStyle = "#ffffff";
      for (const p of hand) { ctx.beginPath(); ctx.arc(X(p), Y(p), 2, 0, Math.PI * 2); ctx.fill(); }
    };

    const loop = async () => {
      if (!alive) return;
      if (!video || video.readyState < 2) { raf = requestAnimationFrame(() => void loop()); return; }
      const t = performance.now();
      const wantFace = Boolean(faceGate) && t >= nextFaceAt;
      let frame;
      try {
        frame = await detect(video, { hand: true, face: wantFace, antiSpoof: prefs.antiSpoof });
      } catch {
        if (alive) raf = requestAnimationFrame(() => void loop());
        return;
      }
      if (!alive) return;

      if (wantFace && faceGate && profile) {
        // 写真を弾く設定のときは、写真らしい顔は「別人」として数える
        const sims = frame.faces
          .filter((f) => f.embedding)
          .map((f) => (prefs.antiSpoof && ((f.real ?? 1) < 0.5 || (f.live ?? 1) < 0.5))
            ? 0
            : bestSimilarity(f.embedding as number[], profile.samples));
        const st = faceGate.observe(sims.length ? Math.max(...sims) : null, t);
        nextFaceAt = t + (st === "ok" ? 1000 : 400);
        if (st !== lastGate) { lastGate = st; setGate(st); }
      }

      const allowed = !faceGate || faceGate.state === "ok";
      const hand = allowed ? frame.hand : null;
      apply(ctl.step(hand, t, hover));
      const view = ctl.view;
      paint(view);
      drawHand(frame.hand);

      const seen = Boolean(hand);
      if (seen !== lastHand) { lastHand = seen; setHandSeen(seen); handSince = t; }

      // 練習の段を進める（押す段は、ボタンの onClick が進める）
      const s = stepRef.current;
      if (s === 0 && seen && view.framing === "ok" && t - handSince > 600) advance(0);
      if (s === 1 && target && target.el === practiceBtnRef.current) advance(1);

      const h = hintText(lastGate, view, seen, prefs.clickMode);
      if (h !== lastHint) { lastHint = h; setHint(h); }

      raf = requestAnimationFrame(() => void loop());
    };

    (async () => {
      const avail = cameraAvailability();
      if (!avail.ok) { setPhase({ kind: "error", message: avail.reason }); return; }
      try {
        stream = await openCamera();
      } catch (e) {
        if (alive) setPhase({ kind: "error", message: cameraErrorMessage(e) });
        return;
      }
      if (!alive || !video) { stopStream(stream); return; }
      await attachStream(video, stream);
      if (!alive) return;
      setPhase({ kind: "loading" });
      try {
        await loadVision({ antiSpoof: prefs.antiSpoof });
      } catch {
        if (alive) {
          setPhase({
            kind: "error",
            message: "認識の部品を読み込めませんでした。ネットに繋がっているか確かめて、もう一度始めてください。",
          });
        }
        return;
      }
      if (!alive) return;
      setPhase({ kind: "running" });
      // 最初の1コマの読み取り（数秒かかることがある）を待たずに、次にすることを言う
      lastHint = hintText(lastGate, ctl.view, false, prefs.clickMode);
      setHint(lastHint);
      raf = requestAnimationFrame(() => void loop());
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stopStream(stream);
      if (video) video.srcObject = null;
    };
  }, [attempt, say, advance, prefs]);

  const togglePause = () => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    const next = !ctl.state.paused;
    ctl.setPaused(next);
    setPaused(next);
  };

  const status = statusText(phase, gate, paused, handSeen);
  const tone = phase.kind === "error" || gate === "stranger" ? "warn"
    : phase.kind === "running" && (gate === "off" || gate === "ok") && !paused && handSeen ? "on" : "idle";
  const showPractice = phase.kind === "running" && step < PRACTICE_DONE;

  return (
    <>
      {/* 押す先の枠・カーソル・押した波紋。どれも押されない（下の物を押すため）。 */}
      <div
        ref={ringRef}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[89] rounded-[12px] border-2 opacity-0 transition-[opacity] duration-100 data-[blocked='1']:border-dashed"
        style={{ borderColor: "var(--accent)", boxShadow: "0 0 14px var(--glow-strong)" }}
      />
      <div ref={rippleRef} aria-hidden className="pointer-events-none fixed left-0 top-0 z-[90]">
        <div className="-ml-[22px] -mt-[22px] h-[44px] w-[44px] rounded-full border-2 opacity-0"
             style={{ borderColor: "var(--accent)" }} />
      </div>
      <div ref={cursorRef} aria-hidden data-camera-cursor
           className="pointer-events-none fixed left-0 top-0 z-[91] opacity-0">
        <div className="relative -ml-[19px] -mt-[19px] h-[38px] w-[38px]">
          <svg width="38" height="38" viewBox="0 0 38 38" className="absolute inset-0 -rotate-90">
            <circle cx="19" cy="19" r="15" fill="rgba(0,243,255,0.14)" stroke="rgba(255,255,255,0.55)" strokeWidth="2" />
            <circle ref={arcRef} cx="19" cy="19" r="15" fill="none" stroke="var(--accent)" strokeWidth="4"
                    strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING}
                    style={{ filter: "drop-shadow(0 0 4px rgba(0,243,255,0.8))" }} />
          </svg>
          <div ref={dotRef} className="absolute left-1/2 top-1/2 h-3 w-3 rounded-full bg-white"
               style={{ transform: "translate(-50%, -50%) scale(0.45)" }} />
        </div>
        <div ref={labelRef}
             className="absolute left-[24px] top-[14px] whitespace-nowrap rounded-full border border-panel bg-[var(--chrome)] px-2.5 py-1 text-[12px] text-fg-strong opacity-0 backdrop-blur-md data-[warn='1']:text-[#ffb347]" />
      </div>

      {/* 小窓 */}
      <aside
        data-camera-overlay
        aria-label="カメラ操作"
        className="panel fixed right-3 z-[70] w-[212px] p-2"
        style={{ top: "calc(max(env(safe-area-inset-top), 0.75rem) + 52px)" }}
      >
        <div
          className="relative overflow-hidden rounded-forge bg-black"
          style={{ height: prefs.preview && !small ? 159 : 0, opacity: prefs.preview && !small ? 1 : 0 }}
        >
          {/* 映像は止めずに流し続ける（隠すときも、要素は残す） */}
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="カメラの映像"
            className="absolute inset-0 h-full w-full object-cover"
            style={{ transform: "scaleX(-1)" }}
          />
          <canvas ref={canvasRef} width={212} height={159} className="absolute inset-0 h-full w-full" aria-hidden />
        </div>

        <div className="mt-2 flex items-start gap-1.5" role="status" aria-live="polite">
          <span
            className="mt-[6px] h-2 w-2 shrink-0 rounded-full"
            aria-hidden
            style={{
              background: tone === "on" ? "var(--accent)" : tone === "warn" ? "#ffb347" : "#5a5f66",
              boxShadow: tone === "on" ? "0 0 8px rgba(0,243,255,0.7)" : "none",
            }}
          />
          <span className="text-[12px] leading-snug text-fg-strong" data-camera-status>{status}</span>
        </div>
        {phase.kind === "running" && hint && (
          <p className="mt-1 pl-3.5 text-[11px] leading-snug text-muted" data-camera-hint>{hint}</p>
        )}

        <div className="mt-2 grid grid-cols-4 gap-1">
          {phase.kind === "error" ? (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}
              className="col-span-3 min-h-[34px] rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] text-[11px] text-fg-strong">
              もう一度
            </button>
          ) : (
            <button type="button" onClick={togglePause} disabled={phase.kind !== "running"}
              aria-label={paused ? "再開" : "一時停止"} title={paused ? "再開" : "一時停止"}
              className="min-h-[34px] rounded-forge border border-panel text-[12px] text-fg-strong disabled:opacity-40">
              {paused ? "▶" : "Ⅱ"}
            </button>
          )}
          {phase.kind !== "error" && (
            <>
              <button type="button" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen}
                aria-label="手の形の一覧" title="手の形の一覧・練習"
                className="min-h-[34px] rounded-forge border border-panel text-[12px] text-fg-strong">
                ?
              </button>
              <button type="button" onClick={() => setSmall((v) => !v)} disabled={!prefs.preview}
                aria-label={small ? "映像を出す" : "映像を隠す"} title={small ? "映像を出す" : "映像を隠す"}
                className="min-h-[34px] rounded-forge border border-panel text-[12px] text-fg-strong disabled:opacity-40">
                {small ? "▢" : "–"}
              </button>
            </>
          )}
          <button type="button" onClick={stopCameraControl}
            aria-label="カメラ操作を止める" title="カメラ操作を止める（カメラも消えます）"
            className="min-h-[34px] rounded-forge border text-[12px]"
            style={{ borderColor: "rgba(255,157,157,0.5)", color: "#ff9d9d" }}>
            ■
          </button>
        </div>

        {helpOpen && (
          <div className="mt-2 border-t border-panel pt-2">
            <ul className="space-y-1.5" aria-label="手の形と動き">
              {GESTURE_HELP
                .filter((g) => (g.pose === "dwell" ? CLICK_MODES[prefs.clickMode].dwell
                  : g.pose === "pinch" ? CLICK_MODES[prefs.clickMode].pinch : true))
                .map((g) => (
                  <li key={g.pose} className="flex gap-1.5 text-[11px] leading-snug">
                    <span className="w-4 shrink-0 text-center" aria-hidden>{g.mark}</span>
                    <span className="text-muted">{g.how} → <span className="text-fg">{g.does}</span></span>
                  </li>
                ))}
            </ul>
            <p className="mt-1.5 text-[10px] leading-snug text-muted">承認のボタンは手では押せません（マウスか指で）。</p>
            <button type="button" onClick={() => { setStep(0); setHelpOpen(false); }}
              className="mt-2 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-1.5 text-[11px] text-fg-strong">
              練習をもう一度
            </button>
          </div>
        )}
      </aside>

      {showPractice && (
        <div
          role="dialog"
          aria-label="カメラ操作の練習"
          data-camera-practice
          className="panel fixed left-1/2 top-1/2 z-[65] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 p-5"
        >
          <div className="mb-3 text-[10px] tracking-[0.2em] text-muted label-mono">はじめての練習</div>
          <ol className="mb-4 flex gap-1" aria-label="練習の段">
            {PRACTICE.map((p, i) => (
              <li key={p.id} className="flex-1">
                <div className="h-1 rounded-full" style={{ background: i < step ? "var(--accent)" : i === step ? "rgba(0,243,255,0.4)" : "rgba(255,255,255,0.1)" }} />
                <div className={`mt-1 text-center text-[10px] ${i === step ? "text-fg-strong" : "text-muted"}`}>
                  {i < step ? "✓ " : ""}{p.title}
                </div>
              </li>
            ))}
          </ol>
          <p className="text-[15px] leading-relaxed text-fg-strong" data-practice-step={PRACTICE[step].id}>
            {practiceText(step, prefs.clickMode, gate)}
          </p>

          {(step === 1 || step === 2) && (
            <div className="mt-4 flex justify-center">
              <button
                ref={practiceBtnRef}
                type="button"
                onClick={() => { if (stepRef.current <= 2) { setStep(3); } }}
                className="h-16 w-44 rounded-forge border-2 text-[15px] text-fg-strong"
                style={{ borderColor: "var(--accent)", background: "var(--btn-bg)" }}
              >
                ここ
              </button>
            </div>
          )}
          {step === 3 && (
            <div className="mt-4 h-24 overflow-y-auto rounded-forge border border-panel p-2 text-[12px] leading-relaxed text-muted">
              {Array.from({ length: 12 }, (_, i) => (
                <p key={i}>{i + 1}. にぎったまま、手を上げ下げすると、この中が動きます。</p>
              ))}
            </div>
          )}

          <div className="mt-5 flex items-center justify-between">
            <span className="text-[11px] text-muted">{step + 1} / {PRACTICE.length}</span>
            <button type="button" onClick={endPractice}
              className="rounded-forge border border-panel px-3 py-1.5 text-[11px] text-muted">
              スキップ
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-0 z-[90] flex justify-center px-4"
          style={{ bottom: "calc(5rem + env(safe-area-inset-bottom))" }}
        >
          <div className="rounded-full border border-panel bg-[var(--chrome)] px-3 py-1.5 text-[12px] text-fg-strong backdrop-blur-md">
            {toast}
          </div>
        </div>
      )}
    </>
  );
}

/** 押せる物の名前（カーソルの横に出す）。長い物は切る。 */
function targetName(t: Target): string {
  const raw = (t.el.getAttribute("aria-label") || t.el.getAttribute("title")
    || t.el.textContent || t.el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
  return raw.length > 14 ? `${raw.slice(0, 13)}…` : raw;
}

/** カーソルの横に出す言葉。いまの手で「何が起きるか」を1つだけ言う。 */
function cursorLabel(view: ControllerView, target: Target | null): string {
  if (view.hold?.command === "close") return "✌ 閉じる…";
  if (view.hold?.command === "pause") return view.paused ? "👍 再開…" : "👍 一時停止…";
  if (view.paused) return "";
  if (view.pose === "fist") return "✊ スクロール";
  if (!target) return "";
  if (target.blocked) return "手では押せません";
  const name = targetName(target);
  if (view.dwell > 0) return name ? `押します… ${name}` : "押します…";
  return name;
}

function statusText(phase: Phase, gate: GateState | "off", paused: boolean, handSeen: boolean): string {
  if (phase.kind === "camera") return "カメラを開いています…";
  if (phase.kind === "loading") return `認識の部品を読み込んでいます（初回だけ約${MODEL_DOWNLOAD_MB}MB）…`;
  if (phase.kind === "error") return phase.message;
  if (gate === "checking") return "顔を確かめています…";
  if (gate === "absent") return "登録した顔が見えないので止めています";
  if (gate === "stranger") return "登録した人ではないので止めています";
  if (paused) return "一時停止中";
  if (!handSeen) return gate === "ok" ? "本人を確認しました。手を映してください" : "手を映してください";
  return "手で操作中";
}

/** 小窓の2行目。「次にすること」を言う。 */
function hintText(gate: GateState | "off", view: ControllerView, handSeen: boolean, mode: ClickMode): string {
  if (gate === "checking" || gate === "absent") return "カメラの正面に顔を向けてください。";
  if (gate === "stranger") return "顔を登録した人だけが操作できます。";
  if (view.paused) return "👍 親指を立てて少し止めると再開します。";
  if (!handSeen) return "手のひらをカメラに向けて、顔の横くらいまで上げてください。";
  if (view.framing === "far") return "手が遠いです。少しカメラに近づけてください。";
  if (view.framing === "near") return "手が近すぎます。少し離してください。";
  if (view.framing === "edge") return "手が映像の端にあります。真ん中寄りで動かしてください。";
  const m = CLICK_MODES[mode];
  if (m.dwell && m.pinch) return "ボタンの上で1秒止めるか、つまむと押せます。";
  if (m.dwell) return "ボタンの上で1秒止めると押せます。";
  return "親指と人差し指でつまむと押せます。";
}

function practiceText(step: number, mode: ClickMode, gate: GateState | "off"): string {
  const m = CLICK_MODES[mode];
  switch (PRACTICE[step]?.id) {
    case "hand":
      if (gate === "checking" || gate === "absent") return "まず、カメラの正面に顔を向けてください（登録した顔を確かめます）。";
      if (gate === "stranger") return "顔を登録した人だけが操作できます。";
      return "手のひらをカメラに向けて、顔の横くらいまで上げてください。右上の小窓に、手の線が出れば大丈夫です。";
    case "aim":
      return "手をゆっくり動かして、カーソル（丸）を下の「ここ」に合わせてください。";
    case "press":
      return m.dwell && m.pinch
        ? "そのまま1秒止めてください（輪が一周すると押せます）。親指と人差し指でつまんでも押せます。"
        : m.dwell
          ? "そのまま1秒止めてください。輪が一周すると押せます。"
          : "親指と人差し指でつまんでください。中の点が大きくなり、くっつくと押せます。";
    case "scroll":
      return "✊ にぎったまま、手を上下に動かしてください。下の枠の中が動きます（上げると下へ進みます）。";
    case "close":
      return "最後に ✌ ピースをして、少し止めてください。窓を閉じるときの形です。これで練習は終わりです。";
    default:
      return "";
  }
}
