"use client";

/**
 * Tilt3D — pointer-tracked 3D tilt for cards.
 *
 * Wraps a card and leans it toward the cursor (rotateX/rotateY around a
 * perspective origin) with a moving specular sheen — the "holographic panel"
 * feel. Writes CSS vars directly on the element (no re-renders). Desktop
 * pointer-fine only; disabled under prefers-reduced-motion (see globals.css).
 */

import { useRef, type ReactNode, type PointerEvent } from "react";

export default function Tilt3D({
  children,
  className = "",
  max = 7,
}: {
  children: ReactNode;
  className?: string;
  /** Max tilt in degrees. */
  max?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.pointerType !== "mouse") return;
    const r = el.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;  // 0..1
    const ny = (e.clientY - r.top) / r.height;
    el.style.setProperty("--ry", `${((nx - 0.5) * 2 * max).toFixed(2)}deg`);
    el.style.setProperty("--rx", `${(-(ny - 0.5) * 2 * max).toFixed(2)}deg`);
    el.style.setProperty("--mx", `${(nx * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(ny * 100).toFixed(1)}%`);
  };

  const onLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  };

  return (
    <div ref={ref} className={`tilt3d ${className}`} onPointerMove={onMove} onPointerLeave={onLeave}>
      {children}
    </div>
  );
}
