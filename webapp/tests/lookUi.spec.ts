/**
 * 見た目の設定を、実際のブラウザで確かめる。
 *
 * ここで見ているのは主に**重さ**。「軽くしました」は言うだけなら
 * ただなので、数で押さえる：
 *
 *   ・使わない背景の画像を落としていないか（前は必ず落としていた）
 *   ・一覧を開いただけで本体が落ちていないか
 *   ・見本のせいで毎コマの仕事が増えていないか
 *
 * 見た目そのもの（ドットらしいか）は目で見るしかないが、**約束**
 * （角を落とさない・影をぼかさない）は数で決まるので固定する。
 */

import { test, expect, type Page } from "@playwright/test";

const FLOOR = "/skin-cyber-floor.webp";

async function enterApp(page: Page) {
  // EntryGate → BootScreen（接続先が無いので、すぐ「ENTER OFFLINE」が出る）
  await page.waitForSelector("text=ENTER", { timeout: 10_000 });
  await page.click("text=ENTER");
  const offlineBtn = page.getByText("ENTER OFFLINE");
  const hud = page.getByText("THE FORGE OS").first();
  await Promise.race([
    offlineBtn.waitFor({ timeout: 8_000 }).then(() => offlineBtn.click()),
    hud.waitFor({ timeout: 10_000 }),
  ]);
  await expect(page.getByLabel("Settings")).toBeVisible({ timeout: 10_000 });
}

/**
 * 背景の一覧にある、その名前のカード。
 *
 * 「✓ 端末にあり」を画面全体から探さない。同じ絵を使う背景が2つある
 * （水たまり・銀／銀の流れ）ので、どちらの話をしているのか分からなく
 * なる——実際それで、通ったり落ちたりするテストになった。
 */
function bgCard(page: Page, label: string) {
  return page.getByRole("button", { name: label, exact: true }).locator("xpath=..");
}

/** そのURLへの通信を数える（部分一致ではなく、末尾で見る）。 */
function countRequests(page: Page, path: string) {
  const hits: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === path) hits.push(r.url());
  });
  return hits;
}

/* ── 落とす物を減らせているか ──────────────────────────────────── */

test("水を使わないテーマでは、背景の画像を落とさない", async ({ page }) => {
  // 前はここが素通しで、白いテーマの人にも 118KB を毎回配っていた。
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("forge_skin", "aibou"));

  const hits = countRequests(page, FLOOR);
  await page.reload({ waitUntil: "networkidle" });
  await enterApp(page);
  await page.waitForTimeout(800);

  expect(hits, `使っていない背景の画像を落としている: ${hits.join(", ")}`).toHaveLength(0);
});

test("見た目の一覧を開いても、本体は落ちない（見本だけ）", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("forge_skin", "forge");    // 水を使わないテーマ
    localStorage.setItem("forge_bg", "stars");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);

  const hits = countRequests(page, FLOOR);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /水たまり・銀/ })).toBeVisible();
  await page.waitForTimeout(800);

  expect(hits, "一覧を開いただけで本体を落としている").toHaveLength(0);
  // 見本のほうは出ている（一覧が空っぽではない）
  const thumb = page.locator('img[src*="skin-cyber-floor-thumb"]');
  await expect(thumb.first()).toBeVisible();
});

test("選んだときに落として、次からは端末の物を使う", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("forge_skin", "forge");
    localStorage.setItem("forge_bg", "stars");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });

  const first = countRequests(page, FLOOR);
  await page.getByRole("button", { name: "水たまり・銀", exact: true }).click();
  await expect(bgCard(page, "水たまり・銀").getByText("✓ 端末にあり"))
    .toBeVisible({ timeout: 15_000 });
  expect(first.length, "選んでも落としに行っていない").toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.dataset.bg)).toBe("water-chrome");

  // 2回目は端末の物を使う（通信しない）
  const again = countRequests(page, FLOOR);
  await page.reload({ waitUntil: "networkidle" });
  await enterApp(page);
  await page.waitForTimeout(1000);
  expect(again, "端末にあるのに、また落としている").toHaveLength(0);
});

/* ── 見本が重さを増やしていないか ──────────────────────────────── */

test("見た目の一覧を開いても、毎コマの仕事はほとんど増えない", async ({ page }) => {
  /* 前は見本も本物と同じ 60fps で回っていたので、この画面を開くだけで
     canvas が7枚まわっていた（形が増えるほど悪化する）。
     requestAnimationFrame が何回呼ばれたかで、直に測る。 */
  await page.addInitScript(() => {
    const w = window as unknown as { __raf: number };
    w.__raf = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      w.__raf += 1;
      return orig(cb);
    };
  });
  await page.goto("/");
  await enterApp(page);
  await page.waitForTimeout(500);

  const sample = async () => {
    const before = await page.evaluate(() => (window as unknown as { __raf: number }).__raf);
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => (window as unknown as { __raf: number }).__raf);
    return after - before;
  };

  const closed = await sample();
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("コアの形")).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(900);            // 開くときの動きが落ち着くのを待つ
  const open = await sample();

  // 見本1枚につき毎秒60回増えるなら、7枚で +400 前後になる。
  // 止まった絵なら、増えるのは誤差の範囲。
  expect(open - closed, `閉=${closed}/s 開=${open}/s`).toBeLessThan(70);
});

/* ── レトロ ──────────────────────────────────────────────────── */

test("レトロは角を落とさず、影をぼかさない", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await page.getByRole("button", { name: /RETRO（ドット）/ }).click();

  const look = await page.evaluate(() => {
    const panel = document.querySelector(".panel") as HTMLElement | null;
    const cs = panel ? getComputedStyle(panel) : null;
    return {
      skin: document.documentElement.dataset.skin,
      radius: cs?.borderTopLeftRadius ?? "",
      shadow: cs?.boxShadow ?? "",
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    };
  });

  expect(look.skin).toBe("retro");
  expect(look.radius, "角が丸いままだと、ドットに見えない").toBe("0px");
  // ぼかし（3つ目の長さ）が 0 の影が含まれていること＝ドットの立体感
  expect(look.shadow, `影=${look.shadow}`).toMatch(/rgba?\([^)]*\)\s+\d+px\s+\d+px\s+0px/);
  expect(look.accent.toLowerCase()).toBe("#ffd23f");
});

test("レトロでも、丸いままにする物は丸い（コアの枠など）", async ({ page }) => {
  // 角を一律で潰しているので、丸くないと意味が通らない物が巻き添えに
  // なっていないかを見る。
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await page.getByRole("button", { name: /RETRO（ドット）/ }).click();
  await page.getByRole("button", { name: "✕" }).click();

  const round = await page.evaluate(() => {
    const el = document.querySelector(".rounded-full") as HTMLElement | null;
    return el ? getComputedStyle(el).borderTopLeftRadius : null;
  });
  if (round !== null) expect(round).not.toBe("0px");
});

/* ── カスタム ────────────────────────────────────────────────── */

test("自分で決めた色が、開いた瞬間から効いている", async ({ page }) => {
  // React を待ってから色を流し込むと、既定の紺が一瞬出てから変わる。
  // 起動スクリプトが同じ計算をしているかを、ここで確かめる。
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("forge_skin", "custom");
    localStorage.setItem("forge_custom_theme", JSON.stringify({
      ink: "#ffeeaa", frame: "#ff6699", bg: "#201005", veil: 0.5,
    }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  const v = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      skin: document.documentElement.dataset.skin,
      ink: cs.getPropertyValue("--fg-strong").trim(),
      accent: cs.getPropertyValue("--accent").trim(),
      bg: cs.getPropertyValue("--bg").trim(),
      theme: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    };
  });
  expect(v.skin).toBe("custom");
  expect(v.ink.toLowerCase()).toBe("#ffeeaa");
  expect(v.accent.toLowerCase()).toBe("#ff6699");
  expect(v.bg.toLowerCase()).toBe("#201005");
  expect(v.theme?.toLowerCase()).toBe("#201005");
});

test("読めない配色は、選んだその場で分かって直せる", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("forge_skin", "custom");
    // 白地に白文字（＝1:1）
    localStorage.setItem("forge_custom_theme", JSON.stringify({
      ink: "#ffffff", frame: "#8fb6ff", bg: "#ffffff", veil: 0.3,
    }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();

  await expect(page.getByText(/明暗の差が .* しかありません/)).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "直す" }).click();

  const after = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--fg-strong").trim());
  expect(after.toLowerCase(), "直しても白のまま").not.toBe("#ffffff");
  await expect(page.getByText(/読める濃さです/)).toBeVisible();
});

test("色をはじめに戻せる（どんな配色からでも押せる）", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("forge_skin", "custom");
    localStorage.setItem("forge_custom_theme", JSON.stringify({
      ink: "#101010", frame: "#111111", bg: "#0a0a0a", veil: 0.8,
    }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();

  const reset = page.getByRole("button", { name: "色をはじめに戻す" });
  await expect(reset).toBeVisible({ timeout: 5_000 });
  // 逃げ道は、その人の配色に関係なく見えていること（色を決め打ちで描く）
  const box = await reset.boundingBox();
  expect(box?.height ?? 0, "戻すボタンが潰れている").toBeGreaterThan(20);
  await reset.click();
  const ink = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--fg-strong").trim());
  expect(ink.toLowerCase()).toBe("#ffffff");
});

/* ── 背景の選択 ──────────────────────────────────────────────── */

test("背景はテーマと別に選べて、再読込しても残る", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });

  // 紺のテーマのまま、背景だけ星空にする
  await page.getByRole("button", { name: /星空/ }).click();
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.bg)).toBe("stars");
  }).toPass({ timeout: 5_000 });
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe("cyber");

  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.bg)).toBe("stars");
  }).toPass({ timeout: 5_000 });
});

test("画像が要る背景は、画像が無いうちは選べない", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("画像を保存すると選べます").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /自分の画像＋水/ })).toBeDisabled();
});

test("無地を選ぶと、背景の canvas ごと出さない", async ({ page }) => {
  // 「いちばん軽い」を名乗る以上、本当に何も回っていないことを見る。
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await page.getByRole("button", { name: /無地/ }).click();
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.bg)).toBe("plain");
  }).toPass({ timeout: 5_000 });

  const shown = await page.evaluate(() => {
    const el = document.querySelector(".forge-backdrop");
    return el ? getComputedStyle(el).display : "missing";
  });
  expect(shown).toBe("none");
});

/* ── 画面の形で、敷く絵を変える ──────────────────────────────────
 *
 * ふだんのテストは縦長（390×844）で回っているので、**横長の道だけ
 * 誰も通らない**。ここだけ窓を横に開けて見る。
 *
 * 直した中身: 縦 900×1600 の絵を 1440×900 の画面に cover で敷くと、
 * 高さの35%しか映らず、残りを1.6倍に引き伸ばしていた。 */

const WIDE = "/skin-chrome-wide.webp";

test("横長の画面では、横長の絵を落とす", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("forge_skin", "cyber");
    localStorage.setItem("forge_bg", "water-chrome");
  });

  const wide = countRequests(page, WIDE);
  const tall = countRequests(page, FLOOR);
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await expect(async () => {
    expect(wide.length, "横長の絵を落としていない").toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });
  expect(tall, `横長の画面で縦の絵を落としている: ${tall.join(", ")}`).toHaveLength(0);
});

test("縦長の画面では、これまで通り縦の絵のまま", async ({ page }) => {
  // 「スマホはそのままでいい」——横長を足したせいで縦が変わっては困る
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("forge_skin", "cyber");
    localStorage.setItem("forge_bg", "water-chrome");
  });

  const wide = countRequests(page, WIDE);
  const tall = countRequests(page, FLOOR);
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await expect(async () => {
    expect(tall.length, "縦の絵を落としていない").toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });
  expect(wide, `縦長の画面で横長の絵を落としている: ${wide.join(", ")}`).toHaveLength(0);
});

test("水を張らない「銀の流れ」は、canvas ではなく CSS が絵を敷く", async ({ page }) => {
  /* 水を通すと、絵は格子の細かさ（1440×900 で 481×301）までしか持てない。
     CSS に直接渡せば、画面の実解像度でそのまま出る。

     絵は canvas と**同じ層**（画面いっぱいの固定要素）に敷いてある。
     はじめは層ごと隠して html の背景にしていたが、
     `background-attachment: fixed` を iOS が素直に扱わないので、
     画面に貼る役目を固定要素のほうへ移した。
     そのため「要素が出ていないこと」ではなく、
     **毎コマ描いていないこと**を見る。 */
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });

  await page.getByRole("button", { name: "銀の流れ", exact: true }).click();
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.bg)).toBe("chrome-flat");
  }).toPass({ timeout: 15_000 });

  // 絵が CSS に渡っている
  await expect(async () => {
    const url = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--asset-bg"));
    expect(url, "絵が CSS に渡っていない").toContain("url(");
  }).toPass({ timeout: 10_000 });

  /* 絵が **canvas ではなく CSS から出ている**こと。
     ここが鮮明さの理由そのもの——canvas を通すと、絵は canvas の
     解像度までしか持てない。CSS なら画面の実解像度で出る。

     数え方: canvas の中身を読む。水なら不透明な絵が焼かれているが、
     こちらは1画素も描いていない（＝全部透明）はず。

     はじめは requestAnimationFrame の回数で測ろうとしたが、この画面は
     コアがいつも回っているので毎秒120回あり、背景のぶんを取り出せない。
     「何回描いたか」ではなく「何が描かれているか」を見るほうが素直。 */
  await page.getByRole("button", { name: "✕" }).click();
  await page.waitForTimeout(800);
  const painted = await page.evaluate(() => {
    const el = document.querySelector(".forge-backdrop") as HTMLCanvasElement | null;
    if (!el) return null;
    const ctx = el.getContext("2d");
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, Math.min(el.width, 64), Math.min(el.height, 64)).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
    return { opaque, total: d.length / 4 };
  });
  expect(painted, "絵を敷く層が無い").not.toBeNull();
  expect(painted!.opaque,
    `canvas に ${painted!.opaque}/${painted!.total} 画素描かれている（CSSで敷いていない）`)
    .toBe(0);

  // 絵の層は画面ぴったり（実機の倍率での検証は tests/backdropFit.spec.ts）
  const fit = await page.evaluate(() => {
    const el = document.querySelector(".forge-backdrop");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             vw: innerWidth, vh: innerHeight };
  });
  expect(fit, "絵を敷く層が無い").not.toBeNull();
  expect(Math.abs(fit!.w - fit!.vw)).toBeLessThanOrEqual(1);
  expect(Math.abs(fit!.h - fit!.vh)).toBeLessThanOrEqual(1);
});

/**
 * その背景の上で、本文がどれだけ読めるか（コントラスト比）。
 *
 * 測り方: 中身をいったん隠して**下地だけ**を撮り、本文が載っていた場所の
 * 画素を拾って、本文の色との比を出す。撮った絵の解読はブラウザにさせる
 * （canvas に描いて getImageData）——そのために画像の変換ライブラリを
 * 足すと、テストが宣言していない依存で動くことになる。
 */
async function bodyContrast(page: Page, bg: string): Promise<number> {
  await page.goto("/");
  await page.evaluate((bg) => {
    localStorage.setItem("forge_skin", "cyber");
    localStorage.setItem("forge_bg", bg);
  }, bg);
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await page.waitForTimeout(3500);          // 絵の取得と、水なら波が落ち着くまで

  const probe = await page.evaluate(() => {
    const el = [...document.querySelectorAll("p,div,span")]
      .find((e) => e.children.length === 0 && e.textContent?.includes("話しかけるか入力して"));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const color = getComputedStyle(el).color;
    // 下地だけにする（canvas の背景は残す）
    document.querySelectorAll<HTMLElement>("body > *").forEach((e) => {
      if (!e.classList.contains("forge-backdrop") && !e.querySelector(".forge-backdrop")) {
        e.style.visibility = "hidden";
      }
    });
    document.querySelectorAll<HTMLElement>("main, header, footer")
      .forEach((e) => { e.style.visibility = "hidden"; });
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), color };
  });
  expect(probe, "本文が見つからない（画面の作りが変わった？）").not.toBeNull();

  await page.waitForTimeout(300);
  const shot = (await page.screenshot()).toString("base64");

  return page.evaluate(async ({ shot, probe }) => {
    const img = new Image();
    await new Promise((ok, ng) => {
      img.onload = ok; img.onerror = ng;
      img.src = `data:image/png;base64,${shot}`;
    });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const ch = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const lum = (r: number, g: number, b: number) => 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    const m = probe.color.match(/\d+/g)!.map(Number);
    const text = lum(m[0], m[1], m[2]);
    const d = ctx.getImageData(probe.x, probe.y, Math.max(1, probe.w), Math.max(1, probe.h)).data;
    let worst = 99;
    for (let i = 0; i < d.length; i += 4) {
      const L = lum(d[i], d[i + 1], d[i + 2]);
      const ratio = (Math.max(text, L) + 0.05) / (Math.min(text, L) + 0.05);
      if (ratio < worst) worst = ratio;
    }
    return worst;
  }, { shot, probe: probe! });
}

test("絵を敷く背景の上でも、本文が水の背景と同じくらい読める", async ({ page }) => {
  /* 鮮明にするために膜を薄くしていくと、銀の帯に重なった本文が消える。
     作っている最中、膜 0.35 では本文のコントラストが **1.05**（＝ほぼ
     見えない）まで落ちていた。目では「少し読みにくい」程度にしか
     見えないので、数で止める。

     基準は WCAG ではなく**いま使えている水の背景**。水も 2.35 しか
     無いので、そこへ 4.5 を求めると背景ごと作り直しになる。狙いは
     「同じ読みやすさで、鮮明さだけ勝つ」。 */
  const water = await bodyContrast(page, "water-chrome");
  const flat = await bodyContrast(page, "chrome-flat");
  expect(flat, `銀の流れ=${flat.toFixed(2)} / 水たまり=${water.toFixed(2)}`)
    .toBeGreaterThan(water * 0.8);
  // 水そのものが薄くなっていないことも見る（両方一緒に落ちたら気づけない）
  expect(water, `水たまりの本文が読みにくくなっている（${water.toFixed(2)}）`)
    .toBeGreaterThan(1.9);
});

/* ── 新しいテーマで、画面が壊れていないか ────────────────────────
 *
 * レトロは角を一律で潰し、見出しにドットの字を当てている。どちらも
 * 「全部に効く」種類の指定なので、どこか1か所が枠から出ていても
 * 目では気づけない。数で見る。 */

const NARROW = { width: 360, height: 740 };

/** 横に切れている枠を数える（mobile.spec.ts と同じ見かた）。 */
async function clipped(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const SCROLLY = new Set(["auto", "scroll"]);
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth < 120) continue;
      const st = getComputedStyle(el);
      const cls = (el.className || "").toString();
      if (/\boverflow-x-(auto|scroll)\b/.test(cls)) continue;
      if (/\boverflow-hidden\b/.test(cls) || st.overflowX === "hidden") continue;
      if (!SCROLLY.has(st.overflowX)) continue;
      out.push(`枠${el.clientWidth}px に中身${el.scrollWidth}px 「${(el.textContent || "").trim().slice(0, 32)}」`);
    }
    return out;
  });
}

for (const skin of ["retro", "custom"] as const) {
  test(`${skin} でも、文字が枠から出ない`, async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto("/");
    await page.evaluate((s) => localStorage.setItem("forge_skin", s), skin);
    await page.reload({ waitUntil: "domcontentloaded" });
    await enterApp(page);

    const home = await clipped(page);
    await page.getByLabel("Settings").click();
    await page.getByRole("button", { name: "見た目" }).click();
    await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(600);            // 字が届いてから測る
    const settings = await clipped(page);

    expect([...home, ...settings], `横に切れている所:\n${[...home, ...settings].join("\n")}`).toEqual([]);
  });
}

test("ドットの字は、レトロを使わない人には落ちてこない", async ({ page }) => {
  // preload を切っていないと、全員の端末が開くたびに先読みする。
  const fonts: string[] = [];
  page.on("request", (r) => {
    if (/\.(woff2?|ttf|otf)$/.test(new URL(r.url()).pathname)) fonts.push(r.url());
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await enterApp(page);
  await page.waitForTimeout(1200);
  // Press Start 2P は Next が自分のファイル名に直すので、preload の
  // 有無ではなく「字の数」で見る。既定の2書体より増えていないこと。
  const unique = new Set(fonts.map((u) => new URL(u).pathname));
  expect(unique.size, `落ちてきた字: ${[...unique].join(", ")}`).toBeLessThanOrEqual(2);
});

/* ── 自分の画像 ──────────────────────────────────────────────────
 *
 * 「背景画像を保存、変更できる」の本体。ここが動かないと、カスタムの
 * テーマは色を変えるだけのものになる。
 *
 * 画面の中で大きな画像を作ってから入力欄へ渡す。実物の写真を置くより、
 * **画面より大きい画像**を確実に作れるほうが、縮小の検算になる。 */

async function putBigImage(page: Page, w = 3000, h = 2000) {
  return page.evaluate(async ([iw, ih]) => {
    const c = document.createElement("canvas");
    c.width = iw; c.height = ih;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, iw, ih);
    g.addColorStop(0, "#2b6cff");
    g.addColorStop(1, "#ff3d7f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, iw, ih);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) return false;
    const file = new File([blob], "big.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    /* 画面には画像の入力欄が2つある（チャットの添付と、背景）。
       ざっくり選ぶとチャットの添付に入る（実際そうなった）。名指しする。 */
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][aria-label="背景にする画像を選ぶ"]');
    if (!input) return false;
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, [w, h]);
}

test("自分の画像を保存すると、背景になり、縮んで残る", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });

  expect(await putBigImage(page), "画像を渡せなかった").toBe(true);

  // 画面より大きい画像は、長辺 2048 まで縮めて保存する
  await expect(page.getByText(/2048×1365|2048×1366/)).toBeVisible({ timeout: 20_000 });
  // 保存したら、そのまま背景になる（「保存したのに何も変わらない」を作らない）
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.bg)).toBe("user-flat");
  }).toPass({ timeout: 8_000 });
  // CSS 側にも画像が渡っている
  const url = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--user-bg").trim());
  expect(url, "背景の画像が CSS に渡っていない").toContain("blob:");

  // 画像が要る背景が、選べるようになっている
  await expect(page.getByRole("button", { name: /自分の画像＋水/ })).toBeEnabled();
});

test("画像を消すと、背景が無地へ逃げる（真っ黒にならない）", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });
  expect(await putBigImage(page, 1200, 800)).toBe(true);
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.bg)).toBe("user-flat");
  }).toPass({ timeout: 20_000 });

  await page.getByRole("button", { name: "画像を消す" }).click();
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.bg)).not.toBe("user-flat");
  }).toPass({ timeout: 8_000 });
  await expect(page.getByText("画像を保存すると選べます").first()).toBeVisible();
});

test("自分の画像は、再読込しても残る", async ({ page }) => {
  await page.goto("/");
  await enterApp(page);
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await expect(page.getByText("画面のテーマ")).toBeVisible({ timeout: 5_000 });
  expect(await putBigImage(page, 1000, 600)).toBe(true);
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.bg)).toBe("user-flat");
  }).toPass({ timeout: 20_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  await expect(async () => {
    const v = await page.evaluate(() => ({
      bg: document.documentElement.dataset.bg,
      url: getComputedStyle(document.documentElement).getPropertyValue("--user-bg").trim(),
    }));
    expect(v.bg).toBe("user-flat");
    expect(v.url).toContain("blob:");
  }).toPass({ timeout: 10_000 });
});

test("テーマを離れても、背景の膜の濃さは消えない", async ({ page }) => {
  /* 膜は「色」ではなく「背景」の設定。テーマの色を片付けるときに
     巻き添えにすると、カスタム以外で設定を開いた瞬間に濃さが既定へ
     戻る（実際そうなっていた）。 */
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("forge_skin", "custom");
    localStorage.setItem("forge_custom_theme", JSON.stringify({
      ink: "#ffffff", frame: "#8fb6ff", bg: "#101018", veil: 0.62,
    }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await enterApp(page);
  const veil = () => page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--veil").trim());
  expect(await veil()).toBe("0.62");

  // 別のテーマへ移る（色は片付くが、膜は背景の設定なので残る）
  await page.getByLabel("Settings").click();
  await page.getByRole("button", { name: "見た目" }).click();
  await page.getByRole("button", { name: /CYBER（紺）/ }).click();
  await expect(async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe("cyber");
  }).toPass({ timeout: 5_000 });

  expect(await veil(), "テーマを変えたら膜の濃さが消えた").toBe("0.62");
  // 色のほうはちゃんと片付いている（カスタムの色が居座らない）
  const ink = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--fg-strong").trim());
  expect(ink, "カスタムの色が残っている").toBe("");
});
