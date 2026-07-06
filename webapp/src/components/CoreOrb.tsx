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

import { useEffect, useRef } from "react";

export type CoreState = "idle" | "listening" | "speaking" | "thinking";

export interface CoreOrbProps {
  /** Diameter in px (layout size — the canvas paints slightly beyond it). */
  size?: number;
  /** Current assistant state — tunes glow + animation. */
  state?: CoreState;
  className?: string;
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

export default function CoreOrb({ size = 140, state = "idle", className = "" }: CoreOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<CoreState>(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Canvas paints on a stage larger than the layout box so ring tracers and
    // bloom aren't clipped at the edges.
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
    const pts: { x: number; y: number; z: number; tw: number }[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < PARTICLES; i++) {
      const y = 1 - (i / (PARTICLES - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, tw: (i % 7) / 7 });
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

      /* 1 — wide bloom */
      const bloom = ctx.createRadialGradient(cx, cy, coreR * 0.3, cx, cy, size * 0.68);
      bloom.addColorStop(0, `rgba(150,200,255,${(live.glow * 0.55).toFixed(3)})`);
      bloom.addColorStop(0.55, `rgba(120,180,255,${(live.glow * 0.16).toFixed(3)})`);
      bloom.addColorStop(1, "rgba(120,180,255,0)");
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, stage, stage);
      if (live.cyan > 0.02) {
        const cb = ctx.createRadialGradient(cx, cy, coreR * 0.4, cx, cy, size * 0.52);
        cb.addColorStop(0, `rgba(0,243,255,${(live.cyan * 0.22).toFixed(3)})`);
        cb.addColorStop(1, "rgba(0,243,255,0)");
        ctx.fillStyle = cb;
        ctx.fillRect(0, 0, stage, stage);
      }

      /* 2 — halo pings (expanding rings) */
      const pingPhase = (t % live.ping) / live.ping;
      ctx.beginPath();
      ctx.arc(cx, cy, size * (0.42 + pingPhase * 0.30), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(150,200,255,${(0.45 * (1 - pingPhase)).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (live.cyan > 0.05) {
        const p2 = ((t + live.ping / 2) % live.ping) / live.ping;
        ctx.beginPath();
        ctx.arc(cx, cy, size * (0.44 + p2 * 0.34), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,243,255,${(live.cyan * (1 - p2)).toFixed(3)})`;
        ctx.stroke();
      }

      // Project a unit-sphere point; returns screen pos + depth scale.
      const project = (x0: number, y0: number, z0: number, radius: number) => {
        const x1 = x0 * cosY + z0 * sinY;
        const z1 = -x0 * sinY + z0 * cosY;
        const y2 = y0 * cosP - z1 * sinP;
        const z2 = y0 * sinP + z1 * cosP;
        const s = PERSPECTIVE / (PERSPECTIVE - z2);
        return { sx: cx + x1 * radius * s, sy: cy + y2 * radius * s, z: z2, s };
      };

      /* 3 — back half of the particle shell (dim, behind the body) */
      for (const p of pts) {
        const q = project(p.x, p.y, p.z, R * pulse);
        if (q.z >= 0) continue;
        const d = (q.z + 1) / 2; // 0 far → 0.5 mid
        const a = 0.05 + d * 0.30;
        const tw = 0.75 + 0.25 * Math.sin(t * 2 + p.tw * Math.PI * 2);
        ctx.fillStyle = `rgba(140,185,250,${(a * tw).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(q.sx, q.sy, Math.max(0.4, size * 0.006 * q.s), 0, Math.PI * 2);
        ctx.fill();
      }

      /* 4 — core body: pale-blue centre → deep navy/black rim */
      const bodyR = coreR * pulse;
      const body = ctx.createRadialGradient(
        cx - bodyR * 0.24, cy - bodyR * 0.36, bodyR * 0.08,
        cx, cy, bodyR,
      );
      body.addColorStop(0, "rgba(255,255,255,0.98)");
      body.addColorStop(0.2, "rgba(214,234,255,0.95)");
      body.addColorStop(0.44, "rgba(158,198,245,0.72)");
      body.addColorStop(0.68, "rgba(70,118,190,0.60)");
      body.addColorStop(0.86, "rgba(22,44,86,0.78)");
      body.addColorStop(1, "rgba(6,12,30,0.95)");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, bodyR, 0, Math.PI * 2);
      ctx.fill();

      // Specular highlight + thin silver rim.
      const spec = ctx.createRadialGradient(
        cx - bodyR * 0.34, cy - bodyR * 0.44, 0,
        cx - bodyR * 0.34, cy - bodyR * 0.44, bodyR * 0.5,
      );
      spec.addColorStop(0, "rgba(255,255,255,0.85)");
      spec.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = spec;
      ctx.beginPath();
      ctx.arc(cx - bodyR * 0.34, cy - bodyR * 0.44, bodyR * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.37, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(197,198,199,0.28)";
      ctx.lineWidth = 1;
      ctx.stroke();

      /* 5 — front half of the particle shell (bright energy) */
      for (const p of pts) {
        const q = project(p.x, p.y, p.z, R * pulse);
        if (q.z < 0) continue;
        const d = q.z; // 0 mid → 1 nearest
        const tw = 0.7 + 0.3 * Math.sin(t * 2.4 + p.tw * Math.PI * 2);
        const a = (0.25 + d * 0.65) * tw;
        const cyanMix = live.cyan > 0.1 && p.tw > 0.6;
        ctx.fillStyle = cyanMix
          ? `rgba(120,240,255,${a.toFixed(3)})`
          : `rgba(225,240,255,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(q.sx, q.sy, Math.max(0.5, size * 0.0085 * q.s), 0, Math.PI * 2);
        ctx.fill();
      }

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
          ctx.strokeStyle = `rgba(200,222,255,${a.toFixed(3)})`;
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
        tg.addColorStop(0.35, "rgba(190,230,255,0.5)");
        tg.addColorStop(1, "rgba(0,243,255,0)");
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
  }, [size]);

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
