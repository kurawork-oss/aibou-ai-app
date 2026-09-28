/**
 * live.ts — 変わったことを受けて、開いている画面を読み直す（仕様§38）。
 *
 * サーバーは人ごとに1本の流れ（/events）を持ち、変わった「種類」だけを流す
 * （中身は流さない。api/events.py）。ここでその流れを**タブに1本だけ**開き、
 * 聞いている画面に「読み直して」と伝える。
 *
 *   スマホでタスクを足す → ノートのタスク画面に出る
 *   会話で「付箋を貼って」 → 隣に開いているボードに出る
 *
 * EventSource を使わないのは、ログイン情報を見出し（Authorization）で
 * 送るため（EventSource は見出しを付けられない）。会話と同じく fetch で読む。
 *
 * 閉じ方・開き直し方
 * ------------------
 *   ・聞いている画面が無くなって、しばらくしたら閉じる（画面の行き来で
 *     開け閉めを繰り返さない）
 *   ・流れを返さないサーバー（古い版・/events が無い・断られた）なら、
 *     そのページでは諦める（開き直し続けない）
 *   ・切れたら少し待って開き直す。すぐ切れるなら間隔を伸ばしていく
 *   ・自分のタブが書いた変化では読み直さない（書いた画面は新しい物を持っている）
 */

import { useEffect, useRef } from "react";
import { API_URL, TAB_ID, authHeaders } from "@/lib/api";

export type LiveKind =
  | "tasks" | "agenda" | "board" | "automations" | "missions" | "artifacts"
  | "notifications" | "memory" | "vault" | "schedules" | "income";

interface Listener {
  kinds: Set<string>;
  fn: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const listeners = new Set<Listener>();
let ctrl: AbortController | null = null;
let giveUp = false;
let retryMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let watchingVisibility = false;

/** 続けて変わったときは、まとめて1回読み直す。 */
const SETTLE_MS = 300;
/** 聞く画面が無くなってから閉じるまで。画面の行き来で開け閉めしない。 */
const LINGER_MS = 10_000;

function dispatch(kind: string) {
  for (const l of listeners) {
    if (!l.kinds.has(kind)) continue;
    if (l.timer) clearTimeout(l.timer);
    l.timer = setTimeout(() => {
      l.timer = null;
      try { l.fn(); } catch { /* 読み直しの失敗は、その画面が出す */ }
    }, SETTLE_MS);
  }
}

function handle(block: string) {
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const ev = JSON.parse(line.slice(5).trim()) as { kind?: string; from?: string };
      if (!ev.kind || ev.kind === "hello") continue;
      if (ev.from && ev.from === TAB_ID) continue;          // 自分が書いた変化
      dispatch(ev.kind);
    } catch { /* 読めない行は捨てる */ }
  }
}

async function connect(): Promise<void> {
  if (ctrl || giveUp || !API_URL || listeners.size === 0) return;
  const c = new AbortController();
  ctrl = c;
  const opened = Date.now();
  let streamed = false;
  try {
    const res = await fetch(`${API_URL}/events`, {
      headers: authHeaders({ Accept: "text/event-stream" }),
      cache: "no-store",
      signal: c.signal,
    });
    const type = res.headers.get("content-type") || "";
    if (res.status >= 500) {
      // 起き上がりの途中など。少し待って開き直す
    } else if (!res.ok || !type.includes("text/event-stream") || !res.body) {
      giveUp = true;              // 流れを返さないサーバー。このページでは諦める
    } else {
      streamed = true;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let at = buf.indexOf("\n\n");
        while (at >= 0) {
          handle(buf.slice(0, at));
          buf = buf.slice(at + 2);
          at = buf.indexOf("\n\n");
        }
      }
    }
  } catch {
    /* 切れた・閉じた */
  } finally {
    if (ctrl === c) ctrl = null;
  }
  if (c.signal.aborted || giveUp || listeners.size === 0) return;
  // 長くつながっていたなら、すぐ開き直す。すぐ切れるなら、間を空けていく
  retryMs = streamed && Date.now() - opened > 30_000 ? 1000 : Math.min(retryMs * 2, 30_000);
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, retryMs);
}

function closeSoon() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (listeners.size > 0) return;
    ctrl?.abort();
    ctrl = null;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }, LINGER_MS);
}

/** スマホは裏に回すと流れが切られる。戻ってきたら開き直す。 */
function watchVisibility() {
  if (watchingVisibility || typeof document === "undefined") return;
  watchingVisibility = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || listeners.size === 0) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryMs = 1000;
    void connect();
  });
}

/** その種類が変わったら fn を呼ぶ。戻り値で聞くのをやめる。 */
export function onLive(kinds: LiveKind | LiveKind[], fn: () => void): () => void {
  const l: Listener = { kinds: new Set(Array.isArray(kinds) ? kinds : [kinds]), fn, timer: null };
  listeners.add(l);
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  watchVisibility();
  void connect();
  return () => {
    listeners.delete(l);
    if (l.timer) clearTimeout(l.timer);
    if (listeners.size === 0) closeSoon();
  };
}

/**
 * React から使う形。fn は毎回の描画で最新の物に差し替わる
 * （貼り直しのたびに聞き直すと、その隙の変化を取りこぼす）。
 */
export function useLive(kinds: LiveKind[], fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  const key = kinds.join(",");
  useEffect(() => onLive(key.split(",") as LiveKind[], () => ref.current()), [key]);
}
