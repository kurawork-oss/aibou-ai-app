"use client";

/**
 * 見た目の設定。
 *
 * 3つを**別々に**決められるようにしてある。
 *
 *   画面のテーマ … 色・枠・文字の体裁
 *   背景         … 後ろで何が動くか
 *   コア         … 真ん中の球の形
 *
 * 前は「紺のテーマ＝水たまり」のように固定で、色だけ変えたい人も
 * 背景だけ変えたい人も選べなかった。
 *
 * 重くしないための決まり
 * ----------------------
 * ① 見本は**1コマだけ**描く。前は見本も本物と同じく 60fps で回っていたので、
 *    この画面を開くだけで canvas が7枚まわっていた（形が増えるほど悪化する）。
 * ② 重い素材は、**一覧を開いただけでは落とさない**。一覧に出すのは
 *    小さな見本（本体の 1/12）だけ。本体はその背景を選んだときに落とす。
 * ③ 落とした物は端末に残す（圏外でも出る）。「落とした／まだ」は
 *    自前の印ではなく、実際に手元にあるかを聞いて出す。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import CoreOrb from "@/components/CoreOrb";
import { CORE_TYPES, readCoreType, setCoreType, type CoreType } from "@/lib/coreType";
import {
  BACKGROUNDS, assetFor, backgroundDef, isWideScreen, readBackground, setBackground,
  type BackgroundChoice, type BackgroundDef, type BackgroundKey,
} from "@/lib/background";
import {
  DEFAULT_CUSTOM_THEME, SKINS, applySkin, readCustomTheme, readSkin,
  saveCustomTheme, setSkin, type CustomTheme, type Skin,
} from "@/lib/skin";
import { contrast, isLight, parseHex, readableInk, toHex } from "@/lib/color";
import { canKeepAssets, downloadAsset, formatBytes, hasAsset, removeAsset } from "@/lib/assetCache";
import { clearUserImage, getUserImage, putUserImage, veilFor } from "@/lib/imageStore";
import { RetroSky } from "@/lib/retroSky";
import { QUALITY_STEPS, Water } from "@/lib/water";

/* ── 見本（背景）────────────────────────────────────────────────────
 *
 * 落とす物がある背景だけ、小さな画像を出す。それ以外は**その背景を描く
 * コードそのもの**で小さく1枚描く。別に絵を用意すると、背景を直したとき
 * に見本だけ古いまま残る。 */

const THUMB_H = 58;
/** 見本の幅は、枠いっぱい（カードの幅は端末で変わる）。 */
const THUMB_STYLE = { width: "100%", height: THUMB_H, display: "block" } as const;

function CanvasThumb({ kind }: { kind: BackgroundKey }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    /* 描く大きさは、置かれた枠の実寸に合わせる。決め打ちの幅で描いて
       CSS で伸ばすと、ドットの見本が半端な倍率で拡大されて濁る。 */
    const THUMB_W = Math.max(48, Math.round(canvas.clientWidth || 92));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = THUMB_W * dpr;
    canvas.height = THUMB_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (kind === "water-grid") {
      // 本物と同じ計算を、小さい面で。波を少し立ててから1枚だけ描く
      const water = new Water({ cell: 2, maxCells: 9000, damping: 0.99, rainEvery: 0, refract: 12 });
      water.resize(THUMB_W, THUMB_H, QUALITY_STEPS[1]);
      water.drop(THUMB_W * 0.36, THUMB_H * 0.42, 2.4, 8);
      water.drop(THUMB_W * 0.68, THUMB_H * 0.66, 1.8, 6);
      for (let i = 0; i < 26; i++) water.step(1 / 60);
      water.render(ctx, THUMB_W, THUMB_H, {
        deep: [6, 11, 26], shallow: [14, 24, 52], sheen: [198, 212, 238],
      });
      return;
    }

    if (kind === "retro") {
      const sky = new RetroSky();
      sky.resize(THUMB_W, THUMB_H);
      ctx.imageSmoothingEnabled = false;
      sky.render(ctx, THUMB_W, THUMB_H, 1.5);
      return;
    }

    if (kind === "stars") {
      // 星空は全画面ぶんの仕掛け（星座・流れ星）を持つので、見本は
      // 「星と、奥へ伸びる床」だけを同じ色で描く
      ctx.fillStyle = "#0a0b0f";
      ctx.fillRect(0, 0, THUMB_W, THUMB_H);
      for (let i = 0; i < 46; i++) {
        const x = (Math.sin(i * 12.9898) * 43758.5453) % 1;
        const y = (Math.sin(i * 78.233) * 43758.5453) % 1;
        const z = 0.3 + ((i % 7) / 7) * 0.7;
        ctx.fillStyle = `rgba(228,235,248,${(0.2 + z * 0.5).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(Math.abs(x) * THUMB_W, Math.abs(y) * THUMB_H * 0.72, 0.4 + z, 0, Math.PI * 2);
        ctx.fill();
      }
      const horizon = THUMB_H * 0.66;
      ctx.strokeStyle = "rgba(170,186,212,0.24)";
      ctx.lineWidth = 0.6;
      for (let i = -5; i <= 5; i++) {
        ctx.beginPath();
        ctx.moveTo(THUMB_W / 2, horizon);
        ctx.lineTo(THUMB_W / 2 + (i / 5) * THUMB_W * 1.1, THUMB_H);
        ctx.stroke();
      }
      for (let j = 1; j <= 4; j++) {
        const y = horizon + Math.pow(j / 4, 2.1) * (THUMB_H - horizon);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(THUMB_W, y);
        ctx.stroke();
      }
      return;
    }

    ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  }, [kind]);

  return <canvas ref={ref} style={THUMB_STYLE} aria-hidden />;
}

/** 自分の画像の見本。保存してある物をそのまま小さく出す。 */
function UserThumb({ url }: { url: string | null }) {
  if (!url) {
    return (
      <span
        className="text-[9px] text-muted"
        style={{
          ...THUMB_STYLE,
          // grid にしないと中の文字が上に張り付いて切れる（THUMB_STYLE の
          // display:block が className の grid を打ち消すため、ここで戻す）
          display: "grid", placeItems: "center",
          border: "1px dashed var(--panel-bd)",
        }}
      >
        画像なし
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- blob: なので最適化は通らない
  return <img src={url} alt="" style={{ ...THUMB_STYLE, objectFit: "cover" }} />;
}

function BackgroundThumb(
  { def, userUrl, wide }: { def: BackgroundDef; userUrl: string | null; wide: boolean },
) {
  if (def.needsUserImage) return <UserThumb url={userUrl} />;
  const asset = assetFor(def, wide);
  if (asset) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- 素の <img> で十分（最適化は切ってある）
      <img
        src={asset.thumb}
        alt=""
        loading="lazy"
        decoding="async"
        style={{ ...THUMB_STYLE, objectFit: "cover" }}
      />
    );
  }
  if (def.key === "emerald") {
    return (
      <span
        aria-hidden
        style={{
          ...THUMB_STYLE,
          // 本物と同じ組み立て（金の細い綾＋上から緑のにじみ）。間隔と
          // 濃さも本物に合わせる——見本だけ派手だと、選んで拍子抜けする。
          background:
            "repeating-linear-gradient(45deg, rgba(212,175,55,0.16) 0 1px, transparent 1px 11px)," +
            "repeating-linear-gradient(-45deg, rgba(212,175,55,0.10) 0 1px, transparent 1px 11px)," +
            "radial-gradient(90px 26px at 50% -26%, rgba(60,210,160,0.22), transparent 70%)," +
            "#03201a",
        }}
      />
    );
  }
  if (def.key === "plain") {
    return (
      <span
        aria-hidden
        style={{ ...THUMB_STYLE, background: "var(--bg)" }}
      />
    );
  }
  return <CanvasThumb kind={def.key} />;
}

/* ── ダウンロードの状態 ──────────────────────────────────────────── */

type DlState = { have: boolean; busy: boolean; pct: number; failed?: boolean };

/**
 * いまの画面が横長か。横長／縦長で敷く絵が変わる背景がある。
 *
 * 描いている途中に `window` を直に読まない。SSR では横長を既定にして
 * いるので、スマホで開くと「サーバーが作った中身」と食い違って
 * hydration が壊れる。立ち上がってから直す。
 */
function useWideScreen(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const sync = () => setWide(isWideScreen());
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return wide;
}

function useAssetState(defs: BackgroundDef[], wide: boolean) {
  const [state, setState] = useState<Record<string, DlState>>({});

  /* 「手元にあるか」は**毎回聞き直す**。同じ絵を使う背景が2つある
     （水あり／水なし）ので、片方を落とすともう片方も手元にある。
     自前の印で持つと、そこがずれる。 */
  const refresh = useCallback(async () => {
    const have: Record<string, boolean> = {};
    for (const d of defs) {
      const a = assetFor(d, wide);
      if (!a) continue;
      have[d.key] = await hasAsset(a.url);
    }
    setState((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(have)) {
        next[k] = { ...(next[k] ?? { busy: false, pct: 0, have: false }), have: have[k], busy: false };
      }
      return next;
    });
  }, [defs, wide]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** 落とす。進み具合を出しながら。 */
  const fetchAsset = useCallback(async (d: BackgroundDef) => {
    const a = assetFor(d, wide);
    if (!a) return true;
    setState((s) => ({ ...s, [d.key]: { have: false, busy: true, pct: 0 } }));
    const ok = await downloadAsset(a.url, ({ received, total }) => {
      const pct = total > 0 ? Math.round((received / total) * 100) : 0;
      setState((s) => ({ ...s, [d.key]: { have: false, busy: true, pct } }));
    });
    /* 「手元にあるか」は、落とせたかどうかではなく**実際に聞いて**決める。
       取っておけない端末（http:// の開発サーバーなど）では落とせても
       残らないので、ok をそのまま出すと「もう手元にあります」と
       言い続けることになる。 */
    const have = await hasAsset(a.url);
    setState((s) => ({ ...s, [d.key]: { have, busy: false, pct: 100, failed: !ok } }));
    // 同じ絵を使う他の背景の印も合わせる（refresh は failed を消さない）
    void refresh();
    return ok;
  }, [wide, refresh]);

  const drop = useCallback(async (d: BackgroundDef) => {
    const a = assetFor(d, wide);
    if (!a) return;
    await removeAsset(a.url);
    await refresh();
  }, [wide, refresh]);

  return { state, fetchAsset, drop, refresh };
}

/* ── 本体 ────────────────────────────────────────────────────────── */

export default function AppearanceSettings() {
  const [skin, setSkinState] = useState<Skin>("cyber");
  const [bg, setBgState] = useState<BackgroundChoice>("auto");
  const [core, setCore] = useState<CoreType>("orb");
  const [custom, setCustom] = useState<CustomTheme>(DEFAULT_CUSTOM_THEME);
  const [userUrl, setUserUrl] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<{ w: number; h: number; bytes: number } | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const wide = useWideScreen();
  const { state: dl, fetchAsset, drop } = useAssetState(BACKGROUNDS, wide);
  /* 取っておけるかは端末による。できない所で「✓ 端末にあり」と出すと嘘になる。 */
  const [keepable, setKeepable] = useState(true);
  useEffect(() => { setKeepable(canKeepAssets()); }, []);

  useEffect(() => {
    const s = readSkin();
    setSkinState(s);
    applySkin(s);            // 保存値と実際の表示がずれないよう、開いた時に必ず揃える
    setBgState(readBackground());
    setCore(readCoreType());
    setCustom(readCustomTheme());
  }, []);

  /** 保存してある画像を読み直す（選び直し・削除のあと）。 */
  const urlRef = useRef<string | null>(null);
  const reloadUserImage = useCallback(async () => {
    const rec = await getUserImage();
    /* object URL を作るのは setState の**外**。中で作ると、React が
       更新関数を2回呼ぶ場面（開発時の二重実行）で1本が迷子になる。 */
    const next = rec ? URL.createObjectURL(rec.blob) : null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
    setUserUrl(next);
    setUserInfo(rec ? { w: rec.width, h: rec.height, bytes: rec.blob.size } : null);
  }, []);

  useEffect(() => {
    void reloadUserImage();
    // 画面を閉じるときに手放す（object URL は放っておくと残る）
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [reloadUserImage]);

  const pickSkin = (next: Skin) => {
    setSkinState(setSkin(next));
  };

  /**
   * 背景を選ぶ。素材が要る背景で、まだ手元に無ければ**先に落とす**。
   * 落とせなかったら切り替えない——切り替えてから何も出ないのが
   * いちばん分かりにくい。
   */
  const pickBg = async (key: BackgroundChoice) => {
    if (key !== "auto") {
      const def = backgroundDef(key);
      if (assetFor(def, wide) && !dl[def.key]?.have) {
        const ok = await fetchAsset(def);
        if (!ok) return;
      }
    }
    setBgState(setBackground(key));
  };

  const onFile = async (file: File | null) => {
    if (!file) return;
    setImgError(null);
    setImgBusy(true);
    const rec = await putUserImage(file);
    setImgBusy(false);
    if (!rec) {
      setImgError("この画像は読めませんでした（HEIC など、ブラウザが開けない形式かもしれません）。JPEG か PNG でお試しください。");
      return;
    }
    /* 膜の濃さを、その画像の明るさから決める。
       35%の決め打ちで明るい写真を敷いたら、上の文字が飛んだ（実際なった）。
       逆に暗い写真へ同じ35%をかけると、ただ真っ暗になる。
       測って合わせる——あとで、つまみでいくらでも変えられる。 */
    const darkVeil = !isLight(parseHex(custom.bg) ?? { r: 0, g: 0, b: 0 });
    setCustom(saveCustomTheme({ ...custom, veil: veilFor(rec.luminance, darkVeil) }));

    await reloadUserImage();
    // 入れたのに背景が変わらないと、保存できたか分からない
    setBgState(setBackground("user-flat"));
  };

  const removeImage = async () => {
    await clearUserImage();
    await reloadUserImage();
    if (bg === "user-flat" || bg === "user-water") setBgState(setBackground("auto"));
  };

  /* 読めるかどうかの検算。人が色を選べる以上、読めない組み合わせも
     選べてしまう。選んだ瞬間に比を出して、足りなければその場で直せる
     ようにする（設定画面ごと読めなくなると、戻す道が無くなる）。 */
  const inkRgb = parseHex(custom.ink);
  const bgRgb = parseHex(custom.bg);
  const ratio = inkRgb && bgRgb ? contrast(inkRgb, bgRgb) : 21;
  const unreadable = ratio < 4.5;

  const updateCustom = (patch: Partial<CustomTheme>) => {
    const next = saveCustomTheme({ ...custom, ...patch });
    setCustom(next);
  };

  return (
    <div className="space-y-4">
      {/* ── 画面のテーマ ─────────────────────────────────────────── */}
      <section className="rounded-forge border border-panel p-3">
        <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">画面のテーマ</div>
        <div className="grid grid-cols-2 gap-2">
          {SKINS.map((s) => {
            const active = skin === s.key;
            const c = SWATCH[s.key];
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => pickSkin(s.key)}
                aria-pressed={active}
                title={s.hint}
                className="min-w-0 rounded-forge border p-2 text-left transition"
                style={{
                  borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                  background: active ? "var(--btn-bg)" : "transparent",
                }}
              >
                <span
                  className="mb-1.5 flex h-9 items-center gap-1 rounded-forge px-1.5"
                  style={{ background: c.bg, border: `1px solid ${c.bd}` }}
                  aria-hidden
                >
                  <span className="h-5 flex-1 rounded" style={{ background: c.card, border: `1px solid ${c.bd}` }} />
                  <span className="h-5 w-1.5 rounded" style={{ background: c.accent }} />
                </span>
                <span className="block truncate text-[10px] label-mono"
                      style={{ color: active ? "var(--fg-strong)" : "var(--muted)" }}>
                  {s.label}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          {SKINS.find((s) => s.key === skin)?.hint}
          ／ 画面の構成（モードの並びや操作）は変わりません。
        </p>
      </section>

      {/* ── カスタムの色（テーマが custom のときだけ）─────────────── */}
      {skin === "custom" && (
        <section className="rounded-forge border border-panel p-3">
          <div className="mb-2 text-[10px] tracking-[0.2em] text-muted label-mono">自分で決める色</div>

          <div className="grid grid-cols-3 gap-2">
            <ColorField label="文字" value={custom.ink} onChange={(v) => updateCustom({ ink: v })} />
            <ColorField label="枠・強調" value={custom.frame} onChange={(v) => updateCustom({ frame: v })} />
            <ColorField label="下地" value={custom.bg} onChange={(v) => updateCustom({ bg: v })} />
          </div>

          {/* 背景画像の上にかける膜。写真を敷いたときに文字を守る唯一のつまみ */}
          <label className="mt-3 block">
            <span className="mb-1 flex items-center justify-between text-[10px] tracking-[0.16em] text-muted label-mono">
              <span>背景の膜の濃さ</span>
              <span>{Math.round(custom.veil * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={85}
              value={Math.round(custom.veil * 100)}
              onChange={(e) => updateCustom({ veil: Number(e.target.value) / 100 })}
              aria-label="背景の膜の濃さ"
              className="w-full"
            />
            <span className="mt-0.5 block text-[10px] leading-relaxed text-muted">
              画像を入れたときに、その明るさから自動で決めます。合わなければここで変えてください。
            </span>
          </label>

          {/* 読めるかどうかは、感想ではなく比で出す */}
          <div
            className="mt-2 flex items-center justify-between gap-2 rounded-forge border p-2"
            style={{ borderColor: unreadable ? "#ff6b6b" : "var(--panel-bd)" }}
          >
            <span className="text-[11px] leading-relaxed" style={{ color: unreadable ? "#ff9d9d" : "var(--muted)" }}>
              {unreadable
                ? `文字と下地の明暗の差が ${ratio.toFixed(1)}：1 しかありません（読める目安は 4.5）。`
                : `文字と下地の明暗の差は ${ratio.toFixed(1)}：1。読める濃さです。`}
            </span>
            {unreadable && bgRgb && (
              <button
                type="button"
                onClick={() => updateCustom({ ink: toHex(readableInk(bgRgb)) })}
                className="shrink-0 rounded-forge border px-2 py-1 text-[10px] label-mono"
                style={{ borderColor: "#ff6b6b", color: "#ff9d9d" }}
              >
                直す
              </button>
            )}
          </div>

          {/* 逃げ道。色を決め打ちで描くので、どんな配色を選んでも必ず見える */}
          <button
            type="button"
            onClick={() => { setCustom(saveCustomTheme(DEFAULT_CUSTOM_THEME)); }}
            className="mt-2 w-full px-3 py-2 text-[11px]"
            style={{ background: "#1b1f2e", color: "#ffffff", border: "1px solid #7c869e" }}
          >
            色をはじめに戻す
          </button>
        </section>
      )}

      {/* ── 背景 ─────────────────────────────────────────────────── */}
      <section className="rounded-forge border border-panel p-3">
        <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">背景</div>
        <p className="mb-2 text-[11px] leading-relaxed text-muted">
          一覧に出しているのは小さな見本だけです。通信が要るものは、選んだときに落とします。
        </p>

        <button
          type="button"
          onClick={() => void pickBg("auto")}
          aria-pressed={bg === "auto"}
          className="mb-2 w-full rounded-forge border px-3 py-2 text-left text-[11px]"
          style={{
            borderColor: bg === "auto" ? "var(--accent)" : "var(--panel-bd)",
            background: bg === "auto" ? "var(--btn-bg)" : "transparent",
          }}
        >
          <span className="text-fg-strong">おまかせ</span>
          <span className="ml-2 text-muted">テーマに合った背景（いまは「{backgroundDef(autoKeyFor(skin, !!userUrl)).label}」）</span>
        </button>

        <div className="grid grid-cols-2 gap-2">
          {BACKGROUNDS.map((d) => {
            const active = bg === d.key;
            const st = dl[d.key];
            const locked = d.needsUserImage && !userUrl;
            // 落とす大きさも「いまの画面に敷く絵」のもの（縦横で別の絵）
            const asset = assetFor(d, wide);
            return (
              <div
                key={d.key}
                className="min-w-0 rounded-forge border p-2"
                style={{
                  borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                  background: active ? "var(--btn-bg)" : "transparent",
                  opacity: locked ? 0.5 : 1,
                }}
              >
                <button
                  type="button"
                  disabled={locked || st?.busy}
                  onClick={() => void pickBg(d.key)}
                  aria-pressed={active}
                  title={d.hint}
                  className="block w-full text-left disabled:cursor-not-allowed"
                >
                  <span className="mb-1.5 block overflow-hidden rounded-forge"
                        style={{ border: "1px solid var(--panel-bd)", lineHeight: 0 }}>
                    <BackgroundThumb def={d} userUrl={userUrl} wide={wide} />
                  </span>
                  <span className="block truncate text-[10px] label-mono"
                        style={{ color: active ? "var(--fg-strong)" : "var(--muted)" }}>
                    {d.label}
                  </span>
                </button>

                {/* 落とす物があるものだけ、状態を出す */}
                {asset && (
                  st?.busy ? (
                    <div className="mt-1">
                      <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-bd)" }}>
                        <div className="h-full transition-[width] duration-150"
                             style={{ width: `${st.pct}%`, background: "var(--accent)" }} />
                      </div>
                      <span className="mt-0.5 block text-[9px] text-muted label-mono">落としています {st.pct}%</span>
                    </div>
                  ) : st?.have ? (
                    <div className="mt-1 flex items-center justify-between gap-1">
                      <span className="text-[9px] text-muted label-mono">✓ 端末にあり</span>
                      {!active && (
                        <button
                          type="button"
                          onClick={() => void drop(d)}
                          /* 「消す」だけだと、下の「画像を消す」と同じ名前になる。
                             目で見れば場所で分かるが、読み上げでは区別がつかない。 */
                          aria-label={`${d.label}を端末から消す`}
                          className="text-[9px] text-muted underline label-mono"
                        >
                          端末から消す
                        </button>
                      )}
                    </div>
                  ) : st?.failed ? (
                    <span className="mt-1 block text-[9px] label-mono" style={{ color: "#ff9d9d" }}>
                      落とせませんでした。通信を確かめて、もう一度押してください
                    </span>
                  ) : (
                    <span className="mt-1 block text-[9px] text-muted label-mono">
                      ⤓ 約{formatBytes(asset.bytes)}
                      {keepable ? "（選ぶと落とします）" : "（この端末では毎回読み込みます）"}
                    </span>
                  )
                )}
                {!asset && !d.needsUserImage && (
                  <span className="mt-1 block text-[9px] text-muted label-mono">通信なし</span>
                )}
                {locked && (
                  <span className="mt-1 block text-[9px] text-muted label-mono">画像を保存すると選べます</span>
                )}
              </div>
            );
          })}
        </div>

        {/* 自分の画像 */}
        <div className="mt-3 rounded-forge border border-panel p-2.5">
          <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">自分の画像</div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            aria-label="背景にする画像を選ぶ"
            onChange={(e) => { void onFile(e.target.files?.[0] ?? null); e.target.value = ""; }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={imgBusy}
              onClick={() => fileRef.current?.click()}
              className="rounded-forge border px-3 py-2 text-[11px] disabled:opacity-50"
              style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}
            >
              {imgBusy ? "取り込んでいます…" : userUrl ? "別の画像にする" : "画像を選ぶ"}
            </button>
            {userUrl && (
              <button
                type="button"
                onClick={() => void removeImage()}
                className="rounded-forge border border-panel px-3 py-2 text-[11px] text-muted"
              >
                画像を消す
              </button>
            )}
          </div>
          {userInfo && (
            <p className="mt-1.5 text-[10px] text-muted label-mono">
              {userInfo.w}×{userInfo.h} · {formatBytes(userInfo.bytes)}（端末の中だけに保存。どこにも送りません）
            </p>
          )}
          {imgError && <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: "#ff9d9d" }}>{imgError}</p>}
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            長い辺 2048 まで縮めて保存します（画面より大きい画像は、重くなるだけで見た目は変わりません）。
          </p>
        </div>
      </section>

      {/* ── コア ─────────────────────────────────────────────────── */}
      <section className="rounded-forge border border-panel p-3">
        <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">コアの形</div>
        <p className="mb-2 text-[11px] leading-relaxed text-muted">
          見本は止まった絵です（動かすと、この画面を開くだけで重くなるため）。選ぶと本物が動きます。
          形は画像ではなく計算なので、落とす物はありません（選んだときに描き方だけ読み込みます）。
        </p>
        <div className="grid grid-cols-3 gap-2">
          {CORE_TYPES.map((c) => {
            const active = core === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setCore(setCoreType(c.key))}
                aria-pressed={active}
                aria-label={c.label}
                title={c.hint}
                className="min-w-0 rounded-forge border p-1.5 text-center transition"
                style={{
                  borderColor: active ? "var(--accent)" : "var(--panel-bd)",
                  background: active ? "var(--btn-bg)" : "transparent",
                }}
              >
                <span className="mx-auto block h-[52px] w-[52px]">
                  <CoreOrb size={52} state="idle" type={c.key} still />
                </span>
                <span className="mt-1 block truncate text-[9px] label-mono"
                      style={{ color: active ? "var(--fg-strong)" : "var(--muted)" }}>
                  {c.label}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          {CORE_TYPES.find((c) => c.key === core)?.hint}
        </p>
      </section>
    </div>
  );
}

/** 「おまかせ」がいま何になるか（ボタンに出すため）。 */
function autoKeyFor(skin: Skin, hasUserImage: boolean): BackgroundKey {
  if (skin === "custom" && hasUserImage) return "user-flat";
  const map: Record<Skin, BackgroundKey> = {
    cyber: "water-chrome", emerald: "emerald", forge: "stars",
    aibou: "plain", retro: "retro", custom: "plain",
  };
  return map[skin] ?? "plain";
}

function ColorField({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] tracking-[0.14em] text-muted label-mono">{label}</span>
      <span className="flex items-center gap-1.5 rounded-forge border border-panel p-1">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="h-7 w-7 shrink-0 cursor-pointer border-0 bg-transparent p-0"
        />
        <span className="min-w-0 truncate text-[10px] text-muted label-mono">{value.toUpperCase()}</span>
      </span>
    </label>
  );
}

/** 見本の色は、実際のトークンと同じ値を並べる（見本と中身がずれないように）。 */
const SWATCH: Record<Skin, { bg: string; card: string; bd: string; ink: string; accent: string }> = {
  cyber: { bg: "#080e20", card: "#111a33", bd: "#3d4a68", ink: "#ffffff", accent: "#cfd8ea" },
  emerald: { bg: "#03201a", card: "#050e0c", bd: "#d4af37", ink: "#ffffff", accent: "#e7c65c" },
  forge: { bg: "#0a0b0f", card: "#171a21", bd: "#3a3d45", ink: "#e8eaee", accent: "#00f3ff" },
  aibou: { bg: "#f4f5fd", card: "#ffffff", bd: "#e3e6f5", ink: "#1b2440", accent: "#3b5bfd" },
  retro: { bg: "#0d0d20", card: "#10102e", bd: "#ffffff", ink: "#ffffff", accent: "#ffd23f" },
  custom: { bg: "#101018", card: "#1a1a28", bd: "#8fb6ff", ink: "#ffffff", accent: "#8fb6ff" },
};
