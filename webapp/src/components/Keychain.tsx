"use client";

/**
 * Keychain — APIキー暗号化ボルト（端末内でAES-256-GCM暗号化）.
 *
 * 移行前と同様、いろんなAPIキーをアプリのUI上で暗号化して保管できる。
 * - マスターパスコード → PBKDF2(SHA-256,150k) で鍵導出 → AES-GCM でキー群を暗号化。
 *   localStorage には暗号文（salt/iv/ct）だけを保存。パスコードは端末外に出ない。
 * - バックエンド不要（offlineでも保管できる）。
 * - バックエンド接続時は「同期」でサーバーへ送り、サーバー側で実利用（Gemini等）。
 */

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { setKey as pushKey, deleteKey as pushDelete, API_URL } from "@/lib/api";

const LS_VAULT = "forge_vault_v1";

/** よく使うキー（プリセット）。ここに無いものは「カスタム」で追加可能。 */
const KNOWN_KEYS: { name: string; label: string; hint: string }[] = [
  { name: "GEMINI_API_KEY", label: "Gemini API Key", hint: "コアAI（必須） · Google AI Studioで取得" },
  { name: "OPENAI_API_KEY", label: "OpenAI API Key", hint: "任意 · GPT系を使う場合" },
  { name: "LINE_NOTIFY_TOKEN", label: "LINE Notify Token", hint: "完了/失敗をLINEに通知" },
  { name: "DISCORD_WEBHOOK", label: "Discord Webhook", hint: "Discordに通知" },
  { name: "SLACK_WEBHOOK", label: "Slack Webhook", hint: "Slackに通知" },
  { name: "LEONARDO_API_KEY", label: "Leonardo API Key", hint: "画像生成" },
  { name: "YOUTUBE_API_KEY", label: "YouTube API Key", hint: "YouTube Data API v3 / OAuth" },
  { name: "NOTE_TOKEN", label: "note Token", hint: "note投稿" },
  { name: "SHUTTERSTOCK_FTP", label: "Shutterstock FTP", hint: "user:pass@host 形式など" },
  { name: "SUPABASE_URL", label: "Supabase URL", hint: "プロジェクトURL" },
  { name: "SUPABASE_SERVICE_KEY", label: "Supabase Service Key", hint: "service_role キー" },
];

type StoredVault = { v: number; salt: string; iv: string; ct: string };
type Phase = "loading" | "setup" | "locked" | "unlocked";

/* ── crypto helpers (Web Crypto: PBKDF2 + AES-GCM) ─────────────────── */
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptVault(keys: Record<string, string>, passcode: string): Promise<StoredVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passcode, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(keys)));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function decryptVault(s: StoredVault, passcode: string): Promise<Record<string, string>> {
  const key = await deriveKey(passcode, unb64(s.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, key, unb64(s.ct));
  return JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>;
}

const maskValue = (v: string) => (v.length <= 4 ? "••••" : `${v.slice(0, 2)}••••${v.slice(-2)}`);

/* ── component ─────────────────────────────────────────────────────── */
export default function Keychain() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [pass, setPass] = useState("");           // held in memory only while unlocked
  const [passInput, setPassInput] = useState("");
  const [passConfirm, setPassConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [keys, setKeys] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [customName, setCustomName] = useState("");
  const [customValue, setCustomValue] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    try {
      setPhase(localStorage.getItem(LS_VAULT) ? "locked" : "setup");
    } catch {
      setPhase("setup");
    }
  }, []);

  const persist = async (next: Record<string, string>, passcode: string) => {
    const stored = await encryptVault(next, passcode);
    try { localStorage.setItem(LS_VAULT, JSON.stringify(stored)); } catch { /* ignore */ }
  };

  const createVault = async () => {
    if (passInput.length < 4) { setError("パスコードは4文字以上で設定してください"); return; }
    if (passInput !== passConfirm) { setError("確認用パスコードが一致しません"); return; }
    await persist({}, passInput);
    setPass(passInput); setKeys({}); setPhase("unlocked");
    setPassInput(""); setPassConfirm(""); setError(null);
  };

  const unlock = async () => {
    if (!passInput.trim()) return;
    let raw: string | null = null;
    try { raw = localStorage.getItem(LS_VAULT); } catch { /* ignore */ }
    if (!raw) { setPhase("setup"); return; }
    try {
      const dec = await decryptVault(JSON.parse(raw) as StoredVault, passInput);
      setKeys(dec); setPass(passInput); setPhase("unlocked");
      setPassInput(""); setError(null);
    } catch {
      setError("パスコードが違います");
    }
  };

  const lock = () => { setKeys({}); setPass(""); setReveal({}); setPhase("locked"); setNote(null); };

  const destroyVault = () => {
    if (!window.confirm("ボルトを完全に削除します。保管したキーは復元できません。よろしいですか？")) return;
    try { localStorage.removeItem(LS_VAULT); } catch { /* ignore */ }
    setKeys({}); setPass(""); setPhase("setup");
  };

  const saveKey = async (name: string, value: string) => {
    const v = value.trim();
    if (!v || !name) return;
    const next = { ...keys, [name]: v };
    setKeys(next);
    await persist(next, pass);
    setEdits((p) => ({ ...p, [name]: "" }));
    if (API_URL) { try { await pushKey(name, v); setNote(`✓ ${name} を保存＋バックエンドに同期`); } catch { setNote(`✓ ${name} を暗号化保存（同期は失敗）`); } }
    else setNote(`✓ ${name} を暗号化して端末に保存`);
  };

  const removeKey = async (name: string) => {
    const next = { ...keys };
    delete next[name];
    setKeys(next);
    await persist(next, pass);
    if (API_URL) { try { await pushDelete(name); } catch { /* ignore */ } }
  };

  const syncAll = async () => {
    if (!API_URL) return;
    setSyncing(true);
    let ok = 0, fail = 0;
    for (const [name, value] of Object.entries(keys)) {
      if (!value) continue;
      try { await pushKey(name, value); ok++; } catch { fail++; }
    }
    setNote(`✓ ${ok}件をバックエンドに同期${fail ? ` / ${fail}件失敗` : ""}`);
    setSyncing(false);
  };

  /* ── loading ── */
  if (phase === "loading") {
    return (
      <motion.div className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
        ◈ LOADING VAULT…
      </motion.div>
    );
  }

  /* ── setup: create master passcode ── */
  if (phase === "setup") {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="grid h-12 w-12 place-items-center rounded-full border border-[var(--line)] text-[var(--accent)]"><LockIcon /></div>
        <p className="text-[11px] tracking-[0.2em] text-muted label-mono">SET ACCESS CODE</p>
        <p className="max-w-xs text-center text-[11px] leading-relaxed text-muted">
          マスターパスコードでAPIキーを暗号化して保管します。<br />
          このコードは端末内だけで使われ、サーバーには送られません。<b className="text-fg-strong">忘れると復元できません。</b>
        </p>
        <input
          type="password" value={passInput} onChange={(e) => setPassInput(e.target.value)}
          placeholder="パスコード（4文字以上）"
          className="w-56 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-center tracking-[0.2em] text-fg-strong focus:border-[var(--line)] focus:outline-none"
        />
        <input
          type="password" value={passConfirm} onChange={(e) => setPassConfirm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void createVault()}
          placeholder="確認のためもう一度"
          className="w-56 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-center tracking-[0.2em] text-fg-strong focus:border-[var(--line)] focus:outline-none"
        />
        {error && <p className="text-[11px] text-[#ff9b9b]">{error}</p>}
        <button type="button" onClick={() => void createVault()} className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-6 py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow label-mono">
          CREATE VAULT
        </button>
      </div>
    );
  }

  /* ── locked: enter passcode ── */
  if (phase === "locked") {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <div className="grid h-12 w-12 place-items-center rounded-full border border-[var(--line)] text-[var(--accent)]"><LockIcon /></div>
        <p className="text-[11px] tracking-[0.2em] text-muted label-mono">ENTER ACCESS CODE</p>
        <input
          type="password" value={passInput} onChange={(e) => setPassInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void unlock()}
          placeholder="••••"
          className="w-40 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-center text-lg tracking-[0.4em] text-fg-strong focus:border-[var(--line)] focus:outline-none"
        />
        {error && <p className="text-[11px] text-[#ff9b9b]">{error}</p>}
        <button type="button" onClick={() => void unlock()} className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-6 py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow label-mono">
          UNLOCK
        </button>
        <button type="button" onClick={destroyVault} className="text-[10px] tracking-[0.14em] text-[#ff8888] hover:underline label-mono">
          パスコードを忘れた → ボルトを削除して作り直す
        </button>
      </div>
    );
  }

  /* ── unlocked: manage keys ── */
  const customKeys = Object.keys(keys).filter((n) => !KNOWN_KEYS.some((k) => k.name === n));
  const rows = [
    ...KNOWN_KEYS.map((k) => ({ ...k, custom: false })),
    ...customKeys.map((n) => ({ name: n, label: n, hint: "カスタム", custom: true })),
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* header / controls */}
      <div className="flex items-center justify-between rounded-forge border border-panel p-3">
        <div>
          <div className="text-[10px] tracking-[0.2em] text-fg-strong label-mono">🔐 ENCRYPTED VAULT · UNLOCKED</div>
          <div className="text-[9px] text-muted">AES-256-GCM · 端末内で暗号化 · localStorageには暗号文のみ</div>
        </div>
        <button type="button" onClick={lock} className="rounded-forge border border-[var(--line)] px-3 py-1.5 text-[10px] tracking-[0.14em] text-fg-strong label-mono">🔒 LOCK</button>
      </div>

      {/* backend sync status */}
      <div className="rounded-forge border border-panel p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] tracking-[0.16em] text-muted label-mono">
            BACKEND: {API_URL ? "● LINK ACTIVE" : "○ OFFLINE"}
          </span>
          {API_URL && (
            <button type="button" onClick={() => void syncAll()} disabled={syncing || Object.keys(keys).length === 0}
              className="rounded-forge border border-[var(--line)] px-3 py-1 text-[10px] tracking-[0.14em] text-[var(--accent)] disabled:opacity-40 label-mono">
              {syncing ? "同期中…" : "↑ 全キーを同期"}
            </button>
          )}
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-muted">
          {API_URL
            ? "保存時に自動でバックエンドへ送られ、サーバー側（Gemini等）で利用されます。"
            : "バックエンド未接続でも暗号化保管できます。接続後に「同期」でサーバーへ送れます。"}
        </p>
        {note && <p className="mt-1 text-[10px] text-[#60d394]">{note}</p>}
      </div>

      {/* key rows */}
      <div className="flex flex-col gap-2">
        {rows.map((k) => {
          const set = !!keys[k.name];
          return (
            <div key={k.name} className="rounded-forge border border-panel p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[11px] tracking-[0.1em] text-fg-strong label-mono">{k.label}</div>
                  <div className="text-[9px] text-muted">{k.hint}</div>
                </div>
                <span className="text-[9px] tracking-[0.12em] label-mono" style={{ color: set ? "#60d394" : "#6a6f77" }}>
                  {set ? (reveal[k.name] ? keys[k.name] : `SET · ${maskValue(keys[k.name])}`) : "NOT SET"}
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  type="password" value={edits[k.name] ?? ""}
                  onChange={(e) => setEdits((p) => ({ ...p, [k.name]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void saveKey(k.name, edits[k.name] ?? "")}
                  placeholder={set ? "新しい値で上書き…" : "キーを貼り付け…"}
                  className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-sm text-fg-strong focus:border-[var(--line)] focus:outline-none"
                />
                <button type="button" onClick={() => void saveKey(k.name, edits[k.name] ?? "")}
                  disabled={!(edits[k.name] ?? "").trim()}
                  className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 text-[10px] tracking-[0.14em] text-fg-strong disabled:opacity-40 label-mono">SAVE</button>
                {set && (
                  <>
                    <button type="button" onClick={() => setReveal((p) => ({ ...p, [k.name]: !p[k.name] }))}
                      title={reveal[k.name] ? "隠す" : "表示"}
                      className="shrink-0 rounded-forge border border-panel px-2 text-[10px] text-muted hover:text-fg-strong label-mono">
                      {reveal[k.name] ? "🙈" : "👁"}
                    </button>
                    <button type="button" onClick={() => void removeKey(k.name)}
                      className="shrink-0 rounded-forge border border-[#ff6b6b44] px-2 text-[10px] text-[#ff8888] label-mono">✕</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* add custom key */}
      <div className="rounded-forge border border-panel border-dashed p-3">
        <div className="mb-2 text-[10px] tracking-[0.16em] text-muted label-mono">+ カスタムキーを追加</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={customName} onChange={(e) => setCustomName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder="キー名（例：STRIPE_API_KEY）"
            className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-sm text-fg-strong focus:border-[var(--line)] focus:outline-none label-mono" />
          <input type="password" value={customValue} onChange={(e) => setCustomValue(e.target.value)}
            placeholder="値"
            className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-sm text-fg-strong focus:border-[var(--line)] focus:outline-none" />
          <button type="button"
            onClick={() => { if (customName && customValue.trim()) { void saveKey(customName, customValue); setCustomName(""); setCustomValue(""); } }}
            disabled={!customName || !customValue.trim()}
            className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-4 text-[10px] tracking-[0.14em] text-fg-strong disabled:opacity-40 label-mono">追加</button>
        </div>
      </div>

      <button type="button" onClick={destroyVault} className="self-start text-[10px] tracking-[0.14em] text-[#ff8888] hover:underline label-mono">
        ボルトを削除（全キーを消去）
      </button>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
