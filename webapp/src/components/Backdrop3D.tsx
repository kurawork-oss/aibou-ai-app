"use client";

/**
 * Backdrop3D — full-screen 3D environment behind the HUD.
 *
 * A depth-layered starfield (near stars drift & parallax faster than far
 * ones) over a perspective grid floor that scrolls slowly toward the viewer,
 * like a holodeck. Pointer-parallax leans the whole field so the UI reads as
 * a window into 3D space. Very low intensity by design — it must never fight
 * the content.
 *
 * Pure 2D-canvas (no WebGL). Static frame under prefers-reduced-motion;
 * pauses while the tab is hidden; DPR capped at 2.
 */

import { useEffect, useRef } from "react";

export default function Backdrop3D() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0, h = 0, dpr = 1;
    let stars: { x: number; y: number; z: number; tw: number; cyan: boolean }[] = [];

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.ceil(w * dpr);
      canvas.height = Math.ceil(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Star density scales with area (fewer on phones).
      const n = Math.max(70, Math.min(200, Math.round((w * h) / 11000)));
      stars = Array.from({ length: n }, (_, i) => ({
        x: Math.random(),
        y: Math.random(),
        z: 0.25 + Math.random() * 0.75, // depth: 0.25 far → 1 near
        tw: (i % 11) / 11,
        cyan: i % 9 === 0,
      }));
    };
    resize();
    window.addEventListener("resize", resize);

    let px = 0, py = 0, lpx = 0, lpy = 0;
    const onPointer = (e: PointerEvent) => {
      px = (e.clientX / w) * 2 - 1;
      py = (e.clientY / h) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    let raf = 0;
    let last = performance.now();
    let t = 0;

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      t += dt;
      lpx += (px - lpx) * Math.min(1, dt * 2.5);
      lpy += (py - lpy) * Math.min(1, dt * 2.5);

      ctx.clearRect(0, 0, w, h);

      /* Stars — three implicit depth layers via per-star z. */
      for (const s of stars) {
        // Slow sideways drift, wrapped; near stars move & parallax more.
        const drift = (s.x + t * 0.0035 * s.z) % 1;
        const sx = drift * w - lpx * 16 * s.z;
        const sy = s.y * h - lpy * 10 * s.z;
        const tw = 0.55 + 0.45 * Math.sin(t * (0.6 + s.tw) + s.tw * Math.PI * 2);
        const a = (0.16 + s.z * 0.42) * tw;
        ctx.fillStyle = s.cyan
          ? `rgba(0,243,255,${(a * 0.9).toFixed(3)})`
          : `rgba(205,225,255,${a.toFixed(3)})`;
        const r = 0.5 + s.z * 1.1;
        ctx.beginPath();
        ctx.arc(((sx % w) + w) % w, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      /* Perspective grid floor (bottom of the viewport). */
      const horizon = h * 0.66;
      const vpx = w / 2 - lpx * 30; // vanishing point leans with the pointer
      const floorH = h - horizon;

      // Longitudinal lines converging on the vanishing point.
      const COLS = 12;
      for (let i = -COLS; i <= COLS; i++) {
        const xb = w / 2 + (i / COLS) * w * 1.15; // where it meets the bottom
        const a = 0.13 * (1 - Math.abs(i) / (COLS + 2));
        const grad = ctx.createLinearGradient(0, horizon, 0, h);
        grad.addColorStop(0, "rgba(120,170,230,0)");
        grad.addColorStop(1, `rgba(120,170,230,${a.toFixed(3)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(vpx, horizon);
        ctx.lineTo(xb, h);
        ctx.stroke();
      }

      // Latitude rows sliding toward the viewer (t-scroll, eased spacing).
      const ROWS = 9;
      const scroll = (t * 0.05) % (1 / ROWS);
      for (let j = 0; j <= ROWS; j++) {
        const d = j / ROWS + scroll; // 0 horizon → 1 near
        if (d > 1) continue;
        const y = horizon + Math.pow(d, 2.1) * floorH;
        const a = 0.03 + Math.pow(d, 2) * 0.14;
        ctx.strokeStyle = `rgba(140,190,245,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Faint cyan glow along the horizon line.
      const hg = ctx.createLinearGradient(0, horizon - 40, 0, horizon + 30);
      hg.addColorStop(0, "rgba(0,243,255,0)");
      hg.addColorStop(0.55, "rgba(0,243,255,0.08)");
      hg.addColorStop(1, "rgba(0,243,255,0)");
      ctx.fillStyle = hg;
      ctx.fillRect(0, horizon - 40, w, 70);
    };

    if (reduce) {
      draw(last + 16);
      return () => {
        window.removeEventListener("resize", resize);
        window.removeEventListener("pointermove", onPointer);
      };
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
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointer);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: -1 }}
    />
  );
}
