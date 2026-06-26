import type { Config } from "tailwindcss";

/**
 * THE FORGE OS — Tailwind theme.
 * Colors mirror the canonical design tokens in src/app/globals.css
 * (white × silver × black, calm pale-blue core glow). We expose them here
 * so utilities like `bg-bg`, `text-fg`, `border-panel` stay on-brand.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0a0b0f",
        bg2: "#0d0f14",
        fg: "#c9ccd2",
        "fg-strong": "#ffffff",
        muted: "#8b8f97",
        line: "#c5c6c7",
        silver: "#c5c6c7",
        accent: "#00f3ff",
      },
      backgroundColor: {
        panel: "rgba(255,255,255,0.05)",
      },
      borderColor: {
        panel: "rgba(197,198,199,0.28)",
        "panel-strong": "rgba(197,198,199,0.50)",
      },
      boxShadow: {
        glow: "0 0 18px rgba(150,200,255,0.30)",
        "glow-strong": "0 0 28px rgba(150,200,255,0.45)",
        cyan: "0 0 18px rgba(0,243,255,0.45)",
        panel: "0 6px 18px rgba(0,0,0,0.55)",
      },
      borderRadius: {
        forge: "14px",
      },
      fontFamily: {
        // Wired to the next/font CSS variables defined in layout.tsx.
        mono: ["var(--font-share-tech-mono)", "ui-monospace", "monospace"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      keyframes: {
        "core-pulse": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.92" },
          "50%": { transform: "scale(1.04)", opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "core-pulse": "core-pulse 4s ease-in-out infinite",
        shimmer: "shimmer 2.2s linear infinite",
        "fade-in": "fade-in 0.4s ease both",
      },
    },
  },
  plugins: [],
};

export default config;
