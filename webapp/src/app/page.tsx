"use client";

/**
 * THE FORGE OS — main HUD.
 *
 * Flows: EntryGate → BootScreen → Hud.
 * Views: CHAT / FORGE / VAULT / INCOME / TASKS / STUDIO / ARCHIVE.
 * Horizontally scrollable NavBar for 7+ views without crowding.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import AppArchive from "@/components/AppArchive";
import BootScreen from "@/components/BootScreen";
import Briefing from "@/components/Briefing";
import Chat, { type ChatSettings } from "@/components/Chat";
import CoreOrb, { type CoreState } from "@/components/CoreOrb";
import EntryGate from "@/components/EntryGate";
import Forge from "@/components/Forge";
import Income from "@/components/Income";
import Studio from "@/components/Studio";
import Tasks from "@/components/Tasks";
import Vault from "@/components/Vault";
import { health } from "@/lib/api";

type View = "chat" | "forge" | "vault" | "income" | "tasks" | "studio" | "archive";

const LS_NAME = "forge_name";
const LS_PERSONA = "forge_persona";
const LS_VOICE = "forge_voice_replies";
const DEFAULT_NAME = "JARVIS";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("chat");

  useEffect(() => {
    try {
      const name = localStorage.getItem(LS_NAME) || DEFAULT_NAME;
      const persona = localStorage.getItem(LS_PERSONA) || "";
      const voice = localStorage.getItem(LS_VOICE);
      setSettings({ name, persona });
      if (voice !== null) setVoiceReplies(voice === "1");
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

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
    } catch { /* ignore */ }
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
        <div className="flex items-center gap-2">
          <Briefing />
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

      {/* Core + wordmark (compact when not on chat) */}
      <header
        className="flex flex-col items-center transition-all duration-300"
        style={{ paddingBottom: view === "chat" ? "0.5rem" : "0.25rem", paddingTop: view === "chat" ? "0.25rem" : "0" }}
      >
        <CoreOrb size={view === "chat" ? 108 : 72} state={coreState} />
        <h1 className="label-mono text-glow mt-3 text-[13px] font-normal text-fg-strong sm:text-sm">
          THE FORGE OS
        </h1>
        <p className="mt-0.5 text-[10px] tracking-[0.28em] text-muted/80 label-mono">
          {loaded ? `${settings.name} · ${stateLabel(coreState)}` : "INITIALIZING"}
        </p>
      </header>

      <div className="divider my-2" />

      {/* Active view fills remaining space */}
      <section className="min-h-0 flex-1">
        {loaded && view === "chat" && (
          <Chat settings={settings} voiceReplies={voiceReplies} onStateChange={setCoreState} />
        )}
        {loaded && view === "forge" && <Forge />}
        {loaded && view === "vault" && <Vault />}
        {loaded && view === "income" && <Income />}
        {loaded && view === "tasks" && <Tasks />}
        {loaded && view === "studio" && <Studio />}
        {loaded && view === "archive" && <AppArchive />}
      </section>

      {/* Bottom navigation — horizontal scroll for 7 views */}
      <NavBar view={view} onChange={setView} />

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

const NAV_ITEMS: { key: View; label: string; icon: string }[] = [
  { key: "chat", label: "CHAT", icon: "◈" },
  { key: "forge", label: "FORGE", icon: "⚙" },
  { key: "vault", label: "VAULT", icon: "⌘" },
  { key: "tasks", label: "TASKS", icon: "⚡" },
  { key: "income", label: "INCOME", icon: "💰" },
  { key: "studio", label: "STUDIO", icon: "✦" },
  { key: "archive", label: "ARCHIVE", icon: "📦" },
];

function NavBar({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <nav
      className="mt-2 flex gap-1.5 overflow-x-auto pt-1 pb-0.5"
      style={{ scrollbarWidth: "none" }}
    >
      {NAV_ITEMS.map((it) => {
        const active = it.key === view;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className="shrink-0 rounded-forge border py-2 px-2.5 text-[10px] tracking-[0.16em] label-mono transition"
            style={{
              borderColor: active ? "var(--accent)" : "var(--panel-bd)",
              color: active ? "var(--fg-strong)" : "var(--muted)",
              boxShadow: active ? "0 0 12px var(--glow)" : "none",
              background: active ? "var(--btn-bg)" : "transparent",
              minWidth: "3.5rem",
            }}
          >
            <span className="block text-[12px]">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        );
      })}
    </nav>
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

type SettingsTab = "core" | "persona" | "diagnostics";

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
          {(["core", "persona", "diagnostics"] as SettingsTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="flex-1 py-2.5 text-[10px] tracking-[0.16em] transition label-mono"
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

              <button
                type="button"
                onClick={() => onSave({ name, persona }, voice)}
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
                onClick={() => onSave({ name, persona }, voice)}
                className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
              >
                SAVE & SYNC
              </button>
            </>
          )}

          {tab === "diagnostics" && (
            <div className="flex flex-col gap-3">
              <DiagRow label="LINK STATUS" value={online ? "ACTIVE" : "OFFLINE"} ok={online} />
              <DiagRow label="FRONTEND" value="NEXT.JS 14 · VERCEL" ok={true} />
              <DiagRow label="BACKEND" value={process.env.NEXT_PUBLIC_API_URL ? "CONFIGURED" : "NOT SET"} ok={!!process.env.NEXT_PUBLIC_API_URL} />
              <DiagRow label="AUTH" value={process.env.NEXT_PUBLIC_API_TOKEN ? "BEARER TOKEN" : "OPEN"} ok={true} />
              <DiagRow label="GATE PIN" value={process.env.NEXT_PUBLIC_GATE_PIN ? "ACTIVE" : "DISABLED"} ok={true} />

              <div className="mt-2 rounded-forge border border-panel p-3">
                <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">ENVIRONMENT</div>
                <div className="text-[10px] text-muted">
                  <p>API_URL: <span className="text-fg">{process.env.NEXT_PUBLIC_API_URL || "(not set)"}</span></p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
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
