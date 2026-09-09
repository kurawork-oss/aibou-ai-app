/**
 * api.ts は読み込み時に NEXT_PUBLIC_API_URL を const に取る。
 * つまり import より先に立てておかないと間に合わない。
 *
 * import の順は ESM が守るので、api.ts を読むテストは
 *   import "./apiUrlForTests";
 *   import { ... } from "../src/lib/api";
 * の順で書く（この行を消すと requireApiUrl() が投げる）。
 *
 * ふだんのUIテストは接続先なし（オフライン）で動かしたいので、
 * 設定ファイルではなく、必要なテストだけがこれを読む形にしている。
 *
 * 注意: これはテストを走らせている側（Node）の環境変数で、ブラウザに
 * 出る値ではない（あちらはビルド時に埋まる）。ただし同じワーカーで動く
 * 他のテストが api.ts を実行時に読み込むと、こちらの値を見てしまう。
 * オフライン前提のテストと同じファイルには入れないこと。
 */
process.env.NEXT_PUBLIC_API_URL = "http://api.test";
