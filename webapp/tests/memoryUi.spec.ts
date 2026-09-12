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
  await page.waitForTimeout(400);
  const all = await listed(page);
  expect(all.filter((t) => t === "コーヒーはブラック").length,
    `同じ記憶が ${all.length} 件ある`).toBe(1);
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
