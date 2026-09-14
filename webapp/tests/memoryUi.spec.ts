/**
 * 端末の中の記憶を、実際のブラウザで確かめる。
 *
 * ここで見たいこと
 * ----------------
 * 記憶の不具合は「覚えていない」という形で出るが、**利用者には
 * 区別が付かない**。覚えなかったのか、思い出せなかったのか、そもそも
 * 保存先が無かったのか。どれも「使えないアプリ」にしか見えない。
 *
 *   ・本当に端末に残るか（再読込して消えないか）
 *   ・バックエンドが無くても覚えられるか ← ここが今回の肝
 *   ・消せるか（覚える機能と同時に無いと、消したい人が詰む）
 *
 * このテストは接続先なし（NEXT_PUBLIC_API_URL 空）で動く。つまり
 * 「Supabase もバックエンドも無い人」の状況そのもの。
 * これまで、その人の記憶は**ゼロ件**だった。
 */

import { test, expect, type Page } from "@playwright/test";

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
  // 記憶は専用のタブへ移した（前は「CORE」という物置の中にあった）
  await page.getByRole("button", { name: "記憶", exact: true }).click();
  await expect(page.getByText("覚えていること")).toBeVisible({ timeout: 8_000 });
}

async function remember(page: Page, text: string) {
  await page.getByLabel("覚えておいてほしいこと").fill(text);
  await page.getByRole("button", { name: "覚える" }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 5_000 });
}

/** 一覧に出ている記憶の本文（並び順のまま）。 */
async function listed(page: Page): Promise<string[]> {
  return page.locator('section:has-text("覚えていること") select')
    .evaluateAll((sels) => sels.map((s) => {
      const card = s.closest("div")?.parentElement;
      return (card?.firstElementChild?.textContent || "").trim();
    }));
}

test("バックエンドが無くても覚えられて、再読込しても残る", async ({ page }) => {
  /* いちばん大事な1本。これまで Supabase が無いと mem_add は false を
     返して何も保存せず、mem_recall は空文字だった——つまり毎回
     はじめましてだった。 */
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  await remember(page, "甲殻類アレルギーがある");
  await remember(page, "打ち合わせは毎週火曜の15時から");

  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await openMemory(page);

  await expect(page.getByText("甲殻類アレルギーがある", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("打ち合わせは毎週火曜の15時から", { exact: true })).toBeVisible();
  // 「この端末の中」＝ちゃんと保存先がある（セッション限りではない）
  await expect(page.getByText(/この端末の中/).first()).toBeVisible();
});

test("同じことを何度言っても、記憶は増えない", async ({ page }) => {
  // 会話のたびに同じ文が積まれると、思い出す側が埋まって使い物にならない
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  for (let i = 0; i < 3; i++) await remember(page, "コーヒーはブラック");

  /* 決め打ちの待ちにしない。2回目以降は**増やさずに触れ直す**だけなので、
     `remember` は文がすでに見えている時点ですぐ返る。そのあと一覧を
     読み直すまでの間に数えると、機械が混んでいるときだけ落ちる
     ——実際、単独では10回通るのに他のファイルと並べると落ちていた。 */
  await expect(async () => {
    const all = await listed(page);
    expect(all.filter((t) => t === "コーヒーはブラック").length,
      `出ている記憶: ${all.join(" / ")}`).toBe(1);
  }).toPass({ timeout: 8_000 });
});

test("覚えたことを忘れさせられる", async ({ page }) => {
  /* 覚える機能と同時に無いと、覚えてほしくないことを覚えたまま
     消せない期間ができる。 */
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  await remember(page, "住所は東京都のどこか");
  await page.getByRole("button", { name: /住所は東京都のどこか を忘れる/ }).click();
  await expect(page.getByText("住所は東京都のどこか", { exact: true })).toHaveCount(0, { timeout: 5_000 });

  // 消したことも残るので、再読込しても復活しない
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await openMemory(page);
  await expect(page.getByText("住所は東京都のどこか", { exact: true })).toHaveCount(0);
});

test("まとめて消せる", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);
  await remember(page, "消される記憶A");
  await remember(page, "消される記憶B");

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "この端末の記憶を全部消す" }).click();
  await expect(page.getByText("まだ何も覚えていません。")).toBeVisible({ timeout: 5_000 });
});

test("探すときの引き方が、会話のときと同じ", async ({ page }) => {
  /* ここだけ部分一致にすると、「画面では出るのに会話では思い出さない」
     というずれが起きて、原因が分からなくなる。
     送り仮名が違っても引けること（打合せ ↔ 打ち合わせ）で見る。 */
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  for (const t of ["打ち合わせは毎週火曜の15時から", "コーヒーはブラック",
                   "妹の誕生日は3月12日", "健康診断は毎年10月",
                   "猫の名前はミケ", "朝は7時に起きる"]) {
    await remember(page, t);
  }

  const box = page.getByLabel("覚えていることを探す");
  await expect(box, "件数が増えても探す欄が出ない").toBeVisible();
  await box.fill("打合せ 何時");
  await page.waitForTimeout(400);

  const hits = await listed(page);
  expect(hits, `出たもの: ${hits.join(" / ")}`).toContain("打ち合わせは毎週火曜の15時から");
  expect(hits, "関係ない記憶まで出ている").not.toContain("コーヒーはブラック");
});

test("大事さを変えられる", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);
  await remember(page, "毎朝の薬を忘れない");

  const sel = page.getByLabel(/毎朝の薬を忘れない の大事さ/);
  await sel.selectOption("2");
  /* 画面に反映されるのは、保存が済んで一覧を読み直したあと。そこを待たずに
     再読込すると、書き込みの途中で切ることになる（実際それで落ちた）。 */
  await expect(sel).toHaveValue("2");
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await openMemory(page);
  await expect(page.getByLabel(/毎朝の薬を忘れない の大事さ/)).toHaveValue("2");
});

test("繋がっていない端末では、合流の欄が嘘をつかない", async ({ page }) => {
  /* この組は接続先なし（NEXT_PUBLIC_API_URL 空）で動く。
     ここで「揃えました」と出たり、押せるのに何も起きないボタンが
     あったりすると、本人は2台目でも揃うつもりで使い続ける。 */
  await page.goto("/");
  await enterApp(page);
  await openMemory(page);

  await expect(page.getByText("サーバーとの合流")).toBeVisible();
  await expect(page.getByText(/接続先が設定されていないため/)).toBeVisible();
  await expect(page.getByRole("button", { name: "いま揃える" })).toBeDisabled();
});

test("会話のかけらは、記憶に入れない", async ({ page }) => {
  /* 発言を全部そのまま覚えていた頃、長期記憶が「うん」「これ直して」で
     埋まっていた。AIへ渡せるのは6件なので、そこが埋まるぶん本当に効く
     記憶が届かない（実測で、6問中3問の上位にかけらが入っていた）。 */
  await page.goto("/");
  await enterApp(page);

  const input = page.getByPlaceholder(/にメッセージ/);
  for (const text of ["ありがとう", "これ直して", "どう？", "了解"]) {
    await input.fill(text);
    await input.press("Enter");
    await page.waitForTimeout(500);
  }
  // 覚えるべきものは、同じ道を通っても残る
  await input.fill("甲殻類アレルギーがある");
  await input.press("Enter");
  await page.waitForTimeout(900);

  await openMemory(page);
  const box = page.locator('section:has-text("覚えていること")');
  await expect(box.getByText("甲殻類アレルギーがある", { exact: true }))
    .toBeVisible({ timeout: 5_000 });
  for (const junk of ["ありがとう", "これ直して", "どう？", "了解"]) {
    await expect(box.getByText(junk, { exact: true }),
      `「${junk}」が記憶に入っている`).toHaveCount(0);
  }
});

test("「覚えて」と言えば、会話からでも強く覚える", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);

  const input = page.getByPlaceholder(/にメッセージ/);
  await input.fill("火曜の午後は打ち合わせ。覚えておいて");
  await input.press("Enter");
  await page.waitForTimeout(1200);

  await openMemory(page);
  const box = page.locator('section:has-text("覚えていること")');
  await expect(box.getByText(/火曜の午後は打ち合わせ/)).toBeVisible({ timeout: 5_000 });
  // 「とても大事」で入っている（上限に達しても残る側）
  await expect(page.getByLabel(/火曜の午後は打ち合わせ.* の大事さ/)).toHaveValue("2");
});

test("会話で話した内容も、端末に残る", async ({ page }) => {
  /* 画面から手で足すだけでは、記憶はほとんど溜まらない。
     話しかけた内容そのものが残ることが、長期記憶の本体。 */
  await page.goto("/");
  await enterApp(page);

  const input = page.getByPlaceholder(/にメッセージ/);
  await input.fill("来月の沖縄旅行が楽しみだ");
  await input.press("Enter");
  await page.waitForTimeout(1200);       // 接続先が無いので返事は失敗する

  await openMemory(page);
  /* 会話の吹き出しにも同じ文が出ているので、記憶の欄の中だけを見る。 */
  await expect(page.locator('section:has-text("覚えていること")')
    .getByText("来月の沖縄旅行が楽しみだ", { exact: true }))
    .toBeVisible({ timeout: 5_000 });
});

/* ── 読み込みの追い越し ────────────────────────────────────────────
 *
 * 画面を開いた直後に「覚える」を押すと、こうなっていた:
 *
 *   画面を開く           → 読み込み①（IndexedDBの初回は遅い）
 *   すぐ「覚える」を押す → 保存 → 読み込み② → 速く返る → 1件
 *   読み込み①が返る     → **押す前の中身（0件）で上書き** → 「0件」
 *
 * 保存はできているので開き直せば出てくる。**画面だけが「保存されて
 * いない」と嘘をつく。** 実測で3回に1回ほど落ちていた。
 *
 * ここでは最初の読み出しをわざと遅らせて、毎回その順番になるようにする
 * （そうしないと「たまに落ちるテスト」が増えるだけで、直ったか分からない）。 */
test("開いた直後に覚えても、「0件」に戻らない", async ({ page }) => {
  await page.addInitScript(() => {
    /* 最初の1回だけ、読み出しの「成功」を遅らせる。
       画面を開いたときの読み込みが遅く、そのあとの読み込みが速い——
       という順番を、毎回作るため。 */
    const proto = IDBObjectStore.prototype as unknown as Record<string, unknown>;
    const real = proto.getAll as (...a: unknown[]) => IDBRequest;
    let first = true;
    proto.getAll = function (this: IDBObjectStore, ...args: unknown[]) {
      const req = real.apply(this, args);
      if (!first) return req;
      first = false;
      /* onsuccess の代入を横取りして、本物の success から 700ms 遅らせて呼ぶ。 */
      let handler: ((e: Event) => unknown) | null = null;
      Object.defineProperty(req, "onsuccess", {
        configurable: true,
        get: () => handler,
        set: (fn: ((e: Event) => unknown) | null) => { handler = fn; },
      });
      req.addEventListener("success", (e) => {
        setTimeout(() => { if (handler) handler.call(req, e); }, 700);
      });
      return req;
    };
  });

  await page.goto("/");
  await enterApp(page);
  await openMemory(page);
  await remember(page, "コーヒーはブラック");

  // 遅い読み込みが返ってきたあとも、消えていないこと
  await page.waitForTimeout(1200);
  await expect(page.getByText("コーヒーはブラック", { exact: true })).toBeVisible();
});
