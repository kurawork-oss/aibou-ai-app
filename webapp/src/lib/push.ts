/**
 * 通知（Web Push）の購読まわり。
 *
 * なぜ要るのか
 * ------------
 * このアプリは「見ていない間も動く」ことを狙っている。定期実行も、
 * 承認待ちもある。ところが今まで、こちらから人を呼ぶ手段は LINE・
 * Discord・Slack しか無く、どれも先に相手方の登録が要った。
 * つまり何も設定していない人には、夜中に何が起きても届かなかった。
 *
 * Web Push は、その登録が要らない唯一の道。
 *
 * つまずきやすい所（全部ここで吸収する）
 * --------------------------------------
 *   ・iOS は**ホーム画面に追加したときだけ**通知を使える。Safari で
 *     開いたままでは、許可を求めても何も起きない
 *   ・許可は一度断られると、次からダイアログすら出ない（設定から戻す）
 *   ・`https` か `localhost` でないと、そもそも API が無い
 *   ・鍵が変わると購読は無効になるので、開くたびに登録し直す
 *
 * どれも「押しても何も起きない」という形で出るので、**理由を返す**。
 */

import { API_URL, authHeaders } from "@/lib/api";

export type PushState =
  | "unsupported"      // ブラウザに機能が無い
  | "needs-install"    // iOS：ホーム画面に追加が要る
  | "insecure"         // https でない
  | "denied"           // 断られている（設定から戻すしかない）
  | "off"              // 使えるが、まだ許可していない
  | "on"               // 購読済み
  | "no-backend";      // 接続先が無い（鍵を取りに行けない）

export interface PushStatus {
  state: PushState;
  /** 画面に出す一言。state だけだと何をすればいいか分からない。 */
  reason: string;
}

/** iOS の Safari（ホーム画面に追加していない状態）か。 */
function iosStandaloneMissing(): boolean {
  try {
    const ua = navigator.userAgent || "";
    const isIOS = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === "MacIntel" && (navigator as unknown as { maxTouchPoints: number }).maxTouchPoints > 1);
    if (!isIOS) return false;
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
    return !standalone;
  } catch {
    return false;
  }
}

export function supported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

/** いまの状態を調べる。通信はしない（画面を開いた瞬間に出すため）。 */
export async function status(): Promise<PushStatus> {
  if (typeof window === "undefined") return { state: "off", reason: "" };
  if (!window.isSecureContext) {
    return { state: "insecure", reason: "通知は https のページでしか使えません。" };
  }
  if (iosStandaloneMissing()) {
    return {
      state: "needs-install",
      reason: "iPhone / iPad では、共有 → ホーム画面に追加 をしてから開くと通知を使えます。",
    };
  }
  if (!supported()) {
    return { state: "unsupported", reason: "このブラウザは通知に対応していません。" };
  }
  if (Notification.permission === "denied") {
    return {
      state: "denied",
      reason: "通知が拒否されています。ブラウザの設定（サイトの権限）から許可に戻してください。",
    };
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) return { state: "on", reason: "この端末に通知が届きます。" };
  } catch {
    /* まだ登録していないだけ */
  }
  return { state: "off", reason: "許可すると、見ていない間の知らせが届きます。" };
}

/** base64url の公開鍵を、購読に渡せる形へ。 */
function toBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** サービスワーカーを入れる（通知を受け取る場所）。 */
export async function register(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}

/**
 * 通知を有効にする。
 *
 * 途中で断られても例外にしない。押した人に返すのは「どうなったか」と
 * 「次に何をすればよいか」の2つ。
 */
export async function enable(): Promise<PushStatus> {
  const st = await status();
  if (st.state !== "off" && st.state !== "on") return st;
  if (!API_URL) {
    return { state: "no-backend", reason: "接続先（バックエンド）が無いため、通知を登録できません。" };
  }

  let perm: NotificationPermission;
  try {
    perm = await Notification.requestPermission();
  } catch {
    perm = "denied";
  }
  if (perm !== "granted") {
    return {
      state: "denied",
      reason: "許可されませんでした。ブラウザの設定（サイトの権限）から許可に戻せます。",
    };
  }

  const reg = await register();
  if (!reg) return { state: "unsupported", reason: "通知の受け口を用意できませんでした。" };

  let key = "";
  try {
    const r = await fetch(`${API_URL}/push/key`);
    key = (await r.json())?.key || "";
  } catch {
    key = "";
  }
  if (!key) {
    return { state: "no-backend", reason: "サーバーから鍵を取得できませんでした。" };
  }

  let sub: PushSubscription;
  try {
    /* 既にある購読は、鍵が変わっていると無効。作り直す前に必ず捨てる。
       ここを飛ばすと「登録できたのに1通も来ない」になり、原因が
       いちばん分かりにくい形で出る。 */
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toBytes(key) as BufferSource,
    });
  } catch {
    return { state: "off", reason: "購読を作れませんでした。時間をおいて、もう一度お試しください。" };
  }

  try {
    const res = await fetch(`${API_URL}/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ ...sub.toJSON(), label: navigator.userAgent.slice(0, 60) }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok === false) {
      return { state: "off", reason: body?.error || "サーバーに登録できませんでした。" };
    }
    // 保存できなかったが、この起動中は届く——という中間の状態も伝える
    if (body?.note) return { state: "on", reason: `通知を有効にしました（${body.note}）。` };
  } catch {
    return { state: "off", reason: "サーバーに登録できませんでした（通信に失敗）。" };
  }
  return { state: "on", reason: "この端末に通知が届きます。" };
}

/** 通知をやめる。端末側の購読も、サーバーの控えも両方消す。 */
export async function disable(): Promise<PushStatus> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      if (API_URL) {
        await fetch(`${API_URL}/push/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => null);
      }
      await sub.unsubscribe();
    }
  } catch {
    /* 端末側が既に無ければ、それでよい */
  }
  return { state: "off", reason: "通知を止めました。" };
}

/** 1通送ってみる。届くかどうかは、実際に送らないと分からない。 */
export async function sendTest(): Promise<{ ok: boolean; detail: string }> {
  if (!API_URL) return { ok: false, detail: "接続先がありません。" };
  try {
    const r = await fetch(`${API_URL}/push/test`, { method: "POST", headers: authHeaders() });
    const b = await r.json().catch(() => null);
    if (b?.skipped) return { ok: false, detail: b.reason || "送り先がありません。" };
    if (b?.ok) return { ok: true, detail: `${b.sent}/${b.total} 件に送りました。` };
    return { ok: false, detail: "送れませんでした。" };
  } catch {
    return { ok: false, detail: "送れませんでした（通信に失敗）。" };
  }
}
