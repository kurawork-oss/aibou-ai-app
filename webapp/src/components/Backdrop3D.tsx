"use client";

/**
 * Backdrop3D — full-screen 3D environment behind the HUD.
 *
 * A depth-layered starfield (near stars drift & parallax faster than far
 * ones) over a perspective grid floor that scrolls slowly toward the viewer,
 * like a holodeck. Pointer-parallax leans the whole field so the UI reads as
 * a window into 3D space. Kept below content contrast — present but never
 * fighting the panels.
 *
 * Sky events: every so often a real constellation (北斗七星・カシオペヤ・
 * オリオン・はくちょう・こと座) fades in at a random spot/rotation, holds,
 * and dissolves; meteors (流れ星) streak across the upper sky on a random
 * cadence — occasionally a long bright one.
 *
 * Pure 2D-canvas (no WebGL). Static frame under prefers-reduced-motion
 * (one constellation shown, no meteors); pauses while the tab is hidden;
 * DPR capped at 2.
 */

import { useEffect, useRef } from "react";
import { Water } from "@/lib/water";

/* ── Constellation shapes (normalized coords + edge lists) ─────────── */
interface ConstShape { name: string; pts: [number, number][]; edges: [number, number][] }

const CONSTELLATIONS: ConstShape[] = [
  { // 北斗七星 (Big Dipper) — handle into the bowl
    name: "dipper",
    pts: [[0, 0.28], [0.15, 0.2], [0.3, 0.16], [0.45, 0.2], [0.6, 0.16], [0.78, 0.22], [0.72, 0.42]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]],
  },
  { // カシオペヤ座 (Cassiopeia) — the W
    name: "cassiopeia",
    pts: [[0, 0.4], [0.22, 0.15], [0.45, 0.35], [0.68, 0.05], [0.95, 0.25]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  { // オリオン座 (Orion) — shoulders, belt, feet
    name: "orion",
    pts: [[0.2, 0.05], [0.75, 0.08], [0.38, 0.42], [0.5, 0.5], [0.62, 0.58], [0.15, 0.92], [0.8, 0.95]],
    edges: [[0, 2], [2, 3], [3, 4], [4, 1], [2, 5], [4, 6]],
  },
  { // はくちょう座 (Cygnus) — the Northern Cross
    name: "cygnus",
    pts: [[0.5, 0], [0.5, 0.38], [0.5, 0.66], [0.5, 1], [0.06, 0.5], [0.94, 0.26]],
    edges: [[0, 1], [1, 2], [2, 3], [4, 1], [1, 5]],
  },
  { // こと座 (Lyra) — Vega + the little parallelogram
    name: "lyra",
    pts: [[0.5, 0], [0.42, 0.28], [0.64, 0.34], [0.56, 0.62], [0.34, 0.56]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1]],
  },
];

interface ActiveConst {
  shape: ConstShape;
  x: number; y: number; scale: number; rot: number;
  born: number; dur: number;
}

interface Meteor {
  x: number; y: number; vx: number; vy: number;
  born: number; life: number; len: number; big: boolean;
}

/**
 * 星空とグリッドの色。
 *
 * cyber は「シルバーで光る」ことがそのスキンの肝なので、青みを抜いて
 * 灰白へ寄せる。ここを青のままにすると、コアだけシルバーで背景が青くなり、
 * ちぐはぐに見える。
 */
function backdropTint(skin: string | undefined) {
  const silver = skin === "cyber";
  return {
    star: silver ? "228,235,248" : "205,225,255",
    starHot: silver ? "255,255,255" : "0,243,255",
    grid: silver ? "170,186,212" : "120,170,230",
    gridNear: silver ? "198,210,232" : "140,190,245",
    haze: silver ? "206,216,234" : "0,243,255",
    ray: silver ? "216,226,244" : "175,212,255",
  };
}

/**
 * 水の色。紺の地に、シルバーの照りが乗る。
 *
 * 照りを白（255,255,255）にすると、波の縁だけが白く飛んで
 * 「水」ではなく「ひび割れ」に見える。少し落とした銀にする。
 */
const WATER_COLORS = {
  deep: [6, 11, 26] as [number, number, number],      // 底のほう
  shallow: [14, 24, 52] as [number, number, number],  // 上のほう（やや明るい）
  sheen: [198, 212, 238] as [number, number, number], // 波の照り＝シルバー
};

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
    /* 紺（CYBER）の地は水たまり。高さを計算して、傾きを光に変える。
       格子は8px四方——画素ぶん計算するとスマホで間に合わない。 */
    const water = new Water({ cell: 6, damping: 0.984, rainEvery: 1.9 });
    const fitWater = () => water.resize(w, h);

    resize();
    fitWater();
    window.addEventListener("resize", () => { resize(); fitWater(); });

    let px = 0, py = 0, lpx = 0, lpy = 0;
    let lastDropX = -999, lastDropY = -999;
    const onPointer = (e: PointerEvent) => {
      px = (e.clientX / w) * 2 - 1;
      py = (e.clientY / h) * 2 - 1;
      // 触った所に波を立てる。動かしている間は、少し離れるたびに1滴。
      // 毎イベント落とすと線ではなく帯になり、水に見えない。
      if (document.documentElement.dataset.skin !== "cyber") return;
      const d = Math.hypot(e.clientX - lastDropX, e.clientY - lastDropY);
      if (d < 14) return;
      lastDropX = e.clientX;
      lastDropY = e.clientY;
      water.drop(e.clientX, e.clientY, e.pointerType === "touch" ? 0.9 : 0.55, 2);
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    // 押した瞬間は、はっきり大きく落とす（触れたことが伝わるように）
    const onDown = (e: PointerEvent) => {
      if (document.documentElement.dataset.skin !== "cyber") return;
      lastDropX = e.clientX;
      lastDropY = e.clientY;
      water.drop(e.clientX, e.clientY, 1.6, 3);
    };
    window.addEventListener("pointerdown", onDown, { passive: true });

    let raf = 0;
    let last = performance.now();
    let t = 0;

    /* Sky events — one constellation at a time + up to 3 meteors. */
    let activeConst: ActiveConst | null = null;
    let lastConstIdx = -1;
    let nextConstAt = 1.0;   // first one appears quickly
    let meteors: Meteor[] = [];
    let nextMeteorAt = 1.6;  // first shooting star soon after load

    const spawnConstellation = () => {
      let idx = Math.floor(Math.random() * CONSTELLATIONS.length);
      if (idx === lastConstIdx) idx = (idx + 1) % CONSTELLATIONS.length;
      lastConstIdx = idx;
      const scale = Math.min(w, h) * (0.16 + Math.random() * 0.10);
      activeConst = {
        shape: CONSTELLATIONS[idx],
        x: w * (0.12 + Math.random() * 0.66),
        y: h * (0.06 + Math.random() * 0.34),
        scale,
        rot: (Math.random() - 0.5) * 0.7,
        born: t,
        dur: 8 + Math.random() * 4,
      };
    };

    const spawnMeteor = () => {
      const big = Math.random() < 0.18;
      const dir = Math.random() < 0.5 ? 1 : -1; // left→right or right→left
      const speed = (0.55 + Math.random() * 0.5) * Math.max(w, 900);
      const angle = (24 + Math.random() * 16) * (Math.PI / 180);
      meteors.push({
        x: dir === 1 ? -40 + Math.random() * w * 0.4 : w * 0.6 + Math.random() * w * 0.4 + 40,
        y: h * (0.02 + Math.random() * 0.3),
        vx: Math.cos(angle) * speed * dir,
        vy: Math.sin(angle) * speed,
        born: t,
        life: big ? 1.1 + Math.random() * 0.4 : 0.6 + Math.random() * 0.4,
        len: big ? 150 + Math.random() * 90 : 70 + Math.random() * 60,
        big,
      });
    };

    const drawConstellation = (tone: ReturnType<typeof backdropTint>) => {
      if (!activeConst) return;
      const c = activeConst;
      const age = t - c.born;
      if (age > c.dur) {
        activeConst = null;
        nextConstAt = t + 6 + Math.random() * 9;
        return;
      }
      // Envelope: fade in 1.4s, hold, fade out 1.8s.
      const env = Math.min(1, age / 1.4) * Math.min(1, (c.dur - age) / 1.8);
      const cosR = Math.cos(c.rot), sinR = Math.sin(c.rot);
      const proj = c.shape.pts.map(([nx, ny]) => {
        const ox = (nx - 0.5) * c.scale, oy = (ny - 0.5) * c.scale;
        return {
          x: c.x + ox * cosR - oy * sinR - lpx * 8,
          y: c.y + ox * sinR + oy * cosR - lpy * 5,
        };
      });
      // Connecting lines.
      ctx.strokeStyle = `rgba(${tone.ray},${(0.16 * env).toFixed(3)})`;
      ctx.lineWidth = 1;
      for (const [a, b] of c.shape.edges) {
        ctx.beginPath();
        ctx.moveTo(proj[a].x, proj[a].y);
        ctx.lineTo(proj[b].x, proj[b].y);
        ctx.stroke();
      }
      // Member stars — brighter than the field, with a soft halo.
      for (let i = 0; i < proj.length; i++) {
        const p = proj[i];
        const r = i === 0 ? 2.1 : 1.5; // lead star slightly larger
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.4);
        g.addColorStop(0, `rgba(235,245,255,${(0.85 * env).toFixed(3)})`);
        g.addColorStop(0.4, `rgba(190,222,255,${(0.30 * env).toFixed(3)})`);
        g.addColorStop(1, "rgba(190,222,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const drawMeteors = (dt: number) => {
      meteors = meteors.filter((m) => t - m.born < m.life);
      for (const m of meteors) {
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        const age = (t - m.born) / m.life;
        // Quick flare-in, long fade-out.
        const env = Math.min(1, age * 6) * (1 - age * age);
        const sp = Math.hypot(m.vx, m.vy) || 1;
        const tx = m.x - (m.vx / sp) * m.len;
        const ty = m.y - (m.vy / sp) * m.len;
        const grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
        grad.addColorStop(0, `rgba(240,250,255,${(0.85 * env).toFixed(3)})`);
        grad.addColorStop(0.25, `rgba(170,215,255,${(0.4 * env).toFixed(3)})`);
        grad.addColorStop(1, "rgba(120,180,255,0)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = m.big ? 2 : 1.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        // Bright head.
        const hg2 = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.big ? 7 : 4.5);
        hg2.addColorStop(0, `rgba(255,255,255,${(0.9 * env).toFixed(3)})`);
        hg2.addColorStop(1, "rgba(200,235,255,0)");
        ctx.fillStyle = hg2;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.big ? 7 : 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const draw = (now: number) => {
      // 模様や白地を持つスキンでは、星空・グリッドを描かない。
      //   aibou   … 白地に星を撒くとゴミのように見える
      //   emerald … CSS の綾模様と重なって濁る
      // 1枚消してから抜ける（CSS側でも .forge-backdrop を隠している）。
      const skin = document.documentElement.dataset.skin;
      if (skin === "aibou" || skin === "emerald") {
        ctx.clearRect(0, 0, w, h);
        last = now;
        return;
      }

      // 紺（CYBER）は水たまり。星もグリッドも出さない——水面に星が
      // 浮いていると、水なのか空なのか分からなくなる。
      if (skin === "cyber") {
        const wdt = Math.min((now - last) / 1000, 0.05);
        last = now;
        water.step(wdt);
        water.render(ctx, w, h, WATER_COLORS);
        // 背景として後ろへ下げる。水紋をそのままの強さで出すと、
        // 上に載る文章と明るさで張り合って読みにくくなる（実際なった）。
        ctx.fillStyle = "rgba(6, 11, 26, 0.42)";
        ctx.fillRect(0, 0, w, h);
        return;
      }

      const tone = backdropTint(skin);
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
          ? `rgba(${tone.starHot},${(a * 0.9).toFixed(3)})`
          : `rgba(${tone.star},${a.toFixed(3)})`;
        const r = 0.5 + s.z * 1.1;
        ctx.beginPath();
        ctx.arc(((sx % w) + w) % w, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      /* Sky events — constellations fade in/out; meteors streak across. */
      if (!reduce) {
        if (!activeConst && t >= nextConstAt) spawnConstellation();
        if (t >= nextMeteorAt && meteors.length < 3) {
          spawnMeteor();
          nextMeteorAt = t + 4 + Math.random() * 7;
        }
      }
      drawConstellation(tone);
      drawMeteors(dt);

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
        grad.addColorStop(0, `rgba(${tone.grid},0)`);
        grad.addColorStop(1, `rgba(${tone.grid},${a.toFixed(3)})`);
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
        ctx.strokeStyle = `rgba(${tone.gridNear},${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Faint cyan glow along the horizon line.
      const hg = ctx.createLinearGradient(0, horizon - 40, 0, horizon + 30);
      hg.addColorStop(0, `rgba(${tone.haze},0)`);
      hg.addColorStop(0.55, `rgba(${tone.haze},0.08)`);
      hg.addColorStop(1, `rgba(${tone.haze},0)`);
      ctx.fillStyle = hg;
      ctx.fillRect(0, horizon - 40, w, 70);
    };

    if (reduce) {
      // Static frame — include one fully-faded-in constellation, no meteors.
      spawnConstellation();
      if (activeConst) (activeConst as ActiveConst).born = t - 2;
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
      className="forge-backdrop pointer-events-none fixed inset-0"
      style={{ zIndex: -1 }}
    />
  );
}
