"use client";

/**
 * Guide — アプリの説明書。
 *
 * 縦に全部並べると、初回設定・各画面の使い方・データの扱いが一続きの長い
 * 巻物になり、読む気を失う。用途で4つに分け、いま知りたいところだけを
 * 出す:
 *   はじめる     … 初回設定。1つずつ開く。どこまで済んだかを覚えておく
 *   画面の使い方 … 全モード。一覧から選んで詳細を見る
 *   できること   … 読みもの（秘書としての使い方など）
 *   データと安全 … プライバシーと利用について
 *
 * 手順と用語の説明はフロント側（lib/setup.ts）が持つ。まだ何も繋がって
 * いない人が読むものなので、繋がらないと読めない場所には置けない。
 * 各画面の説明と写真だけはバックエンドから来る（CHATの回答と同じ出どころ）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { API_URL, guideGet, type GuideDoc, type GuideMode } from "@/lib/api";
import { PolicyBody } from "@/components/Policy";
import { GLOSSARY, SETUP_STEPS, type SetupStep } from "@/lib/setup";

type Tab = "start" | "modes" | "can" | "data";

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "start", label: "はじめる", hint: "初回設定" },
  { key: "modes", label: "画面の使い方", hint: "全画面" },
  { key: "can", label: "できること", hint: "使い方の例" },
  { key: "data", label: "データと安全", hint: "保存先・規約" },
];

const LS_TAB = "forge_guide_tab";
const LS_DONE = "forge_guide_done";      // 済ませた手順のid

export default function Guide() {
  const [doc, setDoc] = useState<GuideDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState<GuideMode | null>(null);
  const [tab, setTab] = useState<Tab>("start");
  const [detail, setDetail] = useState<GuideMode | null>(null);

  // どこまで済んだかを覚えておく。設定は数日に分けてやる人もいる。
  const [done, setDone] = useState<string[]>([]);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const t = localStorage.getItem(LS_TAB) as Tab | null;
      if (t && TABS.some((x) => x.key === t)) setTab(t);
      const d = JSON.parse(localStorage.getItem(LS_DONE) || "[]");
      if (Array.isArray(d)) setDone(d.filter((x) => typeof x === "string"));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LS_TAB, tab); } catch { /* ignore */ }
  }, [tab]);

  // 最初に開くのは「まだ済んでいない最初の手順」
  useEffect(() => {
    if (openStep !== null) return;
    const next = SETUP_STEPS.find((s) => !done.includes(s.id));
    setOpenStep(next ? next.id : SETUP_STEPS[0].id);
  }, [done, openStep]);

  useEffect(() => {
    if (!API_URL) { setLoading(false); return; }
    guideGet()
      .then(setDoc)
      .catch(() => setErr("各画面の説明を取得できませんでした（バックエンド未接続）"))
      .finally(() => setLoading(false));
  }, []);

  const toggleDone = useCallback((id: string) => {
    setDone((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try { localStorage.setItem(LS_DONE, JSON.stringify(next)); } catch { /* ignore */ }
      // 済ませたら次の未了へ自動で進む（毎回たたむ手間をなくす）
      if (!prev.includes(id)) {
        const rest = SETUP_STEPS.find((s) => s.id !== id && !next.includes(s.id));
        setOpenStep(rest ? rest.id : null);
      }
      return next;
    });
  }, []);

  const doneCount = SETUP_STEPS.filter((s) => done.includes(s.id)).length;
  const modes = doc?.modes ?? [];

  const go = (t: Tab) => {
    setTab(t);
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div ref={topRef} className="mx-auto w-full max-w-3xl pb-6">
      <div className="mb-3 text-center">
        <h2 className="brand-wordmark text-[20px] text-fg-strong">
          {doc?.app ?? "AIbou"} の説明書
        </h2>
        <p className="mt-1 text-[11px] text-muted">
          はじめての人は「はじめる」から。困ったら CHAT で「使い方教えて」と聞いてもOKです。
        </p>
      </div>

      {/* タブ — 用途で分ける。全部を一度に見せない */}
      <div role="tablist" aria-label="説明書の章"
           className="mb-3 grid grid-cols-4 gap-1.5">
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={on}
              type="button"
              onClick={() => go(t.key)}
              className="rounded-forge border px-1 py-2 transition"
              style={{
                borderColor: on ? "var(--accent)" : "var(--panel-bd)",
                background: on ? "var(--btn-bg)" : "transparent",
              }}
            >
              <span className="block text-[11px] leading-tight"
                    style={{ color: on ? "var(--fg-strong)" : "var(--fg)" }}>
                {t.label}
              </span>
              <span className="mt-0.5 block text-[11px] leading-tight text-muted">{t.hint}</span>
            </button>
          );
        })}
      </div>

      {/* ── はじめる ─────────────────────────────────────────── */}
      {tab === "start" && (
        <div className="grid gap-3">
          <section className="panel p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[13px] text-fg-strong">はじめる手順</h3>
              <span className="text-[11px] text-muted">
                {doneCount} / {SETUP_STEPS.length} 完了
              </span>
            </div>
            {/* 進み具合。残りが見えると途中でやめにくい */}
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full"
                 style={{ background: "var(--panel-bd)" }}
                 role="progressbar" aria-valuenow={doneCount}
                 aria-valuemin={0} aria-valuemax={SETUP_STEPS.length}>
              <div className="h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none"
                   style={{
                     width: `${(doneCount / SETUP_STEPS.length) * 100}%`,
                     background: "var(--accent)",
                   }} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              全部で15分ほどです。途中でやめても、開いたときに続きから出ます。
              一度やれば、次からは不要です。
            </p>
          </section>

          <div className="grid gap-2">
            {SETUP_STEPS.map((s) => (
              <StepCard
                key={s.id}
                step={s}
                done={done.includes(s.id)}
                open={openStep === s.id}
                onToggleOpen={() => setOpenStep(openStep === s.id ? null : s.id)}
                onToggleDone={() => toggleDone(s.id)}
              />
            ))}
          </div>

          {doneCount === SETUP_STEPS.length && (
            <section className="panel p-4 text-center">
              <p className="text-[12px] text-fg-strong">準備は完了しています。</p>
              <button type="button" onClick={() => go("modes")}
                      className="mt-2 min-h-[40px] text-[11px] text-[var(--accent)] underline">
                各画面の使い方を見る →
              </button>
            </section>
          )}

          <Glossary />
        </div>
      )}

      {/* ── 画面の使い方 ─────────────────────────────────────── */}
      {tab === "modes" && (
        <div className="grid gap-3">
          {loading && (
            <div className="panel p-4 text-center text-[10px] tracking-[0.2em] text-muted label-mono">
              ◈ LOADING…
            </div>
          )}

          {!loading && modes.length === 0 && (
            <div className="panel p-4">
              <p className="text-[12px] leading-relaxed text-fg">
                各画面の使い方（写真つき）は、バックエンドに繋がると出ます。
              </p>
              {err && <p className="mt-1.5 text-[11px] text-muted">{err}</p>}
              <button type="button" onClick={() => go("start")}
                      className="mt-2 min-h-[40px] text-[11px] text-[var(--accent)] underline">
                先に「はじめる」を済ませる →
              </button>
            </div>
          )}

          {modes.length > 0 && (
            <>
              <p className="px-1 text-[11px] text-muted">
                知りたい画面を押すと、写真つきの説明が出ます。（全{modes.length}画面）
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {modes.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setDetail(m)}
                    className="panel overflow-hidden p-0 text-left transition hover:border-[var(--line)]"
                  >
                    {/* どの画面も上部はコアと名前で同じなので、そこを写すと
                        全部同じ絵になる。中身が始まるあたりを見せる。 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.image} alt="" loading="lazy" decoding="async"
                         className="block h-36 w-full object-cover"
                         style={{ objectPosition: "50% 62%" }} />
                    <div className="p-2">
                      <div className="text-[11px] text-fg-strong label-mono">{m.label}</div>
                      <div className="text-[10px] leading-tight text-muted">{m.name}</div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── できること ───────────────────────────────────────── */}
      {tab === "can" && (
        <div className="grid gap-3">
          {loading && (
            <div className="panel p-4 text-center text-[10px] tracking-[0.2em] text-muted label-mono">
              ◈ LOADING…
            </div>
          )}
          {!loading && !doc && (
            <div className="panel p-4">
              <p className="text-[12px] leading-relaxed text-fg">
                使い方の例は、バックエンドに繋がると出ます。
              </p>
              {err && <p className="mt-1.5 text-[11px] text-muted">{err}</p>}
            </div>
          )}
          {doc?.sections.map((s) => (
            <section key={s.id} className="panel p-4">
              <h3 className="text-[13px] text-fg-strong">{s.title}</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-fg">{s.summary}</p>
              {s.steps.length > 0 && (
                <ul className="mt-2.5 space-y-1.5">
                  {s.steps.map((step) => (
                    <li key={step} className="flex gap-2 text-[12px] leading-relaxed text-fg">
                      <Dot />
                      <span className="min-w-0">{step}</span>
                    </li>
                  ))}
                </ul>
              )}
              {s.notes.length > 0 && (
                <ul className="mt-2.5 space-y-1 border-t border-panel pt-2.5">
                  {s.notes.map((n) => (
                    <li key={n} className="text-[11px] leading-relaxed text-muted">※ {n}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}

      {/* ── データと安全 ─────────────────────────────────────── */}
      {tab === "data" && <PolicyBody />}

      {detail && (
        <ModeDetail mode={detail} onClose={() => setDetail(null)} onZoom={() => setZoom(detail)} />
      )}
      {zoom && <ZoomOverlay mode={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full"
          style={{ background: "var(--accent)" }} />
  );
}

/** 用語のいいかえ。畳んでおいて、分からない人だけ開く。 */
function Glossary() {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel p-4">
      <button type="button" onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex w-full items-center justify-between gap-2 text-left">
        <span>
          <span className="block text-[13px] text-fg-strong">聞き慣れない言葉が出てきたら</span>
          <span className="mt-0.5 block text-[11px] text-muted">
            Supabase・SQL・APIキーって何？ を1行で
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-[11px] text-muted">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <dl className="mt-3 grid gap-2 border-t border-panel pt-3">
          {GLOSSARY.map((t) => (
            <div key={t.word}>
              <dt className="text-[12px] text-fg-strong">{t.word}</dt>
              <dd className="text-[11px] leading-relaxed text-muted">{t.means}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * 手順1つ。閉じているときは「何をするか」だけ、開くと操作が出る。
 * 済んだ印は自分で押す（自動判定にすると、外れたときに直せない）。
 */
function StepCard({ step, done, open, onToggleOpen, onToggleDone }: {
  step: SetupStep; done: boolean; open: boolean;
  onToggleOpen: () => void; onToggleDone: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (!step.codeUrl || !open) return;
    let alive = true;
    fetch(step.codeUrl, { cache: "force-cache" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (alive) setCode(t); })
      .catch(() => { if (alive) setCodeErr(true); });
    return () => { alive = false; };
  }, [step.codeUrl, open]);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setShowCode(true);
    }
  };

  return (
    // min-w-0 が無いと、中の <pre> の長い行が親を押し広げて画面が横スクロールする
    <section className="panel min-w-0 overflow-hidden p-0"
             style={done ? { borderColor: "color-mix(in srgb, var(--accent) 45%, transparent)" } : undefined}>
      <div className="flex items-start gap-2 p-3">
        {/* 済んだ印 */}
        <button
          type="button"
          onClick={onToggleDone}
          aria-pressed={done}
          aria-label={`${step.title} を${done ? "未完了に戻す" : "完了にする"}`}
          className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] transition"
          style={{
            borderColor: done ? "var(--accent)" : "var(--panel-bd)",
            background: done ? "var(--accent)" : "transparent",
            color: done ? "var(--bg)" : "var(--muted)",
          }}
        >
          {done ? "✓" : ""}
        </button>

        <button type="button" onClick={onToggleOpen} aria-expanded={open}
                className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] text-fg-strong"
                  style={done ? { textDecoration: "line-through", opacity: 0.7 } : undefined}>
              {step.title}
            </span>
            <span className="shrink-0 text-[10px] text-muted">{step.minutes}</span>
          </div>
          {/* 閉じていても「何をさせられるのか」は必ず見える */}
          <p className="mt-1 text-[11px] leading-relaxed text-muted">{step.plain}</p>
        </button>

        <span aria-hidden className="mt-0.5 shrink-0 text-[11px] text-muted">
          {open ? "▲" : "▼"}
        </span>
      </div>

      {open && (
        <div className="border-t border-panel p-3">
          {step.detail && (
            <p className="mb-2 text-[11px] leading-relaxed text-muted">{step.detail}</p>
          )}
          <ol className="ml-4 list-decimal space-y-1 text-[12px] leading-relaxed text-fg">
            {step.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>

          {step.codeUrl && (
            <div className="mt-3">
              {code ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* 「コピーする」だけだと、何がコピーされるのか分からない
                        （読み上げでも同じ）。中身を名前に入れる。 */}
                    <button type="button" onClick={copy}
                            aria-label={step.codeLabel ?? "貼り付ける内容をコピー"}
                            className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong label-mono">
                      {copied ? "✓ コピーしました" : "⧉ コピーする"}
                    </button>
                    <button type="button" onClick={() => setShowCode((v) => !v)}
                            className="text-[10px] text-muted underline">
                      {showCode ? "中身を隠す" : "中身を見る"}
                    </button>
                    <span className="text-[10px] text-muted">{code.split("\n").length} 行</span>
                  </div>
                  {step.codeLabel && (
                    <p className="mt-1 text-[10px] text-muted">{step.codeLabel}</p>
                  )}
                  {showCode && (
                    <pre className="mt-2 max-h-64 w-full max-w-full overflow-auto rounded-forge border border-panel bg-[var(--input-bg)] p-2.5 text-[10px] leading-relaxed text-fg">
                      <code>{code}</code>
                    </pre>
                  )}
                </>
              ) : codeErr ? (
                <p className="text-[11px] text-muted">
                  読み込めませんでした。
                  <a href={step.codeUrl} target="_blank" rel="noopener noreferrer"
                     className="ml-1 text-[var(--accent)] underline">こちらから開いて</a>
                  コピーしてください。
                </p>
              ) : (
                <p className="text-[10px] text-muted label-mono">読み込み中…</p>
              )}
            </div>
          )}

          {step.caution && step.caution.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-panel pt-2.5">
              {step.caution.map((c) => (
                <li key={c} className="text-[11px] leading-relaxed text-muted">※ {c}</li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={onToggleDone}
            className="mt-3 w-full rounded-forge border px-3 py-2 text-[11px] transition"
            style={{
              borderColor: done ? "var(--panel-bd)" : "var(--line)",
              background: done ? "transparent" : "var(--btn-bg)",
              color: done ? "var(--muted)" : "var(--fg-strong)",
            }}
          >
            {done ? "未完了に戻す" : "できた（次へ）"}
          </button>
        </div>
      )}
    </section>
  );
}

/** 1画面ぶんの詳細。一覧から選んだときだけ出す。 */
function ModeDetail({ mode, onClose, onZoom }: {
  mode: GuideMode; onClose: () => void; onZoom: () => void;
}) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-[var(--bg)]"
         role="dialog" aria-label={`${mode.label} の使い方`}>
      <div className="flex items-center justify-between gap-3 border-b border-panel p-3">
        <div className="min-w-0">
          <span className="text-[12px] text-fg-strong label-mono">{mode.label}</span>
          <span className="ml-2 text-[11px] text-muted">{mode.name}</span>
        </div>
        <button type="button" onClick={onClose}
                className="min-h-[44px] shrink-0 px-3 text-[12px] text-muted transition hover:text-fg-strong">
          閉じる
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[max(env(safe-area-inset-bottom),1.5rem)]">
        <div className="mx-auto grid w-full max-w-2xl gap-3">
          <button type="button" onClick={onZoom}
                  aria-label={`${mode.label} の画面を拡大`}
                  className="mx-auto w-[240px] overflow-hidden rounded-forge border border-panel transition hover:border-[var(--line)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mode.image} alt={`${mode.label}（${mode.name}）の画面`}
                 className="block w-full" />
          </button>
          <p className="text-center text-[10px] text-muted">押すと大きく見られます</p>

          <p className="text-[12px] leading-relaxed text-fg">{mode.what}</p>

          {mode.how.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] tracking-[0.16em] text-muted label-mono">つかいかた</div>
              <ul className="space-y-1.5">
                {mode.how.map((h) => (
                  <li key={h} className="flex gap-2 text-[12px] leading-relaxed text-fg">
                    <Dot /><span className="min-w-0">{h}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {mode.tips.length > 0 && (
            <ul className="space-y-1 border-t border-panel pt-2.5">
              {mode.tips.map((t) => (
                <li key={t} className="text-[11px] leading-relaxed text-muted">※ {t}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 画面写真の拡大。Escでも閉じられる。 */
function ZoomOverlay({ mode, onClose }: { mode: GuideMode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 親に perspective が掛かっていると fixed がビューポート基準にならないため、
  // body へポータルする（押しても何も起きないように見える不具合を踏んだ）。
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label={`${mode.label} の画面`}
    >
      <div className="text-center">
        <span className="text-[12px] text-fg-strong label-mono">{mode.label}</span>
        <span className="ml-2 text-[11px] text-muted">{mode.name}</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={mode.image} alt={`${mode.label}（${mode.name}）の画面`}
           className="max-h-[76vh] w-auto rounded-forge border border-panel" />
      <button type="button" onClick={onClose}
              className="rounded-forge border border-panel bg-[var(--btn-bg)] px-4 py-2 text-[11px] text-fg-strong label-mono">
        閉じる
      </button>
    </div>,
    document.body,
  );
}
