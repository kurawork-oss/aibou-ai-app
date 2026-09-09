/**
 * homeLayout.ts — HOMEの並び・表示/非表示・幅を覚えておく（ロック画面のような編集）.
 *
 * 画面の組み方を localStorage に持つだけの純粋なロジック。UIから切り離して
 * あるのは、並べ替えや復元の取り違えが一番事故になりやすいから
 * （順番が壊れる／消えたウィジェットが戻せない）。
 *
 * 保存形式に無いIDや、増えた新しいウィジェットは normalize() で必ず補う。
 * こうしないとアプリを更新したときに新機能が永久に出てこない。
 */

export type WidgetId =
  "agent" | "watch" | "dials" | "agenda" | "notifications" | "artifacts" | "connect";

export interface WidgetMeta { label: string; hint: string }

/** 表示名（カスタマイズ画面と非表示トレイで使う）。 */
export const WIDGET_META: Record<WidgetId, WidgetMeta> = {
  agent: { label: "エージェント", hint: "指示すると実際に動く" },
  watch: { label: "見張り", hint: "タスク・予定・メール・Slack・LINEの新着" },
  dials: { label: "計器盤", hint: "タスク・予定などの件数" },
  agenda: { label: "予定", hint: "今日以降の予定" },
  notifications: { label: "通知", hint: "未読のお知らせ" },
  artifacts: { label: "生成物", hint: "作った資料・画像" },
  connect: { label: "接続", hint: "各モードへの入口" },
};

/**
 * 既定の並び。
 *
 * エージェントの欄（agent）は既定から外した。会話は「実行」タブに1つだけ
 * 置く形にしたので、ここに置くと同じことを2か所でやることになる
 * （実際、HOMEのエージェント欄と CHAT の司令塔モードで二重になっていた）。
 * 消してはいないので、カスタマイズから戻せる。
 */
export const DEFAULT_ORDER: WidgetId[] = [
  "watch", "dials", "agenda", "notifications", "artifacts", "connect", "agent",
];

/** 既定で隠すもの（並びには残すので、カスタマイズから戻せる）。 */
export const DEFAULT_HIDDEN: WidgetId[] = ["agent"];

/** 既定で横長にするもの（3カラムのうち2つ分）。 */
const DEFAULT_WIDE: WidgetId[] = ["watch", "agenda"];

export interface HomeLayout {
  /** 表示順。hidden のものも順序は保持する（戻したとき元の位置に出る）。 */
  order: WidgetId[];
  hidden: WidgetId[];
  wide: WidgetId[];
}

export const LS_KEY = "forge_home_layout_v1";

export function defaultLayout(): HomeLayout {
  return { order: [...DEFAULT_ORDER], hidden: [...DEFAULT_HIDDEN],
           wide: [...DEFAULT_WIDE] };
}

const isId = (v: unknown): v is WidgetId =>
  typeof v === "string" && (DEFAULT_ORDER as string[]).includes(v);

/**
 * 保存値を安全な形に整える。
 *  - 知らないIDは捨てる（古い保存や手書きの壊れた値）
 *  - 重複は最初の1つだけ残す
 *  - 新しく増えたウィジェットは末尾に足す（更新後も必ず出る）
 */
export function normalize(raw: unknown): HomeLayout {
  const src = (raw ?? {}) as Partial<HomeLayout>;
  const order: WidgetId[] = [];
  for (const v of Array.isArray(src.order) ? src.order : []) {
    if (isId(v) && !order.includes(v)) order.push(v);
  }
  for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);

  const hidden = (Array.isArray(src.hidden) ? src.hidden : []).filter(isId);
  const wide = Array.isArray(src.wide) ? src.wide.filter(isId) : [...DEFAULT_WIDE];
  return {
    order,
    hidden: Array.from(new Set(hidden)),
    wide: Array.from(new Set(wide)),
  };
}

export function loadLayout(): HomeLayout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultLayout();
    return normalize(JSON.parse(raw));
  } catch {
    return defaultLayout();
  }
}

export function saveLayout(layout: HomeLayout): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(layout)); } catch { /* quota */ }
}

/** 表示中のウィジェットだけを順番に返す。 */
export function visible(layout: HomeLayout): WidgetId[] {
  return layout.order.filter((id) => !layout.hidden.includes(id));
}

/**
 * 表示中の並びの中で1つ動かす。
 *
 * order には非表示のものも混ざっているので、「見えている順で隣と入れ替える」
 * ように動かす。そうしないと、非表示を挟んだときに押しても動かない見た目になる。
 */
export function move(layout: HomeLayout, id: WidgetId, dir: -1 | 1): HomeLayout {
  const vis = visible(layout);
  const vi = vis.indexOf(id);
  if (vi === -1) return layout;
  const target = vis[vi + dir];
  if (!target) return layout;
  const order = [...layout.order];
  const a = order.indexOf(id), b = order.indexOf(target);
  [order[a], order[b]] = [order[b], order[a]];
  return { ...layout, order };
}

/** 表示/非表示を切り替える（順序は保ったまま）。 */
export function toggleHidden(layout: HomeLayout, id: WidgetId): HomeLayout {
  const hidden = layout.hidden.includes(id)
    ? layout.hidden.filter((x) => x !== id)
    : [...layout.hidden, id];
  return { ...layout, hidden };
}

/** 幅（通常 / 横長）を切り替える。 */
export function toggleWide(layout: HomeLayout, id: WidgetId): HomeLayout {
  const wide = layout.wide.includes(id)
    ? layout.wide.filter((x) => x !== id)
    : [...layout.wide, id];
  return { ...layout, wide };
}

export const isWide = (layout: HomeLayout, id: WidgetId) => layout.wide.includes(id);
