# THE FORGE OS — Web Frontend

The "face" of **THE FORGE OS**: a JARVIS-like personal AI assistant. A dark,
silver-bordered, pale-blue-glowing HUD built as a mobile-first **PWA** with a
glowing core orb at its center.

Built with **Next.js 14 (App Router) · React 18 · TypeScript · Tailwind CSS ·
Framer Motion**.

## Features

- **Branded boot screen** that masks backend cold-starts — polls `/health` and
  shows the pulsing core orb + animated status until the core is awake. The user
  never sees raw backend lag.
- **Core orb** — the centerpiece. A pale-blue radial-gradient orb with layered
  glow that reacts to state (`idle` / `listening` / `speaking` / `thinking`).
- **Streaming chat** — assistant replies stream token-by-token over SSE.
- **Hands-free voice** — speak to it (Web Speech API, ja-JP) and it speaks back
  (browser TTS, with the API `/tts` route as a fallback).
- **Vision** — attach an image and the core analyzes it via `/vision`.
- **Persona & name** — set the assistant's name (default `JARVIS`) and persona;
  persisted in `localStorage` and sent to the backend on every turn.
- **PWA** — installable, standalone, dark theme.

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable                | Required | Description                                                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`   | yes      | Base URL of the AIbou Brain API (FastAPI backend). No trailing slash.       |
| `NEXT_PUBLIC_API_TOKEN` | no       | If the backend sets `APP_TOKEN`, set the same value to send a bearer token. |

> These are `NEXT_PUBLIC_*` because the browser calls the backend directly.

## Local development

```bash
cd webapp
npm install
cp .env.example .env.local   # then edit NEXT_PUBLIC_API_URL (e.g. http://localhost:8080)
npm run dev
```

Open http://localhost:3000.

The companion backend lives in `../api` (FastAPI). Run it (default port `8080`)
so `/health`, `/chat`, `/vision`, `/tts`, and `/income/summary` resolve.

## Build

```bash
npm run build
npm run start
```

## Deploy to Vercel

1. Import the repo into Vercel and set the **Root Directory** to `webapp`.
2. Framework preset: **Next.js** (auto-detected).
3. Add environment variables:
   - `NEXT_PUBLIC_API_URL` → your deployed backend URL (e.g. a Cloud Run /
     Hugging Face Spaces URL).
   - `NEXT_PUBLIC_API_TOKEN` → only if the backend enforces `APP_TOKEN`.
4. Make sure the backend's `FRONTEND_ORIGIN` (CORS) allows your Vercel domain
   (or `*`).
5. Deploy.

## PWA icons

The manifest references `/icon-192.png` and `/icon-512.png`. Provide them by
copying the existing brand icon and resizing:

```bash
# from repo root — source art is assets/aibou_icon.png
cp assets/aibou_icon.png webapp/public/icon-512.png
cp assets/aibou_icon.png webapp/public/icon-192.png
```

For crisp icons, resize to the exact dimensions (e.g. with ImageMagick):

```bash
convert assets/aibou_icon.png -resize 512x512 webapp/public/icon-512.png
convert assets/aibou_icon.png -resize 192x192 webapp/public/icon-192.png
```

The app builds and runs without the icons present; install prompts and the home
-screen icon simply won't have artwork until you add them.

## Project structure

```
webapp/
├── public/
│   └── manifest.webmanifest         # PWA manifest (name, theme, icons)
├── src/
│   ├── app/
│   │   ├── globals.css              # design tokens + base styles + keyframes
│   │   ├── layout.tsx               # fonts (Share Tech Mono + Inter), metadata
│   │   └── page.tsx                 # the HUD (BootScreen + CoreOrb + Chat)
│   ├── components/
│   │   ├── BootScreen.tsx           # branded cold-start loader
│   │   ├── Chat.tsx                 # conversation UI (stream/voice/vision)
│   │   └── CoreOrb.tsx              # the glowing core centerpiece
│   └── lib/
│       ├── api.ts                   # typed client (chat SSE, vision, tts, …)
│       └── voice.ts                 # Web Speech API helpers (STT + TTS)
└── …config (next, tailwind, ts, postcss, eslint)
```

## Backend API contract

```
GET  /health          → { status: "ok" }
POST /chat   (SSE)    → data: {"token":"..."} …  then  data: {"done":true}
POST /vision          → { text }
POST /tts             → { audio_base64 }   (mp3, base64)
GET  /income/summary  → { pending, approved, …, total }
```

Design tokens (kept in sync with the original FORGE OS surface): background
`#0a0b0f`, panel `rgba(255,255,255,0.05)` with silver border
`rgba(197,198,199,0.28)`, body `#c9ccd2`, headings `#ffffff`, core glow
`rgba(150,200,255,0.30)`, accent cyan `#00f3ff`.
