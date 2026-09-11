/**
 * memory.ts — 端末の中の長期記憶。
 *
 * なぜ端末にも持つのか
 * --------------------
 * これまで記憶はサーバー側（Supabase）にしか無く、**繋がっていなければ
 * 1件も覚えられなかった**。`mem_add` は保存先が無いと false を返して
 * 何もせず、`mem_recall` は空文字を返す。つまり Supabase を繋いでいない
 * 人にとって、このアプリは毎回はじめましてだった。
 *
 * 端末の中に持てば、
 *   ・圏外でも、バックエンドが寝ていても思い出せる
 *   ・「覚えていること」を自分の手元で見て、消せる
 *   ・繋がったときに、サーバーの記憶と合流できる（次の段）
 *
 * サーバー側を置き換えるものではない。**両方に置いて、両方から引く**。
 * サーバーは意味で引ける（埋め込み）、こちらは通信なしで引ける。
 * 得意が違うので、混ぜたほうが強い。
 *
 * 消せることを先に用意する
 * ------------------------
 * 覚える機能を作るときは、**消す手段を同時に**用意する。あとで足す、に
 * すると「覚えてほしくないことを覚えたまま消せない」期間ができる。
 * `remove()` は墓標（deletedAt）を残す——合流のときに「消したこと」も
 * 伝えないと、サーバー側から復活してしまうため。
 */

import { recall as rank, toBlock, type Hit, type Recallable } from "@/lib/recall";

const DB_NAME = "forge-memory";
const DB_VERSION = 1;
const STORE = "items";

/** 持っておく上限。超えたら、大事でない古い物から落とす。 */
export const MAX_ITEMS = 2000;
/** 墓標を持っておく日数（合流に必要な期間だけ）。 */
export const TOMBSTONE_DAYS = 90;

export type MemoryKind = "fact" | "note";
export type MemorySource = "me" | "agent" | "server";

export interface MemoryItem extends Recallable {
  id: string;
  text: string;
  kind: MemoryKind;
  /** 0=ふつう 1=大事 2=とても大事 */
  importance: number;
  createdAt: number;
  updatedAt: number;
  /** 消した時刻。合流のために、消したことも残す。 */
  deletedAt?: number;
  source: MemorySource;
}

/* ── 置き場 ─────────────────────────────────────────────────────── */

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: "id" });
          // 合流のとき「前回より後に変わった物」だけを送るのに使う
          s.createIndex("updatedAt", "updatedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 4000);
    } catch {
      resolve(null);
    }
  });
}

/**
 * IndexedDB が使えないときの受け皿（プライベートモードなど）。
 *
 * 黙って落とさない。この画面を開いている間は覚えるが、閉じると消える
 * ——`storage()` がそれを返すので、画面はその旨を出せる。
 */
const fallback = new Map<string, MemoryItem>();
let usingFallback = false;

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode,
               run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** いま記憶がどこにあるか。画面に出して、消える保存先を隠さない。 */
export function storage(): "device" | "session" | "unknown" {
  if (usingFallback) return "session";
  return typeof indexedDB === "undefined" ? "session" : "device";
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/* ── 読み書き ───────────────────────────────────────────────────── */

/** 生きている記憶（墓標は除く）。 */
export async function all(): Promise<MemoryItem[]> {
  const rows = await allRaw();
  return rows.filter((r) => !r.deletedAt);
}

/** 墓標も含めた全部（合流で使う）。 */
export async function allRaw(): Promise<MemoryItem[]> {
  const db = await openDb();
  if (!db) {
    usingFallback = true;
    return Array.from(fallback.values());
  }
  const rows = await tx<MemoryItem[]>(db, "readonly",
    (s) => s.getAll() as IDBRequest<MemoryItem[]>);
  db.close();
  return rows || [];
}

async function put(item: MemoryItem): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    usingFallback = true;
    fallback.set(item.id, item);
    return true;
  }
  const ok = await tx(db, "readwrite", (s) => s.put(item));
  db.close();
  return ok !== null;
}

export interface AddOptions {
  kind?: MemoryKind;
  importance?: number;
  source?: MemorySource;
  /** 合流で入れ直すとき用。ふだんは指定しない。 */
  id?: string;
  updatedAt?: number;
}

/**
 * 1件覚える。
 *
 * 同じ文がすでにあれば**増やさずに触れ直す**。会話のたびに同じことを
 * 言われると、同じ記憶が何十件も積まれて、思い出す側が埋まってしまう。
 */
export async function add(text: string, opts: AddOptions = {}): Promise<MemoryItem | null> {
  const body = (text || "").trim();
  if (!body) return null;

  const now = Date.now();
  const rows = await allRaw();
  const same = rows.find((r) => !r.deletedAt && r.text.trim() === body);
  if (same) {
    const bumped: MemoryItem = {
      ...same,
      updatedAt: opts.updatedAt ?? now,
      // 「大事」と言われ直したら上げる。下げはしない（下げたいなら編集から）
      importance: Math.max(same.importance, opts.importance ?? 0),
    };
    await put(bumped);
    return bumped;
  }

  const item: MemoryItem = {
    id: opts.id || newId(),
    text: body.slice(0, 2000),
    kind: opts.kind || "note",
    importance: Math.max(0, Math.min(2, opts.importance ?? 0)),
    createdAt: now,
    updatedAt: opts.updatedAt ?? now,
    source: opts.source || "me",
  };
  await put(item);
  await prune();
  return item;
}

export async function update(id: string, patch: Partial<MemoryItem>): Promise<MemoryItem | null> {
  const rows = await allRaw();
  const cur = rows.find((r) => r.id === id);
  if (!cur) return null;
  const next: MemoryItem = {
    ...cur,
    ...patch,
    id: cur.id,
    createdAt: cur.createdAt,
    updatedAt: Date.now(),
  };
  await put(next);
  return next;
}

/**
 * 消す。中身は空にしつつ、墓標（deletedAt）は残す。
 *
 * 行ごと消すと、次の合流でサーバー側から**復活する**。消したことも
 * 伝える必要がある。中身を空にするのは、消したのに端末へ文が残るのを
 * 避けるため（消したい理由は、たいてい中身のほうにある）。
 */
export async function remove(id: string): Promise<boolean> {
  const rows = await allRaw();
  const cur = rows.find((r) => r.id === id);
  if (!cur) return false;
  return put({ ...cur, text: "", deletedAt: Date.now(), updatedAt: Date.now() });
}

/** 端末の記憶を全部消す（墓標も残さない＝完全に無かったことにする）。 */
export async function clearAll(): Promise<void> {
  const db = await openDb();
  if (!db) { fallback.clear(); return; }
  await tx(db, "readwrite", (s) => s.clear());
  db.close();
}

/**
 * 多すぎる分を落とす。
 *
 * 落とす順は「大事でない → 古い」。大事と印を付けた物は、古くても残す
 * （印を付けた人は、それを残したくて付けている）。
 */
async function prune(): Promise<void> {
  const rows = await allRaw();
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86_400_000;
  const stale = rows.filter((r) => r.deletedAt && r.deletedAt < cutoff);
  const live = rows.filter((r) => !r.deletedAt);

  const over = live.length - MAX_ITEMS;
  const drop = [...stale];
  if (over > 0) {
    const ordered = [...live].sort(
      (a, b) => (a.importance - b.importance) || (a.updatedAt - b.updatedAt));
    drop.push(...ordered.slice(0, over));
  }
  if (!drop.length) return;

  const db = await openDb();
  if (!db) { drop.forEach((d) => fallback.delete(d.id)); return; }
  for (const d of drop) await tx(db, "readwrite", (s) => s.delete(d.id));
  db.close();
}

/* ── 思い出す ───────────────────────────────────────────────────── */

export interface RecalledMemory {
  hits: Hit<MemoryItem>[];
  /** そのままAIへ渡せる文章。何も当たらなければ空。 */
  block: string;
}

/**
 * 関係のある記憶を引く。**通信しない。**
 *
 * 引き方は recall.ts（文字bigram × 珍しさ）。ここは保管の都合だけを見る。
 */
export async function search(query: string, limit = 6): Promise<RecalledMemory> {
  const items = await all();
  const hits = rank(items, query, { limit });
  return { hits, block: toBlock(hits) };
}

/** 件数と保存先。設定画面に出す。 */
export async function stats(): Promise<{ count: number; important: number; where: string }> {
  const items = await all();
  return {
    count: items.length,
    important: items.filter((i) => i.importance > 0).length,
    where: storage(),
  };
}
