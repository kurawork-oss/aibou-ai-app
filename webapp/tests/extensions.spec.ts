/**
 * 拡張機能の台帳の検証。
 *
 * ここは「入れる理由」を書く場所なので、嘘があると一番きつい。
 * 実装が無い機能を unlocks に書けば、入れたのに動かないことになる。
 * 取り方が抜けていれば、値を持っていない人はそこで止まる。
 */

import { test, expect } from "@playwright/test";
import {
  EXTENSIONS, GROUP_LABEL, GROUP_ORDER, NO_KEY_FEATURES, connectedCount, isConnected,
  visibleExtensions,
} from "../src/lib/extensions";

test("どの拡張にも「できるようになること」と「取り方」がある", () => {
  for (const e of EXTENSIONS) {
    expect(e.unlocks.length, `${e.id} の unlocks`).toBeGreaterThan(0);
    expect(e.howto.length, `${e.id} の howto`).toBeGreaterThan(0);
    expect(e.tagline.length, `${e.id} の tagline`).toBeGreaterThan(4);
    // 見出しに専門用語だけを置かない（何のサービスか分かる名前にする）
    expect(e.name.length).toBeGreaterThan(1);
  }
});

test("idが重複していない（重複すると別のカードが同じ鍵を消し合う）", () => {
  const ids = EXTENSIONS.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("鍵の名前が拡張をまたいで重複していない", () => {
  // 同じ鍵を2つのカードが持つと、片方で「連携を外す」ともう片方が黙って壊れる
  const seen = new Map<string, string>();
  for (const e of EXTENSIONS) {
    for (const f of e.fields) {
      expect(seen.has(f.name), `${f.name} が ${seen.get(f.name)} と ${e.id} で重複`).toBe(false);
      seen.set(f.name, e.id);
    }
  }
});

test("グループはすべて表示できる（ラベルの付け忘れが無い）", () => {
  for (const e of EXTENSIONS) {
    expect(GROUP_ORDER).toContain(e.group);
    expect(GROUP_LABEL[e.group]).toBeTruthy();
  }
});

test("必須項目がそろって初めて「連携済み」になる", () => {
  const line = EXTENSIONS.find((e) => e.id === "line")!;
  // LINEは宛先IDが任意。トークンだけで連携済みとみなす
  expect(isConnected(line, new Set(["LINE_CHANNEL_TOKEN"]))).toBe(true);
  expect(isConnected(line, new Set(["LINE_TO_USER_ID"]))).toBe(false);

  const notion = EXTENSIONS.find((e) => e.id === "notion")!;
  // Notionは2つとも要る。片方だけで「済み」にすると、押しても動かない
  expect(isConnected(notion, new Set(["NOTION_TOKEN"]))).toBe(false);
  expect(isConnected(notion, new Set(["NOTION_TOKEN", "NOTION_PARENT_ID"]))).toBe(true);
});

test("入力欄が無いものを「連携済み」と数えない", () => {
  const supabase = EXTENSIONS.find((e) => e.id === "supabase")!;
  expect(supabase.fields).toHaveLength(0);
  expect(isConnected(supabase, new Set())).toBe(false);
});

test("持ち主専用の拡張は、他の人には出さない", () => {
  const owner = visibleExtensions(true);
  const member = visibleExtensions(false);
  expect(owner.length).toBeGreaterThan(member.length);
  expect(member.some((e) => e.ownerOnly)).toBe(false);
  // 判定が返る前（null）は隠す側に倒す
  expect(visibleExtensions(null).some((e) => e.ownerOnly)).toBe(false);
});

test("連携済みの数え方", () => {
  const set = new Set(["GEMINI_API_KEY", "SLACK_WEBHOOK"]);
  expect(connectedCount(visibleExtensions(false), set)).toBe(2);
  expect(connectedCount(visibleExtensions(false), new Set())).toBe(0);
});

test("任意項目だけでは連携済みにならない", () => {
  // メールはサーバー名が任意。アドレスとパスワードが要る
  const email = EXTENSIONS.find((e) => e.id === "email")!;
  expect(isConnected(email, new Set(["EMAIL_SMTP_HOST", "EMAIL_IMAP_HOST"]))).toBe(false);
  expect(isConnected(email, new Set(["EMAIL_ADDRESS", "EMAIL_PASSWORD"]))).toBe(true);
});

test("実装が無いサービスを載せていない", () => {
  // 実際に起きた: OpenAI と Leonardo の鍵の欄はあったが、llm.py も imagegen.py も
  // 見ていなかった。「連携するとこれができます」と書いてある以上、動かないと嘘になる。
  // Leonardo は実装が無いので台帳から外し、OpenAI は実装を足して残した。
  const ids = EXTENSIONS.map((e) => e.id);
  for (const dead of ["leonardo", "youtube", "shutterstock"]) {
    expect(ids, `${dead} は実装が無い`).not.toContain(dead);
  }
  expect(ids).toContain("openai");
});

test("保存先はこの画面の中で設定できる（別の画面に送らない）", () => {
  // 「設定→KEYCHAINへ」と案内していたが、そこから設定できないなら
  // 拡張機能として置いている意味がない
  const supabase = EXTENSIONS.find((e) => e.id === "supabase")!;
  expect(supabase.kind).toBe("database");
  expect(supabase.howto.join("")).not.toContain("つなぐ");
});

test("LINE は終了した方式を案内していない", () => {
  const line = EXTENSIONS.find((e) => e.id === "line")!;
  // LINE Notify は2025年3月末で終了。手順に混ぜると必ず失敗する
  expect(line.fields.map((f) => f.name)).toContain("LINE_CHANNEL_TOKEN");
  expect(line.fields.map((f) => f.name)).not.toContain("LINE_NOTIFY_TOKEN");
  expect(line.warning).toContain("終了");
  expect(line.howto.join("")).toContain("Messaging API");
});

test("Xは、取り消せないことと自動投稿しないことを書いている", () => {
  const x = EXTENSIONS.find((e) => e.id === "x")!;
  // 投稿は取り返しがつかない。押す前に分かるようにする
  expect(x.warning).toContain("取り消せません");
  expect(x.warning).toContain("自動実行からは投稿しません");
  // 4つそろわないと投稿できない
  expect(x.fields).toHaveLength(4);
  expect(x.fields.every((f) => f.secret)).toBe(true);
  expect(isConnected(x, new Set(["X_API_KEY"]))).toBe(false);
  expect(isConnected(x, new Set(
    ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]))).toBe(true);
  // 権限の落とし穴（Read のままだと投稿できない）を手順に書く
  expect(x.howto.join("")).toContain("Read and write");
});

test("鍵が要らない機能を、要らないと書いてある", () => {
  // 「一覧に無い＝できない」と読まれるのを防ぐ
  expect(NO_KEY_FEATURES.length).toBeGreaterThan(2);
  const titles = NO_KEY_FEATURES.map((f) => f.title).join(" ");
  expect(titles).toContain("画像");
  expect(titles).toContain("動画");
  for (const f of NO_KEY_FEATURES) {
    expect(f.where.length, `${f.title} にどこで使うかが無い`).toBeGreaterThan(2);
  }
});

test("強い権限を扱うものには注意書きがある", () => {
  for (const id of ["supabase", "slack", "email", "x"]) {
    const e = EXTENSIONS.find((x) => x.id === id)!;
    expect(e.warning, `${id} に注意書きが無い`).toBeTruthy();
  }
});

test("秘密の値は secret 指定になっている", () => {
  // secret でないと入力が画面に残り、肩越しに見える
  const mustHide = [
    "GEMINI_API_KEY", "OPENAI_API_KEY", "HUGGINGFACE_TOKEN", "GITHUB_TOKEN",
    "SLACK_WEBHOOK", "DISCORD_WEBHOOK", "LINE_CHANNEL_TOKEN",
    "EMAIL_PASSWORD", "GOOGLE_CLIENT_SECRET", "NOTION_TOKEN",
    "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET",
  ];
  const byName = new Map(EXTENSIONS.flatMap((e) => e.fields.map((f) => [f.name, f] as const)));
  for (const n of mustHide) {
    expect(byName.get(n)?.secret, `${n} が伏せられていない`).toBe(true);
  }
});
