"use client";

/**
 * CameraControl — カメラ操作モード。どの画面の上にもかぶさる。
 *
 * パソコンのカメラで手の形を読み、マウスの代わりにこのアプリを動かす。
 * 顔を登録してあれば、**登録した人が映っている間だけ**動く
 * （lib/faceMatch.ts の FaceGate）。
 *
 * 画面の右上に小窓を出す。ここで「いま何が見えていて、何をしているか」を
 * 必ず言う——手で操作するとき、いちばん困るのは「効いているのか
 * 分からない」ことなので。止めるボタンも、ここに常に出しておく。
 *
 * 1コマごとの描き直しは React を通さない（カーソルは ref で直接動かす）。
 * 30コマ/秒で画面全体を描き直すと、会話の画面が重くなる。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailability, cameraErrorMessage, readCameraPrefs, readFaceProfile,
  stopCameraControl,
} from "@/lib/cameraControl";
import { bestSimilarity, FaceGate, STRICTNESS, type GateState } from "@/lib/faceMatch";
import { GESTURE_HELP, GestureController, type Effect, type HandPose, type Pt } from "@/lib/handGesture";
import { clickableAt, isBlocked, pressAt, pressEscape, scrollAt } from "@/lib/pointerDom";
import {
  attachStream, detect, loadVision, MODEL_DOWNLOAD_MB, openCamera, stopStream,
} from "@/lib/vision";

type Phase =
  | { kind: "camera" }
  | { kind: "loading" }
  | { kind: "running" }
  | { kind: "error"; message: string };

const POSE_LABEL: Record<HandPose, string> = {
  point: "カーソル", pinch: "押す", fist: "スクロール", victory: "ピース",
  three: "指3本", thumbs_up: "親指", palm: "手を広げた", none: "",
};

/** 指の骨の並び（小窓に手の形を描く用）。 */
const BONES = [
  [0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20], [5, 9, 13, 17],
];

export default function CameraControl({ onCommand }: { onCommand: (c: "run" | "manage") => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<GestureController | null>(null);
  const onCommandRef = useRef(onCommand);
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "camera" });
  const [gate, setGate] = useState<GateState | "off">("off");
  const [handSeen, setHandSeen] = useState(false);
  const [pose, setPose] = useState<HandPose>("none");
  const [paused, setPaused] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [small, setSmall] = useState(false);
  const [preview] = useState(() => readCameraPrefs().preview);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    let raf = 0;
    const video = videoRef.current;
    const ctl = new GestureController();
    ctlRef.current = ctl;
    const prefs = readCameraPrefs();
    const profile = readFaceProfile();
    const faceGate = profile && prefs.requireFace
      ? new FaceGate(STRICTNESS[prefs.strictness].threshold)
      : null;
    setGate(faceGate ? "checking" : "off");
    setPaused(false);
    setPhase({ kind: "camera" });

    let lastGate: GateState | "off" = faceGate ? "checking" : "off";
    let lastHand = false;
    let lastPose: HandPose = "none";
    let nextFaceAt = 0;

    const apply = (effects: Effect[]) => {
      for (const e of effects) {
        const px = e.kind === "cursor" || e.kind === "click" ? e.x * window.innerWidth : 0;
        const py = e.kind === "cursor" || e.kind === "click" ? e.y * window.innerHeight : 0;
        if (e.kind === "cursor") {
          const c = cursorRef.current;
          const ring = ringRef.current;
          if (c) {
            c.style.opacity = e.visible ? "1" : "0";
            c.style.transform = `translate(${px}px, ${py}px)`;
          }
          if (ring) {
            const target = e.visible ? clickableAt(px, py) : null;
            if (target && !target.closest("[data-camera-overlay]")) {
              const r = target.getBoundingClientRect();
              ring.style.opacity = "1";
              ring.style.transform = `translate(${r.left - 3}px, ${r.top - 3}px)`;
              ring.style.width = `${r.width + 6}px`;
              ring.style.height = `${r.height + 6}px`;
              ring.dataset.blocked = isBlocked(target) ? "1" : "0";
            } else {
              ring.style.opacity = "0";
            }
          }
        } else if (e.kind === "click") {
          const res = pressAt(px, py);
          cursorRef.current?.firstElementChild?.animate(
            [{ transform: "scale(0.6)" }, { transform: "scale(1)" }], { duration: 220 });
          if (!res.done && res.why) say(res.why);
        } else if (e.kind === "scroll") {
          const c = cursorRef.current?.getBoundingClientRect();
          scrollAt(c ? c.left : window.innerWidth / 2, c ? c.top : window.innerHeight / 2, e.dy * window.innerHeight);
        } else if (e.kind === "command") {
          if (e.command === "close") { pressEscape(); say("閉じる（Esc）"); }
          else { onCommandRef.current(e.command); say(e.command === "run" ? "実行（会話）へ" : "管理へ"); }
        } else if (e.kind === "paused") {
          setPaused(e.paused);
          say(e.paused ? "一時停止しました（手を広げて止めると再開）" : "再開しました");
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
      ctx.strokeStyle = "rgba(0,243,255,0.85)";
      ctx.lineWidth = 1.5;
      for (const bone of BONES) {
        ctx.beginPath();
        bone.forEach((i, k) => (k ? ctx.lineTo(X(hand[i]), Y(hand[i])) : ctx.moveTo(X(hand[i]), Y(hand[i]))));
        ctx.stroke();
      }
      ctx.fillStyle = "#ffffff";
      for (const p of hand) { ctx.beginPath(); ctx.arc(X(p), Y(p), 1.8, 0, Math.PI * 2); ctx.fill(); }
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
      apply(ctl.step(hand, t));
      drawHand(frame.hand);

      const seen = Boolean(hand);
      if (seen !== lastHand) { lastHand = seen; setHandSeen(seen); }
      const p = ctl.state.pose;
      if (p !== lastPose) { lastPose = p; setPose(p); }

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
      raf = requestAnimationFrame(() => void loop());
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stopStream(stream);
      if (video) video.srcObject = null;
    };
  }, [attempt, say]);

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

  return (
    <>
      {/* 手のカーソルと、押す先の枠。どちらも押されない（下の物を押すため）。 */}
      <div
        ref={ringRef}
        aria-hidden
        data-camera-overlay
        className="pointer-events-none fixed left-0 top-0 z-[89] rounded-[10px] border-2 opacity-0 transition-opacity duration-100 data-[blocked='1']:border-dashed"
        style={{ borderColor: "var(--accent)", boxShadow: "0 0 12px var(--glow-strong)" }}
      />
      <div
        ref={cursorRef}
        aria-hidden
        data-camera-overlay
        className="pointer-events-none fixed left-0 top-0 z-[90] opacity-0"
      >
        <div
          className="-ml-[13px] -mt-[13px] h-[26px] w-[26px] rounded-full border-2"
          style={{ borderColor: "var(--accent)", background: "rgba(0,243,255,0.18)", boxShadow: "0 0 14px var(--glow-strong)" }}
        >
          <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
        </div>
      </div>

      {/* 小窓 */}
      <aside
        data-camera-overlay
        aria-label="カメラ操作"
        className="panel fixed right-3 z-[70] w-[184px] p-2"
        style={{ top: "calc(max(env(safe-area-inset-top), 0.75rem) + 52px)" }}
      >
        <div
          className="relative overflow-hidden rounded-forge bg-black"
          style={{ height: preview && !small ? 138 : 0, opacity: preview && !small ? 1 : 0 }}
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
          <canvas ref={canvasRef} width={184} height={138} className="absolute inset-0 h-full w-full" aria-hidden />
        </div>

        <div className="mt-1.5 flex items-start gap-1.5" role="status" aria-live="polite">
          <span
            className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
            aria-hidden
            style={{
              background: tone === "on" ? "var(--accent)" : tone === "warn" ? "#ffb347" : "#5a5f66",
              boxShadow: tone === "on" ? "0 0 8px rgba(0,243,255,0.7)" : "none",
            }}
          />
          <span className="text-[11px] leading-snug text-fg" data-camera-status>{status}</span>
        </div>
        {phase.kind === "running" && handSeen && !paused && POSE_LABEL[pose] && (
          <div className="mt-0.5 pl-3.5 text-[10px] text-muted label-mono">{POSE_LABEL[pose]}</div>
        )}

        <div className="mt-2 grid grid-cols-4 gap-1">
          {phase.kind === "error" ? (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}
              className="col-span-3 min-h-[32px] rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] text-[10px] text-fg-strong">
              もう一度
            </button>
          ) : (
            <button type="button" onClick={togglePause} disabled={phase.kind !== "running"}
              aria-label={paused ? "再開" : "一時停止"} title={paused ? "再開" : "一時停止"}
              className="min-h-[32px] rounded-forge border border-panel text-[12px] text-fg-strong disabled:opacity-40">
              {paused ? "▶" : "Ⅱ"}
            </button>
          )}
          {phase.kind !== "error" && (
            <>
              <button type="button" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen}
                aria-label="手の形の一覧" title="手の形の一覧"
                className="min-h-[32px] rounded-forge border border-panel text-[12px] text-fg-strong">
                ?
              </button>
              <button type="button" onClick={() => setSmall((v) => !v)} disabled={!preview}
                aria-label={small ? "映像を出す" : "映像を隠す"} title={small ? "映像を出す" : "映像を隠す"}
                className="min-h-[32px] rounded-forge border border-panel text-[12px] text-fg-strong disabled:opacity-40">
                {small ? "▢" : "–"}
              </button>
            </>
          )}
          <button type="button" onClick={stopCameraControl}
            aria-label="カメラ操作を止める" title="カメラ操作を止める（カメラも消えます）"
            className="min-h-[32px] rounded-forge border text-[12px]"
            style={{ borderColor: "rgba(255,157,157,0.5)", color: "#ff9d9d" }}>
            ■
          </button>
        </div>

        {helpOpen && (
          <ul className="mt-2 space-y-1 border-t border-panel pt-2" aria-label="手の形と動き">
            {GESTURE_HELP.map((g) => (
              <li key={g.pose} className="flex gap-1.5 text-[10px] leading-snug">
                <span className="w-4 shrink-0 text-center" aria-hidden>{g.mark}</span>
                <span className="text-muted">{g.how} → <span className="text-fg">{g.does}</span></span>
              </li>
            ))}
            <li className="pt-1 text-[10px] leading-snug text-muted">
              承認のボタンは手では押せません（マウスか指で）。
            </li>
          </ul>
        )}
      </aside>

      {toast && (
        <div
          role="status"
          data-camera-overlay
          className="pointer-events-none fixed inset-x-0 z-[90] flex justify-center px-4"
          style={{ bottom: "calc(5rem + env(safe-area-inset-bottom))" }}
        >
          <div className="rounded-full border border-panel bg-[var(--chrome)] px-3 py-1.5 text-[11px] text-fg-strong backdrop-blur-md">
            {toast}
          </div>
        </div>
      )}
    </>
  );
}

function statusText(phase: Phase, gate: GateState | "off", paused: boolean, handSeen: boolean): string {
  if (phase.kind === "camera") return "カメラを開いています…";
  if (phase.kind === "loading") return `認識の部品を読み込んでいます（初回だけ約${MODEL_DOWNLOAD_MB}MB）…`;
  if (phase.kind === "error") return phase.message;
  if (gate === "checking") return "顔を確かめています…";
  if (gate === "absent") return "登録した顔が見えないので止めています";
  if (gate === "stranger") return "登録した人ではないので止めています";
  if (paused) return "一時停止中（手を広げて止めると再開）";
  if (!handSeen) return gate === "ok" ? "本人を確認しました。手を映してください" : "手を映してください";
  return "手で操作中";
}
