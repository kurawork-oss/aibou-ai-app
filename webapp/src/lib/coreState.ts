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
 * なぜ「動いている」を足したか
 * ----------------------------
 * これまでの4つは、全部「喋ること」に関する状態だった。
 *
 *     待機 / 聞いている / 喋っている / 考えている
 *
 * ところがこのアプリは、頼まれたら**実際に手を動かす**（絵を描く・資料を
 * 作る・調べる・送る）。画像の生成は10秒かかることがある。その10秒間、
 * コアは「考えている」のまま、ゆっくり回っていた。考えているのではなく、
 * 作っている。見ている側からは、止まっているのと区別が付かない。
 *
 * 手を動かしている間だけ、コアがはっきり別の顔になる。何かが起きている
 * ことが、文字を読まなくても分かるようにする。
 */

export type CoreState = "idle" | "listening" | "speaking" | "thinking" | "working";

export interface CoreSignals {
  /** マイクが開いている（利用者が話している） */
  listening?: boolean;
  /** 読み上げている */
  speaking?: boolean;
  /** 道具を動かしている（作っている・調べている・送っている） */
  acting?: boolean;
  /** 返事を受け取っている途中 */
  streaming?: boolean;
}

/**
 * いくつも同時に立つので、強い順に決める。
 *
 *   聞いている > 動かしている > 喋っている > 考えている > 待機
 *
 * 「聞いている」が最優先なのは、そこだけ**利用者の番**だから。こちらの
 * 都合で上書きすると、話しかけているのに反応が無いように見える。
 */
export function coreStateOf(s: CoreSignals): CoreState {
  if (s.listening) return "listening";
  if (s.acting) return "working";
  if (s.speaking) return "speaking";
  if (s.streaming) return "thinking";
  return "idle";
}

/** HUDに出す呼び名。細い英字で揃えている所なので英語。 */
export function coreStateLabel(state: CoreState): string {
  switch (state) {
    case "listening": return "LISTENING";
    case "speaking": return "SPEAKING";
    case "thinking": return "THINKING";
    case "working": return "EXECUTING";
    default: return "ONLINE";
  }
}
