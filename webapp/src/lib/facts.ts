/**
 * facts.ts — 会話から事実を取り出して、長期記憶に入れる（呼ぶ側）。
 *
 * これまでの取りこぼし
 * --------------------
 * 記憶に入っていたのは、本人の発言を**形で**選り分けた物だけだった
 * （worthRemembering.ts）。問いかけと指示は落とす決まりなので:
 *
 *     「今度の沖縄、3泊で考えてるんだけどおすすめある？」  → 捨てる
 *     「妻が甲殻類だめだから、店は肉にして」               → 捨てる
 *
 * どちらも、**次に会ったときに知っていてほしいこと**が入っている。
 * 形で選ぶかぎり、ここは永久に取れない。
 *
 * どこで動かすか
 * --------------
 * **返事が終わったあと。** 返事の前に1往復足すと、そのぶん丸ごと
 * 「返事が始まるまでの待ち時間」になる（そこは何度も削ってきた所）。
 * 終わったあとなら、利用者はもう読んでいる。
 *
 * 毎回は呼ばない
 * --------------
 * 1発言ごとに呼ぶと、往復の数＝発言の数になる。相づちだけの往復にも
 * 費用がかかるし、短すぎて何も取れない。**溜めてから1回**にする:
 *
 *   ・本人の発言が合わせて 60 文字を超えた、または
 *   ・やりとりが 2 往復たまった、または
 *   ・12 秒だまった（会話が一段落した）
 *
 * 溜めたものは、まとめて渡す。前後がつながっているほうが取れる
 * （「沖縄ね」だけでは何も分からないが、その前の行と一緒なら分かる）。
 *
 * 溜めている途中で閉じられても、落とさない
 * ----------------------------------------
 * だまってから取りに行く決まりなので、**その前にタブを閉じられる**ことが
 * ある。溜めたぶんがメモリにしか無いと、そこで消える——しかも本人からは
 * 「一言も覚えていない」ようにしか見えない。sessionStorage に置いて、
 * 次に開いたときに続きから取りに行く。
 *
 * 入れる前に見ること
 * ------------------
 * 返ってくるのは**AIが書いた文**なので、本人が言っていない物が混ざり
 * うる。サーバー側でも絞っているが、ここでも:
 *   ・鍵とパスワードは入れない（memory.add にも同じ関門がある）
 *   ・すでにある記憶と同じなら入れない
 *   ・どこから来たか（source="agent"）を残して、画面で見分けられるようにする
 */

import * as memory from "@/lib/memory";
import { memoryExtract, API_URL } from "@/lib/api";
import { scheduleSync } from "@/lib/memorySync";

/** 溜まったやりとり。 */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** ここを超えたら取りに行く。 */
export const CHARS_TRIGGER = 60;
export const TURNS_TRIGGER = 4;         // 本人＋AI で2往復
/** 会話が止まってから、これだけ経ったら取りに行く。 */
export const IDLE_MS = 12_000;
/** 1回に渡すやりとりの数（これより古いものは落とす）。 */
export const MAX_BUFFER = 12;

const ON_KEY = "forge_facts_on";
const BUFFER_KEY = "forge_facts_buffer";

/**
 * この機能を使うか。
 *
 * 既定は**入**。「覚えてくれる相棒」を名乗る以上、既定で切っていては
 * 名前負けする。ただし切れるようにはしてある——会話がそのまま記憶に
 * なるのが気持ち悪い、という感覚はもっともなので。
 */
export function enabled(): boolean {
  try {
    return localStorage.getItem(ON_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setEnabled(on: boolean): void {
  try {
    localStorage.setItem(ON_KEY, on ? "on" : "off");
  } catch {
    /* プライベートモードなどで書けないことがある。既定（入）のままでよい */
  }
}

/* ── 溜める所 ──────────────────────────────────────────────────── */

let buffer: Turn[] = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function save(): void {
  try {
    if (buffer.length) sessionStorage.setItem(BUFFER_KEY, JSON.stringify(buffer));
    else sessionStorage.removeItem(BUFFER_KEY);
  } catch {
    /* 書けない設定でも動く。取りこぼしが増えるだけで、壊れはしない */
  }
}

/**
 * 前に開いていたときの溜まりを引き継ぐ。
 *
 * 画面が立ち上がったら1回呼ぶ。だまっている途中で閉じられたぶんが
 * ここで拾われる。
 */
export function resume(): void {
  if (buffer.length) return;
  try {
    const raw = sessionStorage.getItem(BUFFER_KEY);
    if (!raw) return;
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    buffer = rows
      .filter((t) => t && typeof t.content === "string" && t.content.trim())
      .map((t): Turn => ({ role: t.role === "assistant" ? "assistant" : "user",
                           content: String(t.content).slice(0, 2000) }))
      .slice(-MAX_BUFFER);
    if (buffer.length) void flush();
  } catch {
    /* 読めない物が入っていたら、無かったことにする */
  }
}

/** テストと、画面を離れるときのため。 */
export function reset(): void {
  buffer = [];
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  save();
}

/** いま溜まっているもの（テスト用）。 */
export function pending(): Turn[] {
  return [...buffer];
}

function userChars(): number {
  return buffer.filter((t) => t.role === "user")
    .reduce((n, t) => n + t.content.length, 0);
}

/**
 * やりとりを1つ足す。しきい値を超えたらその場で取りに行く。
 *
 * 待たない（`void`）。ここで待つと、次の発言を受け付ける所が止まる。
 */
export function note(role: "user" | "assistant", content: string): void {
  const body = (content || "").trim();
  if (!body || !enabled()) return;
  buffer.push({ role, content: body.slice(0, 2000) });
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  save();

  if (idleTimer) clearTimeout(idleTimer);
  if (userChars() >= CHARS_TRIGGER || buffer.length >= TURNS_TRIGGER) {
    void flush();
    return;
  }
  /* まだ足りない。だまったら取りに行く——3往復に届かないまま終わる
     短い会話が、いちばん事実を含んでいることがある（「引っ越すんだ」）。 */
  idleTimer = setTimeout(() => { void flush(); }, IDLE_MS);
}

/**
 * 溜まったぶんから事実を取り出して、記憶に入れる。
 *
 * 入れた件数を返す。**例外は出さない**。
 */
export async function flush(): Promise<number> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (running) return 0;                 // 二重に走らせない
  const turns = buffer;
  buffer = [];
  save();
  if (!turns.length || !enabled() || !API_URL) return 0;
  /* 本人が一言も喋っていないなら、取れる事実は無い。 */
  if (!turns.some((t) => t.role === "user")) return 0;

  running = true;
  try {
    /* すでに覚えていることを渡して、同じ事実が言い回し違いで増えるのを
       止める。全部は渡せない（毎回の入力が膨らむ）ので、新しい順に。 */
    let known: string[] = [];
    try {
      known = (await memory.all())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 40)
        .map((m) => m.text);
    } catch {
      known = [];
    }

    const found = await memoryExtract(turns, known);
    let added = 0;
    for (const f of found) {
      /* source="agent" ＝ この人が言ったのではなく、会話から起こした文。
         記憶の画面でそう見えるようにしてある（本人が消せる）。 */
      const item = await memory.add(f.text, {
        source: "agent",
        kind: "fact",
        importance: f.importance >= 1 ? 1 : 0,
      }).catch(() => null);
      if (item) added += 1;
    }
    // 覚えたら、ほかの端末にも行き渡らせる（まとめて後で1回）
    if (added) scheduleSync();
    return added;
  } catch {
    return 0;
  } finally {
    running = false;
  }
}
