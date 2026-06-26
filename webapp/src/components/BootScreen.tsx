"use client";

/**
 * BootScreen — full-screen FORGE OS splash that MASKS backend cold-start.
 *
 * On mount we poll `${NEXT_PUBLIC_API_URL}/health` every 1.5s (up to ~60s) over
 * the animated loading backdrop (loading_bg.gif + holographic grid + scanline),
 * showing the orbiting core, a boot log, and a link-progress bar. When healthy
 * we fade out and render children. If it never responds we show an offline /
 * retry state — but the user can always tap to enter. The point: never expose
 * raw backend lag.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import CoreOrb from "./CoreOrb";
import { health, API_URL } from "@/lib/api";

const POLL_INTERVAL_MS = 1500;
const MAX_WAIT_MS = 60_000;

const STATUS_LINES = [
  "WAKING CORE…",
  "ESTABLISHING LINK…",
  "CALIBRATING SENSORS…",
  "SYNCING MEMORY…",
  "ALIGNING NEURAL LATTICE…",
];

const BOOT_LOG = [
  "AUTH SESSION ............ OK",
  "SECURE VAULT ........... LOADED",
  "AI CORE ................ ONLINE",
  "WORKSPACE SYNC ......... DONE",
];

type Phase = "booting" | "ready" | "offline";

export default function BootScreen({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("booting");
  const [statusIndex, setStatusIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const cancelledRef = useRef(false);
  const startRef = useRef<number>(Date.now());

  // ── Health polling loop ────────────────────────────────────────────
  const runBoot = useCallback(async () => {
    cancelledRef.current = false;
    startRef.current = Date.now();
    setElapsed(0);

    // If no API URL is configured, don't hang — show offline but allow entry.
    if (!API_URL) {
      setPhase("offline");
      return;
    }

    while (!cancelledRef.current) {
      const ok = await health();
      if (cancelledRef.current) return;
      if (ok) {
        setPhase("ready");
        return;
      }
      if (Date.now() - startRef.current > MAX_WAIT_MS) {
        setPhase("offline");
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }, []);

  useEffect(() => {
    void runBoot();
    return () => {
      cancelledRef.current = true;
    };
  }, [runBoot, attempt]);

  // ── Rotating status line + elapsed counter (while booting) ─────────
  useEffect(() => {
    if (phase !== "booting") return;
    const statusTimer = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_LINES.length);
    }, 1800);
    const tick = setInterval(() => {
      setElapsed(Math.min(MAX_WAIT_MS, Date.now() - startRef.current));
    }, 100);
    return () => {
      clearInterval(statusTimer);
      clearInterval(tick);
    };
  }, [phase, attempt]);

  const retry = useCallback(() => {
    setPhase("booting");
    setStatusIndex(0);
    setAttempt((a) => a + 1);
  }, []);

  const enterAnyway = useCallback(() => {
    cancelledRef.current = true;
    setPhase("ready");
  }, []);

  const progress = Math.min(100, Math.round((elapsed / MAX_WAIT_MS) * 100));
  const orbState = phase === "offline" ? "idle" : "thinking";

  return (
    <>
      {/* Children mount as soon as we're ready; the overlay fades on top. */}
      {phase === "ready" && children}

      <AnimatePresence>
        {phase !== "ready" && (
          <motion.div
            key="bootscreen"
            className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden px-6"
            style={{ background: "var(--bg)" }}
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.8, ease: "easeInOut" } }}
          >
            {/* Animated loading backdrop (GIF) — blurred + dimmed for legibility. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage: "url('/loading_bg.gif')",
                backgroundSize: "cover",
                backgroundPosition: "center",
                filter: "blur(2px) brightness(0.42) saturate(1.15)",
                transform: "scale(1.08)",
              }}
            />
            {/* Holographic grid + vignette + scanline over the GIF. */}
            <div aria-hidden className="forge-grid pointer-events-none absolute inset-0 opacity-70" />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(720px 520px at 50% 40%, rgba(150,200,255,0.10), transparent 62%), rgba(5,6,9,0.55)",
              }}
            />
            <div aria-hidden className="forge-scan pointer-events-none" />

            <motion.div
              className="relative flex flex-col items-center text-center"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              <CoreOrb size={170} state={orbState} />

              <h1 className="label-mono text-glow mt-9 text-[15px] font-normal tracking-[0.4em] text-fg-strong sm:text-base">
                THE FORGE OS
              </h1>

              {phase === "booting" ? (
                <>
                  <p className="mt-2 text-[11px] tracking-[0.25em] text-muted label-mono">SYSTEM BOOTING…</p>

                  {/* Boot log — lines reveal as the link climbs. */}
                  <div className="mt-5 min-h-[84px] w-[260px] max-w-[78vw] text-left">
                    {BOOT_LOG.map((line, i) => {
                      const shown = progress >= (i + 1) * 12 || elapsed > (i + 1) * 700;
                      return (
                        <motion.div
                          key={line}
                          className="text-[11px] leading-relaxed label-mono"
                          style={{ color: "rgba(159,231,255,0.92)", letterSpacing: "0.12em" }}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: shown ? 1 : 0 }}
                          transition={{ duration: 0.4 }}
                        >
                          <span className="text-muted">▸ </span>
                          {line}
                        </motion.div>
                      );
                    })}
                  </div>

                  {/* Rotating status line with a thinking shimmer. */}
                  <div className="mt-2 h-5 overflow-hidden">
                    <AnimatePresence mode="wait">
                      <motion.span
                        key={statusIndex}
                        className="block text-xs label-mono shimmer"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.35 }}
                      >
                        {STATUS_LINES[statusIndex]}
                      </motion.span>
                    </AnimatePresence>
                  </div>

                  {/* Slim progress bar. */}
                  <div className="mt-5 h-[3px] w-56 max-w-[70vw] overflow-hidden rounded-full bg-white/5">
                    <motion.div
                      className="h-full rounded-full"
                      style={{
                        background: "linear-gradient(90deg, rgba(150,200,255,0.5), #00f3ff)",
                        boxShadow: "0 0 12px rgba(0,243,255,0.5)",
                      }}
                      animate={{ width: `${Math.max(8, progress)}%` }}
                      transition={{ ease: "easeOut", duration: 0.3 }}
                    />
                  </div>
                  <p className="mt-3 text-[10px] tracking-[0.2em] text-muted/70 label-mono">LINK {progress}%</p>
                </>
              ) : (
                // Offline / retry state.
                <div className="mt-6 flex flex-col items-center">
                  <p className="text-[11px] tracking-[0.22em] text-muted label-mono">
                    {API_URL ? "CORE UNREACHABLE" : "NO LINK CONFIGURED"}
                  </p>
                  <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted">
                    {API_URL
                      ? "The core didn't respond in time. It may still be waking."
                      : "Set NEXT_PUBLIC_API_URL to connect the core."}
                  </p>
                  <div className="mt-6 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={retry}
                      className="rounded-forge border border-panel-strong bg-[var(--btn-bg)] px-4 py-2 text-[11px] tracking-[0.18em] text-fg-strong transition hover:border-[var(--line)] hover:shadow-glow label-mono"
                    >
                      RETRY LINK
                    </button>
                    <button
                      type="button"
                      onClick={enterAnyway}
                      className="rounded-forge border border-transparent px-4 py-2 text-[11px] tracking-[0.18em] text-muted transition hover:text-fg-strong label-mono"
                    >
                      ENTER OFFLINE
                    </button>
                  </div>
                </div>
              )}
            </motion.div>

            <p className="absolute bottom-6 text-[10px] tracking-[0.3em] text-muted/50 label-mono">PERSONAL AI CORE</p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
