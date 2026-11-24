# Tangent.

**Two pages. Fewest clicks.**  
A free daily Wikipedia link-racing puzzle game with a live Wikimedia Daily Feed, 4 difficulty tiers, 15 Wikipedia languages, a streaming 3-column editorial reader, and 10-player live race rooms.

## Features

- **Live Wikimedia Daily Feed + 456-Title Verified Pool:** Daily challenges pair Today's Featured Article with a trending Most Read article via `/api/daily` (with 1-click & backlink reachability guards, 30-day Redis history, and curated offline fallback), alongside a 456-title cross-domain English generator across 12 semantic buckets.
- **4 Difficulty Tiers & 15 Languages:** Play **Easy**, **Medium**, **Hardcore** (mega-hubs banned), or **Boss Mode** (blind, infobox links locked, 0 hints, Back +2) across curated packs, random rolls, or custom challenges in 15 Wikipedia languages.
- **Fast Streaming Reader:** Server-trimmed Parsoid HTML via `/api/wiki` (early stream abort at `References`/`External links`, Edge CDN cached 24h), L1 RAM + L2 IndexedDB 24h article cache, intent-driven hover/`pointerdown` prefetch, and a collapsible 3-column layout (Contents · Prose · Quick Facts) with compact horizontal image strips and native Light / Dark / OLED theming.
- **10-Player Live Race Rooms:** Shareable `/room/:code` invites, synchronized 3-2-1 countdowns, Fewest Clicks or Speedrun scoring, 60-second finisher grace timer, and spoiler-free route replays + downloadable 1200×630 PNG share cards.
- **Playful Gameplay UX:** Pre-pause "Earn Your Pause" challenges (clock keeps running until passed), Back & browser-back leave confirmations, auto-saved challenge resume, Web Audio tactile sound effects, and a one-time `Tangent+ ($0/forever)` VIP gag.

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. All `/api/*` routes (streaming article proxy, live daily feed, global records, link-graph score verification, and 10-player live rooms) run locally via Vite dev middleware with an automatic in-memory Redis fallback.

## Scripts

```bash
npm run dev           # Start local Vite dev server + /api/* middleware
npm run build         # Production build into dist/
npm run preview       # Preview built dist/
npm run verify-packs  # Verify all curated pack, Daily Pool, and 456-title pool articles against Wikipedia
```

## Deploy to Vercel

1. Import this repository into Vercel (Framework Preset: **Vite**, Build Command: `npm run build`, Output Directory: `dist`).
2. In your Vercel project dashboard → **Storage** (or **Integrations → Marketplace**) → connect **Upstash Redis**. It injects `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (Vercel `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars are also supported).
3. In Vercel Dashboard → **Analytics** → click **Enable** to activate `@vercel/analytics`.
4. Redeploy once. Global records, daily leaderboards, 30-day live daily history, link-verification cache, and 10-player live rooms (24h auto-TTL) are ready.

---

Article text & images are sourced from Wikipedia ([CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)). Tangent is not affiliated with the Wikimedia Foundation.
