"use client";

/**
 * Capture — PC画面の録画 / 音声の録音（ブラウザ内で完結・無料）.
 *
 *  - 画面録画: getDisplayMedia で画面/ウィンドウ/タブを録画（タブ音声も可）
 *  - 画面＋マイク: 画面音声とマイクを Web Audio でミックスして録画
 *  - 音声のみ: マイクを録音
 * MediaRecorder で WebM を生成し、その場で再生＆ダウンロード。サーバー送信なし。
 * 非対応ブラウザ（iOS Safari 等の画面録画）では丁寧に案内して縮退する。
 */

import { useEffect, useRef, useState } from "react";
import {
  captureStatus, captureTranscribe, captureNarrate, captureVoiceover, API_URL,
  type CaptureStatus,
} from "@/lib/api";
import { useSpeechRecognition } from "@/lib/voice";

type Mode = "screen" | "screen_mic" | "mic";
interface Result {
  url: string;
  isVideo: boolean;
  size: number;
  /** アップロードして文字起こし/ナレーションに使うため、Blob自体も持つ。 */
  blob: Blob;
  seconds: number;
}

const MODES: { key: Mode; label: string; hint: string; video: boolean }[] = [
  { key: "screen", label: "画面録画", hint: "画面＋タブ音声", video: true },
  { key: "screen_mic", label: "画面＋マイク", hint: "解説ナレーション向け", video: true },
  { key: "mic", label: "音声のみ", hint: "ボイスメモ・録音", video: false },
];

function pickMime(video: boolean): string {
  const cands = video
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  const MR = typeof window !== "undefined" ? window.MediaRecorder : undefined;
  for (const c of cands) {
    try { if (MR && MR.isTypeSupported(c)) return c; } catch { /* ignore */ }
  }
  return "";
}

function fmtSize(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export default function Capture() {
  const [mode, setMode] = useState<Mode>("screen");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── AI文字起こし / ナレーション ──
  const [caps, setCaps] = useState<CaptureStatus | null>(null);
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState<"" | "stt" | "script" | "mix">("");
  const [note, setNote] = useState<string | null>(null);
  const [style, setStyle] = useState("explain");
  const [instruction, setInstruction] = useState("");
  const [script, setScript] = useState("");
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [narrated, setNarrated] = useState<string | null>(null);   // 合成後の動画URL
  const narratedRef = useRef<string | null>(null);
  // 録音中の下書き文字起こし（ブラウザの音声認識。鍵もサーバーも不要）
  const live = useSpeechRecognition("ja-JP");
  const [liveText, setLiveText] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<{ streams: MediaStream[]; ctx: AudioContext | null }>({ streams: [], ctx: null });
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastUrlRef = useRef<string | null>(null);
  // onstop のクロージャからは最新の state が見えないので、経過秒は ref でも持つ
  const elapsedRef = useRef(0);

  // この環境で何ができるか（ffmpeg / キーの有無）を先に聞く
  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    captureStatus().then((c) => { if (alive) setCaps(c); }).catch(() => { /* 任意機能 */ });
    return () => { alive = false; };
  }, []);

  // 合成した動画のObject URLを解放する
  useEffect(() => () => { if (narratedRef.current) URL.revokeObjectURL(narratedRef.current); }, []);

  const screenSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const micSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const cleanupStreams = () => {
    streamsRef.current.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    try { streamsRef.current.ctx?.close(); } catch { /* ignore */ }
    streamsRef.current = { streams: [], ctx: null };
  };

  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  // Cleanup on unmount.
  useEffect(() => () => {
    try { recorderRef.current?.state !== "inactive" && recorderRef.current?.stop(); } catch { /* ignore */ }
    cleanupStreams();
    stopTimer();
    if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current);
  }, []);

  const stop = () => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    } catch { /* ignore */ }
    // 下書きの文字起こしを確定させる（サーバー無しでも何か残るように）
    try { live.stop(); } catch { /* ignore */ }
    setLiveText((prev) => (live.transcript.trim() || prev));
  };

  /** 録画/録音をAIで文字起こしする（サーバーで音声を抽出してから渡す）。 */
  const runTranscribe = async () => {
    if (!result || busy) return;
    if (!caps?.transcribe) {
      setNote("⚠ 文字起こしにはサーバーの ffmpeg と Gemini のキーが必要です");
      return;
    }
    setBusy("stt");
    setNote("音声を書き起こしています…（長い録画は時間がかかります）");
    try {
      const r = await captureTranscribe(result.blob, result.isVideo ? "rec.webm" : "rec.audio.webm");
      if (r.error || !r.text) setNote(`⚠ ${r.error ?? "文字起こしできませんでした"}`);
      else {
        setTranscript(r.text);
        setNote(r.truncated
          ? `✓ 文字起こししました（長いため先頭 ${Math.round((caps ? 1800 : 1800) / 60)} 分ぶんのみ）`
          : `✓ 文字起こししました（${r.text.length}字）`);
      }
    } catch { setNote("⚠ 通信に失敗しました"); } finally { setBusy(""); }
  };

  /** 文字起こし（または下書き/メモ）からナレーション台本を作る。 */
  const runScript = async () => {
    const source = (transcript || liveText).trim();
    if (!source) { setNote("⚠ 先に文字起こしをするか、素材メモを書いてください"); return; }
    setBusy("script");
    setNote("ナレーション台本を作成中…");
    try {
      const r = await captureNarrate({
        source, style, seconds: result?.seconds ?? 0, instruction: instruction.trim(),
      });
      if (r.error || !r.script) setNote(`⚠ ${r.error ?? "台本を作れませんでした"}`);
      else { setScript(r.script); setNote("✓ 台本ができました（直してから吹き込めます）"); }
    } catch { setNote("⚠ 通信に失敗しました"); } finally { setBusy(""); }
  };

  /** 台本を読み上げて録画に重ねる。 */
  const runVoiceover = async () => {
    if (!result?.isVideo) { setNote("⚠ ナレーションを重ねられるのは画面録画だけです"); return; }
    if (!script.trim()) { setNote("⚠ 台本が空です"); return; }
    if (!caps?.voiceover) { setNote("⚠ 合成にはサーバーの ffmpeg が必要です"); return; }
    setBusy("mix");
    setNote("ナレーションを読み上げて重ねています…（数十秒かかります）");
    try {
      const r = await captureVoiceover({ blob: result.blob, script, keepOriginal });
      if (r.error || !r.video_base64) setNote(`⚠ ${r.error ?? "合成できませんでした"}`);
      else {
        const bin = atob(r.video_base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        if (narratedRef.current) URL.revokeObjectURL(narratedRef.current);
        const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
        narratedRef.current = url;
        setNarrated(url);
        setNote(r.mixed ? "✓ 元の音を残してナレーションを重ねました" : "✓ ナレーションに差し替えました");
      }
    } catch { setNote("⚠ 通信に失敗しました"); } finally { setBusy(""); }
  };

  const start = async () => {
    setError(null);
    if (result) { if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current); setResult(null); }
    const wantVideo = mode !== "mic";
    if (wantVideo && !screenSupported) { setError("この端末/ブラウザは画面録画に未対応です（PCのChrome/Edge推奨）。音声のみは利用できます。"); return; }
    if (!wantVideo && !micSupported) { setError("マイクにアクセスできません。"); return; }

    try {
      let recStream: MediaStream;
      let ctx: AudioContext | null = null;
      const streams: MediaStream[] = [];

      if (mode === "mic") {
        recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streams.push(recStream);
      } else {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
        streams.push(display);
        let audioTrack: MediaStreamTrack | undefined = display.getAudioTracks()[0];
        if (mode === "screen_mic") {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          streams.push(mic);
          ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
          const dest = ctx.createMediaStreamDestination();
          [display, mic].forEach((s) => { if (s.getAudioTracks().length) ctx!.createMediaStreamSource(s).connect(dest); });
          audioTrack = dest.stream.getAudioTracks()[0];
        }
        recStream = new MediaStream([...display.getVideoTracks(), ...(audioTrack ? [audioTrack] : [])]);
        // ユーザーがブラウザUIの「共有を停止」を押したら録画も止める。
        const vt = display.getVideoTracks()[0];
        if (vt) vt.addEventListener("ended", stop);
      }

      const mime = pickMime(wantVideo);
      const rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime || (wantVideo ? "video/webm" : "audio/webm") });
        const url = URL.createObjectURL(blob);
        lastUrlRef.current = url;
        setResult({ url, isVideo: wantVideo, size: blob.size, blob, seconds: elapsedRef.current });
        cleanupStreams();
        stopTimer();
        setRecording(false);
      };

      recorderRef.current = rec;
      streamsRef.current = { streams, ctx };
      rec.start();
      setRecording(true);
      setElapsed(0);
      elapsedRef.current = 0;
      // マイクを含むモードでは、ブラウザの音声認識で下書きを取る
      // （鍵もサーバーも不要。あとでAI文字起こしに置き換えられる）
      setTranscript("");
      setLiveText("");
      setScript("");
      setNarrated(null);
      setNote(null);
      if (mode !== "screen" && live.supported) { live.reset(); live.start(); }
      elapsedRef.current = 0;
      timerRef.current = setInterval(() => {
        elapsedRef.current += 1;
        setElapsed(elapsedRef.current);
      }, 1000);

      if (wantVideo && previewRef.current) {
        previewRef.current.srcObject = recStream;
        previewRef.current.muted = true;
        void previewRef.current.play?.().catch(() => {});
      }
    } catch (e) {
      cleanupStreams();
      const msg = (e as Error)?.name === "NotAllowedError" ? "権限が拒否されました。" : "録画を開始できませんでした。";
      setError(msg);
      setRecording(false);
    }
  };

  const download = () => {
    if (!result) return;
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `capture_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.webm`;
    const a = document.createElement("a");
    a.href = result.url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-3 overflow-y-auto pb-2">
      <div className="glass-silver p-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full border border-[var(--line)] text-[#ff6b6b]"><RecIcon /></span>
          <span className="text-[10px] tracking-[0.24em] text-muted label-mono">SCREEN & AUDIO CAPTURE</span>
        </div>
        <h2 className="label-mono text-glow text-sm text-fg-strong">画面録画・録音</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          PCの画面や音声をこの場で録画・録音します。データは端末内で処理され、サーバーには送られません。
        </p>

        {/* Mode select */}
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {MODES.map((m) => {
            const disabled = m.video && !screenSupported;
            const active = mode === m.key;
            return (
              <button
                key={m.key}
                type="button"
                disabled={recording || disabled}
                onClick={() => setMode(m.key)}
                title={disabled ? "この端末は画面録画に未対応" : m.hint}
                className="rounded-forge border p-2 text-center transition disabled:opacity-30"
                style={{
                  borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                  background: active ? "var(--btn-bg)" : "transparent",
                  boxShadow: active ? "0 0 10px var(--glow)" : "none",
                }}
              >
                <div className="text-[11px] text-fg-strong label-mono">{m.label}</div>
                <div className="mt-0.5 text-[11px] text-muted">{m.hint}</div>
              </button>
            );
          })}
        </div>

        {/* Control */}
        <div className="mt-3 flex items-center gap-3">
          {!recording ? (
            <button
              type="button"
              onClick={() => void start()}
              className="flex items-center gap-2 rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-5 py-2.5 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
            >
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#ff6b6b]" /> 録画開始
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="flex items-center gap-2 rounded-forge border border-[#ff6b6b66] bg-[rgba(255,107,107,0.1)] px-5 py-2.5 text-[11px] tracking-[0.16em] text-[#ff8888] label-mono"
            >
              <span className="inline-block h-2.5 w-2.5 bg-[#ff8888]" /> 停止
            </button>
          )}
          {recording && (
            <span className="flex items-center gap-2 text-[12px] text-fg-strong label-mono">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#ff6b6b]" />
              REC {fmtTime(elapsed)}
            </span>
          )}
        </div>

        {error && <p className="mt-2 text-[11px] leading-relaxed text-[#ff9b9b]">⚠ {error}</p>}
        {!screenSupported && (
          <p className="mt-2 text-[10px] leading-relaxed text-muted">※ 画面録画はPCの Chrome / Edge / Firefox で利用できます（スマホは音声のみ）。</p>
        )}
      </div>

      {/* Live preview while recording (screen modes) */}
      {recording && mode !== "mic" && (
        <div className="glass-silver p-2">
          <div className="mb-1 text-[9px] tracking-[0.2em] text-muted label-mono">LIVE PREVIEW</div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={previewRef} className="w-full rounded-forge border border-panel bg-black" playsInline />
        </div>
      )}

      {/* Result */}
      {result && !recording && (
        <div className="glass-silver p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] tracking-[0.2em] text-muted label-mono">録画結果 — {result.isVideo ? "VIDEO" : "AUDIO"} · {fmtSize(result.size)}</span>
            <button type="button" onClick={() => { if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current); setResult(null); }}
              className="text-[10px] text-muted transition hover:text-fg-strong label-mono">✕ 破棄</button>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          {result.isVideo
            ? <video src={result.url} controls className="w-full rounded-forge border border-panel bg-black" />
            : <audio src={result.url} controls className="w-full" />}
          <button
            type="button"
            onClick={download}
            className="mt-2 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow transition hover:shadow-glow-strong label-mono"
          >
            ⭳ ダウンロード（.webm）
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            ※ WebM形式で保存されます。MP4が必要な場合は、保存後に変換ツールをご利用ください。
          </p>
        </div>
      )}

      {/* ── AI文字起こし / ナレーション ── */}
      {result && !recording && (
        <div className="glass-silver p-3">
          <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">AI — 文字起こし / ナレーション</div>

          {!API_URL ? (
            <p className="text-[11px] leading-relaxed text-muted">
              文字起こしとナレーションはバックエンド接続後に使えます（DIAGNOSTICS参照）。
            </p>
          ) : (
            <>
              {/* 1) 文字起こし */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={() => void runTranscribe()}
                  disabled={!!busy || !caps?.transcribe}
                  title={caps?.transcribe ? "録音音声をAIで書き起こす"
                    : "サーバーの ffmpeg と、Geminiのキーか HuggingFace の文字起こしモデルが必要です"}
                  className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong disabled:opacity-40 label-mono">
                  {busy === "stt" ? "…" : "✎ AIで文字起こし"}
                </button>
                {caps && !caps.transcribe && (
                  <span className="text-[11px] text-muted">
                    {caps.ffmpeg
                      ? "Geminiのキー、または 設定 →「つなぐ」で文字起こしモデルの割り当てが必要です"
                      : "サーバーに ffmpeg がありません"}
                  </span>
                )}
                {caps?.transcribe && caps.engines?.hf && caps.asr_model && (
                  <span className="text-[9px] text-muted label-mono">
                    via {caps.asr_model.split("/").pop()}
                  </span>
                )}
                {liveText && !transcript && (
                  <span className="text-[11px] text-muted">下書き（ブラウザの音声認識）があります</span>
                )}
              </div>

              <textarea
                value={transcript || liveText}
                onChange={(e) => setTranscript(e.target.value)}
                rows={4}
                aria-label="文字起こし"
                placeholder="ここに文字起こしが入ります（手で直せます。素材メモを直接書いてもOK）"
                className="mt-2 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-[12px] leading-relaxed text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
              />
              {(transcript || liveText) && (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[9px] text-muted label-mono">{(transcript || liveText).length}字</span>
                  <button type="button"
                    onClick={() => downloadText(`${stamp()}_transcript.txt`, transcript || liveText)}
                    className="text-[9px] text-muted transition hover:text-fg-strong label-mono">⭳ .txt</button>
                </div>
              )}

              {/* 2) ナレーション台本 */}
              <div className="mt-3 border-t border-panel pt-2">
                <div className="mb-1 text-[9px] tracking-[0.16em] text-muted label-mono">読み口</div>
                <div className="flex flex-wrap gap-1">
                  {(caps?.styles ?? [{ key: "explain", label: "解説口調" }]).map((st) => (
                    <button key={st.key} type="button" onClick={() => setStyle(st.key)}
                      aria-pressed={style === st.key} title={st.label}
                      className="rounded-full border px-2.5 py-1 text-[10px] label-mono"
                      style={{
                        borderColor: style === st.key ? "var(--accent)" : "var(--panel-bd)",
                        color: style === st.key ? "var(--fg-strong)" : "var(--muted)",
                      }}>
                      {st.label.slice(0, 12)}
                    </button>
                  ))}
                </div>
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  aria-label="ナレーションへの追加指示"
                  placeholder="追加の指示（例：専門用語を避けて / 冒頭で結論を言って）"
                  className="mt-1.5 w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-1.5 text-[11px] text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
                />
                <button type="button" onClick={() => void runScript()} disabled={!!busy}
                  className="mt-1.5 w-full rounded-forge border border-panel py-1.5 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">
                  {busy === "script" ? "…" : "▤ ナレーション台本を作る"}
                </button>

                {script && (
                  <>
                    <textarea
                      value={script}
                      onChange={(e) => setScript(e.target.value)}
                      rows={5}
                      aria-label="ナレーション台本"
                      className="mt-2 w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-[12px] leading-relaxed text-fg-strong focus:border-[var(--line)] focus:outline-none"
                    />
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-[9px] text-muted label-mono">
                        {script.length}字 · 読み上げ約{Math.round(script.length / 5.5)}秒
                        {result.seconds ? ` / 録画 ${result.seconds}秒` : ""}
                      </span>
                      <button type="button" onClick={() => downloadText(`${stamp()}_narration.txt`, script)}
                        className="text-[9px] text-muted transition hover:text-fg-strong label-mono">⭳ .txt</button>
                    </div>

                    {/* 3) 吹き込み（画面録画のみ） */}
                    {result.isVideo && (
                      <div className="mt-2">
                        <label className="flex cursor-pointer items-center gap-2">
                          <input type="checkbox" checked={keepOriginal}
                            onChange={(e) => setKeepOriginal(e.target.checked)}
                            className="accent-[var(--accent)]" />
                          <span className="text-[10px] text-muted">元の音を小さく残して重ねる</span>
                        </label>
                        <button type="button" onClick={() => void runVoiceover()}
                          disabled={!!busy || !caps?.voiceover}
                          title={caps?.voiceover ? "台本を読み上げて録画に重ねる" : "サーバーの ffmpeg が必要です"}
                          className="mt-1.5 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.12em] text-fg-strong disabled:opacity-40 label-mono">
                          {busy === "mix" ? "…" : "▶ ナレーションを重ねて書き出す（MP4）"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {note && (
                <p className="mt-2 text-[10px] leading-relaxed"
                  style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>
                  {note}
                </p>
              )}

              {/* 合成結果 */}
              {narrated && (
                <div className="mt-2 rounded-forge border border-panel p-2">
                  <div className="mb-1 text-[9px] tracking-[0.16em] text-muted label-mono">ナレーション入り</div>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video src={narrated} controls className="w-full rounded-forge bg-black" />
                  <a href={narrated} download={`${stamp()}_narrated.mp4`}
                    className="mt-1.5 inline-block rounded-md border border-panel px-2.5 py-1 text-[10px] tracking-[0.12em] text-fg-strong transition hover:border-[var(--line)] label-mono">
                    ⭳ .mp4
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** ファイル名用の時刻（重複しない名前にする）。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function RecIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}
