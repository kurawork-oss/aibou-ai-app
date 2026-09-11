/**
 * 重い素材（背景の画像など）を、選んだときだけ落として取っておく。
 *
 * なぜ「ダウンロード式」にするのか
 * --------------------------------
 * 前は背景の画像を**開くたびに必ず**取りに行っていた。紺のテーマを
 * 使っていない人にも 115KB を配っていたということで、単純に無駄。
 * 背景は増える予定なので、この作りのままだと開くのが遅くなっていく。
 *
 * なぜ Cache Storage なのか
 * -------------------------
 * 「落とした／まだ」を自前の印（localStorage のフラグ等）で持つと、
 * ブラウザが中身を捨てたときに**印だけ残って嘘になる**。
 * Cache Storage は中身そのものを聞けるので、`has()` が常に本当のことを言う。
 * ついでに、一度落とせば圏外でも出る。
 *
 * 使えない環境（Cache Storage が無い・プライベートモード等）では、
 * 素通しで普通に fetch する。落とし損ねても背景が出ないだけで、
 * アプリは動く——画像1枚のために画面を止めない。
 */

const CACHE_NAME = "forge-assets-v1";

/** Cache Storage が使えるか。http:// では使えないので毎回確かめる。 */
function cacheApi(): CacheStorage | null {
  try {
    return typeof caches !== "undefined" ? caches : null;
  } catch {
    return null;
  }
}

/**
 * この端末で「取っておく」ができるか。
 *
 * できない環境（http:// の開発サーバー、一部のプライベートモード）では、
 * 落としても残らない。画面が「✓ 端末にあり」と出すかどうかの判断に使う。
 * ここを見ずに「落とせた＝ある」と書くと、毎回落とし直している人に
 * 「もう手元にあります」と言い続けることになる。
 */
export function canKeepAssets(): boolean {
  return cacheApi() !== null;
}

/** もう手元にあるか。無い・分からないときは false。 */
export async function hasAsset(url: string): Promise<boolean> {
  const c = cacheApi();
  if (!c) return false;
  try {
    const cache = await c.open(CACHE_NAME);
    return (await cache.match(url)) !== undefined;
  } catch {
    return false;
  }
}

export interface DownloadProgress {
  /** 受け取った byte 数。 */
  received: number;
  /** 全体の byte 数。サーバーが教えてくれないときは 0。 */
  total: number;
}

/**
 * 落として取っておく。すでにあれば何もしない。
 *
 * 進み具合を返すのは、ここが**人が待つ唯一の場所**だから。
 * 「ダウンロード」と書いたボタンが無反応のまま数秒止まると、壊れたと思われる。
 */
export async function downloadAsset(
  url: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<boolean> {
  const c = cacheApi();
  try {
    const cache = c ? await c.open(CACHE_NAME) : null;
    if (cache && (await cache.match(url))) return true;

    const res = await fetch(url);
    if (!res.ok || !res.body) {
      // 取れなかったことを黙って成功にしない（画面は「未取得」のままになる）
      return false;
    }

    const total = Number(res.headers.get("content-length") || 0);
    // 進み具合を出すために自分で読む。読んだ物はそのまま Response に組み直す。
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress?.({ received, total });
      }
    }
    const blob = new Blob(chunks as BlobPart[], {
      type: res.headers.get("content-type") || "application/octet-stream",
    });
    if (cache) await cache.put(url, new Response(blob, { headers: res.headers }));
    return true;
  } catch {
    return false;
  }
}

/** 取っておいた物を捨てる（容量を空けたいとき）。 */
export async function removeAsset(url: string): Promise<boolean> {
  const c = cacheApi();
  if (!c) return false;
  try {
    const cache = await c.open(CACHE_NAME);
    return await cache.delete(url);
  } catch {
    return false;
  }
}

/**
 * 画像として読む。手元にあればそれを、無ければ取りに行く。
 *
 * `download` が false のときは、**取りに行かない**。まだ選ばれていない
 * 背景のために通信を始めないための逃げ道（一覧を開いただけで全部の
 * 背景が落ち始めたら、ダウンロード式にした意味がない）。
 */
export async function loadCachedImage(
  url: string, opts: { download?: boolean } = {},
): Promise<HTMLImageElement | null> {
  const { download = true } = opts;
  const c = cacheApi();
  let src = url;
  let revoke: string | null = null;

  try {
    if (c) {
      const cache = await c.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        revoke = URL.createObjectURL(await hit.blob());
        src = revoke;
      } else if (!download) {
        return null;
      } else {
        const ok = await downloadAsset(url);
        if (ok) {
          const again = await cache.match(url);
          if (again) {
            revoke = URL.createObjectURL(await again.blob());
            src = revoke;
          }
        }
      }
    } else if (!download) {
      return null;
    }

    return await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        // blob: の URL は使い終わったら手放す（放っておくとメモリに残る）
        if (revoke) URL.revokeObjectURL(revoke);
        resolve(img);
      };
      img.onerror = () => {
        if (revoke) URL.revokeObjectURL(revoke);
        resolve(null);
      };
      img.src = src;
    });
  } catch {
    if (revoke) URL.revokeObjectURL(revoke);
    return null;
  }
}

/** 人に見せる大きさ（「約 115KB」）。 */
export function formatBytes(n: number): string {
  if (n <= 0) return "0";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
