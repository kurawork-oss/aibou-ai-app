import type { Metadata, Viewport } from "next";
import { Inter, Share_Tech_Mono } from "next/font/google";
import "./globals.css";

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

export const metadata: Metadata = {
  title: "THE FORGE OS",
  description: "Your personal JARVIS-like AI assistant — THE FORGE OS.",
  applicationName: "THE FORGE OS",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "FORGE",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/icon-192.png",
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
    <html lang="en" className={`${inter.variable} ${shareTechMono.variable}`}>
      <head>
        {/* iOS PWA niceties (mirrors appleWebApp metadata for older Safari). */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      {/* No bg on <body> — backgrounds live on <html> (globals.css) so the
          fixed z-index:-1 Backdrop3D starfield paints above them. */}
      <body className="min-h-[100dvh] font-sans text-fg antialiased">
        {children}
      </body>
    </html>
  );
}
