"use client";

/**
 * 設定 →「基本」の「カメラで操作」。
 *
 * ここで、始める・止める・顔を登録する・確かめる、が全部できる。
 * 顔の登録は、その場で小さく映像を出して「いま何が足りないか」
 * （顔が見えない・横を向いている・2人映っている）を言いながら撮る。
 * 黙って失敗させない。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailability, cameraErrorMessage, clearFaceProfile, DEFAULT_CAMERA_PREFS,
  readCameraPrefs, readFaceProfile, resetTutorial, startCameraControl, stopCameraControl,
  subscribeCameraStore, useCameraControlRunning, writeCameraPrefs, writeFaceProfile,
  type CameraPrefs,
} from "@/lib/cameraControl";
import {
  bestSimilarity, ENROLL_SAMPLES, isFrontal, samplesConsistent, STRICTNESS, type Strictness,
} from "@/lib/faceMatch";
import { CLICK_MODES, GESTURE_HELP, SPEEDS, type ClickMode, type Speed } from "@/lib/handGesture";
import { attachStream, detect, loadVision, MODEL_DOWNLOAD_MB, openCamera, stopStream } from "@/lib/vision";

type Session = "idle" | "enroll" | "test";
type Outcome = { ok: boolean; text: string } | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function CameraSettings({ onStart }: { onStart?: () => void }) {
  const running = useCameraControlRunning();
  const [prefs, setPrefs] = useState<CameraPrefs>(DEFAULT_CAMERA_PREFS);
  const [registeredAt, setRegisteredAt] = useState<number | null>(null);
  const [avail, setAvail] = useState<ReturnType<typeof cameraAvailability> | null>(null);

  const refresh = useCallback(() => {
    setPrefs(readCameraPrefs());
    setRegisteredAt(readFaceProfile()?.at ?? null);
  }, []);
  useEffect(() => {
    refresh();
    setAvail(cameraAvailability());
    return subscribeCameraStore(refresh);
  }, [refresh]);

  const update = (patch: Partial<CameraPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writeCameraPrefs(next);
  };

  const canUse = avail?.ok === true;
  const registered = registeredAt !== null;

  return (
    <section className="mt-5" aria-label="カメラで操作">
      <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">カメラで操作（顔と手）</div>
      <p className="text-[12px] leading-relaxed text-fg">
        パソコンのカメラで手の形を読み取って、マウスの代わりにこのアプリを操作します。
        顔を登録しておくと、<b className="text-fg-strong">登録した人が映っている間だけ</b>動きます。
      </p>
      {avail && !avail.ok && (
        <p className="mt-1 text-[11px] leading-relaxed" style={{ color: "#ffb347" }}>{avail.reason}</p>
      )}

      <button
        type="button"
        disabled={!canUse}
        onClick={() => {
          if (running) { stopCameraControl(); return; }
          startCameraControl();
          onStart?.();
        }}
        className="mt-2 w-full rounded-forge border py-2.5 text-[11px] tracking-[0.12em] text-fg-strong transition label-mono disabled:opacity-40"
        style={{ borderColor: running ? "rgba(255,157,157,0.5)" : "var(--accent)", background: "var(--btn-bg)" }}
      >
        {running ? "■ カメラ操作を止める" : "▶ カメラ操作を始める"}
      </button>
      {!registered && canUse && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          顔を登録していないので、いまは誰の手でも動きます。下で登録できます。
        </p>
      )}

      <div className="mt-3 space-y-3">
        <Choice
          label="押し方"
          value={prefs.clickMode}
          options={(Object.keys(CLICK_MODES) as ClickMode[]).map((k) => ({ value: k, label: CLICK_MODES[k].label }))}
          onChange={(v) => update({ clickMode: v })}
          note="「両方」なら、ボタンの上で1秒止めても、つまんでも押せます。つまむのが難しければ「止めるだけ」に。"
        />
        <Choice
          label="カーソルの速さ"
          value={prefs.speed}
          options={(Object.keys(SPEEDS) as Speed[]).map((k) => ({ value: k, label: SPEEDS[k].label }))}
          onChange={(v) => update({ speed: v })}
          note="画面の端まで届かないなら「はやい」、行き過ぎるなら「ゆっくり」に。"
        />
        <button
          type="button"
          disabled={!canUse}
          onClick={() => {
            resetTutorial();
            if (running) stopCameraControl();
            startCameraControl();
            onStart?.();
          }}
          className="w-full rounded-forge border border-panel py-2 text-[11px] text-fg-strong disabled:opacity-40"
        >
          練習しながら始める（手を映す → 合わせる → 押す → スクロール → 閉じる）
        </button>
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-muted">手の形と動き</summary>
        <ul className="mt-1.5 space-y-1" aria-label="手の形と動き">
          {GESTURE_HELP.map((g) => (
            <li key={g.pose} className="flex gap-2 text-[11px] leading-snug">
              <span className="w-5 shrink-0 text-center" aria-hidden>{g.mark}</span>
              <span className="text-muted">{g.how} → <span className="text-fg">{g.does}</span></span>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          文字は打てないので、会話の🎤（声で入力）と組み合わせてください。
          カメラから50cm〜1mほど離れ、手のひらをカメラに向けると読み取りやすくなります。
          画面の行き来は、カーソルで下（または上）のボタンを押します。
        </p>
      </details>

      <FaceSection prefs={prefs} registeredAt={registeredAt} canUse={canUse} running={running} />

      <div className="mt-3 space-y-2">
        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" checked={prefs.requireFace}
            onChange={(e) => update({ requireFace: e.target.checked })}
            className="mt-0.5 accent-[var(--accent)]" />
          <span className="text-[12px] leading-relaxed text-fg">
            登録した顔が映っている間だけ、手で操作できるようにする
            <span className="block text-[11px] text-muted">
              {registered ? "顔が5秒見えないと止まり、戻ると自動で再開します。" : "顔を登録すると効きます。"}
            </span>
          </span>
        </label>

        <div>
          <div className="mb-1 text-[11px] text-muted">本人と判定する厳しさ</div>
          <Segments
            label="本人と判定する厳しさ"
            value={prefs.strictness}
            options={(Object.keys(STRICTNESS) as Strictness[]).map((k) => ({ value: k, label: STRICTNESS[k].label }))}
            onChange={(v) => update({ strictness: v })}
          />
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            本人なのに止まるなら「ゆるめ」に。「確かめる」で実際の値が見られます。
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" checked={prefs.antiSpoof}
            onChange={(e) => update({ antiSpoof: e.target.checked })}
            className="mt-0.5 accent-[var(--accent)]" />
          <span className="text-[12px] leading-relaxed text-fg">
            写真や画面に映した顔を弾く（試験的）
            <span className="block text-[11px] text-muted">
              暗い所などで本人が弾かれることがあります。部品が約1.5MB増えます。
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" checked={prefs.preview}
            onChange={(e) => update({ preview: e.target.checked })}
            className="mt-0.5 accent-[var(--accent)]" />
          <span className="text-[12px] leading-relaxed text-fg">操作中、右上の小窓にカメラの映像を出す</span>
        </label>
        {running && (
          <p className="text-[11px] text-muted">変えた設定は、次に始めたときから効きます。</p>
        )}
      </div>

      <ul className="mt-3 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted">
        <li>映像はこの端末の中だけで読み取り、保存も送信もしません。</li>
        <li>顔の特徴（数値）は、この端末にだけ保存します。サーバーにも、記憶の同期にも乗せません。</li>
        <li>認識の部品（約{MODEL_DOWNLOAD_MB}MB）は、初回だけ無料の配信元（jsDelivr）から取得してブラウザに残します。料金はかかりません。</li>
        <li>
          <b className="text-fg">顔の確認はログインの代わりではありません。</b>
          ブラウザの中での確認なので、写真などでだませることがあります。
          データはこれまでどおり、ログインとサーバー側の権限で守られています。
        </li>
        <li>承認のボタン（「実行する」「承認して実行」「いつも許可」など）は、誤って通さないよう手では押せません。</li>
      </ul>
    </section>
  );
}

/** 3つから1つ選ぶ（押し方・速さ・厳しさ）。 */
function Segments<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className="rounded-forge border px-2 py-1.5 text-[11px] transition"
          style={{
            borderColor: value === o.value ? "var(--accent)" : "var(--panel-bd)",
            background: value === o.value ? "var(--btn-bg)" : "transparent",
            color: value === o.value ? "var(--fg-strong)" : "var(--muted)",
          }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Choice<T extends string>({ label, value, options, onChange, note }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; note?: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-muted">{label}</div>
      <Segments label={label} value={value} options={options} onChange={onChange} />
      {note && <p className="mt-1 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  );
}

function FaceSection({ prefs, registeredAt, canUse, running }: {
  prefs: CameraPrefs; registeredAt: number | null; canUse: boolean; running: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<Session>("idle");
  const [hint, setHint] = useState("");
  const [count, setCount] = useState(0);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const cancelRef = useRef<() => void>(() => {});

  // 設定を閉じたら、カメラも閉じる
  useEffect(() => () => cancelRef.current(), []);

  const run = async (kind: Exclude<Session, "idle">) => {
    const video = videoRef.current;
    if (!video) return;
    if (running) stopCameraControl(); // 同じカメラを2か所で読まない
    const profile = readFaceProfile();
    if (kind === "test" && !profile) return;

    let stopped = false;
    let stream: MediaStream | null = null;
    const close = () => { stopped = true; stopStream(stream); video.srcObject = null; };
    cancelRef.current = close;
    const finish = (o: Outcome) => { close(); setSession("idle"); setOutcome(o); };

    setOutcome(null);
    setCount(0);
    setSession(kind);
    setHint("カメラを開いています…");
    try {
      stream = await openCamera();
    } catch (e) {
      finish({ ok: false, text: cameraErrorMessage(e) });
      return;
    }
    if (stopped) { stopStream(stream); return; }
    await attachStream(video, stream);
    setHint(`認識の部品を読み込んでいます（初回だけ約${MODEL_DOWNLOAD_MB}MB）…`);
    try {
      await loadVision({ antiSpoof: prefs.antiSpoof });
    } catch {
      finish({ ok: false, text: "認識の部品を読み込めませんでした。ネットに繋がっているか確かめてください。" });
      return;
    }

    const samples: number[][] = [];
    const deadline = Date.now() + (kind === "enroll" ? 30_000 : 8_000);
    let lastSampleAt = 0;
    let best = 0;
    let looks = 0;
    setHint(kind === "enroll" ? "カメラの正面を見てください。" : "カメラを見てください。");

    while (!stopped && Date.now() < deadline) {
      let frame;
      try {
        frame = await detect(video, { hand: false, face: true, antiSpoof: prefs.antiSpoof });
      } catch {
        await sleep(200);
        continue;
      }
      if (stopped) return;
      const faces = frame.faces;
      const one = faces[0];
      if (faces.length === 0) setHint("顔が見えません。カメラの正面に顔を入れてください。");
      else if (faces.length > 1) setHint("1人だけ映るようにしてください。");
      else if (!one.embedding) setHint("顔の特徴が取れませんでした。明るい所で、少し近づいてください。");
      else if (kind === "enroll" && !isFrontal(one.yaw, one.pitch)) setHint("正面を向いてください。");
      else if (prefs.antiSpoof && ((one.real ?? 1) < 0.5 || (one.live ?? 1) < 0.5)) {
        setHint("写真や画面ではなく、本人を映してください。");
      } else if (kind === "enroll") {
        if (Date.now() - lastSampleAt >= 350) {
          samples.push(one.embedding);
          lastSampleAt = Date.now();
          setCount(samples.length);
          setHint("そのまま。少しだけ顔の角度を変えてください。");
        }
        if (samples.length >= ENROLL_SAMPLES) break;
      } else if (profile) {
        best = Math.max(best, bestSimilarity(one.embedding, profile.samples));
        if (++looks >= 4) break;
      }
      await sleep(120);
    }
    if (stopped) return;

    if (kind === "enroll") {
      if (samples.length < ENROLL_SAMPLES) {
        finish({ ok: false, text: "時間内に撮れませんでした。明るい所で、カメラの正面からもう一度どうぞ。" });
      } else if (!samplesConsistent(samples)) {
        finish({ ok: false, text: "途中で別の顔が映ったか、ぶれていました。1人だけで、もう一度どうぞ。" });
      } else if (!writeFaceProfile(samples)) {
        finish({ ok: false, text: "この端末に保存できませんでした（空き容量が足りない可能性があります）。" });
      } else {
        finish({ ok: true, text: "顔を登録しました（この端末にだけ保存）。「確かめる」で判定を試せます。" });
      }
      return;
    }
    if (looks === 0) { finish({ ok: false, text: "顔が見えませんでした。カメラの正面からもう一度どうぞ。" }); return; }
    const s = STRICTNESS[prefs.strictness];
    finish({
      ok: best >= s.threshold,
      text: `一致度 ${best.toFixed(2)}（基準 ${s.threshold.toFixed(2)}・${s.label}）→ ${best >= s.threshold ? "本人と判定" : "別人と判定"}`,
    });
  };

  const busy = session !== "idle";

  return (
    <div className="mt-3 rounded-forge border border-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-fg-strong">顔の登録</span>
        <span className="text-[11px] text-muted" data-face-registered={registeredAt !== null ? "1" : "0"}>
          {registeredAt !== null
            ? `登録済み（${new Date(registeredAt).toLocaleDateString("ja-JP")}・この端末だけ）`
            : "まだ登録していません"}
        </span>
      </div>

      {/* 映像の要素は常に置いておく（撮るときにすぐ流せるように）。撮っていない間は高さ0。 */}
      <div className="relative mt-2 overflow-hidden rounded-forge bg-black transition-[height] duration-200"
           style={{ height: busy ? 150 : 0 }}>
        <video ref={videoRef} muted playsInline aria-label="顔の登録用の映像"
          className="absolute inset-0 h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} />
      </div>
      {busy && (
        <div className="mt-1.5" role="status" aria-live="polite">
          <p className="text-[11px] leading-relaxed text-fg" data-face-hint>{hint}</p>
          {session === "enroll" && (
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)]"
                 aria-label={`${count} / ${ENROLL_SAMPLES} 枚`}>
              <div className="h-full rounded-full transition-[width] duration-200"
                   style={{ width: `${(count / ENROLL_SAMPLES) * 100}%`, background: "var(--accent)" }} />
            </div>
          )}
        </div>
      )}
      {outcome && (
        <p className="mt-1.5 text-[11px] leading-relaxed" role="status" data-face-outcome
           style={{ color: outcome.ok ? "var(--accent)" : "#ffb347" }}>
          {outcome.text}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {busy ? (
          <button type="button" onClick={() => { cancelRef.current(); setSession("idle"); }}
            className="rounded-forge border border-panel px-3 py-1.5 text-[11px] text-fg-strong">
            やめる
          </button>
        ) : (
          <>
            <button type="button" disabled={!canUse} onClick={() => void run("enroll")}
              className="rounded-forge border px-3 py-1.5 text-[11px] text-fg-strong disabled:opacity-40"
              style={{ borderColor: "var(--accent)", background: "var(--btn-bg)" }}>
              {registeredAt !== null ? "登録し直す" : "顔を登録する"}
            </button>
            {registeredAt !== null && (
              <>
                <button type="button" disabled={!canUse} onClick={() => void run("test")}
                  className="rounded-forge border border-panel px-3 py-1.5 text-[11px] text-fg-strong disabled:opacity-40">
                  確かめる
                </button>
                <button type="button"
                  onClick={() => {
                    if (!window.confirm("登録した顔をこの端末から消します。よろしいですか？")) return;
                    clearFaceProfile();
                    setOutcome({ ok: true, text: "登録した顔を消しました。" });
                  }}
                  className="rounded-forge border border-panel px-3 py-1.5 text-[11px] text-muted">
                  登録を消す
                </button>
              </>
            )}
          </>
        )}
      </div>
      {running && !busy && (
        <p className="mt-1 text-[11px] text-muted">登録・確認を始めると、カメラ操作はいったん止まります。</p>
      )}
    </div>
  );
}
