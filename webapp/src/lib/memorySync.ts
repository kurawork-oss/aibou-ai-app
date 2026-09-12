/**
 * memorySync.ts — 端末の記憶とサーバーの記憶を合流させる（呼ぶ側）。
 *
 * これまで端末の記憶は**島**だった
 * --------------------------------
 *   ・端末で覚えたことはサーバーへ上がらない → 機種変で全部消える
 *   ・サーバーが覚えたことは端末へ降りてこない → 圏外で1件も思い出せない
 *   ・2台目の端末は、いつまでも空のまま
 *
 * 「Web とローカルのハイブリッド長期記憶」を名乗る以上、ここが繋がって
 * いないと名前負けする。
 *
 * どちらが欠けても動くこと
 * ------------------------
 * 合流は**あれば嬉しい**もので、無くても端末の記憶は動く。だから
 *   ・接続先が無い       → 何もせず、理由だけ返す
 *   ・サーバーが断った   → その理由をそのまま持ち帰る
 *   ・通信が落ちている   → 静かに諦める（次に開いたときに揃う）
 * 例外は投げない。記憶が揃わないことで、会話が止まってはいけない。
 *
 * 嘘をつかないための決まり
 * ------------------------
 * 「同期しました」と出しておいて何も起きていない、が最悪なので、
 * **実際に上げた数・受け取った数**を返す。0 件なら 0 件と出す。
 * サーバーが断ったときは、その理由の文をそのまま持ち帰る。
 */

import * as memory from "@/lib/memory";
import { API_URL, memorySync as postSync, type MemorySyncResponse } from "@/lib/api";

/**
 * 目印は**2つ**要る。時計が2つあるから。
 *
 *   PULL_KEY … サーバーの時計。「サーバー側でここより後に変わった物」を引く
 *   PUSH_KEY … 端末の時計。  「端末でここより後に変わった物」を送る
 *
 * 1つで済ませようとして、サーバーが返した時刻で端末側も絞っていた。
 * 端末の時計が数分でも遅れていると、**入れたばかりの記憶が「前回より
 * 前」に見えて、永久に上がらない**。しかも画面上は「揃っています」と
 * 出るので、機種変の日まで気づけない。
 *
 * 2つ持てば、それぞれの時計の中だけで比べることになるので、ずれても
 * 取りこぼさない。
 */
const PULL_KEY = "forge_mem_sync_at";
const PUSH_KEY = "forge_mem_sync_sent";
/** 最後に合流した端末側の時刻（画面に「◯分前」と出すため）。 */
const RAN_KEY = "forge_mem_sync_ran";

/**
 * 1回の呼び出しで回す往復の上限。
 *
 * サーバーは一度に 500 件までしか運ばない。はじめての合流では数千件に
 * なりうるので何度か往復するが、**無限には回さない**。回し続けると、
 * 片方が壊れているときに端末が延々と通信し続けることになる。
 * 運びきれなければ、次に開いたときに続きから運ぶ。
 */
const MAX_ROUNDS = 6;

export interface SyncOutcome {
  ok: boolean;
  /** サーバーへ上げた件数。 */
  pushed: number;
  /** サーバーから取り込んだ件数（古くて捨てたぶんは数えない）。 */
  applied: number;
  /** まだ運びきれていない。 */
  more: boolean;
  /** ok=false のときに人へ見せる理由。 */
  reason?: string;
}

function readMark(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function writeMark(serverAt: number, deviceAt: number): void {
  try {
    localStorage.setItem(PULL_KEY, String(serverAt));
    localStorage.setItem(PUSH_KEY, String(deviceAt));
    localStorage.setItem(RAN_KEY, String(Date.now()));
  } catch {
    /* 保存できなくても合流そのものは済んでいる。次回また全部見るだけ */
  }
}

/** 最後に合流した時刻（ミリ秒）。まだなら 0。 */
export function lastSyncedAt(): number {
  try {
    return Number(localStorage.getItem(RAN_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * いま合流できる状態か。できないなら、その理由。
 *
 * **ここで見るのは接続先の有無だけ**。「通してよいか」はサーバーが決める。
 *
 * はじめは、こちら側でログイン済みかどうかも見ていた。が、通れる道は
 * 構成によって違う——共通の通行証（APP_TOKEN）だけの構成、ログイン必須の
 * 構成、認証そのものを入れていない構成。画面からは見分けられないので、
 * 見分けたつもりで判断すると、**繋がる人に「ログインしていません」と
 * 言い続ける**ことになる（実際、そう書いて動かなくなった）。
 *
 * 断られたら、そのときサーバーが返した理由をそのまま出せばよい。
 * 無駄な往復が1回増えるが、嘘を出すよりずっと安い。
 */
export function syncBlockedReason(): string | null {
  if (!API_URL) return "接続先が設定されていないため、この端末の中だけです。";
  return null;
}

/* 同時に走らせない。設定画面を開いた拍子と手動の押下が重なると、
   同じ記憶を2回上げて往復が倍になる。走っている物があれば、それを待つ。 */
let inFlight: Promise<SyncOutcome> | null = null;

export function syncMemory(): Promise<SyncOutcome> {
  if (!inFlight) {
    inFlight = run().finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function run(): Promise<SyncOutcome> {
  const blocked = syncBlockedReason();
  if (blocked) return { ok: false, pushed: 0, applied: 0, more: false, reason: blocked };

  let pushed = 0;
  let applied = 0;
  let more = false;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const since = readMark(PULL_KEY);      // サーバーの時計
      const sent = readMark(PUSH_KEY);       // 端末の時計

      /* 端末側の目印は、**集める前**の時刻で置く。集めたあとの時刻にすると、
         往復の最中に覚えたことが「送った扱い」になって落ちる。 */
      const deviceAt = Date.now();
      /* 送るのは「前回より後に変わったぶん」だけ。はじめては 0 なので
         全部送ることになる——それが2台目の端末を空でなくする道。 */
      const mine = await memory.changedSince(sent);
      const res: MemorySyncResponse = await postSync(since, mine.slice(0, 500));

      if (!res.ok) {
        return { ok: false, pushed, applied, more,
                 reason: res.reason || "合流できませんでした。" };
      }

      pushed += res.pushed ?? 0;
      applied += await memory.applyRemote(res.items ?? []);
      /* 引く側の目印は**サーバーが返した時刻**で進める。端末の時計で
         進めると、ずれているぶんだけ記憶を取りこぼす。 */
      writeMark(res.at, deviceAt);
      more = Boolean(res.more);

      // 送るぶんも受け取るぶんも残っていなければ終わり
      if (!more && mine.length <= 500) break;
    }
  } catch {
    // 通信が落ちている等。ここで投げると、記憶のために会話が止まる
    return { ok: false, pushed, applied, more,
             reason: "サーバーに繋がらないため、この端末の中だけです。" };
  }

  return { ok: true, pushed, applied, more };
}

/* ── いつ走らせるか ─────────────────────────────────────────────── */

/**
 * しばらく待ってから、まとめて1回だけ合流する。
 *
 * なぜ待つのか
 * ------------
 * 覚えた直後に毎回走らせると、会話のたびに通信する。しかも記憶は
 * 続けて増えることが多い（何度か話しかける）ので、そのぶん往復が増える。
 * 少し待って**最後の1回にまとめる**。
 *
 * 記憶が揃うのが数秒遅れても困らない。困るのは「いつまでも揃わない」
 * ほうなので、待ちは短めにしてある。
 */
const SETTLE_MS = 8000;
let timer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSync(delay = SETTLE_MS): void {
  if (syncBlockedReason()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncMemory().catch(() => null);
  }, delay);
}

/** 待っている合流を取り消す（画面を離れるときなど）。 */
export function cancelScheduledSync(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

/* アプリを開いたときに1回だけ。
   ここが無いと、**2台目の端末は設定画面を開くまで空のまま会話する**
   ——記憶を合流させた意味が、いちばん効いてほしい場所で出ない。 */
let bootDone = false;

/**
 * 開いたときの1回。最初の描画を邪魔しないよう、少し置いてから走らせる。
 *
 * 2回目以降は何もしない（画面を行き来するたびに走らせない）。
 */
export function syncOnBoot(delay = 2500): void {
  if (bootDone) return;
  bootDone = true;
  scheduleSync(delay);
}

/**
 * この端末を、サーバーとの合流からいったん切り離す。
 *
 * 記憶を全部消したときに呼ぶ。目印を残したままにすると、次の合流で
 * 「前回より後に変わった物は無い」と判断して、**消したはずの記憶が
 * サーバーから降りてこないまま、消えたことも伝わらない**状態になる。
 */
export function forgetSyncMark(): void {
  try {
    localStorage.removeItem(PULL_KEY);
    localStorage.removeItem(PUSH_KEY);
    localStorage.removeItem(RAN_KEY);
  } catch {
    /* 消せなくても実害は小さい */
  }
}
