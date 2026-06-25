"use client";

/**
 * THE FORGE OS — main HUD.
 *
 * Layout: centered CoreOrb + wordmark + online dot up top, the Chat surface
 * filling the rest (mobile-first, max-width container). A slim status row and a
 * settings affordance let the user set the assistant name + persona, persisted
 * to localStorage and sent to /chat. The whole page is wrapped in BootScreen so
 * a backend cold-start is masked by the branded loader.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import BootScreen from "@/components/BootScreen";
import Chat, { type ChatSettings } from "@/components/Chat";
import CoreOrb, { type CoreState } from "@/components/CoreOrb";
import { health } from "@/lib/api";

const LS_NAME = "forge_name";
const LS_PERSONA = "forge_persona";
const LS_VOICE = "forge_voice_replies";
const DEFAULT_NAME = "JARVIS";

export default function Page() {
  return (
    <BootScreen>
      <Hud />
    </BootScreen>
  );
}

function Hud() {
  const [settings, setSettings] = useState<ChatSettings>({ name: DEFAULT_NAME, persona: "" });
  const [voiceReplies, setVoiceReplies] = useState(true);
  const [coreState, setCoreState] = useState<CoreState>("idle");
  const [online, setOnline] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Hydrate settings from localStorage (client-only).
  useEffect(() => {
    try {
      const name = localStorage.getItem(LS_NAME) || DEFAULT_NAME;
      const persona = localStorage.getItem(LS_PERSONA) || "";
      const voice = localStorage.getItem(LS_VOICE);
      setSettings({ name, persona });
      if (voice !== null) setVoiceReplies(voice === "1");
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);

  // Lightweight online indicator: re-check health periodically.
  useEffect(() => {
    let active = true;
    const check = async () => {
      const ok = await health();
      if (active) setOnline(ok);
    };
    void check();
    const id = setInterval(check, 20_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const persist = useCallback((next: ChatSettings, voice: boolean) => {
    try {
      localStorage.setItem(LS_NAME, next.name);
      localStorage.setItem(LS_PERSONA, next.persona);
      localStorage.setItem(LS_VOICE, voice ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);

  const handleSave = useCallback(
    (next: ChatSettings, voice: boolean) => {
      const cleaned: ChatSettings = {
        name: next.name.trim() || DEFAULT_NAME,
        persona: next.persona.trim(),
      };
      setSettings(cleaned);
      setVoiceReplies(voice);
      persist(cleaned, voice);
      setSettingsOpen(false);
    },
    [persist],
  );

  return (
    <main className="relative mx-auto flex h-[100dvh] w-full max-w-2xl flex-col px-4 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)]">
      {/* Top status row */}
      <div className="flex items-center justify-between py-1">
        <div className="flex items-center gap-2">
          <StatusDot online={online} />
          <span className="text-[10px] tracking-[0.22em] text-muted label-mono">
            {online ? "LINK ACTIVE" : "OFFLINE"}
          </span>
        </div>
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

      {/* Core + wordmark */}
      <header className="flex flex-col items-center pb-2 pt-1">
        <CoreOrb size={108} state={coreState} />
        <h1 className="label-mono text-glow mt-4 text-[13px] font-normal text-fg-strong sm:text-sm">
          THE FORGE OS
        </h1>
        <p className="mt-1 text-[10px] tracking-[0.28em] text-muted/80 label-mono">
          {loaded ? `${settings.name} · ${stateLabel(coreState)}` : "INITIALIZING"}
        </p>
      </header>

      <div className="divider my-2" />

      {/* Chat fills remaining space */}
      <section className="min-h-0 flex-1">
        {loaded && (
          <Chat settings={settings} voiceReplies={voiceReplies} onStateChange={setCoreState} />
        )}
      </section>

      {/* Settings drawer */}
      <AnimatePresence>
        {settingsOpen && (
          <SettingsPanel
            initial={settings}
            initialVoice={voiceReplies}
            onClose={() => setSettingsOpen(false)}
            onSave={handleSave}
          />
        )}
      </AnimatePresence>
    </main>
  );
}

function stateLabel(state: CoreState): string {
  switch (state) {
    case "listening":
      return "LISTENING";
    case "speaking":
      return "SPEAKING";
    case "thinking":
      return "THINKING";
    default:
      return "ONLINE";
  }
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

/* ------------------------------------------------------------------ */

function SettingsPanel({
  initial,
  initialVoice,
  onClose,
  onSave,
}: {
  initial: ChatSettings;
  initialVoice: boolean;
  onClose: () => void;
  onSave: (settings: ChatSettings, voice: boolean) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [persona, setPersona] = useState(initial.persona);
  const [voice, setVoice] = useState(initialVoice);

  return (
    <motion.div
      className="fixed inset-0 z-40 flex items-end justify-center sm:items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      <motion.div
        className="panel relative z-10 m-3 w-full max-w-md p-5"
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 30, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="label-mono text-glow text-sm text-fg-strong">CORE SETTINGS</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-muted transition hover:text-fg-strong"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">ASSISTANT NAME</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={DEFAULT_NAME}
          className="mb-4 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
        />

        <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">PERSONA / BEHAVIOR</label>
        <textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={4}
          placeholder="e.g. Calm, concise, proactive. Address me by name. Anticipate next steps."
          className="mb-4 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
        />

        <label className="mb-5 flex cursor-pointer items-center justify-between">
          <span className="text-[10px] tracking-[0.2em] text-muted label-mono">SPOKEN REPLIES</span>
          <button
            type="button"
            role="switch"
            aria-checked={voice}
            onClick={() => setVoice((v) => !v)}
            className="relative h-6 w-11 rounded-full border border-panel-strong transition"
            style={{ background: voice ? "rgba(0,243,255,0.18)" : "rgba(255,255,255,0.05)" }}
          >
            <span
              className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all"
              style={{
                left: voice ? "calc(100% - 1.25rem)" : "0.2rem",
                background: voice ? "var(--accent)" : "var(--muted)",
                boxShadow: voice ? "0 0 8px rgba(0,243,255,0.7)" : "none",
              }}
            />
          </button>
        </label>

        <button
          type="button"
          onClick={() => onSave({ name, persona }, voice)}
          className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
        >
          SAVE & SYNC
        </button>
      </motion.div>
    </motion.div>
  );
}
