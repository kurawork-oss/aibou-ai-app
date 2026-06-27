"use client";

/**
 * VideoPanel — 画像＋ナレーションからMP4を合成（バックエンド /video = ffmpeg）。
 * FORGE OSの世界観。生成は数十秒かかるためブランド演出のローディングで待たせる。
 */

import { motion } from "framer-motion";
import { useState } from "react";
import { videoGenerate } from "@/lib/api";

export default function VideoPanel() {
  const [style, setStyle] = useState("");
  const [scenesText, setScenesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const run = async () => {
    const scenes = scenesText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((narration) => ({ narration, visual: style.trim() }));
    if (scenes.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setVideoUrl(null);
    try {
      const r = await videoGenerate(scenes, style.trim());
      if (r.error || !r.video_base64) {
        setError(r.error || "動画を生成できませんでした");
      } else {
        setVideoUrl(`data:video/mp4;base64,${r.video_base64}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "動画生成に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">
          画像スタイル（英語プロンプト）
        </label>
        <input
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="cinematic, neon city at night, 4k"
          className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-[10px] tracking-[0.2em] text-muted label-mono">
          ナレーション（1行＝1シーン）
        </label>
        <textarea
          value={scenesText}
          onChange={(e) => setScenesText(e.target.value)}
          rows={4}
          placeholder={"夜の街にネオンが灯る\n雨に濡れた路地を歩く\n遠くにそびえる高層ビル"}
          className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:shadow-glow focus:outline-none"
        />
      </div>
      <button
        type="button"
        onClick={run}
        disabled={busy || !scenesText.trim()}
        className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.2em] text-fg-strong shadow-glow transition hover:shadow-glow-strong disabled:opacity-40 label-mono"
      >
        {busy ? "RENDERING…" : "動画(MP4)を生成"}
      </button>

      {busy && (
        <motion.div
          className="panel p-4 text-center text-[11px] tracking-[0.18em] text-muted label-mono"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.4, repeat: Infinity }}
        >
          ◈ 画像とナレーションを合成中…（数十秒かかります）
        </motion.div>
      )}

      {error && <div className="panel p-3 text-xs text-[#ff9b9b]">⚠️ {error}</div>}

      {videoUrl && !busy && (
        <div className="panel p-3">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={videoUrl} controls className="w-full rounded-forge" />
          <a
            href={videoUrl}
            download="forge_video.mp4"
            className="mt-2 inline-block rounded-md border border-panel px-2.5 py-1 text-[10px] tracking-[0.15em] text-fg-strong transition hover:border-[var(--line)] label-mono"
          >
            ↓ .mp4
          </a>
        </div>
      )}
    </div>
  );
}
