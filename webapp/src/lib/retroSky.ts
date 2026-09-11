/**
 * 昔のゲームの夜空。
 *
 * 作り方の肝：**小さく描いて、拡大する**
 * --------------------------------------
 * 「粗く見せる」ために大きな四角をたくさん置くのは、遠回りのうえに重い。
 * 160×90 くらいの小さな面に普通に描いて、それを画面いっぱいへ
 * 引き伸ばす（補間を切って）。すると
 *
 *   ・画素が必ず格子に揃う（中途半端な位置に点が出ない）
 *   ・計算する点が 1.4万で済む。画面が 4K でも増えない
 *
 * 昔の機械が実際にやっていたことと同じで、いちばん安い。
 *
 * もうひとつの肝は**時間も刻む**こと。なめらかに動かすと、いくら画素が
 * 粗くても「粗い今の絵」にしかならない。毎秒8コマに落とす。
 */

/**
 * 小さい面の高さ（幅は画面の比から決まる）。
 *
 * 粗いほどドットらしいが、粗すぎると星1つが1cm四方の白い箱になって、
 * 星ではなく**ゴミ**に見える（96 で描いたら実際そうなった）。
 * 実機のファミコンは 240 本。そこまで細かいとドット感が薄れるので、
 * その半分あたりに置く。
 */
const BASE_H = 128;
/** 1秒あたりのコマ数。昔のゲームの見え方に寄せる。 */
const FPS = 8;

export interface RetroSkyColors {
  /** 空（上→下の2段）。 */
  skyTop: string;
  skyBottom: string;
  /** 山の影。 */
  hill: string;
  hillFar: string;
  /** 地面。 */
  ground: string;
  groundDot: string;
  /** 星と月。 */
  star: string;
  moon: string;
}

export const RETRO_COLORS: RetroSkyColors = {
  skyTop: "#0d0d20",
  skyBottom: "#1c1c44",
  hillFar: "#241f4d",
  hill: "#15132e",
  ground: "#0a1c13",
  groundDot: "#14311f",
  star: "#ffffff",
  moon: "#ffd23f",
};

/**
 * 星の位置は毎回ばらつかせたいが、**コマごとに変わってはいけない**
 * （毎フレーム乱数を振ると、星が降っているように見える）。
 * 座標から決まる、繰り返せる乱数を使う。
 */
function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export class RetroSky {
  private buf: HTMLCanvasElement | null = null;
  private bctx: CanvasRenderingContext2D | null = null;
  private bw = 0;
  private bh = BASE_H;
  /** 最後に描いたコマ番号。同じコマなら描き直さない。 */
  private lastFrame = -1;

  /** 画面の大きさに合わせる。小さい面の大きさだけが変わる。 */
  resize(pxW: number, pxH: number): void {
    if (typeof document === "undefined") return;
    this.bh = BASE_H;
    this.bw = Math.max(16, Math.round((pxW / Math.max(1, pxH)) * BASE_H));
    const c = document.createElement("canvas");
    c.width = this.bw;
    c.height = this.bh;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    this.buf = c;
    this.bctx = ctx;
    this.lastFrame = -1;
  }

  get bufferWidth(): number { return this.bw; }
  get bufferHeight(): number { return this.bh; }

  /**
   * 描く。
   *
   * コマが変わっていなければ、前に描いた面をそのまま貼るだけ
   * （60fps の画面でも、実際に描くのは毎秒8回）。
   */
  render(ctx: CanvasRenderingContext2D, pxW: number, pxH: number, t: number,
         colors: RetroSkyColors = RETRO_COLORS): void {
    if (!this.buf || !this.bctx) return;
    const frame = Math.floor(t * FPS);
    if (frame !== this.lastFrame) {
      this.paint(frame, colors);
      this.lastFrame = frame;
    }
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;   // ここを切らないと、ただのぼやけた絵になる
    ctx.drawImage(this.buf, 0, 0, this.bw, this.bh, 0, 0, pxW, pxH);
    ctx.imageSmoothingEnabled = smooth;
  }

  private paint(frame: number, c: RetroSkyColors): void {
    const ctx = this.bctx!;
    const w = this.bw;
    const h = this.bh;

    /* 空は段で塗る。なめらかな階調にすると、そこだけ今の絵になる。
       ただし2色を市松で混ぜる（昔のディザ）を1本入れたら、その帯だけが
       **不具合のような縞**として浮いた。段数を増やして、混ぜずに刻む。 */
    const BANDS = 7;
    const skyH = Math.round(h * 0.70);
    const top = parseRgb(c.skyTop);
    const bot = parseRgb(c.skyBottom);
    for (let i = 0; i < BANDS; i++) {
      const k = i / (BANDS - 1);
      const ch = (a: number, b: number) => Math.round(a + (b - a) * k);
      ctx.fillStyle = `rgb(${ch(top[0], bot[0])},${ch(top[1], bot[1])},${ch(top[2], bot[2])})`;
      const y0 = Math.floor((skyH * i) / BANDS);
      const y1 = Math.ceil((skyH * (i + 1)) / BANDS);
      ctx.fillRect(0, y0, w, y1 - y0 + 1);
    }

    // 星。位置は固定、またたきだけコマで変わる
    const STARS = Math.round(w * 0.5);
    ctx.fillStyle = c.star;
    for (let i = 0; i < STARS; i++) {
      const sx = Math.floor(hash(i, 1) * w);
      const sy = Math.floor(hash(i, 2) * h * 0.52);
      // 数コマに1回、消える（全部が同時にまたたかないように位相をずらす）
      if ((frame + i) % 13 < 2) continue;
      ctx.fillRect(sx, sy, 1, 1);
      if (hash(i, 3) > 0.96) {
        // 大きい星は十字に
        ctx.fillRect(sx - 1, sy, 1, 1);
        ctx.fillRect(sx + 1, sy, 1, 1);
        ctx.fillRect(sx, sy - 1, 1, 1);
        ctx.fillRect(sx, sy + 1, 1, 1);
      }
    }

    /* 月。
       最初は半径7（画面では直径120px）で描いたら、コアの真横に巨大な丸が
       並んで、どちらが主役か分からなくなった。背景は背景に留める：
       小さくして、薄く置く。 */
    const mx = Math.round(w * 0.84);
    const my = Math.round(h * 0.11);
    const mr = 4;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = c.moon;
    for (let y = -mr; y <= mr; y++) {
      for (let x = -mr; x <= mr; x++) {
        if (x * x + y * y > mr * mr) continue;
        ctx.fillRect(mx + x, my + y, 1, 1);
      }
    }
    ctx.fillStyle = c.skyTop;
    for (const [dx, dy] of [[-1, -1], [2, 1], [0, 2]] as const) {
      ctx.fillRect(mx + dx, my + dy, 1, 1);
    }
    ctx.restore();

    // 遠くの山（2段）。横にゆっくり流す
    const drift = (frame / FPS) * 1.2;
    const hills = (baseY: number, amp: number, period: number, color: string, off: number) => {
      ctx.fillStyle = color;
      for (let x = 0; x < w; x++) {
        const y = Math.round(baseY
          + Math.sin((x + off + drift) / period) * amp
          + Math.sin((x + off) / (period * 0.37)) * (amp * 0.35));
        ctx.fillRect(x, y, 1, h - y);
      }
    };
    hills(Math.round(h * 0.72), 5, 17, c.hillFar, 0);
    hills(Math.round(h * 0.82), 4, 12, c.hill, 40);

    /* 地面。手前へ流れる草の点。
       画面の下は入力欄と送信の案内が載る所なので、明るい帯を敷くと
       文字が沈む（緑を高く敷いたら「ENTERで送信」が読めなくなった）。
       低く、暗く。 */
    const gy = Math.round(h * 0.945);
    ctx.fillStyle = c.ground;
    ctx.fillRect(0, gy, w, h - gy);
    ctx.fillStyle = c.groundDot;
    for (let y = gy + 1; y < h; y += 3) {
      // 手前ほど大きく流れる（奥行きが出る）
      const speed = 0.5 + ((y - gy) / Math.max(1, h - gy)) * 3.2;
      const shift = Math.floor((frame / FPS) * speed * 6) % 6;
      for (let x = ((y * 3) % 6) - shift; x < w; x += 6) {
        if (x < 0) continue;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

/** "#rrggbb" を数の3つ組にする（段を作るのに中間色が要る）。 */
function parseRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
