"use client";

/**
 * CoreOrb — THE FORGE OS centerpiece, now a true-3D canvas.
 *
 * A fibonacci-sphere particle shell orbits a glowing pale-blue core, wrapped
 * in three tilted orbital rings whose rims are traced by lights — all drawn
 * with real 3D projection (depth-sorted: back shell → body → front shell →
 * rings), plus pointer parallax so the whole core leans toward the cursor.
 * The `state` prop tunes spin / glow / pulse so it feels alive while
 * listening / speaking / thinking.
 *
 * Pure 2D-canvas math (no WebGL, no deps) — works headless and on mobile.
 * Honors prefers-reduced-motion (renders a single static frame) and pauses
 * while the tab is hidden.
 */

import { useEffect, useRef, useState } from "react";
import { SHAPE_DRAWERS, type ShapeCtx } from "@/lib/coreShapes";
import { CORE_TYPE_EVENT, readCoreType, type CoreType } from "@/lib/coreType";
import { corePalette } from "@/lib/coreSkin";
import { DEFAULT_SKIN, type Skin } from "@/lib/skin";

export type CoreState = "idle" | "listening" | "speaking" | "thinking";

export interface CoreOrbProps {
  /** Diameter in px (layout size — the canvas paints slightly beyond it). */
  size?: number;
  /** Current assistant state — tunes glow + animation. */
  state?: CoreState;
  className?: string;
  /**
   * 形の種類。省略すると設定（localStorage）に従い、切り替えにも追従する。
   * 設定画面の見本のように「この形を出したい」ときだけ明示する。
   */
  type?: CoreType;
}

interface Tune {
  /** Sphere yaw speed (rad/s). */
  spin: number;
  /** Pale-blue bloom alpha. */
  glow: number;
  /** Cyan accent alpha (focus/active). */
  cyan: number;
  /** Core pulse frequency (Hz) and amplitude (fraction of radius). */
  pulseHz: number;
  pulseAmp: number;
  /** Ring spin multiplier — >1 spins faster (more energy). */
  orbit: number;
  /** Halo ping period (s). */
  ping: number;
}

const TUNES: Record<CoreState, Tune> = {
  idle: { spin: 0.16, glow: 0.30, cyan: 0.04, pulseHz: 0.22, pulseAmp: 0.014, orbit: 1.0, ping: 4.5 },
  listening: { spin: 0.34, glow: 0.42, cyan: 0.38, pulseHz: 0.60, pulseAmp: 0.030, orbit: 2.0, ping: 1.8 },
  speaking: { spin: 0.52, glow: 0.50, cyan: 0.30, pulseHz: 1.10, pulseAmp: 0.045, orbit: 2.6, ping: 1.2 },
  thinking: { spin: 0.28, glow: 0.45, cyan: 0.20, pulseHz: 0.42, pulseAmp: 0.024, orbit: 1.4, ping: 2.6 },
};

/** The three tilted orbit planes (matches the original CSS rings). */
const RINGS = [
  { rz: 0, rx: (70 * Math.PI) / 180, radius: 0.40, alpha: 0.55, period: 7 },
  { rz: (-58 * Math.PI) / 180, rx: (68 * Math.PI) / 180, radius: 0.445, alpha: 0.40, period: 12 },
  { rz: (58 * Math.PI) / 180, rx: (68 * Math.PI) / 180, radius: 0.49, alpha: 0.30, period: -17 },
] as const;

const PARTICLES = 340;
const PERSPECTIVE = 3.4;

export default function CoreOrb({ size = 140, state = "idle", className = "", type }: CoreOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<CoreState>(state);
  stateRef.current = state;

  // 設定の形。type を渡された場合はそちらを優先する（設定画面の見本用）。
  const [saved, setSaved] = useState<CoreType>("orb");
  useEffect(() => {
    if (type) return;
    setSaved(readCoreType());
    const onChange = (e: Event) => setSaved((e as CustomEvent<CoreType>).detail ?? readCoreType());
    window.addEventListener(CORE_TYPE_EVENT, onChange);
    return () => window.removeEventListener(CORE_TYPE_EVENT, onChange);
  }, [type]);
  const kind: CoreType = type ?? saved;

  /* コアの光の色。CSS変数は canvas に届かないので、スキンごとの配色を
     ここで1回選ぶ（毎フレーム getComputedStyle を呼ぶと、描画のたびに
     版組みが走る）。スキンを切り替えたら選び直す。 */
  const [skin, setSkinName] = useState<Skin>(DEFAULT_SKIN);
  useEffect(() => {
    const read = () => setSkinName(
      (document.documentElement.dataset.skin as Skin) || DEFAULT_SKIN);
    read();
    // data-skin は setSkin() が書き換えるだけなので、属性を見張る
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Canvas paints on a stage larger than the layout box so ring tracers and
    // bloom aren't clipped at the edges.
    const pal = corePalette(skin);
    const stage = Math.ceil(size * 1.4);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = stage * dpr;
    canvas.height = stage * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = stage / 2;
    const cy = stage / 2;
    const R = size * 0.345; // particle-shell radius (just above the core body)
    const coreR = size * 0.33;

    // Fibonacci sphere — evenly distributed particle shell.
    /* 光の粒。**球の殻ではなく、中身の詰まったかたまり**にする。
       殻に並べると、玉の表面に水玉模様が貼られたように見える（以前が
       そうだった）。半径をばらして内側にも置くと、輪郭がほどけて
       「光の集まり」に見えてくる。 */
    const pts: { x: number; y: number; z: number; tw: number; rr: number; wob: number }[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < PARTICLES; i++) {
      const y = 1 - (i / (PARTICLES - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      // 立方根で散らすと、体積あたりの密度が一定になる（中心に寄りすぎない）
      const rr = 0.16 + Math.pow((i * 0.6180339887) % 1, 1 / 3) * 0.84;
      pts.push({
        x: Math.cos(th) * r, y, z: Math.sin(th) * r,
        tw: (i % 7) / 7, rr,
        wob: ((i * 0.381966) % 1) * Math.PI * 2,   // 揺れの位相
      });
    }

    /* 光の粒は1つずつ createRadialGradient すると重い（毎コマ×粒の数）。
       ぼけた点を1枚だけ焼いておいて、拡大して重ねる。 */
    const sprite = document.createElement("canvas");
    const SPR = 64;
    sprite.width = SPR;
    sprite.height = SPR;
    const sctx = sprite.getContext("2d");
    if (sctx) {
      const g = sctx.createRadialGradient(SPR / 2, SPR / 2, 0, SPR / 2, SPR / 2, SPR / 2);
      g.addColorStop(0, `rgba(${pal.shell},1)`);
      g.addColorStop(0.35, `rgba(${pal.shell},0.45)`);
      g.addColorStop(1, `rgba(${pal.shell},0)`);
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SPR, SPR);
    }

    // Smoothly-lerped live tune + pointer parallax.
    const live: Tune = { ...TUNES[stateRef.current] };
    let px = 0, py = 0;        // parallax target (-1..1)
    let lpx = 0, lpy = 0;      // lerped parallax
    const onPointer = (e: PointerEvent) => {
      px = (e.clientX / window.innerWidth) * 2 - 1;
      py = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    let raf = 0;
    let last = performance.now();
    let t = 0;

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      t += dt;

      // Ease live tune toward the current state's targets.
      const target = TUNES[stateRef.current] ?? TUNES.idle;
      (Object.keys(target) as (keyof Tune)[]).forEach((k) => {
        live[k] += (target[k] - live[k]) * Math.min(1, dt * 4);
      });
      lpx += (px - lpx) * Math.min(1, dt * 3);
      lpy += (py - lpy) * Math.min(1, dt * 3);

      const yaw = t * live.spin * 2 + lpx * 0.45;
      const pitch = Math.sin(t * 0.35) * 0.10 + lpy * 0.30;
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
      const pulse = 1 + live.pulseAmp * Math.sin(t * live.pulseHz * Math.PI * 2);

      ctx.clearRect(0, 0, stage, stage);

      // Project a unit-sphere point; returns screen pos + depth scale.
      const project = (x0: number, y0: number, z0: number, radius: number) => {
        const x1 = x0 * cosY + z0 * sinY;
        const z1 = -x0 * sinY + z0 * cosY;
        const y2 = y0 * cosP - z1 * sinP;
        const z2 = y0 * sinP + z1 * cosP;
        const s = PERSPECTIVE / (PERSPECTIVE - z2);
        return { sx: cx + x1 * radius * s, sy: cy + y2 * radius * s, z: z2, s };
      };

      // 既定のコア以外は、形ごとの描画に任せる（舞台づくりはここが持つ）。
      const drawer = kind === "orb" ? null : SHAPE_DRAWERS[kind];
      if (drawer) {
        const shapeCtx: ShapeCtx = {
          ctx, cx, cy, size, t, pulse,
          glow: live.glow, cyan: live.cyan, project,
        };
        drawer(shapeCtx);
        return;
      }

      /* 1 — wide bloom */
      const bloom = ctx.createRadialGradient(cx, cy, coreR * 0.3, cx, cy, size * 0.68);
      bloom.addColorStop(0, `rgba(${pal.bloomIn},${(live.glow * 0.55).toFixed(3)})`);
      bloom.addColorStop(0.55, `rgba(${pal.bloomMid},${(live.glow * 0.16).toFixed(3)})`);
      bloom.addColorStop(1, `rgba(${pal.bloomOut},0)`);
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, stage, stage);
      if (live.cyan > 0.02) {
        const cb = ctx.createRadialGradient(cx, cy, coreR * 0.4, cx, cy, size * 0.52);
        cb.addColorStop(0, `rgba(${pal.ping},${(live.cyan * 0.22).toFixed(3)})`);
        cb.addColorStop(1, `rgba(${pal.ping},0)`);
        ctx.fillStyle = cb;
        ctx.fillRect(0, 0, stage, stage);
      }

      /* 2 — halo pings (expanding rings) */
      const pingPhase = (t % live.ping) / live.ping;
      ctx.beginPath();
      ctx.arc(cx, cy, size * (0.42 + pingPhase * 0.30), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${pal.bloomIn},${(0.45 * (1 - pingPhase)).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (live.cyan > 0.05) {
        const p2 = ((t + live.ping / 2) % live.ping) / live.ping;
        ctx.beginPath();
        ctx.arc(cx, cy, size * (0.44 + p2 * 0.34), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${pal.ping},${(live.cyan * (1 - p2)).toFixed(3)})`;
        ctx.stroke();
      }

      /* 3 — 光の集合体。玉ではなく、光が集まっている状態として描く。
         ・足し算で重ねる（lighter）ので、重なった所ほど白く締まる
         ・輪郭線も、つやの点も描かない。それが「ツルピカ」の正体だった
         ・粒ごとにゆっくり揺らすので、縁が固まらない */
      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      // 中心の芯。ここだけは面で置く（無いと、粒の集まりが散って見える）
      const bodyR = coreR * pulse;
      const heart = ctx.createRadialGradient(cx, cy, 0, cx, cy, bodyR * 1.05);
      heart.addColorStop(0, `rgba(${pal.bloomIn},${(0.60 * live.glow + 0.52).toFixed(3)})`);
      heart.addColorStop(0.32, `rgba(${pal.bloomIn},${(0.40 * live.glow + 0.24).toFixed(3)})`);
      heart.addColorStop(0.7, `rgba(${pal.bloomMid},${(0.20 * live.glow + 0.08).toFixed(3)})`);
      heart.addColorStop(1, `rgba(${pal.bloomMid},0)`);
      ctx.fillStyle = heart;
      ctx.beginPath();
      ctx.arc(cx, cy, bodyR * 1.05, 0, Math.PI * 2);
      ctx.fill();

      // 粒。奥から手前へ向かって明るく・大きくなる
      for (const p of pts) {
        // ゆっくりの息づき。半径を少しだけ動かして、輪郭を固めない
        const rr = p.rr * (1 + 0.06 * Math.sin(t * 0.7 + p.wob));
        const q = project(p.x * rr, p.y * rr, p.z * rr, R * pulse * 1.05);
        const depth = (q.z + 1) / 2;                 // 0 奥 → 1 手前
        const core = 1 - Math.min(1, p.rr);          // 中心ほど 1
        const tw = 0.72 + 0.28 * Math.sin(t * 1.8 + p.tw * Math.PI * 2);
        // 小さく・強く。大きく薄くすると1つの染みになって、
        // 「光が集まっている」ではなく「ぼやけた玉」に戻ってしまう。
        const a = (0.14 + core * 0.42) * (0.34 + depth * 0.66) * tw;
        if (a <= 0.006) continue;
        const rad = size * (0.017 + core * 0.030) * q.s;
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(sprite, q.sx - rad, q.sy - rad, rad * 2, rad * 2);
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      /* 6 — orbital rings with tracer lights (depth-shaded segments) */
      const SEG = 72;
      for (let ri = 0; ri < RINGS.length; ri++) {
        const ring = RINGS[ri];
        const cosRZ = Math.cos(ring.rz), sinRZ = Math.sin(ring.rz);
        const cosRX = Math.cos(ring.rx), sinRX = Math.sin(ring.rx);
        const spinA = (t * live.orbit * Math.PI * 2) / ring.period;
        const ringPt = (a: number) => {
          // circle in local plane → tilt rx → orient rz (like the CSS rings)
          const lx = Math.cos(a), ly = Math.sin(a);
          const y1 = ly * cosRX, z1 = ly * sinRX;
          const gx = lx * cosRZ - y1 * sinRZ;
          const gy = lx * sinRZ + y1 * cosRZ;
          return project(gx, gy, z1, size * ring.radius);
        };
        let prev = ringPt(0);
        for (let i = 1; i <= SEG; i++) {
          const q = ringPt((i / SEG) * Math.PI * 2);
          const depth = (q.z + prev.z) / 2;
          const a = ring.alpha * (0.22 + ((depth + 1) / 2) * 0.78);
          ctx.strokeStyle = `rgba(${pal.ringLight},${a.toFixed(3)})`;
          ctx.lineWidth = depth > 0 ? 1.1 : 0.7;
          ctx.beginPath();
          ctx.moveTo(prev.sx, prev.sy);
          ctx.lineTo(q.sx, q.sy);
          ctx.stroke();
          prev = q;
        }
        // Tracer light riding the rim.
        const tp = ringPt(spinA);
        const tr = Math.max(1.5, size * 0.02 * tp.s);
        const tg = ctx.createRadialGradient(tp.sx, tp.sy, 0, tp.sx, tp.sy, tr * 3.2);
        tg.addColorStop(0, "rgba(255,255,255,0.95)");
        tg.addColorStop(0.35, `rgba(${pal.ringLight},0.5)`);
        tg.addColorStop(1, `rgba(${pal.ringLight},0)`);
        ctx.fillStyle = tg;
        ctx.beginPath();
        ctx.arc(tp.sx, tp.sy, tr * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    if (reduce) {
      // Static single frame — no animation loop.
      draw(last + 16);
      return () => window.removeEventListener("pointermove", onPointer);
    }

    const loop = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onPointer);
    };
  }, [size, kind, skin]);

  const stagePx = Math.ceil(size * 1.4);
  return (
    <div
      className={`relative grid place-items-center ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`THE FORGE OS core — ${state}`}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ width: stagePx, height: stagePx }}
      />
    </div>
  );
}
