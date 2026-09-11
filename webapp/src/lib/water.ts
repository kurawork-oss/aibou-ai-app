/**
 * water.ts — 水たまりの面。触ると波が立って、広がって、消える。
 *
 * どう作っているか
 * ----------------
 * 絵を動かしているのではなく、**水面の高さを計算している**。
 * 格子の各点に高さを持ち、波の式で1コマずつ進める：
 *
 *     次 = (上 + 下 + 左 + 右) / 2 − 前
 *
 * 波動方程式をいちばん粗く解いた形。毎回わずかに減らす（減衰）ので、
 * 放っておけば必ず凪ぐ。
 *
 * 水に見せているのは「屈折」
 * --------------------------
 * 傾きを明るさに変えるだけでも波紋には見えるが、**水には見えない**。
 * 本物の水が水に見えるのは、下にある物が水面の傾きでずれて見えるから。
 *
 * だから底の絵（floor）を先に1枚作っておき、水面の傾きぶんだけ
 * **ずらして拾う**。波の下で底の模様がうねる——これが効く。
 * そこへ光の反射（specular）を足すと、濡れた面になる。
 *
 * 重さの見積もり
 * --------------
 * 1点あたり「波の更新」＋「底を拾う」＋「反射」で、だいたい20〜30演算。
 * 60fpsなら1コマ16.7msなので、JSで回せるのは数万点まで。
 * 画面が広いほど点が増えるので上限を置き、さらに**実測して足りなければ
 * 自動で粗くする**（弱い端末で固まるより、少し粗いほうがいい）。
 */

/**
 * 粗さの段（1点あたりの画素数）。左ほど細かい。
 *
 * 1ずつ足し引きすると、細かい側では刻みが大きすぎる（3→4 で点数が半分近く
 * 減る）。段で持って、1段ずつ上げ下げする。
 */
export const QUALITY_STEPS = [1.5, 2, 2.5, 3, 4, 5, 6, 8] as const;

export interface WaterOptions {
  /** 1点あたりの画素数（下限＝いちばん細かいとき）。 */
  cell?: number;
  /** 格子の点数の上限。広い画面だけ重くなるのを防ぐ。 */
  maxCells?: number;
  /** 波の減り方（0〜1）。1に近いほど長く残る。 */
  damping?: number;
  /** 触っていないときに落とす雨粒の間隔（秒）。0で止める。 */
  rainEvery?: number;
  /** 屈折の強さ（底をどれだけずらして拾うか。格子の点数で数える）。 */
  refract?: number;
}

export interface WaterColors {
  /** 水の地の色（濃い側）。 */
  deep: [number, number, number];
  /** 水の地の色（浅い側＝上のほう）。 */
  shallow: [number, number, number];
  /** 反射の色（波の照り）。 */
  sheen: [number, number, number];
}

/** 底に敷く模様の描き方。grid 座標系（点）で受け取る。 */
export type FloorPainter = (
  ctx: CanvasRenderingContext2D, w: number, h: number, colors: WaterColors,
) => void;

/**
 * 底の既定の絵。深さの階調＋細い格子。
 *
 * 模様を**水の下**に置くのが肝。上に重ねると、水と模様が別々の層に
 * 見えてしまう（実際そう見えていた）。下に置いて屈折させると、
 * 初めて「水を通して見ている」になる。
 */
export const defaultFloor: FloorPainter = (ctx, w, h, colors) => {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  g.addColorStop(0, rgb(colors.shallow));
  g.addColorStop(1, rgb(colors.deep));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // 細い格子（サイバーな床）。点の間隔で引くので、粗さが変わっても
  // 見た目の密度は変わらない。
  const step = Math.max(6, Math.round(w / 26));
  ctx.strokeStyle = "rgba(150,175,215,0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();

  // 斜めの走査線を1本おきに。格子だけだと方眼紙に見える。
  ctx.strokeStyle = "rgba(170,195,235,0.06)";
  ctx.beginPath();
  const diag = Math.max(10, Math.round(w / 9));
  for (let i = -h; i < w + h; i += diag) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
  }
  ctx.stroke();
};

/**
 * 画像を底に敷く。
 *
 * 画面いっぱいに、縦横の比を保って敷く（はみ出るぶんは切る）。
 * 引き伸ばして比を崩すと、金属の照りが歪んで安っぽく見える。
 *
 * 明るい所を抑えるのが肝
 * ----------------------
 * 写真や作品は、真っ白から真っ黒まで使っていることが多い。そのまま
 * 敷くと、白い所に載った文字が読めなくなる（実際そうなった——
 * 「ENTERで送信」の行が銀に飲まれて消えた）。
 *
 * かといって全体を暗い膜で覆うと、絵の良さまで潰れる。だから
 * **掛け算で明るい側だけを引き下げ**、暗い側はほぼそのまま残す。
 * 形と流れは保ったまま、文字と張り合わなくなる。
 *
 * highlight は「いちばん明るい所をどこまで下げるか」（0〜1）。
 */
export function imageFloor(
  img: CanvasImageSource, iw: number, ih: number, highlight = 0.52,
): FloorPainter {
  return (ctx, w, h) => {
    const scale = Math.max(w / iw, h / ih);      // cover
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);

    // 掛け算で全体を下げる（白 255 → 255*highlight）
    const v = Math.round(255 * Math.max(0, Math.min(1, highlight)));
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(0, 0, w, h);

    // 暗い側が沈みすぎないよう、ごくうすく持ち上げる
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(10,16,34,1)";
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = "source-over";
  };
}

/**
 * 水面。
 *
 * `step()` で1コマ進め、`render()` で描く。どちらも呼ぶ側が持つ
 * requestAnimationFrame の中から呼ぶ（自分でループを持たない——
 * 画面側がタブの表示状態や reduce-motion を見て止めるため）。
 */
export class Water {
  /** いま実際に使っている1点あたりの画素数（画面の広さと速さで決まる）。 */
  cell: number;
  readonly minCell: number;
  readonly maxCells: number;
  readonly damping: number;
  readonly rainEvery: number;
  readonly refract: number;

  private w = 0;
  private h = 0;
  private cur: Float32Array = new Float32Array(0);
  private prev: Float32Array = new Float32Array(0);
  private img: ImageData | null = null;
  private buf: HTMLCanvasElement | null = null;
  private bufCtx: CanvasRenderingContext2D | null = null;
  /** 底の絵（RGBA）。屈折して拾う元。 */
  private floor: Uint8ClampedArray | null = null;
  private rainAt = 0;
  private pxW = 0;
  private pxH = 0;
  private painter: FloorPainter = defaultFloor;
  private colors: WaterColors | null = null;

  constructor(opts: WaterOptions = {}) {
    this.minCell = Math.max(1, opts.cell ?? 4);
    this.cell = this.minCell;
    this.maxCells = Math.max(2000, opts.maxCells ?? 60000);
    this.damping = Math.min(0.999, Math.max(0.8, opts.damping ?? 0.986));
    this.rainEvery = opts.rainEvery ?? 1.9;
    this.refract = opts.refract ?? 7;
  }

  /** 底の模様を差し替える（張り直しのたびに描き直される）。 */
  setFloor(painter: FloorPainter): void {
    this.painter = painter;
    if (this.pxW) this.bakeFloor();
  }

  /**
   * 画面の大きさに合わせて張り直す（波はいったん消える）。
   *
   * `cellOverride` を渡すと、その粗さで張る（速さが足りないときに
   * 呼び出し側が粗くするため）。
   */
  resize(pxW: number, pxH: number, cellOverride?: number): void {
    this.pxW = pxW;
    this.pxH = pxH;

    // 上限を超えないところまで粗くする。1ずつ足すと細かい側で刻みが
    // 大きすぎる（1.5→2.5 で点数が3割減る）ので、少しずつ掛けて寄せる。
    let cell = Math.max(this.minCell, cellOverride ?? this.minCell);
    while ((pxW / cell) * (pxH / cell) > this.maxCells) cell *= 1.08;
    this.cell = cell;

    this.w = Math.max(8, Math.ceil(pxW / cell));
    this.h = Math.max(8, Math.ceil(pxH / cell));
    const n = this.w * this.h;
    this.cur = new Float32Array(n);
    this.prev = new Float32Array(n);

    if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = this.w;
      c.height = this.h;
      const ctx = c.getContext("2d");
      if (ctx) {
        this.buf = c;
        this.bufCtx = ctx;
        this.img = ctx.createImageData(this.w, this.h);
      }
      this.bakeFloor();
    }
  }

  /** 底の絵を1枚焼いておく（毎コマ描き直さない）。 */
  private bakeFloor(): void {
    if (typeof document === "undefined" || !this.w || !this.colors) return;
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    this.painter(ctx, this.w, this.h, this.colors);
    this.floor = ctx.getImageData(0, 0, this.w, this.h).data;
  }

  get gridWidth(): number { return this.w; }
  get gridHeight(): number { return this.h; }

  /** いまどれだけ暴れているか（高さの絶対値の合計）。 */
  energy(): number {
    let sum = 0;
    for (let i = 0; i < this.prev.length; i++) sum += Math.abs(this.prev[i]);
    return sum;
  }

  /** 格子の1点の高さ（外側を指したら0）。 */
  heightAt(gx: number, gy: number): number {
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) return 0;
    return this.prev[gy * this.w + gx];
  }

  /**
   * 波を立てる。画面の座標で受ける。
   *
   * radius は「指の太さ」。1点だけ叩くと針のような波になり、水というより
   * 電気に見えるので、少し広げて落とす。
   */
  drop(pxX: number, pxY: number, strength = 1, radiusPx = 14): void {
    if (!this.w) return;
    const gx = Math.round(pxX / this.cell);
    const gy = Math.round(pxY / this.cell);
    // 指の太さは画面の長さで受け取る（粗さが変わっても同じ大きさの波になる）
    const r = Math.max(1, Math.round(radiusPx / this.cell));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const x = gx + dx, y = gy + dy;
        if (x < 1 || y < 1 || x >= this.w - 1 || y >= this.h - 1) continue;
        // なめらかに沈める（角が立つと、波紋が四角くなる）
        const f = 0.5 + 0.5 * Math.cos((d / (r + 1)) * Math.PI);
        this.prev[y * this.w + x] -= strength * f;
      }
    }
  }

  /** 1コマ進める。dt は秒。 */
  step(dt: number): void {
    if (!this.w) return;
    const { w, h, cur, prev, damping } = this;

    if (this.rainEvery > 0) {
      this.rainAt += dt;
      if (this.rainAt >= this.rainEvery) {
        this.rainAt = 0;
        this.drop(Math.random() * this.pxW, Math.random() * this.pxH,
                  0.30 + Math.random() * 0.28, 10 + Math.random() * 10);
      }
    }

    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const next = ((prev[i - 1] + prev[i + 1] + prev[i - w] + prev[i + w]) / 2) - cur[i];
        cur[i] = next * damping;
      }
    }
    const t = this.prev;
    this.prev = this.cur;
    this.cur = t;
  }

  /**
   * 描く。
   *
   *   ① 傾きから法線を作る
   *   ② その向きにずらして**底を拾う**（屈折）
   *   ③ 光の反射を足す（濡れた面の照り）
   *
   * ②が水に見せている。①③だけだと、うねった模様止まりになる。
   */
  render(ctx: CanvasRenderingContext2D, pxW: number, pxH: number, colors: WaterColors): void {
    // 色が変わったら底を焼き直す（初回もここで焼かれる）
    if (!this.colors || this.colors.deep[0] !== colors.deep[0]
        || this.colors.shallow[0] !== colors.shallow[0]) {
      this.colors = colors;
      this.bakeFloor();
    }

    const { w, h, prev, img, buf, bufCtx, floor } = this;
    if (!img || !buf || !bufCtx || !floor || !w) return;

    const data = img.data;
    const [hr, hg, hb] = colors.sheen;
    const K = this.refract;

    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;

        // ① 傾き（法線の x,y 成分にあたる）
        const gx = prev[i - 1] - prev[i + 1];
        const gy = prev[i - w] - prev[i + w];

        // ② 屈折：傾いた向きへずらして底を拾う。
        //    四捨五入で寄せる。切り捨てだと、弱い傾き（ほとんどの所）が
        //    すべて 0 になって、屈折そのものが効かなくなる。
        let sx = (x + gx * K + 0.5) | 0;
        let sy = (y + gy * K + 0.5) | 0;
        if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
        if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
        const f = (sy * w + sx) * 4;

        // ③ 反射：斜め上からの光。傾きが光の向きに合った所が強く光る。
        //    2乗を重ねて、狭く鋭い照りにする（広いと霧に見える）
        // ③ 反射：**細く鋭い照り**にする。広く強くすると白い塊になって、
        //    水ではなくこぼれた絵の具に見える（実際そうなった）。
        //    水らしさを作っているのは②の屈折なので、ここは控える。
        let lit = (gx * 0.55 + gy * 0.83) * 1.5;
        lit = lit > 0 ? lit : 0;
        const s2 = lit * lit;
        const s4 = s2 * s2;
        const spec = s4 * s2 * 0.55;         // 6乗。急な斜面だけが光る
        const k = spec > 0.55 ? 0.55 : spec;

        // 沈んでいる側は暗く。明暗が揃って初めて水になる。
        // 沈んでいる側は少しだけ暗く。明暗が揃って初めて水になるが、
        // 強くすると影が塊になる。
        let dip = -(gx * 0.55 + gy * 0.83) * 1.1;
        dip = dip > 0 ? dip : 0;
        const dark = dip > 0.30 ? 0.30 : dip;

        const p = i * 4;
        data[p] = (floor[f] + (hr - floor[f]) * k) * (1 - dark);
        data[p + 1] = (floor[f + 1] + (hg - floor[f + 1]) * k) * (1 - dark);
        data[p + 2] = (floor[f + 2] + (hb - floor[f + 2]) * k) * (1 - dark);
        data[p + 3] = 255;
      }
    }

    // 端の1列は計算していないので、底をそのまま置く（真っ黒の枠を作らない）
    for (let y = 0; y < h; y++) {
      for (const x of [0, w - 1]) {
        const i = (y * w + x) * 4;
        data[i] = floor[i]; data[i + 1] = floor[i + 1];
        data[i + 2] = floor[i + 2]; data[i + 3] = 255;
      }
    }
    for (let x = 0; x < w; x++) {
      for (const y of [0, h - 1]) {
        const i = (y * w + x) * 4;
        data[i] = floor[i]; data[i + 1] = floor[i + 1];
        data[i + 2] = floor[i + 2]; data[i + 3] = 255;
      }
    }

    bufCtx.putImageData(img, 0, 0);
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buf, 0, 0, w, h, 0, 0, pxW, pxH);
    ctx.imageSmoothingEnabled = smooth;
  }
}
