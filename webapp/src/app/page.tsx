"use client";

/**
 * THE FORGE OS — main HUD.
 *
 * Flows: EntryGate → BootScreen → Hud.
 * Views (12): HOME / CHAT / ME / FORGE / CODE / VAULT / INCOME / TASKS / STUDIO /
 *   AUTOPILOT / BOARD / ARCHIVE — default is CHAT.
 * Navigation is a Google-apps-style waffle "ModeLauncher" popover (top-right),
 * not a bottom bar. CHAT goes extra-wide with its history in the far-left
 * margin; other modes use the full width with their own centring.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import AppArchive from "@/components/AppArchive";
import Autopilot from "@/components/Autopilot";
import Backdrop3D from "@/components/Backdrop3D";
import BootScreen from "@/components/BootScreen";
import Briefing from "@/components/Briefing";
import Chat, { type ChatSettings } from "@/components/Chat";
import CodeMode from "@/components/CodeMode";
import CoreOrb, { type CoreState } from "@/components/CoreOrb";
import Dashboard from "@/components/Dashboard";
import EntryGate from "@/components/EntryGate";
import Forge from "@/components/Forge";
import Home from "@/components/Home";
import Income from "@/components/Income";
import Keychain from "@/components/Keychain";
import LifeMode from "@/components/LifeMode";
import Studio from "@/components/Studio";
import Tasks from "@/components/Tasks";
import Vault from "@/components/Vault";
import { health } from "@/lib/api";
import { supabase, supabaseEnabled } from "@/lib/supabase";
import { APP_VERSION } from "@/lib/version";

type View = "chat" | "me" | "forge" | "code" | "vault" | "income" | "tasks" | "studio" | "autopilot" | "board" | "archive" | "home";

const LS_NAME = "forge_name";
const LS_PERSONA = "forge_persona";
const LS_VOICE = "forge_voice_replies";
const LS_TTS_VOICE = "forge_tts_voice";
const LS_TTS_RATE = "forge_tts_rate";
const DEFAULT_NAME = "JARVIS";
const DEFAULT_TTS_VOICE = "ja-JP-NanamiNeural";
const DEFAULT_TTS_RATE = 1.0;

// edge-tts ja-JP voices (used by the API fallback; browser TTS auto-picks ja-JP).
const VOICE_PRESETS = [
  { label: "NANAMI (女性)", value: "ja-JP-NanamiNeural" },
  { label: "KEITA (男性)", value: "ja-JP-KeitaNeural" },
  { label: "AOI (女性)", value: "ja-JP-AoiNeural" },
  { label: "DAICHI (男性)", value: "ja-JP-DaichiNeural" },
  { label: "MAYU (女性)", value: "ja-JP-MayuNeural" },
  { label: "NAOKI (男性)", value: "ja-JP-NaokiNeural" },
];

const PERSONA_PRESETS = [
  { label: "JARVIS", value: "冷静で知的、先を読んで行動し、ユーザーを名前で呼ぶ。常に敬語で簡潔に。" },
  { label: "FRIENDLY", value: "フレンドリーで親しみやすく、ポジティブな雰囲気を保つ。絵文字も使ってよい。" },
  { label: "SECRETARY", value: "効率的なアシスタント。タスク管理・予定・優先順位を意識してサポートする。" },
  { label: "TACTICAL", value: "戦略家視点。課題を分解し、リスクと機会を明確にして行動プランを提示する。" },
];

export default function Page() {
  return (
    <EntryGate>
      <BootScreen>
        <Backdrop3D />
        <Hud />
      </BootScreen>
    </EntryGate>
  );
}

function Hud() {
  const [settings, setSettings] = useState<ChatSettings>({ name: DEFAULT_NAME, persona: "" });
  const [voiceReplies, setVoiceReplies] = useState(true);
  const [coreState, setCoreState] = useState<CoreState>("idle");
  const [online, setOnline] = useState(true);
  const reduceMotion = useReducedMotion();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("chat");

  useEffect(() => {
    try {
      const name = localStorage.getItem(LS_NAME) || DEFAULT_NAME;
      const persona = localStorage.getItem(LS_PERSONA) || "";
      const voice = localStorage.getItem(LS_VOICE);
      const ttsVoice = localStorage.getItem(LS_TTS_VOICE) || DEFAULT_TTS_VOICE;
      const rateRaw = localStorage.getItem(LS_TTS_RATE);
      const rate = rateRaw ? Number(rateRaw) || DEFAULT_TTS_RATE : DEFAULT_TTS_RATE;
      setSettings({ name, persona, voice: ttsVoice, rate });
      if (voice !== null) setVoiceReplies(voice === "1");
      // Reopen the mode you were using (PWA relaunch lands where you left off).
      const savedView = localStorage.getItem("forge_view") as View | null;
      if (savedView && ["chat", "me", "forge", "code", "vault", "income", "tasks", "studio", "autopilot", "board", "archive", "home"].includes(savedView)) {
        setView(savedView);
      }
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

  // Persist the active mode.
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem("forge_view", view); } catch { /* ignore */ }
  }, [view, loaded]);

  useEffect(() => {
    let active = true;
    const check = async () => {
      const ok = await health();
      if (active) setOnline(ok);
    };
    void check();
    const id = setInterval(check, 20_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const persist = useCallback((next: ChatSettings, voice: boolean) => {
    try {
      localStorage.setItem(LS_NAME, next.name);
      localStorage.setItem(LS_PERSONA, next.persona);
      localStorage.setItem(LS_VOICE, voice ? "1" : "0");
      localStorage.setItem(LS_TTS_VOICE, next.voice || DEFAULT_TTS_VOICE);
      localStorage.setItem(LS_TTS_RATE, String(next.rate ?? DEFAULT_TTS_RATE));
    } catch { /* ignore */ }
  }, []);

  const handleSave = useCallback(
    (next: ChatSettings, voice: boolean) => {
      const cleaned: ChatSettings = {
        name: next.name.trim() || DEFAULT_NAME,
        persona: next.persona.trim(),
        voice: next.voice || DEFAULT_TTS_VOICE,
        rate: next.rate ?? DEFAULT_TTS_RATE,
      };
      setSettings(cleaned);
      setVoiceReplies(voice);
      persist(cleaned, voice);
      setSettingsOpen(false);
    },
    [persist],
  );

  // Every mode uses the full width; each view manages its own internal
  // centering. Chat goes extra-wide so the history rail sits in the far-left
  // margin while the conversation stays centred.
  return (
    <main
      data-mode={view}
      className={`relative mx-auto flex h-[100dvh] w-full flex-col px-4 pb-20 pt-[max(env(safe-area-inset-top),0.75rem)] transition-[max-width] duration-300 sm:pb-3 ${view === "chat" ? "max-w-[1700px]" : "max-w-6xl"}`}
    >
      {/* Occasional drifting light-silver ambient bloom (behind everything). */}
      <div className="forge-ambient" aria-hidden />

      {/* Chrome (status + core) stays centred/narrow even when the page is wide */}
      <div className="mx-auto w-full max-w-2xl">
        {/* Top status row */}
        <div className="flex items-center justify-between py-1">
          <div className="flex items-center gap-2">
            <StatusDot online={online} />
            <span className="text-[10px] tracking-[0.22em] text-muted label-mono">
              {online ? "LINK ACTIVE" : "OFFLINE"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Briefing />
            <ModeLauncher view={view} onChange={setView} />
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="grid h-8 w-8 place-items-center rounded-lg border border-panel text-muted transition hover:border-[var(--line)] hover:text-fg-strong"
              aria-label="Settings"
              title="Settings"
            >
              <GearIcon />
            </button>
          </div>
        </div>

        {/* Core + wordmark (compact when not on chat / home) */}
        <header
          className="flex flex-col items-center transition-all duration-300"
          style={{ paddingBottom: view === "chat" || view === "home" ? "0.5rem" : "0.25rem", paddingTop: view === "chat" || view === "home" ? "0.25rem" : "0" }}
        >
          <CoreOrb size={view === "chat" || view === "home" ? 108 : 72} state={coreState} />
          <h1 className="label-mono text-glow mt-3 text-[13px] font-normal text-fg-strong sm:text-sm">
            THE FORGE OS
          </h1>
          <p className="mt-0.5 text-[10px] tracking-[0.28em] text-muted/80 label-mono">
            {loaded ? `${settings.name} · ${stateLabel(coreState)}` : "INITIALIZING"}
          </p>
        </header>

        <div className="divider my-2" />
      </div>

      {/* Active view fills remaining space. Home & Forge own the full width
          (custom layouts); the rest are centred so they don't look stretched.
          Views enter from depth (3D rotateX) — except CHAT, whose fixed
          history panel must never sit inside a transformed ancestor, so it
          fades only. */}
      <section className="min-h-0 flex-1" style={{ perspective: 1400 }}>
        <motion.div
          key={view}
          className="h-full min-h-0"
          initial={
            reduceMotion
              ? false
              : view === "chat"
                ? { opacity: 0 }
                : { opacity: 0, rotateX: 5, y: 14, scale: 0.985 }
          }
          animate={{ opacity: 1, rotateX: 0, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 320, damping: 30 }}
        >
          {loaded && view === "home" && <Home settings={settings} onNavigate={setView} />}
          {loaded && view === "chat" && (
            <Chat settings={settings} voiceReplies={voiceReplies} onStateChange={setCoreState} />
          )}
          {loaded && view === "me" && <LifeMode settings={settings} />}
          {loaded && view === "forge" && <Forge />}
          {loaded && view === "code" && <CodeMode />}
          {loaded && view === "vault" && <Centered><Vault /></Centered>}
          {loaded && view === "income" && <Centered><Income /></Centered>}
          {loaded && view === "tasks" && <Centered><Tasks /></Centered>}
          {loaded && view === "studio" && <Centered><Studio /></Centered>}
          {loaded && view === "autopilot" && <Centered><Autopilot /></Centered>}
          {loaded && view === "board" && <Centered><Dashboard /></Centered>}
          {loaded && view === "archive" && <Centered><AppArchive /></Centered>}
        </motion.div>
      </section>

      {/* Settings drawer */}
      <AnimatePresence>
        {settingsOpen && (
          <SettingsPanel
            initial={settings}
            initialVoice={voiceReplies}
            online={online}
            onClose={() => setSettingsOpen(false)}
            onSave={handleSave}
          />
        )}
      </AnimatePresence>

      {/* Mobile thumb-zone nav (hidden on ≥sm; hides while the keyboard is open) */}
      <MobileNav view={view} onChange={setView} />
    </main>
  );
}

function stateLabel(state: CoreState): string {
  switch (state) {
    case "listening": return "LISTENING";
    case "speaking": return "SPEAKING";
    case "thinking": return "THINKING";
    default: return "ONLINE";
  }
}

const NAV_ITEMS: { key: View; label: string }[] = [
  { key: "home", label: "HOME" },
  { key: "chat", label: "CHAT" },
  { key: "me", label: "ME" },
  { key: "forge", label: "FORGE" },
  { key: "code", label: "CODE" },
  { key: "vault", label: "VAULT" },
  { key: "tasks", label: "TASKS" },
  { key: "income", label: "INCOME" },
  { key: "studio", label: "STUDIO" },
  { key: "autopilot", label: "AUTO" },
  { key: "board", label: "BOARD" },
  { key: "archive", label: "ARCHIVE" },
];

/* Silver line-art nav icons (stroke = currentColor → inherits the muted /
   bright text colour). No coloured emoji — keeps the futuristic monochrome. */
function NavIcon({ name }: { name: View }) {
  const p = {
    width: 17, height: 17, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.6,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "home":
      return (<svg {...p}><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></svg>);
    case "code":
      return (<svg {...p}><path d="M8 6l-5 6 5 6" /><path d="M16 6l5 6-5 6" /><path d="M13 4l-2 16" /></svg>);
    case "me":
      return (<svg {...p}><path d="M12 20s-7-4.6-9.2-8.8C1.2 8 3 5 6.2 5c2 0 3.3 1 4 2.2C11 6 12.3 5 14.3 5c3.2 0 5 3 3.4 6.2C15.5 15.4 12 20 12 20z" /></svg>);
    case "chat":
      return (<svg {...p}><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z" /></svg>);
    case "forge":
      return (<svg {...p}><path d="M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9L12 3z" /><circle cx="12" cy="12" r="3" /></svg>);
    case "vault":
      return (<svg {...p}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>);
    case "tasks":
      return (<svg {...p}><path d="M10 6h10M10 12h10M10 18h10" /><path d="M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" /></svg>);
    case "income":
      return (<svg {...p}><path d="M3 17l5-5 4 4 7-7" /><path d="M16 9h5v5" /></svg>);
    case "studio":
      return (<svg {...p}><path d="M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6L12 3z" /></svg>);
    case "autopilot":
      return (<svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
    case "board":
      return (<svg {...p}><rect x="3" y="4" width="7" height="7" rx="1" /><rect x="14" y="4" width="7" height="4" rx="1" /><rect x="14" y="12" width="7" height="8" rx="1" /><rect x="3" y="15" width="7" height="5" rx="1" /></svg>);
    case "archive":
      return (<svg {...p}><path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 12l9 4 9-4M3 17l9 4 9-4" /></svg>);
    default:
      return null;
  }
}

/** Centres non-fullbleed views so they don't stretch on the wide page. */
function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto h-full w-full max-w-5xl">{children}</div>;
}

function WaffleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {[4, 10, 16].flatMap((y) => [4, 10, 16].map((x) => (
        <circle key={`${x}-${y}`} cx={x + 1} cy={y + 1} r="1.6" />
      )))}
    </svg>
  );
}

/** Google-apps-style mode launcher: a waffle button → popover grid of modes. */
/** Bottom thumb-zone nav for phones: 4 primary modes + ⋯ (full grid sheet).
    Slides away while the software keyboard is open (visualViewport). */
function MobileNav({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => setKbOpen(window.innerHeight - vv.height > 120);
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  const PRIMARY: View[] = ["home", "chat", "me", "tasks"];
  const items = NAV_ITEMS.filter((i) => PRIMARY.includes(i.key));

  return (
    <div className="sm:hidden">
      {/* Full-grid sheet (all modes) */}
      <AnimatePresence>
        {sheetOpen && (
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setSheetOpen(false)}
              className="fixed inset-0 z-40 bg-black/50"
            />
            <motion.nav
              initial={{ y: 60, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 60, opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
              className="fixed inset-x-3 bottom-20 z-50"
              aria-label="All modes"
            >
              <div className="glass-silver p-3">
                <div className="grid grid-cols-4 gap-1.5">
                  {NAV_ITEMS.map((it) => (
                    <button
                      key={it.key}
                      type="button"
                      onClick={() => { onChange(it.key); setSheetOpen(false); }}
                      className="flex h-16 flex-col items-center justify-center gap-1 rounded-forge border text-[8px] tracking-[0.04em] label-mono"
                      style={{
                        borderColor: it.key === view ? "var(--accent)" : "var(--panel-bd)",
                        color: it.key === view ? "var(--fg-strong)" : "var(--muted)",
                      }}
                    >
                      <NavIcon name={it.key} />
                      <span>{it.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </motion.nav>
          </>
        )}
      </AnimatePresence>

      {/* Bar */}
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-panel bg-[rgba(10,12,18,0.85)] backdrop-blur-md transition-transform duration-200"
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
          transform: kbOpen ? "translateY(110%)" : "none",
        }}
      >
        <div className="mx-auto grid max-w-md grid-cols-5">
          {items.map((it) => {
            const active = it.key === view;
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => onChange(it.key)}
                className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[8px] tracking-[0.06em] label-mono"
                style={{ color: active ? "var(--accent)" : "var(--muted)" }}
                aria-current={active ? "page" : undefined}
              >
                <NavIcon name={it.key} />
                <span>{it.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setSheetOpen((v) => !v)}
            className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[8px] tracking-[0.06em] text-muted label-mono"
            aria-label="More modes"
          >
            <span className="text-base leading-none">⋯</span>
            <span>MORE</span>
          </button>
        </div>
      </nav>
    </div>
  );
}

function ModeLauncher({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="grid h-8 w-8 place-items-center rounded-lg border border-panel text-muted transition hover:border-[var(--line)] hover:text-fg-strong"
        aria-label="Modes"
        title="Modes"
        aria-expanded={open}
      >
        <WaffleIcon />
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* click-away backdrop */}
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            {/* Outer owns positioning (absolute); inner owns the glass look.
                (Keeping glass-silver — which is position:relative — off the
                positioned element avoids it overriding `absolute`.) */}
            <motion.nav
              initial={{ opacity: 0, y: -8, scale: 0.97, rotateX: -16 }}
              animate={{ opacity: 1, y: 0, scale: 1, rotateX: 0 }}
              exit={{ opacity: 0, y: -8, scale: 0.97, rotateX: -12 }}
              transition={{ type: "spring", stiffness: 360, damping: 28 }}
              style={{ transformPerspective: 900 }}
              className="absolute right-0 top-11 z-50 w-[17rem] origin-top-right"
            >
              <div className="glass-silver p-3">
                <div className="mb-2 px-1 text-[9px] tracking-[0.22em] text-muted label-mono">MODES</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {NAV_ITEMS.map((it) => {
                    const active = it.key === view;
                    return (
                      <button
                        key={it.key}
                        type="button"
                        onClick={() => { onChange(it.key); setOpen(false); }}
                        className="flex h-[4.25rem] flex-col items-center justify-center gap-1.5 rounded-forge border text-[9px] tracking-[0.06em] label-mono transition duration-150 hover:-translate-y-0.5 hover:scale-[1.05]"
                        style={{
                          borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                          color: active ? "var(--fg-strong)" : "var(--muted)",
                          boxShadow: active ? "0 0 12px var(--glow)" : "none",
                          background: active ? "var(--btn-bg)" : "rgba(255,255,255,0.02)",
                        }}
                      >
                        <NavIcon name={it.key} />
                        <span>{it.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.nav>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span className="relative grid place-items-center" aria-hidden>
      <span
        className="h-2 w-2 rounded-full"
        style={{
          background: online ? "var(--accent)" : "#5a5f66",
          boxShadow: online ? "0 0 8px rgba(0,243,255,0.7)" : "none",
        }}
      />
      {online && (
        <motion.span
          className="absolute h-2 w-2 rounded-full"
          style={{ border: "1px solid var(--accent)" }}
          animate={{ scale: [1, 2.2], opacity: [0.7, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
        />
      )}
    </span>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/* ─── Settings Panel (enhanced) ──────────────────────────────────── */

type SettingsTab = "core" | "persona" | "keychain" | "diagnostics";

function SettingsPanel({
  initial,
  initialVoice,
  online,
  onClose,
  onSave,
}: {
  initial: ChatSettings;
  initialVoice: boolean;
  online: boolean;
  onClose: () => void;
  onSave: (settings: ChatSettings, voice: boolean) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("core");
  const [name, setName] = useState(initial.name);
  const [persona, setPersona] = useState(initial.persona);
  const [voice, setVoice] = useState(initialVoice);
  const [ttsVoice, setTtsVoice] = useState(initial.voice || DEFAULT_TTS_VOICE);
  const [rate, setRate] = useState(initial.rate ?? DEFAULT_TTS_RATE);
  const [host, setHost] = useState("");
  useEffect(() => { try { setHost(window.location.host); } catch { /* ignore */ } }, []);

  return (
    <motion.div
      className="fixed inset-0 z-40 flex items-end justify-center sm:items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      <motion.div
        className="panel relative z-10 m-3 w-full max-w-md"
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 30, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-panel p-4">
          <h2 className="label-mono text-glow text-sm text-fg-strong">CORE SETTINGS</h2>
          <button type="button" onClick={onClose} className="text-muted transition hover:text-fg-strong">✕</button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-panel">
          {(["core", "persona", "keychain", "diagnostics"] as SettingsTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="flex-1 py-2.5 text-[9px] tracking-[0.12em] transition label-mono"
              style={{
                color: tab === t ? "var(--fg-strong)" : "var(--muted)",
                borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-5">
          {tab === "core" && (
            <>
              <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">ASSISTANT NAME</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={DEFAULT_NAME}
                className="mb-4 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
              />

              <label className="mb-4 flex cursor-pointer items-center justify-between">
                <span className="text-[10px] tracking-[0.2em] text-muted label-mono">SPOKEN REPLIES</span>
                <ToggleSwitch checked={voice} onChange={setVoice} />
              </label>

              {/* Voice selection */}
              <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">CORE VOICE</label>
              <select
                value={ttsVoice}
                onChange={(e) => setTtsVoice(e.target.value)}
                className="mb-4 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong focus:border-[var(--line)] focus:outline-none"
              >
                {VOICE_PRESETS.map((v) => (
                  <option key={v.value} value={v.value} className="bg-[#0a0e16]">{v.label}</option>
                ))}
              </select>

              {/* Talk speed */}
              <div className="mb-4">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] tracking-[0.2em] text-muted label-mono">TALK SPEED</span>
                  <span className="text-[10px] text-fg-strong label-mono">{rate.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={rate}
                  onChange={(e) => setRate(Number(e.target.value))}
                  className="w-full accent-[var(--accent)]"
                  aria-label="Talk speed"
                />
              </div>

              <button
                type="button"
                onClick={() => onSave({ name, persona, voice: ttsVoice, rate }, voice)}
                className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
              >
                SAVE & SYNC
              </button>
            </>
          )}

          {tab === "persona" && (
            <>
              <div className="mb-3 text-[10px] tracking-[0.2em] text-muted label-mono">PRESETS</div>
              <div className="mb-4 grid grid-cols-2 gap-1.5">
                {PERSONA_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setPersona(p.value)}
                    className="rounded-forge border px-2.5 py-2 text-left transition"
                    style={{
                      borderColor: persona === p.value ? "var(--accent)" : "var(--panel-bd)",
                      background: persona === p.value ? "var(--btn-bg)" : "transparent",
                    }}
                  >
                    <span className="block text-[10px] tracking-[0.16em] text-fg-strong label-mono">{p.label}</span>
                  </button>
                ))}
              </div>

              <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">CUSTOM PERSONA</label>
              <textarea
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                rows={5}
                placeholder="例: 冷静で知的、先を読んで行動し、ユーザーをさん付けで呼ぶ。"
                className="mb-4 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
              />

              <button
                type="button"
                onClick={() => onSave({ name, persona, voice: ttsVoice, rate }, voice)}
                className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
              >
                SAVE & SYNC
              </button>
            </>
          )}

          {tab === "keychain" && (
            <>
              <div className="mb-3 text-[10px] leading-relaxed text-muted">
                APIキーを暗号化して保管します。<b className="text-fg">バックエンド接続時は Supabase にサーバー側で暗号化保存</b>（Fernet・DBは暗号文のみ）。
                未接続時は端末内に暗号化下書き（AES-256）として保存し、接続後に取り込めます。ここで追加・変更・削除できます。
              </div>
              <Keychain />
            </>
          )}

          {tab === "diagnostics" && (
            <div className="flex flex-col gap-3">
              {(() => {
                const repo = process.env.NEXT_PUBLIC_GIT_REPO || "";
                const sha = (process.env.NEXT_PUBLIC_COMMIT_SHA || "").slice(0, 7);
                const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV || "";
                const onVercel = !!vercelEnv || host.endsWith(".vercel.app");
                const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
                const sbRef = sbUrl ? sbUrl.replace(/^https?:\/\//, "").split(".")[0] : "";
                const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";
                return (
                  <div className="rounded-forge border border-panel p-3">
                    <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">CONNECTIONS · 接続状況</div>
                    <div className="flex flex-col gap-2">
                      <ConnRow name="GitHub" ok={!!repo} value={repo ? `${repo}${sha ? ` @ ${sha}` : ""}` : "—"} />
                      <ConnRow name="Vercel" ok={onVercel}
                        value={onVercel ? `${vercelEnv ? vercelEnv.toUpperCase() : "HOSTED"}${host ? ` · ${host}` : ""}` : (host || "ローカル / 他ホスト")} />
                      <ConnRow name="Supabase" ok={supabaseEnabled}
                        value={sbRef ? `${sbRef}${supabaseEnabled ? "" : " · キー未設定"}` : "未設定"} />
                      <ConnRow name="Backend API" ok={!!apiUrl} value={apiUrl || "未接続"} />
                    </div>
                  </div>
                );
              })()}

              <DiagRow label="BUILD" value={APP_VERSION} ok={true} />
              <DiagRow label="LINK STATUS" value={online ? "ACTIVE" : "OFFLINE"} ok={online} />
              <DiagRow label="FRONTEND" value="NEXT.JS 14 · VERCEL" ok={true} />
              <DiagRow label="BACKEND" value={process.env.NEXT_PUBLIC_API_URL ? "CONFIGURED" : "NOT SET"} ok={!!process.env.NEXT_PUBLIC_API_URL} />
              <DiagRow label="AUTH" value={supabaseEnabled ? "SUPABASE" : process.env.NEXT_PUBLIC_API_TOKEN ? "BEARER TOKEN" : "OPEN"} ok={true} />
              <DiagRow label="DATABASE" value={supabaseEnabled ? "CONNECTED" : "NOT SET"} ok={supabaseEnabled} />
              <DiagRow label="GATE PIN" value={process.env.NEXT_PUBLIC_GATE_PIN ? "ACTIVE" : "DISABLED"} ok={true} />

              <div className="mt-2 rounded-forge border border-panel p-3">
                <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">ENVIRONMENT</div>
                <div className="flex flex-col gap-0.5 break-all text-[10px] text-muted">
                  <p>API_URL: <span className="text-fg">{process.env.NEXT_PUBLIC_API_URL || "(not set)"}</span></p>
                  <p>SUPABASE_URL: <span className="text-fg">{process.env.NEXT_PUBLIC_SUPABASE_URL || "(not set)"}</span></p>
                </div>
              </div>

              {!process.env.NEXT_PUBLIC_API_URL ? (
                <div className="rounded-forge border border-panel p-3">
                  <div className="mb-2 text-[10px] tracking-[0.2em] label-mono" style={{ color: "#ffd060" }}>◈ バックエンド接続ガイド（3ステップ）</div>
                  <ol className="ml-4 list-decimal space-y-1.5 text-[11px] leading-relaxed text-fg marker:text-muted">
                    <li><b>バックエンドをデプロイ</b>：<code>api/</code> を Render（推奨・付属の <code>render.yaml</code> でほぼワンクリック）か Google Cloud Run へ。<code>api/Dockerfile</code> 同梱済み。</li>
                    <li><b>Vercelに登録</b>：Settings → Environment Variables に <code>NEXT_PUBLIC_API_URL</code> ＝ 発行されたURL を追加 → <b>Redeploy</b>。</li>
                    <li><b>再読込</b>：上部が <b>LINK ACTIVE</b> になったら KEYCHAIN で <b>Gemini API Key</b> を SAVE（自動でサーバーへ同期・即有効）。</li>
                  </ol>
                  <p className="mt-2 text-[10px] text-muted">詳細は <code>BACKEND_CONNECT.md</code>。CORSは既定で全許可、GeminiキーはKEYCHAIN同期でOK（サーバーのenv設定は不要）。</p>
                </div>
              ) : (
                <div className="rounded-forge border border-panel p-3 text-[11px] leading-relaxed text-[#60d394]">
                  ✓ バックエンド接続済み。あとは KEYCHAIN に <b>Gemini API Key</b> を入れれば各AI機能が有効になります。
                </div>
              )}

              {supabaseEnabled && (
                <button
                  type="button"
                  onClick={async () => {
                    try { await supabase?.auth.signOut(); } catch { /* ignore */ }
                    window.location.reload();
                  }}
                  className="rounded-forge border border-panel py-2 text-[10px] tracking-[0.18em] text-muted transition hover:text-fg-strong label-mono"
                >
                  サインアウト
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  if (!window.confirm("端末内の全データを消去します：チャット履歴・アプリアーカイブ・KEYCHAINの暗号化ボルト（オフライン保存分）・各種設定。\n本当に実行しますか？（元に戻せません）")) return;
                  try { localStorage.clear(); } catch { /* ignore */ }
                  try { sessionStorage.clear(); } catch { /* ignore */ }
                  window.location.reload();
                }}
                className="rounded-forge border border-[#ff6b6b44] py-2 text-[10px] tracking-[0.18em] text-[#ff6b6b] transition hover:border-[#ff6b6b] label-mono"
              >
                CLEAR LOCAL DATA & RELOAD
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative h-6 w-11 rounded-full border border-panel-strong transition"
      style={{ background: checked ? "rgba(0,243,255,0.18)" : "rgba(255,255,255,0.05)" }}
    >
      <span
        className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all"
        style={{
          left: checked ? "calc(100% - 1.25rem)" : "0.2rem",
          background: checked ? "var(--accent)" : "var(--muted)",
          boxShadow: checked ? "0 0 8px rgba(0,243,255,0.7)" : "none",
        }}
      />
    </button>
  );
}

function DiagRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-forge border border-panel p-2.5">
      <span className="text-[10px] tracking-[0.16em] text-muted label-mono">{label}</span>
      <span
        className="text-[10px] tracking-[0.12em] label-mono"
        style={{ color: ok ? "#60d394" : "#ff6b6b" }}
      >
        {value}
      </span>
    </div>
  );
}

/** A connection row for the CONNECTIONS panel: colored dot + name + value. */
function ConnRow({ name, ok, value }: { name: string; ok: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-[11px] text-fg-strong">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: ok ? "#60d394" : "#5a5f66", boxShadow: ok ? "0 0 6px rgba(96,211,148,0.7)" : "none" }}
        />
        {name}
      </span>
      <span className="min-w-0 truncate text-right text-[10px] tracking-[0.04em] label-mono" style={{ color: ok ? "#c5c6c7" : "#6a6f77" }}>
        {value}
      </span>
    </div>
  );
}
