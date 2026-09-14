"use client";

/**
 * ImageStudio — 画像作成（ChatGPT の画像生成のような体験）.
 *
 *  ・指示を書く → 同じ指示で複数案を並べて生成し、好きなものを選ぶ
 *  ・用途別のアスペクト比プリセット（Instagram / ストーリー / YouTube ほか）
 *  ・画風チップで指示を補う（写真・イラスト・水彩…）
 *  ・「別案を見る」で seed をずらして、同じ指示のまま違う絵を出す
 *  ・拡大表示（←→で切替）／ダウンロード／生成物に保存
 *
 * 画像は Pollinations（APIキー不要）。同じ指示＋seedなら同じ絵が出る＝再現性がある。
 */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { imageAspects, imageEngines, imageGenerate, API_URL, type ImageAspect, type ImageEngine, type ImageVariant } from "@/lib/api";

/** アスペクト比の既定値（/image/aspects が取れないときのフォールバック）。 */
const FALLBACK_ASPECTS: ImageAspect[] = [
  { key: "1:1", w: 1024, h: 1024, label: "正方形（Instagram）" },
  { key: "4:5", w: 1024, h: 1280, label: "縦長（Instagramフィード）" },
  { key: "9:16", w: 1080, h: 1920, label: "縦全画面（ストーリー/Reels）" },
  { key: "16:9", w: 1280, h: 720, label: "横長（YouTube/スライド）" },
  { key: "3:2", w: 1200, h: 800, label: "写真（ブログ挿絵）" },
];

/** 画風。押すと指示の末尾に足される（言葉で指定するのがいちばん効く）。 */
const LOOKS = [
  { label: "写真", add: "photorealistic, natural lighting, high detail" },
  { label: "イラスト", add: "flat illustration, clean vector shapes" },
  { label: "水彩", add: "watercolor painting, soft edges, paper texture" },
  { label: "アニメ", add: "anime style, cel shading, crisp lineart" },
  { label: "3D", add: "3d render, soft studio lighting, subtle depth of field" },
  { label: "線画", add: "minimal line art, monochrome, white background" },
  { label: "レトロ", add: "retro print, muted palette, film grain" },
];

const HF_MAX = 2;   // サーバー側 imagegen.HF_MAX_VARIANTS と合わせる

const EXAMPLES = [
  "朝もやの中の静かな湖、対岸に杉林、水面に反射した空",
  "木のテーブルに置かれた一杯のコーヒーと開いた文庫本、窓からの斜光",
  "夜の路地の小さなラーメン屋、暖簾から漏れる灯り、雨上がりの反射",
];

export default function ImageStudio() {
  const [prompt, setPrompt] = useState("");
  const [aspects, setAspects] = useState<ImageAspect[]>(FALLBACK_ASPECTS);
  const [aspect, setAspect] = useState("1:1");
  const [n, setN] = useState(2);
  const [images, setImages] = useState<ImageVariant[]>([]);
  const [shown, setShown] = useState("");        // 生成に使った指示（表示用）
  const [offset, setOffset] = useState(0);       // 「別案を見る」でずらす
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  // エンジン：無料(Pollinations) / HFに割り当てたモデル。HFは遅いので枚数上限が別。
  const [engs, setEngs] = useState<Record<string, ImageEngine>>({});
  const [engine, setEngine] = useState("pollinations");

  // HFへ切り替えたら枚数も上限に合わせる（押せない枚数が選ばれたままにしない）
  useEffect(() => { if (engine === "hf" && n > HF_MAX) setN(HF_MAX); }, [engine, n]);

  useEffect(() => {
    let alive = true;
    imageAspects()
      .then((a) => { if (alive && a.length) setAspects(a); })
      .catch(() => { /* フォールバックのままで使える */ });
    imageEngines()
      .then((e) => {
        if (!alive) return;
        setEngs(e);
        // HFにモデルを割り当てていれば、そちらを既定にする（意図して入れたはずなので）
        if (e.hf?.ready) setEngine("hf");
      })
      .catch(() => { /* 無料エンジンのままで使える */ });
    return () => { alive = false; };
  }, []);

  const cur = aspects.find((a) => a.key === aspect) ?? FALLBACK_ASPECTS[0];

  const run = async (opts?: { reroll?: boolean }) => {
    const text = (opts?.reroll ? shown : prompt).trim();
    if (!text || busy) return;
    const nextOffset = opts?.reroll ? offset + images.length : 0;
    setBusy(true);
    setNote(opts?.reroll ? "別案を生成中…" : "生成中…");
    try {
      const r = await imageGenerate({ prompt: text, aspect, n, offset: nextOffset, engine });
      if (r.error || !r.images?.length) {
        setNote(`⚠ ${r.error ?? "生成できませんでした"}`);
      } else {
        setImages(r.images);
        setShown(text);
        setOffset(nextOffset);
        const via = r.engine === "hf" && r.model ? ` · ${r.model.split("/").pop()}` : "";
        setNote(`✓ ${r.images.length}案（${r.width}×${r.height}）${via}`
          + (r.partial_error ? ` ／ 一部失敗: ${r.partial_error}` : ""));
      }
    } catch {
      setNote("⚠ 通信に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const saveAll = async () => {
    if (!shown || busy) return;
    setBusy(true);
    setNote("保存中…");
    try {
      const r = await imageGenerate({ prompt: shown, aspect, n: images.length, offset, save: true, engine });
      setNote(r.artifacts?.length ? `✓ ${r.artifacts.length}枚を生成物に保存しました` : `⚠ ${r.error ?? "保存に失敗"}`);
    } catch { setNote("⚠ 保存に失敗しました"); } finally { setBusy(false); }
  };

  const addLook = (add: string) => {
    setPrompt((p) => {
      const base = p.trim();
      if (!base) return add;
      return base.includes(add) ? base : `${base}, ${add}`;
    });
  };

  if (!API_URL) {
    return <div className="panel p-3 text-[11px] leading-relaxed text-muted">画像作成はバックエンド接続後に使えます（DIAGNOSTICS参照）。</div>;
  }

  return (
    /* min-w-0 が無いと grid の子が内容幅まで広がり、スマホ幅で横にはみ出す。 */
    <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[20rem_1fr]">
      {/* ── 左：指示 ── */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto">
        <div className="panel p-3">
          <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">IMAGE — どんな絵にしますか？</div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="例：朝もやの湖、対岸に杉林、静かな水面"
            className="w-full resize-none rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
          />

          <div className="mt-2 text-[9px] tracking-[0.16em] text-muted label-mono">画風を足す</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {LOOKS.map((l) => (
              <button key={l.label} type="button" onClick={() => addLook(l.add)} title={l.add}
                className="rounded-full border border-panel px-2.5 py-1 text-[10px] text-muted transition hover:border-[var(--line)] hover:text-fg-strong label-mono">
                +{l.label}
              </button>
            ))}
          </div>

          <div className="mt-2.5 text-[9px] tracking-[0.16em] text-muted label-mono">比率</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {aspects.map((a) => (
              <button key={a.key} type="button" onClick={() => setAspect(a.key)} title={a.label}
                aria-pressed={aspect === a.key}
                className="rounded-full border px-2.5 py-1 text-[10px] label-mono"
                style={{
                  borderColor: aspect === a.key ? "var(--accent)" : "var(--panel-bd)",
                  color: aspect === a.key ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {a.key}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted">{cur.label} · {cur.w}×{cur.h}</p>

          <div className="mt-2.5 text-[9px] tracking-[0.16em] text-muted label-mono">エンジン</div>
          <div className="mt-1 flex gap-1">
            {[["pollinations", "無料"], ["hf", "HF"]].map(([key, label]) => {
              const e = engs[key];
              const ready = key === "pollinations" ? true : !!e?.ready;
              return (
                <button key={key} type="button" onClick={() => ready && setEngine(key)}
                  disabled={!ready} aria-pressed={engine === key}
                  title={ready ? (e?.model || e?.label || "キー不要の無料エンジン") : (e?.hint || "未設定")}
                  className="flex-1 min-w-0 truncate rounded-forge border px-2 py-1 text-[10px] label-mono disabled:opacity-30"
                  style={{
                    borderColor: engine === key ? "var(--accent)" : "var(--panel-bd)",
                    color: engine === key ? "var(--fg-strong)" : "var(--muted)",
                  }}>
                  {label}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            {engine === "hf"
              ? `${engs.hf?.model ?? ""}（1枚ずつ数秒〜数十秒。枚数は2までに絞られます）`
              : engs.hf?.ready === false
                ? "HFを使うには 設定 →「つなぐ」で「画像生成」にモデルを割り当ててください"
                : "キー不要・すぐ出る"}
          </p>

          <div className="mt-2.5 text-[9px] tracking-[0.16em] text-muted label-mono">枚数</div>
          <div className="mt-1 flex gap-1">
            {[1, 2, 3, 4].map((v) => (
              <button key={v} type="button" onClick={() => setN(v)} aria-pressed={n === v}
                disabled={engine === "hf" && v > HF_MAX}
                title={engine === "hf" && v > HF_MAX ? "HFのモデルは時間がかかるため2枚までです" : undefined}
                className="flex-1 rounded-forge border py-1 text-[10px] disabled:opacity-25 label-mono"
                style={{
                  borderColor: n === v ? "var(--accent)" : "var(--panel-bd)",
                  color: n === v ? "var(--fg-strong)" : "var(--muted)",
                }}>
                {v}
              </button>
            ))}
          </div>

          <button type="button" onClick={() => void run()} disabled={busy || !prompt.trim()}
            className="mt-2.5 w-full rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2.5 text-[11px] tracking-[0.16em] text-fg-strong shadow-glow disabled:opacity-40 label-mono">
            {busy ? "…" : "画像を生成"}
          </button>

          {note && <p className="mt-2 text-[10px] leading-relaxed" style={{ color: note.startsWith("✓") ? "#60d394" : note.startsWith("⚠") ? "#ff9b9b" : "var(--muted)" }}>{note}</p>}
        </div>

        {images.length === 0 ? (
          <div className="panel p-3">
            <div className="mb-1.5 text-[9px] tracking-[0.16em] text-muted label-mono">例</div>
            <div className="flex flex-col gap-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => setPrompt(ex)}
                  className="rounded-forge border border-panel p-2 text-left text-[10px] leading-relaxed text-muted transition hover:border-[var(--line)] hover:text-fg-strong">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="panel p-3">
            <div className="mb-1.5 text-[9px] tracking-[0.16em] text-muted label-mono">この指示のまま</div>
            <div className="flex flex-col gap-1.5">
              <button type="button" onClick={() => void run({ reroll: true })} disabled={busy}
                className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] py-2 text-[10px] tracking-[0.12em] text-fg-strong disabled:opacity-40 label-mono">↻ 別案を見る</button>
              <button type="button" onClick={() => void saveAll()} disabled={busy}
                className="rounded-forge border border-panel py-2 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong disabled:opacity-40 label-mono">生成物に保存</button>
              <button type="button" onClick={() => { setPrompt(shown); setImages([]); setOffset(0); setNote(null); }}
                className="rounded-forge border border-panel py-2 text-[10px] tracking-[0.12em] text-muted transition hover:text-fg-strong label-mono">指示を編集する</button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              ※ 同じ指示なら同じ絵が出ます（再現性あり）。「別案を見る」でseedをずらします。
            </p>
          </div>
        )}
      </div>

      {/* ── 右：結果 ── */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        {shown && <p className="truncate text-[10px] text-muted label-mono">{shown}</p>}
        <div className="min-h-0 flex-1 overflow-auto rounded-forge border border-panel bg-[rgba(255,255,255,0.02)] p-3">
          {busy && images.length === 0 ? (
            <motion.div className="grid h-full place-items-center text-[11px] tracking-[0.2em] text-muted label-mono"
              animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
              ◈ RENDERING…
            </motion.div>
          ) : images.length === 0 ? (
            <div className="grid h-full place-items-center p-6 text-center">
              <p className="text-[11px] leading-relaxed tracking-[0.14em] text-muted/60 label-mono">
                左に作りたい絵を書いて「画像を生成」<br />
                複数案から選べます
              </p>
            </div>
          ) : (
            /* minmax の下限に min() を挟むと、220pxより狭い枠でも溢れずに1列に落ちる。 */
            <div className="grid gap-3" style={{ gridTemplateColumns: images.length === 1 ? "1fr" : "repeat(auto-fit,minmax(min(220px,100%),1fr))" }}>
              {images.map((img, i) => (
                <ImageCard key={img.seed} img={img} index={i} prompt={shown} onZoom={() => setZoom(i)} />
              ))}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {zoom !== null && images[zoom] && (
          <Zoom images={images} index={zoom} prompt={shown} onNavigate={setZoom} onClose={() => setZoom(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

/** 画像1枚ずつをダウンロードする（CORSで失敗したら別タブで開く）。 */
async function downloadImage(url: string, name: string) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, "_blank");
  }
}

function fileName(prompt: string, seed: number) {
  const base = prompt.trim().slice(0, 24).replace(/[^\p{L}\p{N}_-]/gu, "_") || "image";
  return `${base}_${seed}.png`;
}

function ImageCard({ img, index, prompt, onZoom }: {
  img: ImageVariant; index: number; prompt: string; onZoom: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="overflow-hidden rounded-forge border border-panel bg-black/20">
      <button type="button" onClick={onZoom} className="block w-full" title="拡大して見る">
        {!loaded && !failed && (
          <div className="grid aspect-square w-full place-items-center text-[10px] tracking-[0.16em] text-muted label-mono">◈ …</div>
        )}
        {failed ? (
          <div className="grid aspect-square w-full place-items-center px-4 text-center text-[10px] leading-relaxed text-muted">
            画像を読み込めませんでした
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={img.url} alt={`${prompt} 案${index + 1}`}
            onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
            className="w-full" style={{ display: loaded ? "block" : "none" }} />
        )}
      </button>
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="text-[9px] text-muted label-mono">案{index + 1} · seed {img.seed}</span>
        <div className="flex gap-1">
          <button type="button" onClick={() => void downloadImage(img.url, fileName(prompt, img.seed))}
            title="ダウンロード"
            className="rounded-md border border-panel px-2 py-0.5 text-[10px] text-muted transition hover:text-fg-strong label-mono">⭳</button>
          <a href={img.url} target="_blank" rel="noopener noreferrer" title="別タブで開く"
            className="rounded-md border border-panel px-2 py-0.5 text-[10px] text-muted transition hover:text-fg-strong label-mono">↗</a>
        </div>
      </div>
    </div>
  );
}

/** 拡大表示。←→で案を切替、Escで閉じる。 */
function Zoom({ images, index, prompt, onNavigate, onClose }: {
  images: ImageVariant[]; index: number; prompt: string;
  onNavigate: (i: number) => void; onClose: () => void;
}) {
  const cur = images[index];
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onNavigate((index - 1 + images.length) % images.length);
      else if (e.key === "ArrowRight") onNavigate((index + 1) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onNavigate, onClose]);

  // 親に perspective/rotateX が掛かっていると fixed がビューポートに効かないため
  // body へポータルする。
  return createPortal(
    <motion.div role="dialog" aria-label="画像を拡大"
      className="fixed inset-0 z-[70] flex flex-col bg-black/90 backdrop-blur-sm"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <div className="flex items-center justify-between gap-3 px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0">
          <div className="truncate text-[13px] text-fg-strong">{prompt}</div>
          <div className="text-[9px] tracking-[0.16em] text-muted label-mono">
            案 {index + 1} / {images.length} · seed {cur.seed}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => void downloadImage(cur.url, fileName(prompt, cur.seed))}
            className="rounded-forge border border-[var(--line)] bg-[var(--btn-bg)] px-3 py-1.5 text-[10px] tracking-[0.12em] text-fg-strong label-mono">⭳ 保存</button>
          <button type="button" onClick={onClose} aria-label="閉じる"
            className="grid h-8 w-8 place-items-center rounded-lg border border-panel text-muted transition hover:text-fg-strong">✕</button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6" onClick={(e) => e.stopPropagation()}>
        {images.length > 1 && (
          <button type="button" aria-label="前の案" onClick={() => onNavigate((index - 1 + images.length) % images.length)}
            className="absolute left-3 z-10 grid h-10 w-10 place-items-center rounded-full border border-panel bg-black/50 text-lg text-muted transition hover:text-fg-strong">‹</button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={cur.seed} src={cur.url} alt={prompt} className="max-h-full max-w-full rounded-forge object-contain" />
        {images.length > 1 && (
          <button type="button" aria-label="次の案" onClick={() => onNavigate((index + 1) % images.length)}
            className="absolute right-3 z-10 grid h-10 w-10 place-items-center rounded-full border border-panel bg-black/50 text-lg text-muted transition hover:text-fg-strong">›</button>
        )}
      </div>
    </motion.div>,
    document.body,
  );
}
