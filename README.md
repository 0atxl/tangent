# Tangent.

**Two pages. Fewest clicks.**  
A daily Wikipedia link-racing game with 10-player live race rooms, native Light/Dark/OLED Wikipedia theming, sleek hover previews, custom Web Audio tactile sound effects, and zero-maintenance Vercel + Upstash Redis persistence.

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Everything — including 10-player live rooms, global records, and anti-cheat score verification — works out of the box locally using the built-in in-memory Redis fallback.

## Verify Pack Titles Against Wikipedia

```bash
npm run verify-packs
```

## Deploy to Vercel (2 Minutes, Zero Maintenance)

1. Push this repo to GitHub and import it into Vercel.
2. In your Vercel project dashboard → **Storage** (or **Integrations → Marketplace**) → add **Upstash Redis** (Free Tier — never pauses on inactivity).
3. Upstash automatically injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` into your Vercel environment variables.
4. Redeploy once — your global records, daily leaderboards, anti-cheat link cache, and 10-player live race rooms (with automatic 24h TTL cleanup) are live forever!
