"use client";

/**
 * THE FORGE OS — main HUD.
 *
 * Flows: EntryGate → BootScreen → Hud.
 * Views (13): HOME / CHAT / ME / CODE / STUDIO / SNS / CAPTURE / VAULT / TASKS /
 *   INCOME / AUTO / BOARD / ARCHIVE — default is CHAT.
 * (STUDIO hosts the former FORGE as a tab, plus the LP/HP builder.)
 * Navigation is a Google-apps-style waffle "ModeLauncher" popover (top-right),
 * not a bottom bar. CHAT goes extra-wide with its history in the far-left
 * margin; other modes use the full width with their own centring.
 */

import {
  MANAGE_SURFACES, MORE_SURFACES, RUN_VIEW, isView, surfaceOf, tabOf,
  type ShellView,
} from "@/lib/shell";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import AiProviderSettings from "@/components/AiProviderSettings";
import HfModels from "@/components/HfModels";
import { applySkin, readSkin, setSkin, SKINS, type Skin } from "@/lib/skin";
import { CORE_TYPES, readCoreType, setCoreType, type CoreType } from "@/lib/coreType";
import IntegrationsSettings from "@/components/IntegrationsSettings";
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
import Workshop from "@/components/Workshop";
import Capture from "@/components/Capture";
import SnsMode from "@/components/SnsMode";
import Home from "@/components/Home";
import Guide from "@/components/Guide";
import NeedsNotice from "@/components/NeedsNotice";
import SelfCheck from "@/components/SelfCheck";
import Extensions from "@/components/Extensions";
import Income from "@/components/Income";
import Keychain from "@/components/Keychain";
import LifeMode from "@/components/LifeMode";
import Tasks from "@/components/Tasks";
import Vault from "@/components/Vault";
import { API_URL, health, profileGet } from "@/lib/api";
import {
  loadVoiceSettings, saveVoiceSettings, speakCore, stopCoreVoice, type VoiceEngine,
} from "@/lib/coreVoice";
import { listVoices } from "@/lib/voice";
import { supabase, supabaseEnabled } from "@/lib/supabase";
import { APP_VERSION } from "@/lib/version";

/** 画面の一覧は shell.ts が持つ（2か所に書くと、片方だけ増えても気づけない）。 */
type View = ShellView;

const LS_NAME = "forge_name";
const LS_PERSONA = "forge_persona";
const LS_VOICE = "forge_voice_replies";
const DEFAULT_NAME = "JARVIS";
const DEFAULT_TTS_VOICE = "ja-JP-NanamiNeural";
const DEFAULT_TTS_RATE = 1.0;

// サーバー音声（edge-tts）の日本語。端末に入っている声は機種ごとに違うので
// 決め打ちにできず、設定画面で実際に列挙している。
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
  const [fullscreen, setFullscreen] = useState(false);

  /* ── 持ち主かどうか ───────────────────────────────────────────────
     持ち主専用モード（副業・自己進化）の表示を決める。分かるまでは隠す側に
     倒す（他の人に一瞬でも見せて、押したら403になるほうが分かりにくい）。
     これは見た目の話で、実際の遮断はサーバーが行っている。            */
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [ownerOnlyViews, setOwnerOnlyViews] = useState<View[]>(OWNER_ONLY_VIEWS);

  useEffect(() => {
    if (!API_URL) { setIsOwner(true); return; }   // 未接続時は制限しない
    profileGet()
      .then((p) => {
        setIsOwner(p.is_owner);
        if (p.owner_only_modes.length) {
          setOwnerOnlyViews(p.owner_only_modes.filter((m): m is View =>
            NAV_ITEMS.some((n) => n.key === m)));
        }
      })
      .catch(() => setIsOwner(true));             // 判定できないときは従来通り
  }, []);

  const visibleNav = useMemo(
    () => (isOwner === false ? NAV_ITEMS.filter((i) => !ownerOnlyViews.includes(i.key)) : NAV_ITEMS),
    [isOwner, ownerOnlyViews],
  );

  // 持ち主専用の画面を開いたまま権限が変わった／保存されていた場合に備える
  useEffect(() => {
    if (isOwner === false && ownerOnlyViews.includes(view)) setView("chat");
  }, [isOwner, ownerOnlyViews, view]);

  useEffect(() => {
    try {
      const name = localStorage.getItem(LS_NAME) || DEFAULT_NAME;
      const persona = localStorage.getItem(LS_PERSONA) || "";
      const voice = localStorage.getItem(LS_VOICE);
      const v = loadVoiceSettings();
      setSettings({
        name, persona,
        voice: v.serverVoice, browserVoice: v.browserVoice,
        voiceEngine: v.engine, rate: v.rate, pitch: v.pitch,
      });
      if (voice !== null) setVoiceReplies(voice === "1");
      // Reopen the mode you were using (PWA relaunch lands where you left off).
      let savedView = localStorage.getItem("forge_view") as View | null;
      if (savedView === ("forge" as View)) savedView = "studio"; // 旧FORGEはWORKSHOP(studio)に統合
      if (savedView && ["chat", "me", "sns", "capture", "code", "vault", "income", "tasks", "studio", "autopilot", "board", "archive", "home", "guide", "extend"].includes(savedView)) {
        setView(savedView);
      }
      if (localStorage.getItem("forge_fullscreen") === "1") setFullscreen(true);
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

  // Persist the active mode.
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem("forge_view", view); } catch { /* ignore */ }
  }, [view, loaded]);

  // Persist the fullscreen (focus) preference.
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem("forge_fullscreen", fullscreen ? "1" : "0"); } catch { /* ignore */ }
  }, [fullscreen, loaded]);

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
    // 声まわりは coreVoice が持つ（設定を持たない画面からも読むため）
    saveVoiceSettings({
      engine: next.voiceEngine ?? "browser",
      browserVoice: next.browserVoice,
      serverVoice: next.voice || DEFAULT_TTS_VOICE,
      rate: next.rate ?? DEFAULT_TTS_RATE,
      pitch: next.pitch ?? 1.0,
    });
  }, []);

  const handleSave = useCallback(
    (next: ChatSettings, voice: boolean) => {
      const cleaned: ChatSettings = {
        name: next.name.trim() || DEFAULT_NAME,
        persona: next.persona.trim(),
        voice: next.voice || DEFAULT_TTS_VOICE,
        browserVoice: next.browserVoice,
        voiceEngine: next.voiceEngine ?? "browser",
        rate: next.rate ?? DEFAULT_TTS_RATE,
        pitch: next.pitch ?? 1.0,
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
      className={`relative mx-auto flex h-[100dvh] w-full flex-col px-4 pb-20 pt-[max(env(safe-area-inset-top),0.75rem)] transition-[max-width] duration-300 sm:pb-3 ${fullscreen ? "max-w-none" : view === "chat" ? "max-w-[1700px]" : "max-w-6xl"}`}
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
            <ModeLauncher view={view} onChange={setView} items={visibleNav} />
            <button
              type="button"
              onClick={() => setFullscreen((f) => !f)}
              className="grid h-8 w-8 place-items-center rounded-lg border border-panel text-muted transition hover:border-[var(--line)] hover:text-fg-strong"
              aria-label={fullscreen ? "Restore" : "Fullscreen"}
              title={fullscreen ? "コアを表示（元に戻す）" : "全画面（コアを隠す）"}
              aria-pressed={fullscreen}
              style={fullscreen ? { borderColor: "var(--accent)", color: "var(--fg-strong)" } : undefined}
            >
              <FullscreenIcon on={fullscreen} />
            </button>
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

        {/* フォーカス中はコアが消えるので、戻し方を文字で出す。
            アイコン（⛶）だけだと「コアが壊れた」に見え、設定が保存される
            ぶん再読込しても直らないため、必ず1タップで戻せる導線を置く。 */}
        {fullscreen && (
          <div className="flex justify-center pb-1">
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="rounded-full border border-panel bg-[var(--chrome)] px-3 py-1 text-[9px] tracking-[0.12em] text-muted transition hover:border-[var(--line)] hover:text-fg-strong label-mono"
            >
              フォーカス中 — コアを表示
            </button>
          </div>
        )}

        {/* Core + wordmark (compact when not on chat / home). Hidden in
            fullscreen to give the active mode the whole canvas — the slim
            status row above keeps the restore/modes/settings controls. */}
        {!fullscreen && (
          <>
            <header
              className="flex flex-col items-center transition-all duration-300"
              style={{ paddingBottom: view === "chat" || view === "home" ? "0.5rem" : "0.25rem", paddingTop: view === "chat" || view === "home" ? "0.25rem" : "0" }}
            >
              <CoreOrb size={view === "chat" || view === "home" ? 108 : 72} state={coreState} />
              {/* ブランド＋システム名を1行に。AIbou は小文字を含むので
                  uppercase になる label-mono ではなく brand-wordmark を使う。 */}
              <h1 className="text-glow mt-3 flex items-baseline gap-2 text-fg-strong">
                <span className="brand-wordmark text-[17px] sm:text-[19px]">AIbou</span>
                <span className="brand-sub text-[9px] text-muted">THE FORGE OS</span>
              </h1>
              <p className="mt-0.5 text-[10px] tracking-[0.28em] text-muted/80 label-mono">
                {loaded ? `${settings.name} · ${stateLabel(coreState)}` : "INITIALIZING"}
              </p>
            </header>

            <div className="divider my-2" />
          </>
        )}
      </div>

      {/* Active view fills remaining space. Home & Forge own the full width
          (custom layouts); the rest are centred so they don't look stretched.
          Views enter from depth (3D rotateX) — except CHAT, whose fixed
          history panel must never sit inside a transformed ancestor, so it
          fades only. */}
      <section className="min-h-0 flex-1" style={{ perspective: 1400 }}>
        <motion.div
          key={view}
          /* 縦に積む箱にする。
             ここには画面本体だけでなく、上の案内（NeedsNotice）や管理タブの
             切り替えも並ぶ。それらが場所を取るのに画面本体が h-full（＝親の
             高さ100%）だと、兄弟のぶんだけ下へはみ出す。実測で入力欄の
             下49pxが下のナビの裏に潜っていて、スマホで押しにくかった。 */
          className="flex h-full min-h-0 flex-col"
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
          {/* 「この画面を使うには◯◯を設定してください」を、操作より先に出す。
              押した先で 401 や 503 の数字を見せられても、何をすればいいのか
              分からないため。足りているときは何も出ない。 */}
          {loaded && view !== "guide" && (
            <div className="mx-auto w-full max-w-3xl shrink-0">
              <NeedsNotice mode={view} />
            </div>
          )}

          {/* 管理タブの中の切り替え。実行（会話）のときは出さない。 */}
          {loaded && tabOf(view as ShellView) === "manage" && (
            <ManageBar view={view} onChange={setView} isOwner={isOwner} />
          )}

          {/* 画面本体は「残った高さ」を使う。上の案内や切り替えが場所を
              取っても、はみ出さずに縮む（min-h-0 が無いと縮まない）。 */}
          <div className="flex min-h-0 flex-1 flex-col">
            {loaded && view === "home" && <Home settings={settings} onNavigate={setView} />}
            {loaded && view === "chat" && (
              <Chat
                settings={settings}
                voiceReplies={voiceReplies}
                onStateChange={setCoreState}
                /* `#ボード` などの画面ものを、その場で開く。知らない名前は
                   無視する（サーバー側の名前が先に変わっても、飛び先の
                   無い所へ飛ばさない）。 */
                onOpenView={(v) => { if (isView(v)) setView(v); }}
              />
            )}
            {loaded && view === "me" && <LifeMode settings={settings} />}
            {loaded && view === "sns" && <Centered><SnsMode /></Centered>}
            {loaded && view === "capture" && <Centered><Capture /></Centered>}
            {loaded && view === "code" && <CodeMode />}
            {loaded && view === "vault" && <Centered><Vault /></Centered>}
            {loaded && view === "income" && <Centered><Income /></Centered>}
            {loaded && view === "tasks" && <Centered><Tasks /></Centered>}
            {loaded && view === "studio" && <Centered><Workshop /></Centered>}
            {loaded && view === "autopilot" && <Centered><Autopilot /></Centered>}
            {loaded && view === "board" && <Centered><Dashboard /></Centered>}
            {loaded && view === "archive" && <Centered><AppArchive /></Centered>}
            {loaded && view === "extend" && <Centered><Extensions onNavigate={setView} /></Centered>}
            {loaded && view === "guide" && <Centered><Guide /></Centered>}
          </div>
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
            onGoExtend={() => { setSettingsOpen(false); setView("extend"); }}
          />
        )}
      </AnimatePresence>

      {/* 下のナビ（スマホ）。実行・管理・設定の3つだけ。 */}
      <MobileNav view={view} onChange={setView}
                 onSettings={() => setSettingsOpen(true)} />
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

// 持ち主だけのモード。サーバーの /account/profile が正で、ここは
// 応答が返る前の初期表示に使う控えの一覧（多めに隠す側に倒す）。
const OWNER_ONLY_VIEWS: View[] = ["income"];

const NAV_ITEMS: { key: View; label: string }[] = [
  { key: "home", label: "HOME" },
  { key: "chat", label: "CHAT" },
  { key: "me", label: "ME" },
  { key: "code", label: "CODE" },
  { key: "studio", label: "STUDIO" },
  { key: "sns", label: "SNS" },
  { key: "capture", label: "CAPTURE" },
  { key: "vault", label: "VAULT" },
  { key: "tasks", label: "TASKS" },
  { key: "income", label: "INCOME" },
  { key: "autopilot", label: "AUTO" },
  { key: "board", label: "BOARD" },
  { key: "archive", label: "ARCHIVE" },
  { key: "extend", label: "EXTEND" },
  { key: "guide", label: "GUIDE" },
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
    case "sns":
      return (<svg {...p}><path d="M4 5h16v11H7l-3 3V5z" /><circle cx="9" cy="10.5" r="1" /><circle cx="12" cy="10.5" r="1" /><circle cx="15" cy="10.5" r="1" /></svg>);
    case "capture":
      return (<svg {...p}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /><circle cx="8.5" cy="12" r="2.2" /></svg>);
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
    case "extend":
      // コンセント（差し込む＝つなぐ）。他のアイコンと同じ線画で揃える
      return (<svg {...p}><path d="M9 3v6M15 3v6" /><path d="M5 9h14v3a7 7 0 0 1-14 0V9z" /><path d="M12 19v2" /></svg>);
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
/**
 * 下のナビ。「実行」「管理」の2つと、歯車だけ。
 *
 * 以前は4つのモード＋⋯で、⋯の中に14タイルが並んでいた。15個の行き先が
 * 常に見えていて、開くたびに「どこへ行くか」を決めさせていた。
 *
 * 相棒は、行き先を選ばせない物のはず。だから
 *   実行 … 話して、やってもらう（会話はここ1つ）
 *   管理 … 残っている物を見る・触る
 * の2つにして、残りは管理の中と `#` からたどれるようにした。画面は
 * 1つも消していない（案内する数を減らしただけ）。
 *
 * 歯車を下に置いたのは、右上の32pxが片手では届きにくかったため。
 * キーボードが出ている間は下げる（visualViewport）。
 */
function MobileNav({ view, onChange, onSettings }:
  { view: View; onChange: (v: View) => void; onSettings: () => void }) {
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => setKbOpen(window.innerHeight - vv.height > 120);
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  const tab = tabOf(view as ShellView);

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-panel bg-[var(--chrome)] backdrop-blur-md transition-transform duration-200 sm:hidden"
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
        transform: kbOpen ? "translateY(110%)" : "none",
      }}
    >
      <div className="mx-auto grid max-w-md grid-cols-3">
        <button
          type="button"
          onClick={() => onChange(RUN_VIEW as View)}
          aria-current={tab === "run" ? "page" : undefined}
          className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[10px] tracking-[0.06em] label-mono"
          style={{ color: tab === "run" ? "var(--accent)" : "var(--muted)" }}
        >
          <NavIcon name="chat" />
          <span>実行</span>
        </button>
        <button
          type="button"
          onClick={() => onChange((surfaceOf(view as ShellView)
            ? view : MANAGE_SURFACES[0].view) as View)}
          aria-current={tab === "manage" ? "page" : undefined}
          className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[10px] tracking-[0.06em] label-mono"
          style={{ color: tab === "manage" ? "var(--accent)" : "var(--muted)" }}
        >
          <NavIcon name="home" />
          <span>管理</span>
        </button>
        <button
          type="button"
          onClick={onSettings}
          aria-label="設定"
          className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[10px] tracking-[0.06em] text-muted label-mono"
        >
          <span className="text-base leading-none">⚙</span>
          <span>設定</span>
        </button>
      </div>
    </nav>
  );
}


/**
 * 管理タブの中の切り替え。よく開く4つと「もっと」。
 *
 * 「もっと」に残りを入れてあるのは、`#` を知らない人の行き止まりを
 * 作らないため。会話から呼べるのと、一覧としてたどれるのは別の話。
 */
function ManageBar({ view, onChange, isOwner }:
  { view: View; onChange: (v: View) => void; isOwner: boolean | null }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const here = surfaceOf(view as ShellView);
  const more = MORE_SURFACES.filter((m) => !(m.ownerOnly && isOwner === false));

  return (
    <div className="mx-auto w-full max-w-5xl shrink-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {MANAGE_SURFACES.map((sf) => (
          <button
            key={sf.key}
            type="button"
            onClick={() => { onChange(sf.view as View); setMoreOpen(false); }}
            title={sf.hint}
            className="rounded-forge border px-3 py-2 text-[12px] transition"
            style={{
              borderColor: here === sf.key ? "var(--accent)" : "var(--panel-bd)",
              color: here === sf.key ? "var(--fg-strong)" : "var(--muted)",
              background: here === sf.key ? "var(--btn-bg)" : "transparent",
            }}
          >
            {sf.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          className="rounded-forge border border-panel px-3 py-2 text-[12px] text-muted transition"
          style={{ color: here === null ? "var(--fg-strong)" : undefined }}
        >
          {moreOpen ? "▲ もっと" : "▼ もっと"}
        </button>
      </div>

      {moreOpen && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {more.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => { onChange(m.view as View); setMoreOpen(false); }}
              className="rounded-forge border border-panel px-3 py-2 text-left transition hover:border-[var(--line)]"
              style={{ borderColor: view === m.view ? "var(--accent)" : undefined }}
            >
              <span className="block text-[12px] text-fg-strong">{m.label}</span>
              <span className="block text-[11px] text-muted">{m.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


function ModeLauncher({ view, onChange, items: navItems }:
  { view: View; onChange: (v: View) => void; items: { key: View; label: string }[] }) {
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
                  {navItems.map((it) => {
                    const active = it.key === view;
                    return (
                      <button
                        key={it.key}
                        type="button"
                        onClick={() => { onChange(it.key); setOpen(false); }}
                        className="flex h-[4.25rem] flex-col items-center justify-center gap-1.5 rounded-forge border text-[10px] tracking-[0.06em] label-mono transition duration-150 hover:-translate-y-0.5 hover:scale-[1.05]"
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

function FullscreenIcon({ on }: { on: boolean }) {
  // on → "compress" (arrows in / restore); off → "expand" (arrows out).
  return on ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
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

type SettingsTab = "core" | "persona" | "keychain" | "hf" | "diagnostics";

function SettingsPanel({
  initial,
  initialVoice,
  online,
  onClose,
  onSave,
  onGoExtend,
}: {
  initial: ChatSettings;
  initialVoice: boolean;
  online: boolean;
  onClose: () => void;
  onSave: (settings: ChatSettings, voice: boolean) => void;
  onGoExtend: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("core");
  const [name, setName] = useState(initial.name);
  const [persona, setPersona] = useState(initial.persona);
  const [voice, setVoice] = useState(initialVoice);
  const [ttsVoice, setTtsVoice] = useState(initial.voice || DEFAULT_TTS_VOICE);
  const [rate, setRate] = useState(initial.rate ?? DEFAULT_TTS_RATE);
  const [host, setHost] = useState("");
  useEffect(() => { try { setHost(window.location.host); } catch { /* ignore */ } }, []);

  /* ── 声の設定 ──────────────────────────────────────────────────────
     端末に入っている音声は機種ごとに違うので、決め打ちの一覧ではなく実際に
     列挙する。声が1つも入っていない端末があり、そこで「端末の声」を選ぶと
     無音になるため、その場合は選ばせずサーバー音声へ寄せる。            */
  const [engine, setEngine] = useState<VoiceEngine>(initial.voiceEngine ?? "browser");
  const [browserVoice, setBrowserVoice] = useState(initial.browserVoice ?? "");
  const [pitch, setPitch] = useState(initial.pitch ?? 1.0);
  const [deviceVoices, setDeviceVoices] = useState<{ name: string; lang: string }[]>([]);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setDeviceVoices(listVoices("ja-JP").map((v) => ({ name: v.name, lang: v.lang })));
    };
    refresh();
    // 音声一覧は非同期に埋まる（初回は空で返る端末がある）
    const t = setTimeout(refresh, 600);
    window.speechSynthesis?.addEventListener?.("voiceschanged", refresh);
    return () => {
      clearTimeout(t);
      window.speechSynthesis?.removeEventListener?.("voiceschanged", refresh);
    };
  }, []);

  const noDeviceVoice = deviceVoices.length === 0;

  /** いま選んでいる設定でそのまま喋らせる（効いているか耳で確かめる用）。 */
  const preview = useCallback(() => {
    stopCoreVoice();
    setPreviewing(true);
    speakCore(
      `こんにちは。${name.trim() || DEFAULT_NAME} です。この声と速さでお話しします。`,
      {
        engine,
        browserVoice: browserVoice || undefined,
        serverVoice: ttsVoice,
        rate,
        pitch,
      },
      { onEnd: () => setPreviewing(false) },
      Boolean(API_URL),
    );
  }, [name, engine, browserVoice, ttsVoice, rate, pitch]);

  // 設定を閉じたら試聴を止める（開きっぱなしで喋り続けないように）
  useEffect(() => () => { stopCoreVoice(); }, []);

  return (
    // 下のナビと同じ z-40 だと、スマホでは保存ボタンがナビの下に隠れて
    // 押せなくなる（設定を変えても保存できない）。ナビより前に出す。
    <motion.div
      className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center"
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
          {(["core", "persona", "keychain", "hf", "diagnostics"] as SettingsTab[]).map((t) => (
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
              <SkinSetting />
              <CoreTypeSetting />
              <AiProviderSettings />
              <IntegrationsSettings />
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

              {/* 声の出どころ */}
              <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">VOICE SOURCE</label>
              <div className="mb-3 grid grid-cols-2 gap-2">
                {([
                  { key: "browser" as VoiceEngine, label: "端末の声", hint: "すぐ鳴る" },
                  { key: "server" as VoiceEngine, label: "サーバーの声", hint: "なめらか" },
                ]).map((o) => {
                  const disabled = o.key === "browser" ? noDeviceVoice : !API_URL;
                  const on = engine === o.key;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      disabled={disabled}
                      onClick={() => setEngine(o.key)}
                      className="rounded-forge border px-3 py-2 text-left transition disabled:opacity-40"
                      style={{
                        borderColor: on ? "var(--accent)" : "var(--panel-bd)",
                        background: on ? "var(--btn-bg)" : "transparent",
                      }}
                    >
                      <div className="text-[11px] text-fg-strong">{o.label}</div>
                      <div className="text-[11px] text-muted">{o.hint}</div>
                    </button>
                  );
                })}
              </div>

              {/* 声 */}
              <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">CORE VOICE</label>
              {engine === "browser" ? (
                <select
                  aria-label="コアの声"
                  value={browserVoice}
                  onChange={(e) => setBrowserVoice(e.target.value)}
                  disabled={noDeviceVoice}
                  className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong focus:border-[var(--line)] focus:outline-none disabled:opacity-40"
                >
                  <option value="" className="bg-[#0a0e16]">おまかせ（自動で選ぶ）</option>
                  {deviceVoices.map((v) => (
                    <option key={v.name} value={v.name} className="bg-[#0a0e16]">{v.name}</option>
                  ))}
                </select>
              ) : (
                <select
                  aria-label="コアの声"
                  value={ttsVoice}
                  onChange={(e) => setTtsVoice(e.target.value)}
                  className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong focus:border-[var(--line)] focus:outline-none"
                >
                  {VOICE_PRESETS.map((v) => (
                    <option key={v.value} value={v.value} className="bg-[#0a0e16]">{v.label}</option>
                  ))}
                </select>
              )}

              {/* 使える声が無い／繋がっていない、を隠さない */}
              {engine === "browser" && noDeviceVoice && (
                <p className="mb-3 text-[10px] leading-relaxed text-muted">
                  この端末には音声が入っていないため、端末の声では鳴りません。
                  {API_URL ? "サーバーの声を選んでください。" : "バックエンドに繋ぐと、サーバーの声が使えます。"}
                </p>
              )}
              {engine === "server" && !API_URL && (
                <p className="mb-3 text-[10px] leading-relaxed text-muted">
                  バックエンド未接続のため、サーバーの声は使えません。
                </p>
              )}

              {/* 試聴 — 設定が効いているか、その場で耳で確かめられるようにする */}
              <button
                type="button"
                onClick={preview}
                className="mb-4 w-full rounded-forge border border-panel px-3 py-2 text-[10px] tracking-[0.16em] text-fg-strong transition hover:border-[var(--line)] label-mono"
              >
                {previewing ? "◈ 再生中…" : "▶ この声で試聴"}
              </button>

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

              {/* 声の高さ */}
              <div className="mb-4">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] tracking-[0.2em] text-muted label-mono">VOICE PITCH</span>
                  <span className="text-[10px] text-fg-strong label-mono">{pitch.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  value={pitch}
                  onChange={(e) => setPitch(Number(e.target.value))}
                  className="w-full accent-[var(--accent)]"
                  aria-label="Voice pitch"
                />
              </div>

              <button
                type="button"
                onClick={() => onSave({ name, persona, voice: ttsVoice, browserVoice, voiceEngine: engine, rate, pitch }, voice)}
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
                onClick={() => onSave({ name, persona, voice: ttsVoice, browserVoice, voiceEngine: engine, rate, pitch }, voice)}
                className="w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
              >
                SAVE & SYNC
              </button>
            </>
          )}

          {tab === "keychain" && (
            <>
              {/* 同じ設定が2か所にあると、どちらが本物か分からなくなる。
                  ふだんの操作は拡張機能に一本化し、ここは逃げ道として残す。 */}
              <div className="mb-3 rounded-forge border border-panel p-3">
                <p className="text-[11px] leading-relaxed text-fg">
                  連携（Supabase・LINE・Google など）は
                  <b className="text-fg-strong">「拡張機能」</b>にまとめました。
                  そちらなら、何ができるようになるか・値のとり方まで一緒に出ます。
                </p>
                <button
                  type="button"
                  onClick={onGoExtend}
                  className="mt-2 rounded-forge border px-3 py-2 text-[11px] label-mono"
                  style={{ borderColor: "var(--accent)", color: "var(--fg-strong)", background: "var(--btn-bg)" }}
                >
                  拡張機能をひらく
                </button>
              </div>

              <details>
                <summary className="cursor-pointer text-[11px] text-muted">
                  上級者向け：キーを名前で直接編集する
                </summary>
                <div className="mt-2">
                  <div className="mb-3 text-[10px] leading-relaxed text-muted">
                    APIキーを暗号化して保管します。<b className="text-fg">バックエンド接続時は Supabase にサーバー側で暗号化保存</b>（Fernet・DBは暗号文のみ）。
                    未接続時は端末内に暗号化下書き（AES-256）として保存し、接続後に取り込めます。
                    拡張機能に無い独自のキーは、ここから追加できます。
                  </div>
                  <Keychain />
                </div>
              </details>
            </>
          )}

          {tab === "hf" && (
            <>
              <div className="mb-3 text-[10px] leading-relaxed text-muted">
                HuggingFace のモデルを登録して、<b className="text-fg">会話・コード・画像生成・文字起こし</b>に
                割り当てます。登録したら「テスト」で実際に動くか確かめてください。
              </div>
              <HfModels />
            </>
          )}

          {tab === "diagnostics" && (
            <div className="flex flex-col gap-3">
              {/* 困ったときに最初に押すもの。下の技術情報より前に置く */}
              <SelfCheck />

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
                      <ConnRow name="Backend API" ok={online} value={apiUrl ? (online ? apiUrl : `応答なし · ${apiUrl}`) : "未接続"} />
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

              {online ? (
                /* 「バックエンド接続済み」だけを大きく出すと、自分のデータベースまで
                   繋がったと読まれる（実際に誤解された）。別物だとはっきり書く。 */
                <div className="rounded-forge border border-panel p-3">
                  <p className="text-[11px] leading-relaxed text-[#60d394]">
                    ✓ サーバー（頭脳）には繋がっています。
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-fg">
                    これは<b>あなたのデータベースの接続とは別</b>です。自分のデータを保存するには、
                    KEYCHAIN の「自分のデータベース」を繋いでください
                    （繋ぐまでは保存されません）。手順は GUIDE に載っています。
                  </p>
                </div>
              ) : process.env.NEXT_PUBLIC_API_URL ? (
                <div className="rounded-forge border p-3" style={{ borderColor: "#ffd06055" }}>
                  <div className="mb-1 text-[10px] tracking-[0.2em] label-mono" style={{ color: "#ffd060" }}>⚠ バックエンドが応答していません</div>
                  <p className="text-[11px] leading-relaxed text-fg">
                    <code className="break-all">API_URL</code> は設定されていますが、そのURLに「頭脳（バックエンド）」がありません。
                    <b>Vercelの画面URL（〜.vercel.app）は頭脳ではありません。</b>
                    Render等にバックエンド(<code>api/</code>)をデプロイし、そこで発行された
                    <b>〜.onrender.com のようなURL</b>を <code>NEXT_PUBLIC_API_URL</code> に設定して Redeploy してください。
                  </p>
                  <p className="mt-1.5 text-[10px] text-muted">手順は <code>START_HERE.md</code> / <code>BACKEND_CONNECT.md</code>。</p>
                </div>
              ) : (
                <div className="rounded-forge border border-panel p-3">
                  <div className="mb-2 text-[10px] tracking-[0.2em] label-mono" style={{ color: "#ffd060" }}>◈ バックエンド接続ガイド（3ステップ）</div>
                  <ol className="ml-4 list-decimal space-y-1.5 text-[11px] leading-relaxed text-fg marker:text-muted">
                    <li><b>バックエンドをデプロイ</b>：<code>api/</code> を Render（推奨・付属の <code>render.yaml</code> でほぼワンクリック）か Google Cloud Run へ。<code>api/Dockerfile</code> 同梱済み。</li>
                    <li><b>Vercelに登録</b>：Settings → Environment Variables に <code>NEXT_PUBLIC_API_URL</code> ＝ 発行されたURL を追加 → <b>Redeploy</b>。</li>
                    <li><b>再読込</b>：上部が <b>LINK ACTIVE</b> になったら KEYCHAIN で <b>Gemini API Key</b> を SAVE（自動でサーバーへ同期・即有効）。</li>
                  </ol>
                  <p className="mt-2 text-[10px] text-muted">詳細は <code>BACKEND_CONNECT.md</code>。CORSは既定で全許可、GeminiキーはKEYCHAIN同期でOK（サーバーのenv設定は不要）。</p>
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

/**
 * 見た目（スキン）の切り替え。反映は <html data-skin> の1属性で、
 * 色・面・角丸・ラベルの体裁は globals.css 側が持っている。
 * 選択肢には実際の配色の見本を出して、押す前に分かるようにする。
 */
/**
 * コアの形の切り替え。見本は実物の CoreOrb をそのまま小さく描いているので、
 * 「押したらどう動くか」がその場で分かる（静止画のサムネイルではない）。
 */
function CoreTypeSetting() {
  const [kind, setKind] = useState<CoreType>("orb");
  useEffect(() => { setKind(readCoreType()); }, []);

  return (
    <div className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">コアの形</div>
      <div className="grid grid-cols-3 gap-2">
        {CORE_TYPES.map((c) => {
          const active = kind === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setKind(setCoreType(c.key))}
              aria-pressed={active}
              aria-label={c.label}
              title={c.hint}
              className="min-w-0 rounded-forge border p-1.5 text-center transition"
              style={{
                borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                background: active ? "var(--btn-bg)" : "transparent",
              }}
            >
              <span className="mx-auto block h-[52px] w-[52px]">
                <CoreOrb size={52} state="idle" type={c.key} />
              </span>
              <span className="mt-1 block truncate text-[9px] label-mono"
                    style={{ color: active ? "var(--fg-strong)" : "var(--muted)" }}>
                {c.label}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        {CORE_TYPES.find((c) => c.key === kind)?.hint}
      </p>
    </div>
  );
}

function SkinSetting() {
  const [skin, setSkinState] = useState<Skin>("forge");

  useEffect(() => {
    const s = readSkin();
    setSkinState(s);
    applySkin(s);          // 保存値と実際の表示がずれないよう、開いた時に必ず揃える
  }, []);

  const pick = (next: Skin) => {
    setSkinState(setSkin(next));
  };

  const SWATCH: Record<Skin, { bg: string; card: string; bd: string; ink: string; accent: string }> = {
    forge: { bg: "#0a0b0f", card: "#171a21", bd: "#3a3d45", ink: "#e8eaee", accent: "#00f3ff" },
    aibou: { bg: "#f4f5fd", card: "#ffffff", bd: "#e3e6f5", ink: "#1b2440", accent: "#3b5bfd" },
  };

  return (
    <div className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">見た目（テーマ）</div>
      <div className="grid grid-cols-2 gap-2">
        {SKINS.map((s) => {
          const active = skin === s.key;
          const c = SWATCH[s.key];
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => pick(s.key)}
              aria-pressed={active}
              title={s.hint}
              className="min-w-0 rounded-forge border p-2 text-left transition"
              style={{
                borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                background: active ? "var(--btn-bg)" : "transparent",
              }}
            >
              {/* 配色の見本（実際のトークンの色をそのまま並べる） */}
              <span
                className="mb-1.5 flex h-9 items-center gap-1 rounded-forge px-1.5"
                style={{ background: c.bg, border: `1px solid ${c.bd}` }}
                aria-hidden
              >
                <span className="h-5 flex-1 rounded" style={{ background: c.card, border: `1px solid ${c.bd}` }} />
                <span className="h-5 w-1.5 rounded" style={{ background: c.accent }} />
              </span>
              <span className="block truncate text-[10px] label-mono" style={{ color: active ? "var(--fg-strong)" : "var(--muted)" }}>
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        {SKINS.find((s) => s.key === skin)?.hint}
        ／ 画面の構成（モードの並びや操作）は変わりません。
      </p>
    </div>
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
