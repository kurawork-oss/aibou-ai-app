"use client";

/**
 * Pet — 相棒の姿。いま何をしているかを、動きと一言で見せる（lib/pets.ts）。
 *
 * 置き場所は2つ。どちらも**浮かせずに**列の中に並べる（このアプリでは、
 * 画面に貼り付けた物が切り替えや入力欄に重なって押せなくなったことが
 * 何度かある。列に並べれば、重なりようがない）。
 *
 *   会話 … 入力欄の上の列の右端（Chat の petSlot）
 *   画面 … 「← 会話に戻る」の列の右端（会話が隠れている間も、様子が見える）
 *
 * 押すと「動いていること」の一覧が出る（会話・カメラ操作・拍手・サーバーの
 * 承認待ちとゴール）。ペットを変える・隠すも、ここから。
 *
 * 見た目だけの物なので、会話の邪魔をしない: ふきだしは押せない・待機中は
 * 何も言わない・スマホではふきだしを出さない（上の列に状態の文字がある）。
 * 動きを減らす設定（OS の「視差効果を減らす」）のときは、止まった絵にする。
 */

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import type { CoreState } from "@/lib/coreState";
import type { ActionTarget } from "@/lib/chatActions";
import {
  PETS, PET_OFF, closePetPicker, moodOf, openPetPicker, petById, petSays, usePet, writePet,
  type PetKind, type PetMood,
} from "@/lib/pets";
import {
  stopCameraControl, useCameraControlRunning, useClapStatus, useClapToggleEnabled,
} from "@/lib/cameraControl";
import { API_URL, approvalsWaiting, autopilotList, type Mission } from "@/lib/api";

/** 押したときの説明（ふきだしより長い）。 */
function moodDetail(state: CoreState): string {
  switch (state) {
    case "waiting_user": return "取り消せない操作の前で、あなたの確認を待っています。会話の「実行する」か「やめる」を押してください。";
    case "setup_required": return "サービスとつながないと進めません。会話のボタンから、つなげます。";
    case "error": return "うまくいきませんでした。会話の「再生成」か、言い方を変えて頼んでみてください。";
    case "completed": return "頼まれたことが終わりました。";
    case "thinking": case "planning": return "どう進めるか考えています。";
    case "working": return "手を動かしています（作る・調べる・送る）。";
    case "speaking": return "返事を読み上げています。";
    case "listening": return "あなたの声を聞いています。";
    default: return "なんでも頼んでください。";
  }
}

const TONE: Record<PetMood, string> = {
  idle: "var(--panel-bd)",
  listening: "var(--accent)",
  running: "var(--accent)",
  needs_input: "#ffb347",
  ready: "var(--accent)",
  blocked: "#ff9d9d",
};

/** ペットの絵。mood で表情と小物が変わる（動きは globals.css の .pet-*）。 */
export function PetArt({ kind, mood, size, className = "", still = false }: {
  kind: PetKind; mood: PetMood;
  /** 大きさ（px）。無ければ className で決める（画面の幅で変えたいとき）。 */
  size?: number; className?: string; still?: boolean;
}) {
  const mouth = {
    idle: "M29 41 Q32 43.5 35 41",
    listening: "M30 41.5 Q32 42.5 34 41.5",
    running: "M30 41 Q32 43.6 34 41",
    needs_input: "M30 40.5 Q32 45 34 40.5 Z",
    ready: "M28 40.5 Q32 46 36 40.5",
    blocked: "M29 43 Q32 40.5 35 43",
  }[mood];
  const ink = "#2b2b33";
  return (
    <svg
      width={size} height={size} viewBox="0 0 64 64"
      className={`pet-art ${className}${still ? " pet-still" : ""}`} data-mood={mood} aria-hidden
    >
      <ellipse cx="32" cy="58" rx="15" ry="3" fill="rgba(0,0,0,0.3)" className="pet-shadow" />
      <g className="pet-body">
        {kind.shape === "mochi" && (
          <>
            <ellipse cx="32" cy="40" rx="21" ry="16" fill={kind.body} />
            <ellipse cx="32" cy="50" rx="18" ry="5" fill={kind.shade} opacity="0.55" />
            <ellipse cx="24" cy="30" rx="5" ry="2.5" fill="#ffffff" opacity="0.75" />
          </>
        )}
        {kind.shape === "dog" && (
          <>
            <ellipse cx="15.5" cy="33" rx="5.5" ry="10" fill={kind.shade} transform="rotate(14 15.5 33)" />
            <ellipse cx="48.5" cy="33" rx="5.5" ry="10" fill={kind.shade} transform="rotate(-14 48.5 33)" />
            <circle cx="32" cy="37" r="17" fill={kind.body} />
            <ellipse cx="32" cy="44" rx="8" ry="5.5" fill="#fff4e2" />
            <ellipse cx="32" cy="40.2" rx="2.3" ry="1.7" fill="#3a2b22" />
          </>
        )}
        {kind.shape === "cat" && (
          <>
            <path d="M17 29 L19 12 L29 22 Z" fill={kind.body} />
            <path d="M47 29 L45 12 L35 22 Z" fill={kind.body} />
            <path d="M19.8 25 L20.8 16.5 L26 21.6 Z" fill={kind.cheek} opacity="0.6" />
            <path d="M44.2 25 L43.2 16.5 L38 21.6 Z" fill={kind.cheek} opacity="0.6" />
            <circle cx="32" cy="37" r="17" fill={kind.body} />
            <path d="M15 40 L23 41 M15 44 L23 43 M49 40 L41 41 M49 44 L41 43"
              stroke={kind.shade} strokeWidth="1.2" strokeLinecap="round" />
          </>
        )}
        {kind.shape === "chick" && (
          <>
            <path d="M31 19 Q28.5 12.5 33 13.5 Q31.5 16 35.5 14.5 Q34.5 18.5 32.5 19.5 Z" fill={kind.shade} />
            <ellipse cx="17" cy="42" rx="4" ry="7" fill={kind.shade} transform="rotate(20 17 42)" />
            <ellipse cx="47" cy="42" rx="4" ry="7" fill={kind.shade} transform="rotate(-20 47 42)" />
            <circle cx="32" cy="37" r="18" fill={kind.body} />
          </>
        )}
        {kind.shape === "bot" && (
          <>
            <line x1="32" y1="20" x2="32" y2="12" stroke={kind.shade} strokeWidth="2" />
            <circle cx="32" cy="11" r="3" fill={kind.cheek} className="pet-antenna" />
            <rect x="13" y="20" width="38" height="32" rx="9" fill={kind.body} />
            <rect x="18" y="26" width="28" height="20" rx="6" fill="#16303a" />
          </>
        )}

        {/* 顔 */}
        {kind.shape === "bot" ? (
          <g className="pet-face">
            <rect x="24.5" y="31.5" width="4" height="5" rx="1.5" fill={kind.cheek} className="pet-eye" />
            <rect x="35.5" y="31.5" width="4" height="5" rx="1.5" fill={kind.cheek} className="pet-eye" />
            <path d={mouth} stroke={kind.cheek} strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </g>
        ) : (
          <g className="pet-face">
            {mood === "ready" ? (
              <>
                {/* うれしい目（にっこり） */}
                <path d="M23.5 35.5 Q26 32 28.5 35.5" stroke={ink} strokeWidth="1.8" fill="none" strokeLinecap="round" />
                <path d="M35.5 35.5 Q38 32 40.5 35.5" stroke={ink} strokeWidth="1.8" fill="none" strokeLinecap="round" />
              </>
            ) : (
              <>
                <ellipse cx="26" cy="35" rx="2.2" ry="3" fill={ink} className="pet-eye" />
                <ellipse cx="38" cy="35" rx="2.2" ry="3" fill={ink} className="pet-eye" />
              </>
            )}
            {kind.shape === "chick" ? (
              <path d="M29.5 40 L34.5 40 L32 43.5 Z" fill="#ff8c3a" />
            ) : (
              <path d={mouth} stroke={ink} strokeWidth="1.5"
                fill={mood === "needs_input" ? ink : "none"} strokeLinecap="round" />
            )}
            <circle cx="21" cy="40.5" r="2.6" fill={kind.cheek} opacity="0.55" />
            <circle cx="43" cy="40.5" r="2.6" fill={kind.cheek} opacity="0.55" />
          </g>
        )}
      </g>

      {/* 小物: 作業中の点・確認待ちの「！」・できたの「✓」・困ったの「？」 */}
      {mood === "running" && (
        <g className="pet-dots" fill="var(--accent)">
          <circle cx="46" cy="9" r="2.6" /><circle cx="53" cy="9" r="2.6" /><circle cx="60" cy="9" r="2.6" />
        </g>
      )}
      {mood === "needs_input" && (
        <g className="pet-mark">
          <circle cx="54" cy="11" r="9.5" fill="#ffb347" />
          <text x="54" y="16.5" fontSize="15" fontWeight="800" fill="#1a1205" textAnchor="middle">!</text>
        </g>
      )}
      {mood === "ready" && (
        <g className="pet-mark">
          <circle cx="54" cy="11" r="9.5" fill="var(--accent)" />
          <path d="M49.5 11 L53 14.5 L58.5 7.5" stroke="#06121a" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
      {mood === "blocked" && (
        <g className="pet-mark">
          <circle cx="54" cy="11" r="9.5" fill="#ff9d9d" />
          <text x="54" y="16" fontSize="14" fontWeight="800" fill="#2a0b0b" textAnchor="middle">?</text>
        </g>
      )}
    </svg>
  );
}

interface Row {
  key: string;
  title: string;
  detail: string;
  tone?: string;
  act?: { label: string; run: () => void };
}

/** 「動いていること」。会話・カメラ・拍手は手元で分かる。サーバーの分は、開いたときに1回だけ聞く。 */
function Activity({ state, onShowChat, onOpen, close }: {
  state: CoreState;
  onShowChat?: () => void;
  onOpen?: (t: ActionTarget) => void;
  close: () => void;
}) {
  const camera = useCameraControlRunning();
  const clapOn = useClapToggleEnabled();
  const clap = useClapStatus();
  const [remote, setRemote] = useState<{ approvals: number; missions: Mission[] } | null>(null);

  useEffect(() => {
    if (!API_URL) return;
    let alive = true;
    void Promise.allSettled([approvalsWaiting(), autopilotList()]).then(([a, m]) => {
      if (!alive) return;
      setRemote({
        approvals: a.status === "fulfilled" ? a.value : 0,
        missions: m.status === "fulfilled" ? m.value.filter((x) => x.status === "active") : [],
      });
    });
    return () => { alive = false; };
  }, []);

  const mood = moodOf(state);
  const go = (t: ActionTarget) => () => { close(); onOpen?.(t); };
  const rows: Row[] = [{
    key: "chat",
    title: `会話: ${petSays(state) || "待機中"}`,
    detail: moodDetail(state),
    tone: mood === "idle" ? undefined : TONE[mood],
    act: onShowChat ? { label: "会話を見る", run: () => { close(); onShowChat(); } } : undefined,
  }];
  if (camera) {
    rows.push({
      key: "camera", title: "カメラ操作: 動いています", detail: "手のカーソルで操作できます。",
      act: { label: "止める", run: () => { stopCameraControl(); } },
    });
  }
  if (clapOn) {
    rows.push({
      key: "clap",
      title: clap.state === "error" ? "拍手: 聞けません" : "拍手: 聞いています",
      detail: clap.state === "error" ? clap.message
        : clap.state === "starting" ? "マイクを準備しています。"
          : "パンパンと2回たたくと、カメラ操作を始める・止める。",
      tone: clap.state === "error" ? TONE.blocked : undefined,
    });
  }
  if (remote && remote.approvals > 0) {
    rows.push({
      key: "approvals", title: `承認待ち: ${remote.approvals}件`,
      detail: "取り消せない操作が、あなたの返事を待っています。",
      tone: TONE.needs_input,
      act: onOpen ? { label: "見る", run: go({ kind: "view", view: "board" }) } : undefined,
    });
  }
  for (const m of remote?.missions.slice(0, 3) ?? []) {
    const done = m.steps.filter((s) => s.status === "done").length;
    rows.push({
      key: `mission-${m.id}`, title: `ゴール: ${m.goal}`,
      detail: m.steps.length ? `${done}/${m.steps.length} 手順まで進んでいます。` : "段取りを組んでいます。",
      act: onOpen ? { label: "見る", run: go({ kind: "view", view: "autopilot" }) } : undefined,
    });
  }

  return (
    <div>
      <div className="mb-1.5 text-[10px] tracking-[0.18em] text-muted label-mono">動いていること</div>
      <ul className="space-y-1.5" data-pet-activity>
        {rows.map((r) => (
          <li key={r.key} data-activity={r.key}
            className="rounded-forge border p-2"
            style={{ borderColor: r.tone ?? "var(--panel-bd)" }}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="break-words text-[12px] text-fg-strong">{r.title}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-muted">{r.detail}</div>
              </div>
              {r.act && (
                <button type="button" onClick={r.act.run}
                  className="min-h-[44px] shrink-0 rounded-forge border px-3 text-[12px] text-fg-strong"
                  style={{ borderColor: "var(--line)", background: "var(--btn-bg)" }}>
                  {r.act.label}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {rows.length === 1 && (
        <p className="mt-1.5 text-[11px] text-muted">
          {API_URL && !remote ? "サーバーの作業を確かめています…" : "ほかに動いているものはありません。"}
        </p>
      )}
    </div>
  );
}

export default function Pet({ state, placement = "up", onShowChat, onOpen }: {
  state: CoreState;
  /** 押したときの一覧を、上に開くか下に開くか。 */
  placement?: "up" | "down";
  /** 会話が隠れているとき、会話へ戻す。 */
  onShowChat?: () => void;
  /** 一覧から画面を開く（承認待ち・ゴール）。 */
  onOpen?: (t: ActionTarget) => void;
}) {
  const petId = usePet();
  const reduce = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    // 中の一覧だけ閉じる（外の画面まで閉じない）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (petId === PET_OFF) return null;
  const kind = petById(petId) ?? PETS[0];
  const mood = moodOf(state);
  const says = petSays(state);

  return (
    <div
      ref={boxRef}
      data-pet={kind.id}
      data-pet-mood={mood}
      data-pet-state={state}
      className="relative flex items-center gap-1"
    >
      {/* ふきだし。押せない。スマホでは出さない（上の列に状態の文字がある） */}
      {says && (
        <span
          data-pet-says
          className="pointer-events-none hidden whitespace-nowrap rounded-full border bg-[var(--chrome)] px-2 py-0.5 text-[11px] text-fg-strong backdrop-blur-md sm:inline-flex"
          style={{ borderColor: TONE[mood] }}
        >
          {says}
        </span>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`ペットの${kind.name}（${says || "待機中"}）`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${kind.name}: ${says || "待機中"}`}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full transition hover:bg-white/5 sm:h-12 sm:w-12"
      >
        {/* 並ぶ列（会話の切り替え・「会話に戻る」）が 44px あるので、列は高くならない */}
        <PetArt kind={kind} mood={mood} className="h-10 w-10 sm:h-12 sm:w-12" still={reduce} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`${kind.name}のようす`}
          className={`panel absolute right-0 z-[60] w-[min(300px,calc(100vw-2rem))] p-3 ${
            placement === "up" ? "bottom-full mb-2" : "top-full mt-2"}`}
          style={{ background: "#0d1016" }}
        >
          <div className="mb-2 flex items-center gap-2">
            <PetArt kind={kind} mood={mood} size={32} still />
            <div className="min-w-0 flex-1 text-[13px] text-fg-strong">{kind.name}</div>
            <button type="button" onClick={() => { setOpen(false); openPetPicker(); }}
              className="min-h-[44px] rounded-forge border border-panel px-3 text-[12px] text-fg-strong">
              変える
            </button>
            <button type="button" onClick={() => { setOpen(false); writePet(PET_OFF); }}
              className="min-h-[44px] rounded-forge border border-panel px-3 text-[12px] text-muted">
              隠す
            </button>
          </div>
          <Activity state={state} onShowChat={onShowChat} onOpen={onOpen} close={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** ペットを選ぶ窓。会話の「＋」・「ペット変えて」・ペットの「変える」から開く。 */
export function PetPicker() {
  const current = usePet();
  const reduce = useReducedMotion() ?? false;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closePetPicker(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const pick = (id: string) => { writePet(id); closePetPicker(); };
  return (
    <div
      className="fixed inset-0 z-[65] flex items-end justify-center bg-black/50 p-3 sm:items-center"
      onPointerDown={(e) => { if (e.target === e.currentTarget) closePetPicker(); }}
    >
      <div role="dialog" aria-modal="true" aria-label="ペットを選ぶ"
        className="panel max-h-[90dvh] w-full max-w-md overflow-y-auto p-4" style={{ background: "#0d1016" }}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[14px] text-fg-strong">ペットを選ぶ</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              作業の様子を、動きで見せる相棒です。考え中・確認待ち・できた・困った、が
              ひと目で分かります。見た目だけで、仕事のやり方は変わりません。
            </p>
          </div>
          <button type="button" onClick={closePetPicker} aria-label="閉じる"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-forge text-muted hover:text-fg-strong">
            ✕
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="ペット">
          {PETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={current === p.id}
              aria-label={`${p.name}（${p.about}）`}
              data-pet-choice={p.id}
              onClick={() => pick(p.id)}
              className="flex min-h-[44px] flex-col items-center rounded-forge border p-2 transition"
              style={{
                borderColor: current === p.id ? "var(--accent)" : "var(--panel-bd)",
                background: current === p.id ? "var(--btn-bg)" : "transparent",
              }}>
              <PetArt kind={p} mood={current === p.id ? "ready" : "idle"} size={52} still={reduce} />
              <span className="mt-1 text-[12px] text-fg-strong">{p.name}</span>
              <span className="text-[10px] leading-tight text-muted">{p.about}</span>
            </button>
          ))}
          <button type="button" role="radio" aria-checked={current === PET_OFF}
            data-pet-choice={PET_OFF}
            onClick={() => pick(PET_OFF)}
            className="flex min-h-[44px] flex-col items-center justify-center rounded-forge border p-2 text-[12px] text-muted"
            style={{ borderColor: current === PET_OFF ? "var(--accent)" : "var(--panel-bd)" }}>
            表示しない
          </button>
        </div>
      </div>
    </div>
  );
}
