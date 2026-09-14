/**
 * firstRun — 「初回設定があと何個残っているか」の判定。
 *
 * 並び順は「これが無いと先が無い」順。保存先を先頭にしているのは、
 * つながっていないとタスクもノートも保存できず（作ると理由が出る）、
 * 後回しにすると作業してから気づくことになるため。
 *
 * 判定だけを画面から切り離しておく。ここが間違うと、設定が済んでいる人に
 * 案内を出し続けたり（うるさい）、済んでいない人に出さなかったり（本題）する。
 * 描画なしで検証できる形にしておきたい。
 */

export type FirstRunStep = {
  key: "guide" | "ai-key" | "db";
  done: boolean;
  title: string;
  hint: string;
};

export type FirstRunInput = {
  /** GET /keys の結果（取れなければ null） */
  keys: { name: string; set: boolean }[] | null;
  /** GET /admin/db/status の結果（取れなければ null） */
  db: { connected: boolean } | null;
  /** 説明書の「はじめる」を1つでも進めたか */
  guideTouched: boolean;
};

/** 会話や生成を動かせる鍵。どちらか1つ入っていれば足りる。 */
const AI_KEYS = ["GEMINI_API_KEY", "HF_TOKEN"];

export function firstRunSteps(input: FirstRunInput): FirstRunStep[] {
  const hasAiKey = !!input.keys?.some((k) => k.set && AI_KEYS.includes(k.name));
  return [
    {
      key: "db",
      done: !!input.db?.connected,
      title: "保存先をつなぐ",
      hint: "自分のSupabaseにつなぐまで、タスク・予定・ノートは保存できません"
        + "（作ろうとすると理由が出ます）。管理 → もっと →「連携」→ Supabase から。",
    },
    {
      key: "guide",
      done: input.guideTouched,
      title: "説明書に目を通す",
      hint: "「はじめる」に、最初にやることが順番に並んでいます。5分ほどです。",
    },
    {
      key: "ai-key",
      done: hasAiKey,
      title: "AIの鍵を入れる",
      hint: "「連携」→ Gemini に鍵を入れると、会話や生成が動きます。無料でとれます。",
    },
  ];
}

/**
 * 案内を出すべきか。
 *
 * 状態がまったく取れないとき（両方 null）は出さない。繋がっていないのが原因で、
 * そこで「鍵を入れて」と促しても直らないし、原因を誤解させる。
 */
export function shouldShowFirstRun(input: FirstRunInput, dismissed: boolean): boolean {
  if (dismissed) return false;
  if (!input.keys && !input.db) return false;
  return firstRunSteps(input).some((s) => !s.done);
}

/** 全部済んだか（済んだら以後は保存して出さない）。 */
export function firstRunComplete(input: FirstRunInput): boolean {
  if (!input.keys && !input.db) return false;
  return firstRunSteps(input).every((s) => s.done);
}
