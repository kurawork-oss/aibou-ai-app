/**
 * secretsGuard.ts — 秘密を、端末の記憶に入れない（仕様§12・§22）。
 *
 * なぜ端末側にも要るのか
 * ----------------------
 * 記憶は端末の中（IndexedDB）とサーバー側の両方にある。サーバー側だけで
 * 止めても、**端末に残った鍵は合流でサーバーへ上がる**（memorySync）。
 * どちらの入口にも同じ関門を置く。
 *
 * 記憶はあとで会話に混ぜてAIへ渡る。一度でも鍵を口にすると、以後ずっと
 * 毎回それが送られる。鍵は暗号化して持つ物であって、記憶が持つ物ではない。
 *
 * どちらへ倒すか
 * --------------
 * **迷ったら入れない。** 鍵らしき文字列を覚え損ねても、失うのは利便性だけ。
 * 逆を間違えると、秘密が残り続ける。
 *
 * ただし「パスワードを変えた」「GEMINI_API_KEY を設定した」のような
 * **値を含まない文**は、ふつうの記憶として残す。そこまで弾くと生活の
 * 記録が穴だらけになり、しかも本人には理由が分からない。
 *
 * サーバー側（api/secrets_guard.py）と**同じ形**を見る。片方だけ直すと、
 * 端末で弾いた物がサーバーで通る（またはその逆）ので、変えるときは両方。
 */

export const MASK = "〈伏せました〉";

/** (なぜ弾いたか, 形) の組。理由に鍵そのものは載せない。 */
const PATTERNS: [string, RegExp][] = [
  ["Googleのキー", /\bAIza[0-9A-Za-z\-_]{30,}/],
  ["OpenAI・Claudeのキー", /\bsk-[A-Za-z0-9\-_]{20,}/],
  ["HuggingFaceのトークン", /\bhf_[A-Za-z0-9]{20,}/],
  ["GitHubのトークン", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["Slackのトークン", /\bxox[baprs]-[A-Za-z0-9\-]{10,}/],
  ["Notionのトークン", /\b(?:secret|ntn)_[A-Za-z0-9]{20,}/],
  ["署名つきトークン（JWT）", /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/],
  ["秘密鍵", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["接続文字列（パスワード入り）", /\b[a-z][a-z0-9+.\-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/],
  ["AWSのキー", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  // ← 足すときは api/secrets_guard.py にも同じ名前で足すこと（テストが見張る）
];

/* 「パスワードは ○○」の形。値が続いているときだけ弾く——
   「パスワードを変えた」は残す。語だけで弾くと、生活の記録が消える。 */
const PASSWORD = /(?:パスワード|ぱすわーど|password|passwd|pass\s*phrase|パスフレーズ|暗証番号)\s*(?:は|が|:|：|=)\s*(\S{6,})/;

/** 弾く理由。弾かないなら空文字。 */
export function secretReason(text: string | null | undefined): string {
  const s = (text || "").trim();
  if (!s) return "";
  for (const [name, pat] of PATTERNS) {
    if (pat.test(s)) return `${name}らしき文字列が含まれています`;
  }
  if (PASSWORD.test(s)) return "パスワードらしき文字列が含まれています";
  return "";
}

export function hasSecret(text: string | null | undefined): boolean {
  return secretReason(text) !== "";
}

/** 鍵の所だけ伏せて、文は残す（画面やログに出すとき用）。 */
export function redact(text: string | null | undefined): string {
  let s = text || "";
  if (!s) return s;
  for (const [, pat] of PATTERNS) {
    s = s.replace(new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g"), MASK);
  }
  s = s.replace(new RegExp(PASSWORD.source, "g"), (m, val) => m.replace(val, MASK));
  return s;
}
