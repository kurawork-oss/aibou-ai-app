/**
 * coreState.ts — コアが「いま何をしているか」。
 *
 * なぜ1か所にまとめるか
 * ---------------------
 * これまで、状態を決める式は Chat.tsx の中に、状態の呼び名は page.tsx の
 * 中に、見た目の調整は CoreOrb.tsx の中にあった。3つが別々なので、
 * 状態を足すと**足し忘れた所だけ静かにおかしくなる**（呼び名が
 * "ONLINE" のまま、など）。ここに置いて、3つとも同じ表を見る。
 *
 * なぜ状態を増やすか
 * ------------------
 * 最初の4つは、全部「喋ること」に関する状態だった。
 *
 *     待機 / 聞いている / 喋っている / 考えている
 *
 * ところがこのアプリは、頼まれたら**実際に手を動かす**（絵を描く・資料を
 * 作る・調べる・送る）。画像の生成は10秒かかることがある。その10秒間、
 * コアは「考えている」のまま、ゆっくり回っていた。考えているのではなく、
 * 作っている。見ている側からは、止まっているのと区別が付かない。
 *
 * さらに、**待たれていることに気づけない**状態が2つあった。
 *
 *   ・承認待ち   … 取り消せない操作の前で止まっている
 *   ・設定待ち   … 連携が足りなくて止まっている
 *
 * どちらも「こちらが答えるまで一歩も進まない」のに、コアは待機の顔をして
 * いた。画面から目を離していた人には、終わったように見える。
 *
 * 終わったこと・失敗したことも同じ。終わりが見えないと、人は画面を見張る。
 */

export type CoreState =
  | "idle"            // 待機
  | "listening"       // 聞いている（マイクが開いている）
  | "thinking"        // 考えている
  | "planning"        // 段取りを組んでいる（返事が始まる前の準備）
  | "working"         // 手を動かしている（道具を実行中）
  | "speaking"        // 読み上げている
  | "waiting_user"    // こちらの返事待ち（承認）
  | "setup_required"  // 繋がないと進めない
  | "completed"       // 終わった（少しだけ出して待機へ戻る）
  | "error";          // 失敗した

export interface CoreSignals {
  /** マイクが開いている（利用者が話している） */
  listening?: boolean;
  /** 読み上げている */
  speaking?: boolean;
  /** 道具を動かしている（作っている・調べている・送っている） */
  acting?: boolean;
  /** 返事が始まる前の準備をしている（記憶・ルールの読み込み） */
  planning?: boolean;
  /** 返事を受け取っている途中 */
  streaming?: boolean;
  /** 承認待ちで止まっている（こちらが押すまで進まない） */
  awaiting?: boolean;
  /** 連携が足りなくて止まっている */
  setup?: boolean;
  /** 直前のやりとりが失敗した */
  failed?: boolean;
  /** 直前のやりとりが終わった（少しの間だけ立てる） */
  done?: boolean;
}

/**
 * いくつも同時に立つので、強い順に決める。
 *
 *   聞いている
 *   > 待たれている（承認・設定）
 *   > 失敗
 *   > 手を動かしている
 *   > 喋っている
 *   > 段取り > 考えている
 *   > 終わった
 *   > 待機
 *
 * 「聞いている」が最優先なのは、そこだけ**利用者の番**だから。こちらの
 * 都合で上書きすると、話しかけているのに反応が無いように見える。
 *
 * 「待たれている」がその次なのは、**止まっていることに気づけない**のが
 * いちばん困るため。裏で何かが動いているように見えているあいだ、人は待つ。
 */
export function coreStateOf(s: CoreSignals): CoreState {
  if (s.listening) return "listening";
  if (s.awaiting) return "waiting_user";
  if (s.setup) return "setup_required";
  if (s.failed) return "error";
  if (s.acting) return "working";
  if (s.speaking) return "speaking";
  if (s.planning) return "planning";
  if (s.streaming) return "thinking";
  if (s.done) return "completed";
  return "idle";
}

/** HUDに出す呼び名。細い英字で揃えている所なので英語（仕様§34）。 */
const LABELS: Record<CoreState, string> = {
  idle: "ONLINE",
  listening: "LISTENING",
  thinking: "THINKING",
  planning: "PLANNING",
  working: "EXECUTING",
  speaking: "SPEAKING",
  waiting_user: "WAITING",
  setup_required: "SETUP",
  completed: "COMPLETED",
  error: "ERROR",
};

export function coreStateLabel(state: CoreState): string {
  return LABELS[state] ?? LABELS.idle;
}

/** 全部の状態（テストと、見た目の表の取りこぼしを防ぐのに使う）。 */
export const CORE_STATES = Object.keys(LABELS) as CoreState[];

/**
 * 「終わった」を出しておく長さ。
 *
 * 出しっぱなしにすると、次に何かするまでずっと COMPLETED のままになり、
 * 待機と区別が付かなくなる。短すぎると見逃す。
 */
export const COMPLETED_MS = 1800;


/* ── 見た目の調整 ────────────────────────────────────────────────────
 *
 * これも**ここに置く**。判断（coreStateOf）と呼び名（LABELS）と見た目が
 * 別々のファイルにあると、状態を足したときに足し忘れた所だけ静かに
 * ずれる。3つを並べておけば、1つ足すときに3つとも目に入る。
 *
 * 数字は CoreOrb がそのまま使う（回転・発光・脈・軌道・輪の点滅）。 */
export interface Tune {
  /** Sphere yaw speed (rad/s). */
  spin: number;
  /** Pale-blue bloom alpha. */
  glow: number;
  /** Cyan accent alpha (focus/active). */
  cyan: number;
  /** Core pulse frequency (Hz) and amplitude (fraction of radius). */
  pulseHz: number;
  pulseAmp: number;
  /** Ring spin multiplier — >1 spins faster (more energy). */
  orbit: number;
  /** Halo ping period (s). */
  ping: number;
}

export const TUNES: Record<CoreState, Tune> = {
  idle: { spin: 0.16, glow: 0.30, cyan: 0.04, pulseHz: 0.22, pulseAmp: 0.014, orbit: 1.0, ping: 4.5 },
  listening: { spin: 0.34, glow: 0.42, cyan: 0.38, pulseHz: 0.60, pulseAmp: 0.030, orbit: 2.0, ping: 1.8 },
  speaking: { spin: 0.52, glow: 0.50, cyan: 0.30, pulseHz: 1.10, pulseAmp: 0.045, orbit: 2.6, ping: 1.2 },
  thinking: { spin: 0.28, glow: 0.45, cyan: 0.20, pulseHz: 0.42, pulseAmp: 0.024, orbit: 1.4, ping: 2.6 },
  /* 手を動かしている間。いちばん速く、いちばん明るい。
     10秒かかる仕事でも「何かが起きている」と分かるように、
     考えている（thinking）とははっきり違う顔にする——リングを倍以上
     速く回し、輪の点滅を詰める。ここを thinking の近くにすると、
     見ている側には同じに見えて、足した意味が無くなる。 */
  working: { spin: 0.62, glow: 0.55, cyan: 0.46, pulseHz: 0.90, pulseAmp: 0.038, orbit: 3.2, ping: 0.9 },
  /* 段取りを組んでいる。考えているより落ち着いていて、動き出す前の顔。 */
  planning: { spin: 0.22, glow: 0.38, cyan: 0.14, pulseHz: 0.32, pulseAmp: 0.020, orbit: 1.2, ping: 3.2 },
  /* こちらの返事待ち。**呼んでいる**顔にする——ゆっくり大きく脈打たせて、
     目の端でも「止まって待っている」と分かるようにする。回転は落とす
     （回っていると、裏で進んでいるように見えてしまう）。 */
  waiting_user: { spin: 0.08, glow: 0.50, cyan: 0.42, pulseHz: 0.45, pulseAmp: 0.060, orbit: 0.5, ping: 1.4 },
  /* 繋がないと進めない。待ちと同じ家族だが、もう少し静か。 */
  setup_required: { spin: 0.10, glow: 0.42, cyan: 0.30, pulseHz: 0.38, pulseAmp: 0.048, orbit: 0.6, ping: 2.0 },
  /* 終わった。ひと呼吸だけ明るくして、待機へ戻る。 */
  completed: { spin: 0.30, glow: 0.60, cyan: 0.34, pulseHz: 0.20, pulseAmp: 0.030, orbit: 1.6, ping: 2.2 },
  /* 失敗した。暗く、ほとんど動かさない。速く点滅させると、まだ何か
     やっているように見える。 */
  error: { spin: 0.06, glow: 0.22, cyan: 0.02, pulseHz: 0.70, pulseAmp: 0.016, orbit: 0.3, ping: 5.0 },
};
