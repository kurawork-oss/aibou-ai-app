import type { Metadata, Viewport } from "next";
import { Inter, Press_Start_2P, Share_Tech_Mono } from "next/font/google";
import "./globals.css";
import { SKIN_BOOT_SCRIPT } from "@/lib/skin";
import { BACKGROUND_BOOT_SCRIPT } from "@/lib/background";

/**
 * Fonts (loaded via next/font/google, self-hosted at build time):
 *  - Share Tech Mono → headings / labels / mono HUD chrome
 *  - Inter           → body text
 * Both expose CSS variables consumed by globals.css + tailwind.config.ts.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const shareTechMono = Share_Tech_Mono({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-share-tech-mono",
  display: "swap",
});

/**
 * ドットの字（RETRO テーマの見出しだけ）。
 *
 * preload を切ってあるのが肝。切らないと、レトロを使っていない人の
 * 端末まで、開くたびにこの字を先読みする。切ると「この字で描く文字が
 * 実際に出たときだけ」落ちる——つまりレトロを選んだ人だけが払う。
 *
 * 本文と細かいラベルには使わない。この字は同じ px 数でも横幅が倍
 * 近くあり、長いラベル（DIAGNOSTICS など）が枠から出る。見出しと
 * 短いラベルだけに留めるぶんには収まることを、テストで見ている
 * （tests/lookUi.spec.ts の「レトロでも、文字が枠から出ない」）。
 */
const pixelFont = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-pixel",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  // ブランドは AIbou、その中で動くシステムが THE FORGE OS。
  // 2つ名で並べる（ホーム画面のラベルは短い方＝AIbou を使う）。
  title: "AIbou — THE FORGE OS",
  description: "AIbou — あなた専属のAIアシスタント。THE FORGE OS で動きます。",
  applicationName: "AIbou",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AIbou",
  },
  // アイコンは AIbou のロゴマーク（（ ・ ））。ホーム画面用は余白入り、
  // タブ用は小さくても読めるよう寄せたものを別に用意している。
  // apple- は正方形を角丸に切られるため、192をそのまま使わず専用サイズを渡す。
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: "/favicon.ico",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0b0f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-skin は下の <script> が描画前に付ける。サーバー出力には無いので、
    // React の「属性が増えている」警告だけ抑える（意図した差分）。
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${shareTechMono.variable} ${pixelFont.variable}`}>
      <head>
        {/* iOS PWA niceties (mirrors appleWebApp metadata for older Safari). */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
        {/* 見た目は最初の描画より前に <html data-skin> / <html data-bg> を
            立てる。Reactのマウントを待つと、別の色や別の背景で一瞬描かれて
            から切り替わる「ちらつき」が出るため、ここで同期的に実行する。
            順番は固定：背景の既定はテーマから決まるので、data-skin が先。 */}
        <script dangerouslySetInnerHTML={{ __html: SKIN_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: BACKGROUND_BOOT_SCRIPT }} />
      </head>
      {/* No bg on <body> — backgrounds live on <html> (globals.css) so the
          fixed z-index:-1 Backdrop3D starfield paints above them. */}
      <body className="min-h-[100dvh] font-sans text-fg antialiased">
        {children}
      </body>
    </html>
  );
}
