"use client";

/**
 * EntryGate — the branded "login" splash (login_bg.gif backdrop).
 *
 * Recreates the original FORGE OS entry ritual: an animated geometric
 * background, a glass card with the core + wordmark, and an ENTER affordance.
 * If NEXT_PUBLIC_GATE_PIN is set it acts as a soft lock (client-side only —
 * a deterrent, not real auth); otherwise it's a single ENTER tap.
 *
 * Entry is remembered for the tab session (sessionStorage) so internal reloads
 * don't re-prompt, while a fresh session still gets the ritual. Once entered,
 * children mount (BootScreen → HUD).
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import CoreOrb from "./CoreOrb";
import { supabase, supabaseEnabled } from "@/lib/supabase";

const SS_KEY = "forge_entered";
const GATE_PIN = process.env.NEXT_PUBLIC_GATE_PIN || "";

export default function EntryGate({ children }: { children: React.ReactNode }) {
  const [entered, setEntered] = useState(false);
  const [ready, setReady] = useState(false); // hydration guard (avoid gate flash)
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);

  // Supabase auth (only when configured)
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMsg, setAuthMsg] = useState<string | null>(null);

  useEffect(() => {
    if (supabaseEnabled && supabase) {
      // Real auth: entry follows the Supabase session.
      supabase.auth.getSession().then(({ data }) => {
        setEntered(!!data.session);
        setReady(true);
      });
      const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
        setEntered(!!session);
      });
      return () => sub.subscription.unsubscribe();
    }
    // Soft gate: remembered per tab session.
    try {
      if (sessionStorage.getItem(SS_KEY) === "1") setEntered(true);
    } catch {
      /* ignore */
    }
    setReady(true);
  }, []);

  const enter = useCallback(() => {
    if (GATE_PIN && pin.trim() !== GATE_PIN) {
      setError(true);
      return;
    }
    try {
      sessionStorage.setItem(SS_KEY, "1");
    } catch {
      /* ignore */
    }
    setEntered(true);
  }, [pin]);

  const submitAuth = useCallback(async () => {
    if (!supabase || authBusy) return;
    if (!email.trim() || !password.trim()) {
      setAuthMsg("メールとパスワードを入力してください");
      return;
    }
    setAuthBusy(true);
    setAuthMsg(null);
    try {
      if (authMode === "signup") {
        const { error: e } = await supabase.auth.signUp({ email: email.trim(), password });
        if (e) setAuthMsg(e.message);
        else setAuthMsg("確認メールを送信しました。リンクから認証後にサインインしてください。");
      } else {
        const { error: e } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (e) setAuthMsg(e.message);
        // success → onAuthStateChange flips `entered`
      }
    } catch (err) {
      setAuthMsg(err instanceof Error ? err.message : "認証に失敗しました");
    } finally {
      setAuthBusy(false);
    }
  }, [authBusy, authMode, email, password]);

  // Before hydration: hold a plain dark screen (no flash of either state).
  if (!ready) return <div className="fixed inset-0" style={{ background: "var(--bg)" }} />;

  return (
    <>
      {entered && children}

      <AnimatePresence>
        {!entered && (
          <motion.div
            key="entrygate"
            className="fixed inset-0 z-[60] flex flex-col items-center justify-center overflow-hidden px-6"
            style={{ background: "var(--bg)" }}
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.7, ease: "easeInOut" } }}
          >
            {/* Animated login backdrop (GIF) — blurred + dimmed for legibility. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage: "url('/login_bg.gif')",
                backgroundSize: "cover",
                backgroundPosition: "center",
                filter: "blur(3px) brightness(0.45) saturate(1.1)",
                transform: "scale(1.08)",
              }}
            />
            <div aria-hidden className="forge-grid pointer-events-none absolute inset-0 opacity-60" />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ background: "radial-gradient(700px 520px at 50% 42%, rgba(150,200,255,0.10), transparent 62%), rgba(5,6,9,0.5)" }}
            />
            <div aria-hidden className="forge-scan pointer-events-none" />

            {/* Glass entry card. */}
            <motion.div
              className="panel relative z-10 flex w-full max-w-sm flex-col items-center px-6 py-8 text-center"
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 280, damping: 28 }}
            >
              <CoreOrb size={120} state="idle" />

              <h1 className="label-mono text-glow mt-6 text-[16px] font-normal tracking-[0.42em] text-fg-strong">
                THE FORGE OS
              </h1>
              <p className="mt-2 text-[10px] tracking-[0.32em] text-muted label-mono">PERSONAL AI CORE</p>

              {supabaseEnabled ? (
                <div className="mt-7 w-full space-y-2">
                  <input
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setAuthMsg(null); }}
                    type="email"
                    autoComplete="email"
                    placeholder="メールアドレス"
                    className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:shadow-glow focus:outline-none"
                  />
                  <input
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setAuthMsg(null); }}
                    onKeyDown={(e) => e.key === "Enter" && void submitAuth()}
                    type="password"
                    autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                    placeholder="パスワード"
                    className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:shadow-glow focus:outline-none"
                  />
                  {authMsg && (
                    <p className="text-[10px] leading-relaxed tracking-[0.08em] text-[#ffd07f]">{authMsg}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => void submitAuth()}
                    disabled={authBusy}
                    className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-3 text-[11px] tracking-[0.3em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-50 label-mono"
                  >
                    {authBusy ? "…" : authMode === "signup" ? "▸ アカウント作成" : "▸ サインイン"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAuthMode((m) => (m === "signup" ? "signin" : "signup")); setAuthMsg(null); }}
                    className="w-full text-[9px] tracking-[0.18em] text-muted transition hover:text-fg-strong label-mono"
                  >
                    {authMode === "signup" ? "既にアカウントがある → サインイン" : "アカウントを作成する →"}
                  </button>
                </div>
              ) : GATE_PIN ? (
                <div className="mt-7 w-full">
                  <input
                    value={pin}
                    onChange={(e) => {
                      setPin(e.target.value);
                      setError(false);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && enter()}
                    type="password"
                    inputMode="numeric"
                    autoFocus
                    placeholder="ACCESS CODE"
                    className="w-full rounded-forge border bg-[var(--input-bg)] px-3 py-2.5 text-center text-sm tracking-[0.3em] text-fg-strong placeholder:text-muted focus:shadow-glow focus:outline-none label-mono"
                    style={{ borderColor: error ? "#ff6b6b" : "var(--input-bd)" }}
                  />
                  {error && (
                    <p className="mt-2 text-[10px] tracking-[0.2em] text-[#ff9b9b] label-mono">ACCESS DENIED</p>
                  )}
                </div>
              ) : null}

              {!supabaseEnabled && (
                <button
                  type="button"
                  onClick={enter}
                  className="mt-7 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-3 text-[11px] tracking-[0.34em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
                >
                  ▸ ENTER
                </button>
              )}

              <motion.p
                className="mt-4 text-[9px] tracking-[0.3em] text-muted/60 label-mono"
                animate={{ opacity: [0.35, 0.85, 0.35] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
              >
                AUTHORIZED ACCESS ONLY
              </motion.p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
