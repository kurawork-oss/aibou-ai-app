"use client";

/**
 * Workshop — 「作る」ためのモード（旧 FORGE と旧 STUDIO を統合）.
 *  - FORGE（生成）: 画像/スライド/表/文書を生成
 *  - APP         : ブラウザで動くWebアプリを生成（ライブプレビュー付き）
 *  - LP / HP     : 公開できるページを生成
 *  - AI STUDIO   : カスタムAI・ワークフロー・自己進化
 * 外側タブで切替。選択タブは記憶される。
 */

import { useEffect, useMemo, useState } from "react";
import Forge from "@/components/Forge";
import Studio from "@/components/Studio";
import LpBuilder from "@/components/LpBuilder";
import { API_URL, profileGet } from "@/lib/api";

const TABS = ["forge", "app", "lp", "studio"] as const;
type Tab = (typeof TABS)[number];

export default function Workshop() {
  // 最初に出すのは「アプリ」。ここが一番よく使われ、その場で動くものが作れる
  const [tab, setTab] = useState<Tab>("app");

  // AI STUDIO（カスタムAI・ワークフロー・自己進化）は持ち主だけのもの。
  // 分かるまでは隠す側に倒す。実際の遮断はサーバー側で行っている。
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  useEffect(() => {
    if (!API_URL) { setIsOwner(true); return; }
    profileGet().then((p) => setIsOwner(p.is_owner)).catch(() => setIsOwner(true));
  }, []);

  const tabs = useMemo(() => {
    const all = [
      // 「何を作るか」で並べる。FORGE という名前は、初めての人には
      // 何が出てくるのか分からない
      { key: "app" as Tab, label: "▣ アプリ" },
      { key: "lp" as Tab, label: "◫ LP・ホームページ" },
      { key: "forge" as Tab, label: "✦ 素材（画像・資料）" },
      { key: "studio" as Tab, label: "⚙ AI STUDIO", ownerOnly: true },
    ];
    return isOwner === false ? all.filter((t) => !t.ownerOnly) : all;
  }, [isOwner]);

  // 持ち主専用タブを開いたまま権限が変わった／保存されていた場合に備える
  useEffect(() => {
    if (isOwner === false && tab === "studio") setTab("forge");
  }, [isOwner, tab]);

  useEffect(() => {
    try {
      const t = localStorage.getItem("forge_workshop_tab") as Tab | null;
      if (t && TABS.includes(t)) setTab(t);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("forge_workshop_tab", tab); } catch { /* ignore */ }
  }, [tab]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* スマホでは横に流す1段（折り返すと2段・縦 100px を切り替えだけで使い、
          作る欄が狭くなっていた）。中央寄せは広い画面だけ——横に送れる箱で
          中央に寄せると、左にはみ出した分へ戻れなくなる。 */}
      <div className="-my-1 flex items-center gap-1.5 overflow-x-auto py-1 sm:mx-auto sm:my-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:py-0">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className="shrink-0 rounded-forge border px-3 py-1.5 text-[10px] tracking-[0.16em] transition label-mono sm:px-4"
            style={{
              borderColor: tab === t.key ? "var(--accent)" : "var(--panel-bd)",
              color: tab === t.key ? "var(--fg-strong)" : "var(--muted)",
              background: tab === t.key ? "var(--btn-bg)" : "transparent",
              boxShadow: tab === t.key ? "0 0 10px var(--glow)" : "none",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "forge" ? <Forge />
          : tab === "app" ? <LpBuilder kind="app" />
          : tab === "lp" ? <LpBuilder kind="lp" />
          : <Studio />}
      </div>
    </div>
  );
}
