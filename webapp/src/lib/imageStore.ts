/**
 * 自分で選んだ背景画像の置き場。
 *
 * なぜ localStorage ではないのか
 * ------------------------------
 * localStorage は**文字列**しか置けないので、画像は data: URL に直す
 * ことになる。base64 は元の 1.37 倍に膨らみ、上限はだいたい 5MB。
 * 今どきの写真は 3〜8MB あるので、入れた瞬間に溢れる（しかも溢れ方が
 * 例外なので、何も言わずに保存に失敗する作りだと、次に開いたとき
 * 「消えた」ように見える）。
 *
 * IndexedDB なら Blob をそのまま置けて、上限も桁が違う。
 *
 * 入れる前に必ず縮める
 * --------------------
 * 画面より大きい画像を持っていても、見た目は1ミリも良くならない。
 * 逆に、毎回の読み込みと描画がそのぶん遅くなる。長辺 2048 まで縮めて
 * webp に焼き直す（だいたい元の 1/10 以下になる）。
 *
 * 使えない環境では素直に失敗を返す。黙って成功にすると、設定画面が
 * 「保存しました」と言った後に背景が出ない、という一番困る形になる。
 */

const DB_NAME = "forge-appearance";
const DB_VERSION = 1;
const STORE = "images";
/** 背景は1枚だけ持つ。差し替えると前のは消える。 */
export const USER_BG_KEY = "user-bg";

/** 縮める先（長辺の画素数）。 */
export const MAX_EDGE = 2048;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // プライベートモードなどで固まることがあるので、待ちすぎない
      setTimeout(() => resolve(null), 4000);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode,
               run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 画像を縮めて webp にする。
 *
 * 失敗したら null。理由はいろいろある（HEIC のようにブラウザが読めない
 * 形式、壊れたファイル、canvas が使えない）。呼ぶ側で「この形式は
 * 読めません」と言えるように、例外ではなく null で返す。
 */
export async function shrinkImage(
  file: Blob, maxEdge = MAX_EDGE, quality = 0.82,
): Promise<{ blob: Blob; width: number; height: number; luminance: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const i = new Image();
      i.decoding = "async";
      i.onload = () => resolve(i);
      i.onerror = () => resolve(null);
      i.src = url;
    });
    if (!img || !img.naturalWidth) return null;

    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/webp", quality);
    });
    // webp を作れないブラウザでは jpeg に落とす
    const out = blob ?? await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
    });
    return out ? { blob: out, width: w, height: h, luminance: brightLuminance(canvas) } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 画像の**明るい側**の明るさ（上位1割のところ、0〜1）。
 *
 * これが要るのは、**膜の濃さを決め打ちにできない**から。明るい写真を
 * 35%の膜で敷くと上の文字が飛び、暗い写真を同じ35%で敷くと真っ暗になる。
 * 保存するときに測って、その1枚に合う濃さを出す。
 *
 * なぜ平均ではないのか
 * --------------------
 * 最初は平均で出したが、**膜が薄くなりすぎた**（実際、明るい絵を入れたら
 * 35%より薄い15%が選ばれて、前より読みにくくなった）。全体が暗くても、
 * 白い雲や光が一部にあれば、そこに載った文字は消える。文字が置かれるのは
 * 画面のどこか1か所なので、効くのは平均ではなく**明るい所**。
 *
 * いちばん明るい1点だと、小さなハイライト1個で膜が最大まで振り切れる。
 * 上位1割あたりが、ちょうど「そこそこ広い明るい面」に当たる。
 *
 * 32×32 まで潰してから測る。全画素を舐める必要はない。
 */
function brightLuminance(src: HTMLCanvasElement): number {
  try {
    const n = 32;
    const c = document.createElement("canvas");
    c.width = n; c.height = n;
    const ctx = c.getContext("2d");
    if (!ctx) return 0.5;
    ctx.drawImage(src, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    const ch = (v: number) => {
      const s2 = v / 255;
      return s2 <= 0.03928 ? s2 / 12.92 : Math.pow((s2 + 0.055) / 1.055, 2.4);
    };
    const vals: number[] = [];
    for (let i = 0; i < d.length; i += 4) {
      vals.push(0.2126 * ch(d[i]) + 0.7152 * ch(d[i + 1]) + 0.0722 * ch(d[i + 2]));
    }
    if (!vals.length) return 0.5;
    vals.sort((a, b) => a - b);
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))];
  } catch {
    return 0.5;    // 測れないときは真ん中。膜が濃すぎも薄すぎもしない
  }
}

/**
 * その明るさ（明るい側）の画像の上で、文字が読めるようになる膜の濃さ。
 *
 * 白い文字なら地を暗く、黒い文字なら地を明るくしたい。どちらも
 * 「合成後の明るさ」がいくつ以下／以上になればよいかは、コントラスト比
 * 4.5 の式から逆算できる。感覚ではなく式で出す。
 *
 *   黒い膜:  合成後 = L × (1 − a)
 *   白い膜:  合成後 = L × (1 − a) + a
 */
export function veilFor(luminance: number, darkVeil: boolean): number {
  const L = Math.max(0.001, Math.min(1, luminance));
  let a: number;
  if (darkVeil) {
    // 白い文字（輝度1）に対して 4.5:1 → 合成後 ≤ 1.05/4.5 − 0.05
    const target = 1.05 / 4.5 - 0.05;         // ≈ 0.183
    a = 1 - target / L;
  } else {
    // 黒い文字（輝度0）に対して 4.5:1 → 合成後 ≥ 4.5×0.05 − 0.05
    const target = 4.5 * 0.05 - 0.05;         // ≈ 0.175
    a = (target - L) / (1 - L);
  }
  // 0 だと「膜が効かない」に見えるので少しは残し、上は既定の上限で止める
  return Math.max(0.15, Math.min(0.85, Number.isFinite(a) ? a : 0.35));
}

export interface StoredImage {
  blob: Blob;
  width: number;
  height: number;
  /** 画像の明るい側の明るさ（上位1割）。膜の濃さを決めるのに使う。 */
  luminance: number;
  /** 入れた時刻（設定画面に「いつの画像か」を出すため）。 */
  savedAt: number;
}

/** 縮めてから保存する。保存できたら中身を返す。 */
export async function putUserImage(file: Blob): Promise<StoredImage | null> {
  const shrunk = await shrinkImage(file);
  if (!shrunk) return null;
  const db = await openDb();
  if (!db) return null;
  const rec: StoredImage = {
    blob: shrunk.blob, width: shrunk.width, height: shrunk.height,
    luminance: shrunk.luminance, savedAt: Date.now(),
  };
  const ok = await tx(db, "readwrite", (s) => s.put(rec, USER_BG_KEY));
  db.close();
  return ok === null ? null : rec;
}

export async function getUserImage(): Promise<StoredImage | null> {
  const db = await openDb();
  if (!db) return null;
  const rec = await tx<StoredImage>(db, "readonly", (s) => s.get(USER_BG_KEY) as IDBRequest<StoredImage>);
  db.close();
  return rec && rec.blob ? rec : null;
}

export async function clearUserImage(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await tx(db, "readwrite", (s) => s.delete(USER_BG_KEY));
  db.close();
}

/**
 * 背景として使える <img> にして返す。
 *
 * object URL は使い終わったら手放す必要があるが、ここでは画像が
 * 読み終わった時点で手放してよい（読み込み済みの <img> は URL を
 * 必要としない）。呼ぶ側に後始末を押しつけない。
 */
export async function loadUserImage(): Promise<HTMLImageElement | null> {
  const rec = await getUserImage();
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
