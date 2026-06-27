"use client";

/**
 * CoreOrb — THE FORGE OS centerpiece.
 *
 * A glowing pale-blue core wrapped in the signature "atmosphere": three tilted
 * 3D orbit rings, each with a light that traces its rim (ported from the
 * original FORGE OS core). The `state` prop tunes glow + spin so the core feels
 * alive while listening / speaking / thinking.
 */

import { motion, useReducedMotion, type Transition } from "framer-motion";
import { useMemo } from "react";

export type CoreState = "idle" | "listening" | "speaking" | "thinking";

export interface CoreOrbProps {
  /** Diameter in px. */
  size?: number;
  /** Current assistant state — tunes glow + animation. */
  state?: CoreState;
  className?: string;
}

interface StateStyle {
  /** Core (pale-blue) glow alpha. */
  glow: number;
  /** Cyan accent ring alpha (focus/active). */
  cyan: number;
  pulseScale: [number, number, number];
  pulseDuration: number;
  ringDuration: number;
  /** Orbit spin multiplier — <1 spins faster (more energy). */
  orbit: number;
}

const STATE_STYLES: Record<CoreState, StateStyle> = {
  idle: { glow: 0.3, cyan: 0.0, pulseScale: [1, 1.03, 1], pulseDuration: 4.5, ringDuration: 4.5, orbit: 1 },
  listening: { glow: 0.42, cyan: 0.38, pulseScale: [1, 1.06, 1], pulseDuration: 1.6, ringDuration: 1.8, orbit: 0.5 },
  speaking: { glow: 0.5, cyan: 0.3, pulseScale: [1, 1.08, 1], pulseDuration: 0.9, ringDuration: 1.2, orbit: 0.38 },
  thinking: { glow: 0.45, cyan: 0.2, pulseScale: [1, 1.05, 1], pulseDuration: 2.4, ringDuration: 2.6, orbit: 0.7 },
};

// Base spin (seconds) for each tilted ring; scaled by state.orbit.
const ORBIT_BASE = [7, 12, 17] as const;
// Ring diameter as a fraction of the container, with rim colour.
// Rings extend BEYOND the core (scale > core's 0.66) for the wide-orbit look.
const ORBIT_RINGS = [
  { scale: 1.22, color: "rgba(205,226,255,0.6)" },
  { scale: 1.06, color: "rgba(196,219,255,0.4)" },
  { scale: 1.06, color: "rgba(188,212,255,0.26)" },
] as const;

export default function CoreOrb({ size = 140, state = "idle", className = "" }: CoreOrbProps) {
  const reduceMotion = useReducedMotion();
  const s = STATE_STYLES[state] ?? STATE_STYLES.idle;

  // Layered shadow glow — a tight inner halo plus a soft wide bloom, tinted by
  // the pale-blue core color and (when active) a cyan accent.
  const boxShadow = useMemo(() => {
    const core = (a: number) => `rgba(150,200,255,${a})`;
    const cyan = (a: number) => `rgba(0,243,255,${a})`;
    return [
      `0 0 ${size * 0.18}px ${core(s.glow)}`,
      `0 0 ${size * 0.5}px ${core(s.glow * 0.7)}`,
      `0 0 ${size * 0.95}px ${core(s.glow * 0.45)}`,
      s.cyan > 0 ? `0 0 ${size * 0.32}px ${cyan(s.cyan)}` : "",
      // Soft inner highlight (top-left) + a dark inset rim so the sphere
      // reads as a lit ball against a deep, near-black edge.
      `inset 0 0 ${size * 0.16}px rgba(210,232,255,0.2)`,
      `inset 0 0 ${size * 0.14}px ${size * 0.05}px rgba(6,12,30,0.55)`,
    ]
      .filter(Boolean)
      .join(", ");
  }, [size, s.glow, s.cyan]);

  const pulseTransition: Transition = {
    duration: s.pulseDuration,
    repeat: Infinity,
    ease: "easeInOut",
  };

  return (
    <div
      className={`relative grid place-items-center ${className}`}
      style={{ width: size, height: size, perspective: size * 3 }}
      role="img"
      aria-label={`THE FORGE OS core — ${state}`}
    >
      {/* Expanding halo ring (pings outward). */}
      {!reduceMotion && (
        <motion.span
          aria-hidden
          className="absolute rounded-full"
          style={{
            width: size * 0.92,
            height: size * 0.92,
            border: "1px solid rgba(150,200,255,0.5)",
          }}
          animate={{ scale: [0.9, 1.55], opacity: [0.5, 0] }}
          transition={{ duration: s.ringDuration, repeat: Infinity, ease: "easeOut" }}
        />
      )}

      {/* Second, offset halo for richer depth on active states. */}
      {!reduceMotion && s.cyan > 0 && (
        <motion.span
          aria-hidden
          className="absolute rounded-full"
          style={{
            width: size * 0.92,
            height: size * 0.92,
            border: `1px solid rgba(0,243,255,${s.cyan})`,
          }}
          animate={{ scale: [0.95, 1.7], opacity: [s.cyan, 0] }}
          transition={{ duration: s.ringDuration, repeat: Infinity, ease: "easeOut", delay: s.ringDuration / 2 }}
        />
      )}

      {/* 3D orbit stage — three tilted rings, each with a tracing light. */}
      <div aria-hidden className="forge-stage absolute inset-0">
        {ORBIT_RINGS.map((ring, i) => {
          const d = size * ring.scale;
          return (
            <span
              key={i}
              className={`forge-orbit forge-orbit-${i + 1}`}
              style={{
                width: d,
                height: d,
                border: `1px solid ${ring.color}`,
                animationDuration: `${(ORBIT_BASE[i] * s.orbit).toFixed(2)}s`,
              }}
            />
          );
        })}
      </div>

      {/* Thin silver rim. */}
      <span
        aria-hidden
        className="absolute rounded-full"
        style={{
          width: size * 0.74,
          height: size * 0.74,
          border: "1px solid rgba(197,198,199,0.3)",
        }}
      />

      {/* The core orb — pale-blue centre fading to a deep navy/black rim
          (the original FORGE OS "dark sphere" gradient). */}
      <motion.div
        className="relative rounded-full"
        style={{
          width: size * 0.66,
          height: size * 0.66,
          background:
            "radial-gradient(circle at 42% 36%, rgba(255,255,255,0.98) 0%, rgba(214,234,255,0.95) 20%, rgba(158,198,245,0.7) 44%, rgba(70,118,190,0.55) 68%, rgba(22,44,86,0.7) 86%, rgba(6,12,30,0.92) 100%)",
          boxShadow,
        }}
        animate={reduceMotion ? undefined : { scale: s.pulseScale }}
        transition={reduceMotion ? undefined : pulseTransition}
      >
        {/* Specular highlight. */}
        <span
          aria-hidden
          className="absolute rounded-full"
          style={{
            top: "14%",
            left: "20%",
            width: "34%",
            height: "26%",
            background: "radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 70%)",
            filter: "blur(2px)",
          }}
        />
        {/* Inner shimmer that rotates slowly to suggest a living core. */}
        {!reduceMotion && (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "conic-gradient(from 0deg, rgba(0,243,255,0) 0deg, rgba(0,243,255,0.18) 90deg, rgba(150,200,255,0.05) 200deg, rgba(0,243,255,0) 360deg)",
              mixBlendMode: "screen",
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: state === "speaking" ? 6 : 14, repeat: Infinity, ease: "linear" }}
          />
        )}
      </motion.div>
    </div>
  );
}
