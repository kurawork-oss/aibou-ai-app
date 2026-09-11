/**
 * recall.ts — 通信なしで「関係のある記憶」を引く。
 *
 * なぜ自前で引くのか
 * ------------------
 * サーバー側の想起は、意味検索（Gemini の埋め込み × Supabase の
 * pgvector）でできている。よく効くが、**繋がっていないと1件も引けない**。
 * 端末の中の記憶は、飛行機の中でも地下でも引ける必要がある。
 *
 * 日本語は分かち書きが無い
 * ------------------------
 * 「明日の打ち合わせ」を空白で切ることはできないので、英語向けの
 * 単語検索はそのまま使えない。形態素解析を積むと辞書が数MBになり、
 * それだけでアプリが重くなる。
 *
 * そこで**2文字ずつの並び（bigram）**で引く。
 *
 *     打ち合わせ → 打ち / ち合 / 合わ / わせ
 *
 * 辞書が要らず、全文検索の仕組みが昔から使っている方法で、この用途には十分。
 *
 * ただし2文字だけだと、送り仮名の揺れに弱い。
 *
 *     打ち合わせ → 打ち/ち合/合わ/わせ
 *     打合せ     → 打合/合せ
 *
 * 共通の並びが1つも無い。実際に「打合せ 何時」で1件も引けなかった。
 * そこで**1文字ずつ**も一緒に持ち、重みを下げて足す（打・合・せ は
 * どちらにもある）。下げるのは、1文字だけの一致は当てにならないから
 * ——同じ重さにすると、漢字が1つかすっただけの記憶が上位に来る。
 *
 * 珍しい言葉を重く見る（IDF）
 * ---------------------------
 * 「の」「する」はどの記憶にも出るので、当たっても何の手がかりにも
 * ならない。手元の記憶ぜんぶの中でその並びが何回出るかを数え、
 * **珍しいものほど重く**する。これをやらないと、助詞が一致しただけの
 * 記憶が上位に来る。
 */

/** 引くときに使う1件ぶん。保管の形（memory.ts）とは分けてある。 */
export interface Recallable {
  id: string;
  text: string;
  /** 0=ふつう 1=大事 2=とても大事。上ほど優先して思い出す。 */
  importance?: number;
  /** 最後に触れた時刻（ミリ秒）。新しいほうを少しだけ優先する。 */
  updatedAt?: number;
}

export interface Hit<T extends Recallable = Recallable> {
  item: T;
  score: number;
}

/**
 * 揺れをならす。
 *
 *   ・全角と半角を揃える（ＡＢＣ → ABC、１ → 1）
 *   ・大文字小文字を揃える
 *   ・記号と空白を落とす（区切りとしては使うので、いったん空白へ）
 *
 * カタカナはひらがなへ寄せない。「はし」と「ハシ」は別の語のことが
 * 多く、寄せると取り違えが増える。
 */
export function normalize(text: string): string {
  return (text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[!-/:-@[-`{-~、。「」『』・…—–ー―]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 日本語・中国語・韓国語の文字か（ここだけ bigram にする）。 */
function isCJK(ch: string): boolean {
  const c = ch.codePointAt(0) || 0;
  return (c >= 0x3040 && c <= 0x30ff)      // かな
    || (c >= 0x3400 && c <= 0x4dbf)        // 漢字拡張A
    || (c >= 0x4e00 && c <= 0x9fff)        // 漢字
    || (c >= 0xf900 && c <= 0xfaff)        // 互換漢字
    || (c >= 0xac00 && c <= 0xd7af);       // ハングル
}

/** 1文字ぶんの断片に付ける目印。2文字ぶんと混ざらないように分ける。 */
export const UNI = "\u00a7";

/** その断片が1文字ぶんか（点数の重みを下げる対象）。 */
export function isUnigram(term: string): boolean {
  return term.startsWith(UNI);
}

/**
 * 引くための断片に分ける。
 *
 *   日本語 … 2文字ずつ ＋ 1文字ずつ（1文字は目印を付けて重みを下げる）
 *   英数字 … 単語のまま
 */
export function terms(text: string): string[] {
  const s = normalize(text);
  const out: string[] = [];
  let run = "";

  const flushLatin = () => {
    if (run) out.push(run);
    run = "";
  };

  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === " ") { flushLatin(); continue; }
    if (isCJK(ch)) {
      flushLatin();
      const next = chars[i + 1];
      if (next && isCJK(next)) out.push(ch + next);
      // 1文字ぶんも必ず入れる。送り仮名の揺れ（打ち合わせ / 打合せ）は
      // 2文字だけでは1つも重ならないため。「犬」のような1文字の
      // 問い合わせが空になるのも、これで一緒に防げる
      out.push(UNI + ch);
    } else {
      run += ch;
    }
  }
  flushLatin();
  return out;
}

/** 断片 → その断片を含む記憶の数。 */
function documentFrequency(items: Recallable[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const it of items) {
    for (const t of new Set(terms(it.text))) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return df;
}

/**
 * 珍しさ（IDF）。よく出る断片ほど 0 に近づく。
 *
 * +1 を入れてあるのは、全部の記憶に出る断片でも 0 にしないため
 * （0 にすると、その断片だけが一致した記憶が完全に無視される）。
 */
function idf(total: number, freq: number): number {
  return Math.log(1 + total / (1 + freq));
}

/** 新しさの下駄。半年前の記憶でも 0 にはしない（古い＝無価値ではない）。 */
function freshness(updatedAt: number | undefined, now: number): number {
  if (!updatedAt) return 1;
  const days = Math.max(0, (now - updatedAt) / 86_400_000);
  return 1 + 0.25 / (1 + days / 30);      // 直近で +25%、1か月で半減
}

export interface RecallOptions {
  limit?: number;
  /** この点数に届かない物は返さない（関係ない記憶を混ぜない）。 */
  minScore?: number;
  now?: number;
}

/**
 * 問い合わせに関係する記憶を、点数の高い順に返す。
 *
 * 点数 = Σ（一致した断片の珍しさ）÷ 問い合わせの長さ
 *        × 大事さの下駄 × 新しさの下駄
 *
 * 問い合わせの長さで割るのが肝。割らないと、**長い問い合わせほど
 * 全部の記憶の点数が上がり**、しきい値が意味を持たなくなる。
 */
export function recall<T extends Recallable>(
  items: T[], query: string, opts: RecallOptions = {},
): Hit<T>[] {
  const { limit = 8, minScore = 0.08, now = Date.now() } = opts;
  const qTerms = Array.from(new Set(terms(query)));
  if (!items.length) return [];

  const df = documentFrequency(items);
  const total = items.length;

  // 問い合わせが空でも、大事な記憶だけは返す（「覚えてる？」に答えられる）
  if (!qTerms.length) {
    return items
      .filter((i) => (i.importance || 0) > 0)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0)
        || (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit)
      .map((item) => ({ item, score: 1 }));
  }

  /** 1文字ぶんの重み。同じ重さにすると、漢字が1つかすっただけで上位に来る。 */
  const WEIGHT_UNI = 0.35;
  const weight = (t: string) => (isUnigram(t) ? WEIGHT_UNI : 1);

  const maxPossible = qTerms.reduce(
    (s, t) => s + weight(t) * idf(total, df.get(t) || 0), 0) || 1;

  const hits: Hit<T>[] = [];
  for (const item of items) {
    const have = new Set(terms(item.text));
    let raw = 0;
    let matched = 0;
    for (const t of qTerms) {
      if (have.has(t)) { raw += weight(t) * idf(total, df.get(t) || 0); matched++; }
    }
    if (raw <= 0) continue;

    /* 問い合わせの**どれだけが当たったか**も見る。
       1文字ずつを足したことで、漢字1つがかすっただけの記憶が拾えるように
       なってしまった（「今日の天気」で「妹の誕生日は3月12日」が出た。
       当たっていたのは「日」だけ）。点数の大きさだけでは、たまたま珍しい
       1文字が当たった場合と、広く当たった場合を区別できない。 */
    const coverage = Math.pow(matched / qTerms.length, 0.35);

    const base = (raw / maxPossible) * coverage;
    const score = base
      * (1 + 0.35 * Math.min(2, item.importance || 0))
      * freshness(item.updatedAt, now);
    if (score >= minScore) hits.push({ item, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * 思い出した物を、AIへ渡せる1つの文章にする。
 *
 * サーバー側（memory_store.mem_recall）と同じ見出しにしてある。
 * 形が揃っていないと、両方から届いたときに2つの塊として読まれる。
 */
export function toBlock(hits: Hit[]): string {
  if (!hits.length) return "";
  const lines = hits.map(({ item }) => {
    const tag = (item.importance || 0) >= 1 ? "★事実" : "覚え";
    return `- (${tag}) ${item.text.slice(0, 300)}`;
  });
  return "【関連する記憶】\n" + lines.join("\n");
}
