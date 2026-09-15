"use client";

/**
 * VideoPanel — 動画作成（DeeVid AI のような絵コンテ式）.
 *
 *  1. テーマを1行書く → AIが絵コンテ（シーン割り＋ナレーション＋画の指示）を書く
 *  2. シーンを編集：本文の書き換え・追加・削除・並べ替え
 *  3. 比率（横長 / 縦型Shorts / 正方形）と字幕の有無を選ぶ
 *  4. レンダリング → 各シーンの画像＋読み上げ＋ケン・バーンズ＋字幕焼き込みを連結
 *
 * 合成はバックエンド（ffmpeg）。ffmpegやフォントが無い環境では
 * /video/aspects がそれを返すので、できないことは隠さず表示する。
 */

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  videoGenerate, videoStoryboard, videoCaps, API_URL,
  type VideoScene, type VideoAspect,
} from "@/lib/api";

const FALLBACK_ASPECTS: VideoAspect[] = [
  { key: "16:9", w: 1280, h: 720, label: "横長（YouTube）" },
  { key: "9:16", w: 720, h: 1280, label: "縦型（Shorts / Reels / TikTok）" },
  { key: "1:1", w: 1080, h: 1080, label: "正方形（Instagramフィード）" },
];

const TONES = [
  { key: "friendly", label: "親しみやすく" },
  { key: "calm", label: "落ち着いて" },
  { key: "energetic", label: "元気に" },
  { key: "documentary", label: "ドキュメンタリー風" },
];

const EXAMPLES = [
  "朝の散歩がもたらす3つの効果",
  "初めてのぬか床の始め方",
  "小さなカフェの一日を追いかける",
];

/** base64のMP4をBlobにする（大きな動画をdata:URLでDOMに載せないため）。 */
function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export default function VideoPanel() {
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [tone, setTone] = useState("friendly");
  const [count, setCount] = useState(5);
  const [aspect, setAspect] = useState("16:9");
  const [subtitles, setSubtitles] = useState(true);

  const [aspects, setAspects] = useState<VideoAspect[]>(FALLBACK_ASPECTS);
  const [caps, setCaps] = useState<{ available: boolean; subs: boolean } | null>(null);
  const [scenes, setScenes] = useState<VideoScene[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<"" | "board" | "render">("");
  const [note, setNote] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    videoCaps()
      .then((c) => {
        if (!alive) return;
        if (c.aspects?.length) setAspects(c.aspects);
        setCaps({ available: c.available, subs: c.subtitles_available });
        if (!c.subtitles_available) setSubtitles(false);
      })
      .catch(() => { /* プリセットのままで使える */ });
    return () => { alive = false; };
  }, []);

  // アンマウント時にObject URLを解放する（タブを切り替えても残らないように）
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  const cur = aspects.find((a) => a.key === aspect) ?? FALLBACK_ASPECTS[0];

  const makeBoard = async () => {
    const t = topic.trim();
    if (!t || busy) return;
    setBusy("board");
    setNote("絵コンテを作成中…");
    try {
      const r = await videoStoryboard({ topic: t, n: count, aspect, tone, style: style.trim() });
      if (r.error || !r.scenes?.length) {
        setNote(`⚠ ${r.error ?? "絵コンテを作れませんでした"}`);
      } else {
        setScenes(r.scenes);
        setTitle(r.title ?? t);
        setNote(`✓ ${r.scenes.length}シーンの絵コンテができました。必要なら直してからレンダリングしてください。`);
      }
    } catch {
      setNote("⚠ 通信に失敗しました");
    } finally {
      setBusy("");
    }
  };

  const render = async () => {
    const usable = scenes.filter((s) => (s.narration || "").trim() || (s.visual || "").trim());
    if (!usable.length || busy) return;
    setBusy("render");
    setNote("動画をレンダリング中…（シーン数×十数秒かかります）");
    setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return null; });
    try {
      const r = await videoGenerate(usable, style.trim(), { aspect, subtitles });
      if (r.error || !r.video_base64) {
        setNote(`⚠ ${r.error ?? "動画を生成できませんでした"}`);
      } else {
        // data: URL のままだと数MBの文字列がDOMに乗る。Blobにして参照だけ持つ。
        setVideoUrl(URL.createObjectURL(base64ToBlob(r.video_base64, "video/mp4")));
        setNote("✓ 書き出しました");
      }
    } catch (e) {
      setNote(`⚠ ${e instanceof Error ? e.message : "動画生成に失敗しました"}`);
    } finally {
      setBusy("");
    }
  };

  /* ── シーン編集 ── */
  const patch = (i: number, k: keyof VideoScene, v: string) =>
    setScenes((s) => s.map((sc, j) => (j === i ? { ...sc, [k]: v } : sc)));
  const remove = (i: number) => setScenes((s) => s.filter((_, j) => j !== i));
  const add = () => setScenes((s) => [...s, { narration: "", visual: "" }]);
  const move = (i: number, d: -1 | 1) =>
    setScenes((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const out = [...s];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  if (!API_URL) {
    return <div className="panel p-3 text-[11px] leading-relaxed text-muted">動画作成はバックエンド接続後に使えます（設定 →「しらべる」）。</div>;
  }

  return (
    <div className="grid min-h-0 gap-3 lg:grid-cols-[20rem_1fr]">
      {/* ── 左：設定 ── */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        <div className="panel p-3">
          <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">VIDEO — 何の動画を作りますか？</div>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={3}
            placeholder="例：朝の散歩がもたらす3つの効果"
            className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
          />

          <div className="mt-2 text-[9px] tracking-[0.16em] text-muted label-mono">語り口</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {TONES.map((t) => (
              <button key={t.key} type="button" onClick={() => setTone(t.key)} aria-pressed={tone === t.key}
                className="rounded-full border px-2.5 py-1 text-[10px] label-mono"
                style={{
                  borderColor: tone === t.key ? "var(--accent)" : "var(--panel-bd)",
                  color: tone === t.key ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="mt-2.5 text-[9px] tracking-[0.16em] text-muted label-mono">比率</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {aspects.map((a) => (
              <button key={a.key} type="button" onClick={() => setAspect(a.key)} title={a.label}
                aria-pressed={aspect === a.key}
                className="rounded-full border px-2.5 py-1 text-[10px] label-mono"
                style={{
                  borderColor: aspect === a.key ? "var(--accent)" : "var(--panel-bd)",
                  color: aspect === a.key ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {a.key}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted">{cur.label} · {cur.w}×{cur.h}</p>

          <div className="mt-2.5 text-[9px] tracking-[0.16em] text-muted label-mono">シーン数</div>
          <div className="mt-1 flex gap-1">
            {[3, 4, 5, 6, 8].map((v) => (
              <button key={v} type="button" onClick={() => setCount(v)} aria-pressed={count === v}
                className="flex-1 rounded-forge border py-1 text-[10px] label-mono"
                style={{
                  borderColor: count === v ? "var(--accent)" : "var(--panel-bd)",
                  color: count === v ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {v}
              </button>
            ))}
          </div>

          <label className="mb-1 mt-2.5 block text-[9px] tracking-[0.16em] text-muted label-mono" htmlFor="vstyle">
            画の方向性（英語・任意）
          </label>
          <input
            id="vstyle"
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="cinematic, film photography, soft light"
            className="w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
          />

          <button type="button" onClick={() => void makeBoard()} disabled={!!busy || !topic.trim()}
            className="mt-2.5 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">
            {busy === "board" ? "…" : scenes.length ? "絵コンテを作り直す" : "絵コンテを自動作成"}
          </button>

          {note && <p className="mt-2 text-[10px] leading-relaxed" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</p>}
        </div>

        {scenes.length === 0 ? (
          <div className="panel p-3">
            <div className="mb-1.5 text-[9px] tracking-[0.16em] text-muted label-mono">例</div>
            <div className="flex flex-col gap-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => setTopic(ex)}
                  className="rounded-forge border border-panel p-2 text-left text-[10px] leading-relaxed text-muted transition hover:border-[var(--line)] hover:text-fg-strong">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="panel p-3">
            <label className="flex items-center gap-2 text-[10px] text-muted">
              <input type="checkbox" checked={subtitles} disabled={caps ? !caps.subs : false}
                onChange={(e) => setSubtitles(e.target.checked)} />
              ナレーションを字幕として焼き込む
            </label>
            {caps && !caps.subs && (
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                ※ この環境には日本語フォントが無いため字幕は焼けません（音声のみで書き出します）。
              </p>
            )}
            <button type="button" onClick={() => void render()} disabled={!!busy}
              className="mt-2 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">
              {busy === "render" ? "…" : "▶ 動画(MP4)を書き出す"}
            </button>
            {caps && !caps.available && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                ※ バックエンドに ffmpeg が無いため書き出せません（絵コンテの作成までは使えます）。
              </p>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              各シーンの画像と読み上げを合成し、ゆっくりズーム（ケン・バーンズ）を掛けて繋ぎます。
            </p>
          </div>
        )}
      </div>

      {/* ── 右：絵コンテ／プレビュー ── */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        {title && <p className="truncate text-[10px] text-muted label-mono">{title}</p>}

        {videoUrl && (
          <div className="panel p-3">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={videoUrl} controls
              className="mx-auto w-full rounded-forge"
              style={{ maxHeight: 420, maxWidth: cur.h > cur.w ? 260 : undefined }} />
            <a href={videoUrl} download={`${(title || "forge_video").replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 40)}.mp4`}
              className="mt-2 inline-block rounded-md border border-panel px-2.5 py-1 text-[10px] tracking-[0.15em] text-fg-strong transition hover:border-[var(--line)] label-mono">
              ⭳ .mp4
            </a>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-forge border border-panel bg-[rgba(255,255,255,0.02)] p-3">
          {busy === "render" ? (
            <motion.div className="grid h-full min-h-40 place-items-center px-6 text-center text-[11px] leading-relaxed tracking-[0.18em] text-muted label-mono"
              animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
              ◈ 画像・読み上げ・字幕を合成中…
            </motion.div>
          ) : scenes.length === 0 ? (
            <div className="grid h-full min-h-40 place-items-center p-6 text-center">
              <p className="text-[11px] leading-relaxed tracking-[0.14em] text-muted/60 label-mono">
                左にテーマを書いて「絵コンテを自動作成」<br />
                できた絵コンテはここで自由に直せます
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {scenes.map((sc, i) => (
                <div key={i} className="rounded-forge border border-panel bg-black/20 p-2.5">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className="text-[9px] tracking-[0.16em] text-muted label-mono">SCENE {i + 1}</span>
                    <div className="ml-auto flex gap-1">
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`シーン${i + 1}を上へ`}
                        className="rounded-md border border-panel px-2 py-0.5 text-[10px] text-muted transition hover:text-fg-strong disabled:opacity-30">↑</button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === scenes.length - 1} aria-label={`シーン${i + 1}を下へ`}
                        className="rounded-md border border-panel px-2 py-0.5 text-[10px] text-muted transition hover:text-fg-strong disabled:opacity-30">↓</button>
                      <button type="button" onClick={() => remove(i)} aria-label={`シーン${i + 1}を削除`}
                        className="rounded-md border border-panel px-2 py-0.5 text-[10px] text-muted transition hover:text-[#ff9b9b]">✕</button>
                    </div>
                  </div>
                  <textarea
                    value={sc.narration}
                    onChange={(e) => patch(i, "narration", e.target.value)}
                    rows={2}
                    aria-label={`シーン${i + 1}のナレーション`}
                    placeholder="ナレーション（読み上げ＋字幕になります）"
                    className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[12px] text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
                  />
                  <input
                    value={sc.visual ?? ""}
                    onChange={(e) => patch(i, "visual", e.target.value)}
                    aria-label={`シーン${i + 1}の画の指示`}
                    placeholder="画の指示（英語）"
                    className="mt-1.5 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[11px] text-muted placeholder:text-muted focus:border-[var(--line)] focus:text-fg-strong focus:outline-none"
                  />
                  <p className="mt-1 text-right text-[9px] text-muted label-mono">{(sc.narration || "").length}字</p>
                </div>
              ))}
              <button type="button" onClick={add}
                className="rounded-forge border border-dashed border-panel py-2 text-[10px] tracking-[0.12em] text-muted transition hover:border-[var(--line)] hover:text-fg-strong label-mono">
                ＋ シーンを追加
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
