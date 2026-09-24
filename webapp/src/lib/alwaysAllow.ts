/**
 * alwaysAllow.ts — 「この操作はいつも許可」を覚えておく。
 *
 * なぜ要るか
 * ----------
 * 確認は、危ないから出している。ただし**同じ確認**が何度も出ると、
 * 読まずに押す癖がつく。そうなると、本当に読んでほしい確認
 * （メールを送る・お金が動く）も一緒に素通りする。
 *
 * 実際の使い方で言うと、「カレンダーに入れて」を1日に5回頼む人は、
 * `calendar_add` の確認を5回読まない。確認の数を減らすことが、
 * 残った確認をちゃんと読ませることになる。
 *
 * 何を許してよいか
 * ----------------
 * ここは**画面側の都合では決めない**。出してよいかどうかはサーバーが
 * `may_always` で言ってくる（api/risk.py）。そして許した名前を送っても、
 * サーバーは段階3（取り返せない）と連鎖の確認を必ず出す——画面の作りが
 * 変わっても、そこは守られる。
 *
 * どこに持つか
 * ------------
 * この端末の中（localStorage）。ほかの端末には行かない。
 * 「自分のパソコンでは任せるが、共有の端末では毎回聞いてほしい」が
 * そのまま表せるので、これでよい。
 */

const KEY = "forge_always_allow";

export interface Allowed {
  tool: string;
  /**
   * 押した時点の危なさの説明（「外のサービスに残る」など）。
   *
   * 道具の名前（`calendar_add`）だけを一覧に出すと、あとから見たときに
   * 自分が何を許したのか分からない。押した瞬間はサーバーが説明を
   * 送ってきているので、そこで一緒に控えておく。
   */
  label?: string;
  /** いつ許したか。 */
  at: number;
}

function read(): Allowed[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => (typeof r === "string" ? { tool: r, at: 0 } : r))
      .filter((r) => r && typeof r.tool === "string" && r.tool)
      .map((r): Allowed => ({ tool: r.tool, label: r.label, at: Number(r.at) || 0 }));
  } catch {
    return [];
  }
}

function write(list: Allowed[]): void {
  try {
    const seen = new Map<string, Allowed>();
    for (const row of list) seen.set(row.tool, row);
    localStorage.setItem(KEY, JSON.stringify([...seen.values()].slice(0, 50)));
  } catch {
    /* 書けない設定なら、毎回聞かれるだけ。安全側に外れるのでこれでよい */
  }
}

/** いま「いつも許可」にしてある道具（許した順）。 */
export function list(): Allowed[] {
  return read();
}

/** サーバーへ送る形（名前だけ）。 */
export function allowed(): string[] {
  return read().map((r) => r.tool);
}

/** 1つ許す。 */
export function allow(tool: string, label?: string): void {
  const name = (tool || "").trim();
  if (!name) return;
  write([...read(), { tool: name, label, at: Date.now() }]);
}

/** 1つ取り消す。 */
export function forget(tool: string): void {
  write(read().filter((r) => r.tool !== tool));
}

export function clear(): void {
  write([]);
}
