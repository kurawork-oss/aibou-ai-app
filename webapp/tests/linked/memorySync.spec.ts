/**
 * 端末の記憶とサーバーの記憶の合流を、実際のブラウザで確かめる。
 *
 * ここで見たいこと
 * ----------------
 * 合流の不具合は**その場では見えない**。
 *
 *   上がっていない   → 機種変した日に、全部消えていたと気づく
 *   降りてこない     → 2台目がいつまでも空。故障には見えない
 *   墓標が運ばれない → 「忘れて」と言ったことが、別の端末から復活する
 *
 * サーバー側の合流そのものは api/test_memory_sync.py で見ている。
 * こちらで見るのは**端末側**——本当に IndexedDB へ入るか、本当に
 * 送り出すか、繋がっていないときに嘘をつかないか。
 *
 * 「2台目の端末」は、IndexedDB と合流の目印を消して作る。
 * 新しい端末で同じアカウントに入った状態と、中身は同じ。
 */

import { test, expect, type Page } from "@playwright/test";
import { mockBackend, type Backend } from "./backend";

interface Row {
  id: string; text: string; kind: string; importance: number;
  createdAt: number; updatedAt: number; deletedAt?: number;
}

/** サーバー側の記憶を覚えている差し替え。合流の形だけ本物と揃えてある。 */
function memoryServer(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
  let blocked: string | null = null;
  /** サーバーの時計のずれ（ミリ秒）。端末との食い違いを作るため。 */
  let skew = 0;

  return {
    rows,
    /** サーバーの時計を進める／遅らせる。 */
    setSkew(ms: number) { skew = ms; },
    /** サーバーが断る状態にする（保存先が無い／表が古い）。 */
    block(reason: string | null) { blocked = reason; },
    all(): Row[] { return [...rows.values()]; },
    reply(call: { body: unknown }) {
      if (blocked) return { json: { ok: false, reason: blocked, at: 0, pushed: 0, pulled: 0, items: [] } };
      const body = (call.body ?? {}) as { since?: number; items?: Row[] };
      const since = Number(body.since) || 0;

      // 先に受け取る（本物と同じ順。逆だと、いま上げた物がそのまま降りてくる）
      const out = [...rows.values()].filter((r) => (r.updatedAt || 0) > since);

      let pushed = 0;
      for (const it of body.items ?? []) {
        const cur = rows.get(it.id);
        if (cur && (cur.updatedAt || 0) >= (it.updatedAt || 0)) continue;   // 新しいほうが勝つ
        rows.set(it.id, { ...it, text: it.deletedAt ? "" : it.text });      // 墓標は中身を残さない
        pushed++;
      }
      return { json: { ok: true, at: Date.now() + skew, pushed, pulled: out.length, items: out } };
    },
  };
}

async function enterApp(page: Page) {
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offline = page.getByText("ENTER OFFLINE");
  const settings = page.getByLabel("Settings");
  await Promise.race([
    offline.waitFor({ timeout: 8_000 }).then(() => offline.click()).catch(() => {}),
    settings.waitFor({ timeout: 10_000 }).catch(() => {}),
  ]);
  await expect(settings).toBeVisible({ timeout: 10_000 });
}

async function openMemory(page: Page) {
  await page.getByLabel("Settings").click();
  await expect(page.getByText("覚えていること")).toBeVisible({ timeout: 8_000 });
}

async function remember(page: Page, text: string) {
  await page.getByLabel("覚えておいてほしいこと").fill(text);
  await page.getByRole("button", { name: "覚える" }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 5_000 });
}

/** この端末を「新しい端末」にする（記憶も、どこまで合流したかも捨てる）。 */
async function becomeNewDevice(page: Page) {
  await page.evaluate(async () => {
    localStorage.removeItem("forge_mem_sync_at");
    localStorage.removeItem("forge_mem_sync_ran");
    await new Promise<void>((done) => {
      const req = indexedDB.deleteDatabase("forge-memory");
      req.onsuccess = () => done();
      req.onerror = () => done();
      req.onblocked = () => done();
      setTimeout(done, 2000);
    });
  });
}

async function setup(page: Page, server: ReturnType<typeof memoryServer>): Promise<Backend> {
  return mockBackend(page, { "/memory/sync": (call) => server.reply(call) });
}

/* ── 上がること ─────────────────────────────────────────────────── */

test("端末で覚えたことが、サーバーへ上がる", async ({ page }) => {
  /* これまで端末の記憶は1件も上がっていなかった。機種変した時点で
     消えることに、その日まで気づけない。 */
  const server = memoryServer();
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  await remember(page, "甲殻類アレルギーがある");
  await page.getByRole("button", { name: "いま揃える" }).click();

  await expect(async () => {
    expect(server.all().map((r) => r.text)).toContain("甲殻類アレルギーがある");
  }).toPass({ timeout: 10_000 });
});

test("サーバーの時計が進んでいても、記憶は上がり続ける", async ({ page }) => {
  /* 目印を1つで済ませていたときのバグ。

     サーバーが返した時刻（サーバーの時計）で、端末側の「送るぶん」まで
     絞っていた。サーバーの時計が端末より進んでいると、**一度合流した
     あとに覚えたことが全部「前回より前」に見えて、二度と上がらない**。
     画面には「揃っています」と出るので、機種変の日まで気づけない。

     時計は実際ずれる（サーバーはUTC、端末は手動設定、NTPの遅れ）ので、
     ここは想定ではなく前提。 */
  const server = memoryServer();
  server.setSkew(86_400_000);          // サーバーの時計が1日進んでいる
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);
  // ここで一度合流が走り、未来の目印が入る
  await expect(page.getByText(/揃っています|件を上げ/)).toBeVisible({ timeout: 10_000 });

  await remember(page, "時計がずれていても覚える");
  await page.getByRole("button", { name: "いま揃える" }).click();

  await expect(async () => {
    expect(server.all().map((r) => r.text), "時計のずれで記憶が上がっていない")
      .toContain("時計がずれていても覚える");
  }).toPass({ timeout: 10_000 });
});

/* ── 降りてくること ─────────────────────────────────────────────── */

test("サーバーが覚えていることが、この端末にも入る", async ({ page }) => {
  const now = Date.now();
  const server = memoryServer([
    { id: "s1", text: "打ち合わせは毎週火曜の15時から", kind: "fact",
      importance: 1, createdAt: now, updatedAt: now },
  ]);
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  // 開いたときに自分で揃えに行く（押させないと、空のままだと気づけない）
  await expect(page.getByText("打ち合わせは毎週火曜の15時から", { exact: true }))
    .toBeVisible({ timeout: 10_000 });
});

test("2台目の端末が、空のままにならない", async ({ page }) => {
  /* この一本が、合流を足した理由そのもの。
     1台目で覚える → 端末の中身を捨てる（＝新しい端末）→ 戻ってくるか。 */
  const server = memoryServer();
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  await remember(page, "猫を飼っている。名前はミケ");
  await remember(page, "健康診断は毎年10月");
  await page.getByRole("button", { name: "いま揃える" }).click();
  await expect(async () => {
    expect(server.all().length).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 10_000 });

  await becomeNewDevice(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await openMemory(page);

  await expect(page.getByText("猫を飼っている。名前はミケ", { exact: true }))
    .toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("健康診断は毎年10月", { exact: true })).toBeVisible();
});

test("降りてきた記憶は、会話のときにも思い出せる", async ({ page }) => {
  /* 一覧に出るだけでは足りない。会話で引けなければ、記憶として働かない。
     引き方は端末側（recall.ts）なので、入った物が同じ索引に乗っているか。 */
  const now = Date.now();
  const server = memoryServer([
    { id: "s1", text: "妹の誕生日は3月12日", kind: "fact", importance: 1,
      createdAt: now, updatedAt: now },
    { id: "s2", text: "コーヒーはブラック", kind: "note", importance: 0,
      createdAt: now, updatedAt: now },
    { id: "s3", text: "朝は7時に起きる", kind: "note", importance: 0,
      createdAt: now, updatedAt: now },
    { id: "s4", text: "経費精算は月末まで", kind: "note", importance: 0,
      createdAt: now, updatedAt: now },
    { id: "s5", text: "本は Kindle で読む", kind: "note", importance: 0,
      createdAt: now, updatedAt: now },
  ]);
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);
  await expect(page.getByText("妹の誕生日は3月12日", { exact: true }))
    .toBeVisible({ timeout: 10_000 });

  const box = page.getByLabel("覚えていることを探す");
  await expect(box).toBeVisible();
  await box.fill("妹 誕生日");
  await page.waitForTimeout(400);
  await expect(page.getByText("妹の誕生日は3月12日", { exact: true })).toBeVisible();
  await expect(page.getByText("コーヒーはブラック", { exact: true })).toHaveCount(0);
});

/* ── 消したこと ─────────────────────────────────────────────────── */

test("この端末で忘れさせたら、サーバー側にも伝わる", async ({ page }) => {
  const server = memoryServer();
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  await remember(page, "住所は東京都のどこか");
  await page.getByRole("button", { name: "いま揃える" }).click();
  await expect(async () => {
    expect(server.all().some((r) => r.text === "住所は東京都のどこか")).toBeTruthy();
  }).toPass({ timeout: 10_000 });

  await page.getByRole("button", { name: /住所は東京都のどこか を忘れる/ }).click();
  await expect(page.getByText("住所は東京都のどこか", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "いま揃える" }).click();

  await expect(async () => {
    const row = server.all().find((r) => r.id && r.deletedAt);
    expect(row, "消したことが伝わっていない（別の端末から復活する）").toBeTruthy();
    expect(row!.text, "消したのに中身が残っている").toBe("");
  }).toPass({ timeout: 10_000 });
});

test("別の端末で消したことが、この端末にも届く", async ({ page }) => {
  const now = Date.now();
  const server = memoryServer([
    { id: "g1", text: "消される予定の記憶", kind: "note", importance: 0,
      createdAt: now - 5000, updatedAt: now - 5000 },
  ]);
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);
  await expect(page.getByText("消される予定の記憶", { exact: true }))
    .toBeVisible({ timeout: 10_000 });

  // 別の端末が消した、という状態をサーバー側に作る
  server.rows.set("g1", { id: "g1", text: "", kind: "note", importance: 0,
                          createdAt: now - 5000, updatedAt: Date.now(), deletedAt: Date.now() });

  await page.getByRole("button", { name: "いま揃える" }).click();
  await expect(page.getByText("消される予定の記憶", { exact: true }))
    .toHaveCount(0, { timeout: 10_000 });
});

/* ── 嘘をつかないこと ───────────────────────────────────────────── */

test("サーバーが断ったら、その理由をそのまま出す", async ({ page }) => {
  /* 「揃えました」と出して何も起きていない、がいちばん困る。
     表が古いDBは実際にこの形で断る。 */
  const server = memoryServer();
  server.block("データベースの表が古いため合流できません。設定 → データベースの更新を実行してください。");
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  await expect(page.getByText(/データベースの表が古いため/)).toBeVisible({ timeout: 10_000 });
});

test("揃ったときは、上げた数と受け取った数を出す", async ({ page }) => {
  const server = memoryServer();
  await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  await remember(page, "パスワードマネージャは 1Password");
  await page.getByRole("button", { name: "いま揃える" }).click();
  await expect(page.getByText(/件を上げ、.*件を受け取りました/)).toBeVisible({ timeout: 10_000 });
});

/* ── 設定画面を開かなくても揃うこと ─────────────────────────────── */

test("アプリを開くだけで、記憶が揃う（設定を開かなくても）", async ({ page }) => {
  /* ここが無かった間、合流は「記憶の画面を開いたとき」だけだった。
     つまり**2台目の端末は、設定を開くまで空のまま会話する**——
     記憶を合流させた意味が、いちばん効いてほしい場所で出ない。 */
  const now = Date.now();
  const server = memoryServer([
    { id: "s1", text: "甲殻類アレルギーがある", kind: "fact", importance: 2,
      createdAt: now, updatedAt: now },
  ]);
  const be = await setup(page, server);
  await page.goto("/");
  await enterApp(page);

  // 設定にも記憶の画面にも触らない
  await expect(async () => {
    expect(be.count("/memory/sync"), "開いただけでは揃えに行かない").toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });

  // 本当に端末へ入っている（会話で引ける状態）
  await expect(async () => {
    const n = await page.evaluate(async () => {
      const req = indexedDB.open("forge-memory", 1);
      return new Promise<number>((done) => {
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction("items", "readonly").objectStore("items").getAll();
          all.onsuccess = () => { done((all.result || []).length); db.close(); };
          all.onerror = () => { done(-1); db.close(); };
        };
        req.onerror = () => done(-1);
      });
    });
    expect(n, "揃えに行ったのに、端末へ入っていない").toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
});

test("画面を行き来しても、開くたびに揃え直さない", async ({ page }) => {
  // 起動の合流は1回だけ。タブを押すたびに通信すると、そのぶん遅くなる
  const server = memoryServer();
  const be = await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await expect(async () => {
    expect(be.count("/memory/sync")).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });

  const after = be.count("/memory/sync");
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "✕" }).click();
  await page.waitForTimeout(3000);
  expect(be.count("/memory/sync") - after,
    "画面を開け閉てするたびに揃えに行っている").toBeLessThanOrEqual(1);
});

/* ── 運びすぎないこと ───────────────────────────────────────────── */

test("開くたびに、全部を送り直さない", async ({ page }) => {
  /* 目印（どこまで運んだか）が効いていないと、記憶が増えるほど
     設定画面を開くのが重くなる。 */
  const server = memoryServer();
  const be = await setup(page, server);
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);
  await remember(page, "記憶その1");
  await remember(page, "記憶その2");
  await page.getByRole("button", { name: "いま揃える" }).click();
  await expect(async () => {
    expect(server.all().length).toBe(2);
  }).toPass({ timeout: 10_000 });

  be.reset();
  await page.getByRole("button", { name: "いま揃える" }).click();
  await expect(async () => {
    expect(be.count("/memory/sync")).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });

  const sent = be.calls.filter((c) => c.path === "/memory/sync")
    .map((c) => ((c.body as { items?: unknown[] })?.items ?? []).length);
  expect(Math.max(...sent), `送った件数: ${sent.join(",")}`).toBe(0);
});
