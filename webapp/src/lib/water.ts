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
 * これは波動方程式をいちばん粗く解いた形で、見た目は本物の水になる。
 * 毎回わずかに減らす（減衰）ので、放っておけば必ず凪ぐ。
 *
 * 描くときは高さそのものではなく**傾き**を見る。傾いた所は光の反射が
 * ずれるので、そこに明るい線が出る——それが波紋に見える。
 *
 * なぜ格子を粗くするか
 * --------------------
 * 画面の画素ぶん計算すると、スマホでは間に合わない。8px四方で1点にして
 * 小さな画像を作り、引き伸ばして描く。輪郭がぼけるが、水はぼけていて
 * 構わない——むしろそのほうが水に見える。
 *
 * 触っていないときも、ゆっくり雨粒を落とす。完全に止まった水面は
 * 「壁紙」に見えてしまい、触れることに気づいてもらえない。
 */

export interface WaterOptions {
  /** 1点あたりの画素数（下限）。大きいほど軽く、粗い。 */
  cell?: number;
  /**
   * 格子の点数の上限。
   *
   * 画面が広いほど点が増えるので、放っておくとPCだけ重くなる（実測で
   * 1440x900 だと 30fps まで落ちた）。上限を決めて、超えるぶんは
   * 粗さで吸収する——水はぼけていて構わないので、ここは粗さで払う。
   */
  maxCells?: number;
  /** 波の減り方（0〜1）。1に近いほど長く残る。 */
  damping?: number;
  /** 触っていないときに落とす雨粒の間隔（秒）。0で止める。 */
  rainEvery?: number;
}

export interface WaterColors {
  /** 水の地の色（濃い側）。 */
  deep: [number, number, number];
  /** 水の地の色（浅い側＝上のほう）。 */
  shallow: [number, number, number];
  /** 反射の色（波の光）。 */
  sheen: [number, number, number];
}

/**
 * 水面。
 *
 * `step()` で1コマ進め、`render()` で描く。どちらも呼ぶ側が持つ
 * requestAnimationFrame の中から呼ぶ（自分でループを持たない——
 * 画面側がタブの表示状態や reduce-motion を見て止めるため）。
 */
export class Water {
  /** いま実際に使っている1点あたりの画素数（画面の広さで決まる）。 */
  cell: number;
  readonly minCell: number;
  readonly maxCells: number;
  readonly damping: number;
  readonly rainEvery: number;

  private w = 0;          // 格子の横の点数
  private h = 0;          // 格子の縦の点数
  private cur: Float32Array = new Float32Array(0);
  private prev: Float32Array = new Float32Array(0);
  private img: ImageData | null = null;
  private buf: HTMLCanvasElement | null = null;
  private bufCtx: CanvasRenderingContext2D | null = null;
  private rainAt = 0;

  constructor(opts: WaterOptions = {}) {
    this.minCell = Math.max(3, opts.cell ?? 8);
    this.cell = this.minCell;
    this.maxCells = Math.max(2000, opts.maxCells ?? 14000);
    this.damping = Math.min(0.999, Math.max(0.8, opts.damping ?? 0.976));
    this.rainEvery = opts.rainEvery ?? 2.4;
  }

  /** 画面の大きさに合わせて張り直す（波はいったん消える）。 */
  resize(pxW: number, pxH: number): void {
    // 上限を超えないところまで粗くする（広い画面だけ重くならないように）
    let cell = this.minCell;
    while ((pxW / cell) * (pxH / cell) > this.maxCells) cell += 1;
    this.cell = cell;

    this.w = Math.max(8, Math.ceil(pxW / this.cell));
    this.h = Math.max(8, Math.ceil(pxH / this.cell));
    const n = this.w * this.h;
    this.cur = new Float32Array(n);
    this.prev = new Float32Array(n);
    // 小さい画像を1枚作って、毎コマ書き換えて引き伸ばす
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
    }
  }

  get gridWidth(): number { return this.w; }
  get gridHeight(): number { return this.h; }

  /**
   * いまどれだけ暴れているか（高さの絶対値の合計）。
   *
   * 「凪いだか」を外から判断できるようにしておく。放っておいても
   * 止まらない水は不具合なので、そこを見張れる形にしておきたい。
   */
  energy(): number {
    let sum = 0;
    for (let i = 0; i < this.prev.length; i++) sum += Math.abs(this.prev[i]);
    return sum;
  }

  /** 格子の1点の高さ（外側を指したら0）。波の広がりを確かめるため。 */
  heightAt(gx: number, gy: number): number {
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) return 0;
    return this.prev[gy * this.w + gx];
  }

  /**
   * 波を立てる。画面の座標で受ける。
   *
   * radius は「指の太さ」。1点だけ叩くと尖った針のような波になり、
   * 水というより電気に見えるので、少し広げて落とす。
   */
  drop(pxX: number, pxY: number, strength = 1, radius = 2): void {
    if (!this.w) return;
    const gx = Math.round(pxX / this.cell);
    const gy = Math.round(pxY / this.cell);
    const r = Math.max(1, Math.round(radius));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const x = gx + dx, y = gy + dy;
        if (x < 1 || y < 1 || x >= this.w - 1 || y >= this.h - 1) continue;
        // 中心ほど深く沈める（縁は浅く）
        this.prev[y * this.w + x] -= strength * (1 - d / (r + 1));
      }
    }
  }

  /** 1コマ進める。dt は秒（大きすぎる跳びは丸める）。 */
  step(dt: number): void {
    if (!this.w) return;
    const { w, h, cur, prev, damping } = this;

    // 触っていなくても、たまに雨粒を落とす（止まった水は壁紙に見える）
    if (this.rainEvery > 0) {
      this.rainAt += dt;
      if (this.rainAt >= this.rainEvery) {
        this.rainAt = 0;
        this.drop(Math.random() * w * this.cell, Math.random() * h * this.cell,
                  0.35 + Math.random() * 0.3, 2);
      }
    }

    // 波の式。端は触らない（壁として跳ね返る）。
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const next = ((prev[i - 1] + prev[i + 1] + prev[i - w] + prev[i + w]) / 2) - cur[i];
        cur[i] = next * damping;
      }
    }
    // 入れ替え（今回の「次」が、次回の「前」になる）
    const t = this.prev;
    this.prev = this.cur;
    this.cur = t;
  }

  /**
   * 描く。高さではなく**傾き**を光に変える。
   *
   * 左右の高さの差が、そのまま「光がどれだけずれたか」になる。
   * ずれた所を明るくすると、波紋の縁が光って見える。
   */
  render(ctx: CanvasRenderingContext2D, pxW: number, pxH: number, colors: WaterColors): void {
    const { w, h, prev, img, buf, bufCtx } = this;
    if (!img || !buf || !bufCtx || !w) return;

    const data = img.data;
    const [dr, dg, db] = colors.deep;
    const [sr, sg, sb] = colors.shallow;
    const [hr, hg, hb] = colors.sheen;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      // 上ほど浅い色（遠くの水面が明るく見えるのと同じ理屈）
      const depth = y / (h - 1);
      const br = dr + (sr - dr) * (1 - depth);
      const bg = dg + (sg - dg) * (1 - depth);
      const bb = db + (sb - db) * (1 - depth);

      for (let x = 0; x < w; x++) {
        const i = row + x;
        // 傾き（左右差・上下差）。端は0にする。
        const gx = x > 0 && x < w - 1 ? prev[i - 1] - prev[i + 1] : 0;
        const gy = y > 0 && y < h - 1 ? prev[i - w] - prev[i + w] : 0;
        // 斜め上からの光に対する明るさ。0〜1に収める。
        // 傾きをそのまま明るさにする。係数が小さいと、水面ではなく
        // 「うっすら汚れた壁」に見える（最初そうなっていた）。
        const lit = Math.max(0, Math.min(1, (gx * 0.6 + gy * 0.8) * 1.9));
        const k = lit * lit;                    // 明るい所をより締める

        // 沈んでいる所は暗く落とす。明暗の両方が出て、初めて水になる。
        const dark = Math.max(0, Math.min(0.42, -(gx * 0.6 + gy * 0.8) * 1.3));

        const p = i * 4;
        data[p] = (br + (hr - br) * k) * (1 - dark);
        data[p + 1] = (bg + (hg - bg) * k) * (1 - dark);
        data[p + 2] = (bb + (hb - bb) * k) * (1 - dark);
        data[p + 3] = 255;
      }
    }

    bufCtx.putImageData(img, 0, 0);
    // 引き伸ばして描く。なめらかに拡大されるので、粗い格子が水のぼけになる。
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buf, 0, 0, w, h, 0, 0, pxW, pxH);
    ctx.imageSmoothingEnabled = smooth;
  }
}
