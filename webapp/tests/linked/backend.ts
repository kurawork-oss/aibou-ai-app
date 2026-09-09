/**
 * 繋がっているときの画面を見るための、差し替えバックエンド。
 *
 * 本物のサーバーは立てない。page.route で全部受ける。
 *   ・落ちない・寝ない・速い（測りたいのは画面の側だから）
 *   ・往復を数えられる（開くたびに何回聞いているか）
 *   ・断り方も作れる（409 や 503 のときに画面が何を言うか）
 *
 * 注意: ここに書いていないパスは、当たり障りのない空の応答を返す。
 * 「無いパスは繋がらない」にすると、画面のどこかが壊れた原因を
 * 追いにくくなるため。数を測るときは log を見る。
 */

import type { Page, Route } from "@playwright/test";

export interface Call { path: string; method: string; body: unknown; at: number }

export interface Backend {
  /** 飛んできた問い合わせ（古い順）。 */
  calls: Call[];
  /** 数え直す。画面を開く直前に呼ぶ。 */
  reset(): void;
  /** そのパスが何回来たか。 */
  count(path: string): number;
  /** 同じパスが2回以上来ているもの。 */
  duplicates(): string[];
  /** 1往復あたりの遅さ（ミリ秒）。0 なら即返す。 */
  latency: number;
  /** 特定のパスの応答を差し替える。 */
  set(path: string, reply: Reply): void;
  /** いま覚えている中身（テストから書き換えてよい）。 */
  state: State;
}

export type Reply =
  | { status?: number; json: unknown }
  | ((call: Call) => { status?: number; json: unknown });

export interface State {
  packs: { key: string; label: string; hint: string; enabled: boolean; always: boolean }[];
  commands: {
    cmd: string; yomi?: string; label: string; arg: string; icon: string;
    pack: string; view: string; direct: boolean;
  }[];
  pending: { waiting: boolean; provider?: string; instruction?: string; auto_resume?: boolean };
}

const COMMANDS: State["commands"] = [
  { cmd: "タスク", yomi: "たすく task", label: "タスクを追加", arg: "やること", icon: "✓", pack: "core", view: "", direct: true },
  { cmd: "状況", yomi: "じょうきょう status", label: "いまの状況をまとめる", arg: "", icon: "👀", pack: "core", view: "", direct: true },
  { cmd: "画像", yomi: "がぞう image picture", label: "画像をつくる", arg: "どんな絵か", icon: "🖼", pack: "make", view: "", direct: true },
  { cmd: "ボード", yomi: "ぼーど board", label: "ホワイトボードを開く", arg: "", icon: "🧩", pack: "core", view: "board", direct: false },
  { cmd: "コード", yomi: "こーど code", label: "コードの作業場を開く", arg: "", icon: "⌨", pack: "dev", view: "code", direct: false },
];

const PACKS: State["packs"] = [
  { key: "core", label: "仕事の基本", hint: "タスク・予定・メール・見張り", enabled: true, always: true },
  { key: "make", label: "つくる", hint: "画像・スライド・資料", enabled: true, always: false },
  { key: "share", label: "発信する", hint: "SNS・LP・記事", enabled: false, always: false },
  { key: "dev", label: "開発", hint: "コード・GitHub", enabled: true, always: false },
];

/** 決まった形が要る所（空を返すと画面が落ちる所）だけ、既定を書く。 */
function defaults(state: State): Record<string, Reply> {
  return {
    "/health": { json: { status: "ok" } },
    "/keys": { json: { items: [{ name: "GEMINI_API_KEY", set: true, masked: "AI••••34", where: "db", persisted: true }] } },
    "/account/profile": { json: { is_owner: true, owner_only_modes: [] } },
    "/account/database": { json: { connected: true } },
    "/admin/db/status": { json: { ok: true, tables: [] } },
    "/home/summary": { json: {
      tasks: { open: 0 }, missions: { active: 0 }, automations: { total: 0 },
      income: { pending: 0 }, events: { total: 0 }, notifications: { unread: 0 },
    } },
    "/watch": { json: { ok: true, checked_at: new Date().toISOString(), text: "", sources: [] } },
    "/watch/inbox": { json: { ok: true, items: [], secret_set: true, unread: 0, token: "", path: "" } },
    "/capabilities": () => ({ json: {
      packs: state.packs,
      commands: state.commands.filter(
        (c) => state.packs.find((p) => p.key === c.pack)?.enabled),
    } }),
    "/capabilities/packs": (call) => {
      const want = ((call.body as { packs?: string[] })?.packs) ?? [];
      state.packs = state.packs.map((p) => ({ ...p, enabled: p.always || want.includes(p.key) }));
      return { json: { ok: true, packs: state.packs.filter((p) => p.enabled).map((p) => p.key) } };
    },
    "/setup/pending": () => ({ json: state.pending }),
    "/command": (call) => {
      const text = String((call.body as { text?: string })?.text ?? "").trim();
      const name = text.replace(/^[#＃]/, "").split(/[\s　]/)[0];
      const hit = state.commands.find((c) => c.cmd === name);
      if (!hit) return { json: { ok: false, unknown: true } };
      if (hit.view) return { json: { ok: true, kind: "view", view: hit.view, label: hit.label } };
      const rest = text.slice(text.indexOf(name) + name.length).trim();
      if (hit.arg && !rest) {
        return { json: { ok: false, kind: "needs_arg", message: `${hit.arg}を書いてください`, cmd: hit.cmd } };
      }
      return { json: { ok: true, kind: "done", tool: `tool_${hit.cmd}`, result: `${hit.label}：やりました` } };
    },
  };
}

/** その page の通信を差し替える。テストの先頭で1回呼ぶ。 */
export async function mockBackend(page: Page, over: Record<string, Reply> = {}): Promise<Backend> {
  const state: State = {
    packs: PACKS.map((p) => ({ ...p })),
    commands: COMMANDS.map((c) => ({ ...c })),
    pending: { waiting: false },
  };
  const table: Record<string, Reply> = { ...defaults(state), ...over };
  const be: Backend = {
    calls: [],
    latency: 0,
    state,
    reset() { be.calls = []; },
    count: (p) => be.calls.filter((c) => c.path === p).length,
    duplicates: () => [...new Set(be.calls.map((c) => c.path))]
      .filter((p) => be.count(p) > 1)
      .map((p) => `${p}×${be.count(p)}`),
    set(p, reply) { table[p] = reply; },
  };

  await page.route("**/127.0.0.1:8099/**", async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let body: unknown = null;
    try { body = req.postData() ? JSON.parse(req.postData()!) : null; } catch { body = req.postData(); }
    const call: Call = { path, method: req.method(), body, at: Date.now() };
    be.calls.push(call);

    if (be.latency) await new Promise((r) => setTimeout(r, be.latency));

    const hit = table[path];
    const out = typeof hit === "function" ? hit(call) : hit;
    // 書いていないパスは当たり障りのない形で返す（画面を落とさない）
    const payload = out ?? { json: { ok: true, items: [], keys: [], events: [] } };
    await route.fulfill({
      status: payload.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(payload.json),
    });
  });

  return be;
}

/** 起動して、使える状態まで待つ。 */
export async function enterApp(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByText("ENTER").first().click();
  // 会話欄が出た＝使えるようになった
  await page.locator("textarea").first().waitFor({ timeout: 20_000 });
}

/** 管理タブのその面を開く。 */
export async function openManage(page: Page, label: string) {
  await page.getByLabel("Mobile navigation").getByText("管理", { exact: true }).click();
  await page.getByRole("button", { name: label, exact: true }).click();
}
