"use client";

/**
 * Keychain — APIキー保管庫（認証コード付き）.
 *
 * - 任意の「認証コード（PIN）」でロックできる。PINのSHA-256だけをlocalStorageに保存
 *   （平文PINは保存しない）。未設定なら誰でも開けるが、設定を促すバナーを出す。
 * - キー本体はバックエンド（/keys）に保管され、一覧は常にマスク表示。
 *   フル値はAPIから返らないので画面にも出ない。
 * - バックエンド未接続（offline）でもcrashせず、状態を案内する。
 */

import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { listKeys, setKey, deleteKey, API_URL, type ApiKeyInfo } from "@/lib/api";

const LS_PIN_HASH = "forge_keychain_pin";

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function Keychain() {
  const [pinHash, setPinHash] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const h = localStorage.getItem(LS_PIN_HASH);
      setPinHash(h);
      if (!h) setUnlocked(true); // no PIN set → open (banner prompts to set one)
    } catch {
      setUnlocked(true);
    }
  }, []);

  const tryUnlock = async () => {
    if (!pinInput.trim()) return;
    const h = await sha256(pinInput.trim());
    if (h === pinHash) {
      setUnlocked(true);
      setPinError(null);
      setPinInput("");
    } else {
      setPinError("認証コードが違います");
    }
  };

  const setNewPin = async () => {
    if (pinInput.trim().length < 4) {
      setPinError("4桁以上で設定してください");
      return;
    }
    const h = await sha256(pinInput.trim());
    try {
      localStorage.setItem(LS_PIN_HASH, h);
    } catch { /* ignore */ }
    setPinHash(h);
    setPinInput("");
    setPinError(null);
  };

  const removePin = () => {
    try { localStorage.removeItem(LS_PIN_HASH); } catch { /* ignore */ }
    setPinHash(null);
  };

  // Locked screen (PIN set but not yet unlocked)
  if (pinHash && !unlocked) {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <div className="grid h-12 w-12 place-items-center rounded-full border border-[var(--line)] text-[var(--accent)]">
          <LockIcon />
        </div>
        <p className="text-[11px] tracking-[0.2em] text-muted label-mono">ENTER ACCESS CODE</p>
        <input
          type="password"
          value={pinInput}
          onChange={(e) => setPinInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void tryUnlock()}
          placeholder="••••"
          className="w-40 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-center text-lg tracking-[0.4em] text-fg-strong focus:border-[var(--line)] focus:outline-none"
        />
        {pinError && <p className="text-[11px] text-[#ff9b9b]">{pinError}</p>}
        <button
          type="button"
          onClick={() => void tryUnlock()}
          className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-6 py-2 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow label-mono"
        >
          UNLOCK
        </button>
      </div>
    );
  }

  return <KeychainInner pinSet={!!pinHash} onSetPin={setNewPin} onRemovePin={removePin} pinInput={pinInput} setPinInput={setPinInput} pinError={pinError} />;
}

function KeychainInner({
  pinSet, onSetPin, onRemovePin, pinInput, setPinInput, pinError,
}: {
  pinSet: boolean;
  onSetPin: () => void;
  onRemovePin: () => void;
  pinInput: string;
  setPinInput: (v: string) => void;
  pinError: string | null;
}) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingName, setSavingName] = useState<string | null>(null);
  const [showPinForm, setShowPinForm] = useState(false);

  const refresh = useCallback(async () => {
    if (!API_URL) { setOffline(true); setLoading(false); return; }
    try {
      const items = await listKeys();
      setKeys(items);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async (name: string) => {
    const value = (edits[name] ?? "").trim();
    if (!value) return;
    setSavingName(name);
    try {
      await setKey(name, value);
      setEdits((p) => ({ ...p, [name]: "" }));
      await refresh();
    } catch { /* ignore */ } finally {
      setSavingName(null);
    }
  };

  const remove = async (name: string) => {
    setSavingName(name);
    try {
      await deleteKey(name);
      await refresh();
    } catch { /* ignore */ } finally {
      setSavingName(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Access-code controls */}
      <div className="rounded-forge border border-panel p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] tracking-[0.2em] text-muted label-mono">ACCESS CODE</span>
          <span className="text-[10px] tracking-[0.12em] label-mono" style={{ color: pinSet ? "#60d394" : "#ffd060" }}>
            {pinSet ? "● LOCKED" : "○ NOT SET"}
          </span>
        </div>
        {!pinSet && !showPinForm && (
          <button type="button" onClick={() => setShowPinForm(true)} className="mt-2 text-[10px] tracking-[0.16em] text-[var(--accent)] hover:underline label-mono">
            + 認証コードを設定して保管庫をロック
          </button>
        )}
        {showPinForm && !pinSet && (
          <div className="mt-2 flex gap-2">
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder="4桁以上の認証コード"
              className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-sm text-fg-strong focus:border-[var(--line)] focus:outline-none"
            />
            <button type="button" onClick={onSetPin} className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 text-[10px] tracking-[0.14em] text-fg-strong label-mono">SET</button>
          </div>
        )}
        {pinSet && (
          <button type="button" onClick={onRemovePin} className="mt-2 text-[10px] tracking-[0.16em] text-[#ff8888] hover:underline label-mono">
            認証コードを解除する
          </button>
        )}
        {pinError && <p className="mt-1 text-[10px] text-[#ff9b9b]">{pinError}</p>}
      </div>

      {offline ? (
        <div className="rounded-forge border border-panel p-4 text-center">
          <p className="text-[11px] leading-relaxed text-muted">
            バックエンド未接続です。APIキーはバックエンド（Cloud Run 等）を接続すると保存できます。
            <br />
            <span className="text-[10px] text-muted/70">Settings → DIAGNOSTICS の BACKEND を確認してください。</span>
          </p>
        </div>
      ) : loading ? (
        <motion.div className="panel p-4 text-center text-[11px] tracking-[0.2em] text-muted label-mono" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
          ◈ LOADING KEYCHAIN…
        </motion.div>
      ) : (
        <div className="flex flex-col gap-2">
          {keys.map((k) => (
            <div key={k.name} className="rounded-forge border border-panel p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[11px] tracking-[0.1em] text-fg-strong label-mono">{k.label || k.name}</div>
                  {k.hint && <div className="text-[9px] text-muted">{k.hint}</div>}
                </div>
                <span className="text-[9px] tracking-[0.12em] label-mono" style={{ color: k.set ? "#60d394" : "#6a6f77" }}>
                  {k.set ? `SET · ${k.masked}` : "NOT SET"}
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  type="password"
                  value={edits[k.name] ?? ""}
                  onChange={(e) => setEdits((p) => ({ ...p, [k.name]: e.target.value }))}
                  placeholder={k.set ? "新しい値で上書き…" : "キーを貼り付け…"}
                  className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-sm text-fg-strong focus:border-[var(--line)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void save(k.name)}
                  disabled={savingName === k.name || !(edits[k.name] ?? "").trim()}
                  className="shrink-0 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 text-[10px] tracking-[0.14em] text-fg-strong disabled:opacity-40 label-mono"
                >
                  {savingName === k.name ? "…" : "SAVE"}
                </button>
                {k.set && (
                  <button
                    type="button"
                    onClick={() => void remove(k.name)}
                    disabled={savingName === k.name}
                    className="shrink-0 rounded-forge border border-[#ff6b6b44] px-2 text-[10px] text-[#ff8888] label-mono"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
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
