"use client";

/**
 * AiProviderSettings — Settings 内の「AIプロバイダ / モデル」選択。
 * Gemini / HuggingFace の切替、通常チャット用モデルと CODE 用モデルを選べる。
 * バックエンド(/ai/config)に保存される。未接続時は案内のみ。
 */

import { useEffect, useState } from "react";
import { aiConfigGet, aiConfigSet, API_URL, type AiConfig } from "@/lib/api";

const PROVIDERS = [
  { key: "auto", label: "AUTO", hint: "HFキーがあればHF、無ければGemini" },
  { key: "gemini", label: "GEMINI", hint: "Google Gemini（無料枠は学習に使われる場合あり）" },
  { key: "huggingface", label: "HUGGINGFACE", hint: "学習されない・コード特化モデル可" },
];

export default function AiProviderSettings() {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!API_URL) { setLoading(false); return; }
    aiConfigGet().then(setCfg).catch(() => setNote("設定の取得に失敗しました")).finally(() => setLoading(false));
  }, []);

  const save = async (patch: { provider?: string; hf_model?: string; code_model?: string }) => {
    setSaving(true);
    setNote(null);
    try {
      const next = await aiConfigSet(patch);
      setCfg(next);
      setNote("✓ 保存しました（次の生成から反映）");
    } catch (e) {
      setNote(`⚠ ${e instanceof Error ? e.message : "保存に失敗しました"}`);
    } finally {
      setSaving(false);
    }
  };

  if (!API_URL) {
    return (
      <div className="mb-4 rounded-forge border border-panel p-3 text-[11px] leading-relaxed text-muted">
        AIプロバイダ/モデルの選択は、バックエンド接続後に使えます（DIAGNOSTICS参照）。
      </div>
    );
  }
  if (loading) {
    return <div className="mb-4 rounded-forge border border-panel p-3 text-center text-[10px] tracking-[0.2em] text-muted label-mono">◈ LOADING AI CONFIG…</div>;
  }
  if (!cfg) {
    return <div className="mb-4 rounded-forge border border-panel p-3 text-[11px] text-[#ff9b9b]">{note || "AI設定を取得できませんでした"}</div>;
  }

  const activeLabel = cfg.active === "huggingface" ? "HuggingFace" : cfg.active === "gemini" ? "Gemini" : "未設定";

  return (
    <div className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">AI PROVIDER / MODEL</span>
        <span className="text-[9px] tracking-[0.1em] label-mono" style={{ color: cfg.active === "none" ? "#ffd060" : "#60d394" }}>
          ● {activeLabel}
        </span>
      </div>

      {/* Provider */}
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        {PROVIDERS.map((p) => {
          const active = cfg.provider === p.key;
          const disabled = (p.key === "gemini" && !cfg.gemini_ready) || (p.key === "huggingface" && !cfg.hf_ready);
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => !disabled && void save({ provider: p.key })}
              disabled={saving || disabled}
              title={disabled ? "先にKEYCHAINでキーを設定してください" : p.hint}
              className="rounded-forge border px-2 py-1.5 text-[9px] tracking-[0.08em] label-mono transition disabled:opacity-30"
              style={{
                borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                color: active ? "var(--fg-strong)" : "var(--muted)",
                background: active ? "var(--btn-bg)" : "transparent",
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Models (HF利用時のみ意味を持つ) */}
      <label className="mb-1 mt-2 block text-[9px] tracking-[0.16em] text-muted label-mono">CHAT モデル（HF）</label>
      <select
        value={cfg.hf_model}
        onChange={(e) => void save({ hf_model: e.target.value })}
        disabled={saving}
        className="mb-2 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong focus:outline-none"
      >
        {[cfg.hf_model, ...cfg.presets.chat.filter((m) => m !== cfg.hf_model)].map((m) => (
          <option key={m} value={m} className="bg-[#0a0e16]">{m}</option>
        ))}
      </select>

      <label className="mb-1 block text-[9px] tracking-[0.16em] text-muted label-mono">CODE モデル（HF・コーディング特化）</label>
      <select
        value={cfg.code_model}
        onChange={(e) => void save({ code_model: e.target.value })}
        disabled={saving}
        className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2 py-1.5 text-[11px] text-fg-strong focus:outline-none"
      >
        {[cfg.code_model, ...cfg.presets.code.filter((m) => m !== cfg.code_model)].map((m) => (
          <option key={m} value={m} className="bg-[#0a0e16]">{m}</option>
        ))}
      </select>

      <p className="mt-2 text-[9px] leading-relaxed text-muted">
        ※ モデル指定はHuggingFace使用時に有効（Geminiは自動で最適モデルを選択）。
        HFトークンは KEYCHAIN の HUGGINGFACE_TOKEN に。
      </p>
      {note && <p className="mt-1 text-[10px]" style={{ color: note.startsWith("⚠") ? "#ff9b9b" : "#60d394" }}>{note}</p>}
    </div>
  );
}
