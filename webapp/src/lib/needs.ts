/**
 * 「この画面を使うには何が要るか」と、失敗したときの言い換え。
 *
 * 素のエラー（GitHub repos failed (401) など）をそのまま出すと、利用者には
 * 何をすればいいのか分からない。数字と英語ではなく、次にやることを出す。
 *
 * ここは純粋な関数だけにしてある（通信もReactも触らない）ので、テストで
 * 実際のエラー文を通して確かめられる。
 */

/** 画面が動くために必要な鍵。KEYCHAIN の名前と、やさしい言い方。 */
export interface Need {
  /** KEYCHAIN に保存する名前。 */
  key: string;
  /** 何のためのものか（専門用語を避ける）。 */
  label: string;
  /** 無くても使える機能があるなら true（画面全体は止めない）。 */
  optional?: boolean;
  /** 取りに行く場所。 */
  where?: string;
}

export const NEED: Record<string, Need> = {
  GEMINI_API_KEY: {
    key: "GEMINI_API_KEY",
    label: "AIを動かすための利用券",
    where: "aistudio.google.com/app/apikey で無料で取れます",
  },
  GITHUB_TOKEN: {
    key: "GITHUB_TOKEN",
    label: "GitHub（プログラムの保管場所）とつなぐための鍵",
    optional: true,
    where: "GitHub → Settings → Developer settings → Fine-grained tokens",
  },
  NOTION_TOKEN: {
    key: "NOTION_TOKEN",
    label: "Notion にメモを書き込むための鍵",
    optional: true,
  },
  GOOGLE_CLIENT_ID: {
    key: "GOOGLE_CLIENT_ID",
    label: "Googleカレンダー・Gmail とつなぐための設定",
    optional: true,
  },
  EMAIL_ADDRESS: {
    key: "EMAIL_ADDRESS",
    label: "メールを送るためのアドレス設定",
    optional: true,
  },
};

/** 画面ごとに必要なもの（上から順に大事な順）。 */
export const MODE_NEEDS: Record<string, string[]> = {
  chat: ["GEMINI_API_KEY"],
  home: ["GEMINI_API_KEY"],
  vault: ["GEMINI_API_KEY"],
  studio: ["GEMINI_API_KEY"],
  capture: ["GEMINI_API_KEY"],
  sns: ["GEMINI_API_KEY"],
  code: ["GEMINI_API_KEY", "GITHUB_TOKEN"],
  autopilot: ["GEMINI_API_KEY"],
  // board（ホワイトボード）は入れない。付箋・線・保存はAIを使わず、
  // 鍵が無くても最後まで使える。それでも画面の頭に「先に設定が必要です」
  // と出していたので、使える物を使えないと言っていた。
  // AIを使うのは AUTOMATION タブだけなので、案内はそちらに置く。
  board_auto: ["GEMINI_API_KEY"],
};

/**
 * 通信の失敗を、次にやることが分かる日本語にする。
 *
 * とくに 401 は「利用者が悪い」のではなく、たいてい設定が済んでいない。
 * 「401」とだけ出すのが一番不親切なので、原因の候補まで書く。
 */
export function explain(err: unknown, what = "この操作"): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");

  if (/\(401\)/.test(msg)) {
    return "サーバーがログインを確認できませんでした。"
      + "一度サインアウトして入り直してください。"
      + "それでも直らない場合は、管理者にサーバー側の設定（SUPABASE_JWT_SECRET）の"
      + "確認を依頼してください。";
  }
  if (/\(403\)/.test(msg)) {
    return "この機能は管理者専用です。";
  }
  if (/\(409\)/.test(msg)) {
    // 保存先が無いのに保存しようとした。以前は黙って受け取って消えていた
    return "保存先がつながっていないため、保存できませんでした。"
      + "拡張機能（EXTEND）→ Supabase から自分のデータベースを接続してください。"
      + "接続するまで、作ったものは残りません。";
  }
  if (/\(404\)/.test(msg)) {
    return `${what}の宛先が見つかりませんでした。設定 → DIAGNOSTICS で接続先を確認してください。`;
  }
  if (/\(429\)/.test(msg)) {
    return "短い時間に使いすぎました。少し待ってからもう一度お試しください。";
  }
  if (/\(50\d\)|\(503\)/.test(msg)) {
    return "サーバー側で用意ができていません。設定 → KEYCHAIN に必要な鍵が入っているか確認してください。";
  }
  if (/Failed to fetch|NetworkError|Load failed|ネットワーク/i.test(msg)) {
    return "サーバーに繋がりませんでした。通信状況を確認して、もう一度お試しください。";
  }
  if (/NEXT_PUBLIC_API_URL/.test(msg)) {
    return "接続先が設定されていません。管理者に確認してください。";
  }
  // 知らないものは握りつぶさず、そのまま見せる（原因の手掛かりを消さない）
  return msg || `${what}に失敗しました。`;
}

/** 足りない鍵の案内文。 */
export function needMessage(need: Need): string {
  const base = `この画面を使うには「${need.label}」が必要です。`
    + "設定（右上の歯車）→ KEYCHAIN から入れてください。";
  return need.where ? `${base}（${need.where}）` : base;
}
