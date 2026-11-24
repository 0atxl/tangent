/**
 * Live Daily Tangent generator powered by Wikimedia's official Featured Content Feed:
 * - Pairs Today's Featured Article (tfa) or On This Day (onthisday) with a filtered
 *   Most Read (mostread) trending article.
 * - Filters out Main Page, Lists, Deaths-in-Year, Disambiguations, and Banned Mega-Hubs.
 * - Verifies target reachability (>= 25 backlinks) and 1-click guard (target not directly
 *   linked on start) before caching in Upstash Redis (30d) + Vercel Edge CDN (24h).
 * - Also returns up to 16 clean trending titles so Easy/Medium rolls can sprinkle in live topics.
 */
import { redis } from './_lib/redis.js';
import { getOutgoingLinks, normTitle } from './_lib/wiki.js';

const UA = 'TangentWikiGame/1.0 (https://playtangent.vercel.app; daily-generator)';

const BANNED_HUBS = new Set([
  'united states',
  'united kingdom',
  'europe',
  'world war ii',
  'world war i',
  'english language',
  'earth',
  'human',
  'india',
  'china',
  'france',
  'germany',
  'japan',
  'geography',
  'history',
  '20th century',
  '21st century'
]);

const NOISE_TITLE_RE =
  /^(main page|special:|portal:|wikipedia:|file:|category:|help:|template:|deaths in \d{4}|list of |\d{4}$|\d{4} in |january|february|march|april|may|june|july|august|september|october|november|december)/i;

function isCleanArticle(page) {
  if (!page) return false;
  const title = page.titles?.normalized || page.normalizedtitle || page.title || '';
  if (!title || title.length < 3 || title.length > 64) return false;
  if (title.includes(':')) return false;
  if (NOISE_TITLE_RE.test(title)) return false;
  if (page.type === 'disambiguation') return false;
  if (BANNED_HUBS.has(normTitle(title))) return false;
  const extract = page.extract || '';
  if (extract.length > 0 && extract.length < 80) return false;
  return true;
}

function getTitle(page) {
  return String(page?.titles?.normalized || page?.normalizedtitle || page?.title || '')
    .replace(/_/g, ' ')
    .trim();
}

function hashDate(dateStr) {
  let h = 2166136261;
  for (let i = 0; i < dateStr.length; i++) {
    h ^= dateStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function hasEnoughBacklinks(title, minCount = 25, timeoutMs = 4000) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=backlinks&bltitle=${encodeURIComponent(
      title
    )}&bllimit=${minCount}&blnamespace=0&blfilterredir=nonredirects&format=json&formatversion=2`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, 'Api-User-Agent': UA }
    });
    if (!res.ok) return true; // Fail open on transient network hiccup
    const data = await res.json();
    const list = data?.query?.backlinks || [];
    return list.length >= minCount;
  } catch {
    return true;
  }
}

async function fetchWikimediaFeed(yyyy, mm, dd) {
  const urls = [
    `https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${yyyy}/${mm}/${dd}`,
    `https://en.wikipedia.org/api/rest_v1/feed/featured/${yyyy}/${mm}/${dd}`
  ];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5500);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' }
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
    } catch {
      // try next URL
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = new Date();
  const todayStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
    now.getUTCDate()
  ).padStart(2, '0')}`;
  const rawDate = String(req.query?.date || todayStr).trim();
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : todayStr;

  const cacheKey = `daily-feed:v1:en:${dateStr}`;

  try {
    const cached = await redis.getJSON(cacheKey);
    if (cached && cached.start && cached.target) {
      res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('CDN-Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json(cached);
    }

    const [yyyy, mm, dd] = dateStr.split('-');
    const feed = await fetchWikimediaFeed(yyyy, mm, dd);
    if (!feed) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ date: dateStr, fallback: true });
    }

    const tfaTitle = isCleanArticle(feed.tfa) ? getTitle(feed.tfa) : null;

    const mostread = (feed.mostread?.articles || [])
      .filter(isCleanArticle)
      .map(getTitle)
      .filter((t, i, arr) => arr.indexOf(t) === i);

    const onthisday = (feed.onthisday || [])
      .flatMap((ev) => (ev.pages || []).slice(0, 1))
      .filter(isCleanArticle)
      .map(getTitle)
      .filter((t, i, arr) => arr.indexOf(t) === i);

    const seed = hashDate(dateStr);

    // Pick Start: Today's Featured Article (primary) or deterministic On This Day pick
    const startCandidates = [
      ...(tfaTitle ? [tfaTitle] : []),
      ...onthisday.slice(0, 8),
      ...mostread.slice(0, 5)
    ];

    // Pick Target: deterministic trending Most Read article (or On This Day fallback)
    const targetPool = mostread.length >= 4 ? mostread : onthisday;
    if (startCandidates.length === 0 || targetPool.length < 2) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ date: dateStr, fallback: true });
    }

    const start = startCandidates[0];
    const startLinks = await getOutgoingLinks(start, 'en').catch(() => null);

    let chosenTarget = null;
    const n = targetPool.length;
    const loopDeadline = Date.now() + 7000;
    for (let offset = 0; offset < Math.min(n, 14); offset++) {
      const remaining = loopDeadline - Date.now();
      if (remaining <= 400) break;
      const candidate = targetPool[(seed + offset) % n];
      if (!candidate || normTitle(candidate) === normTitle(start)) continue;
      // 1-click guard: never pick a target already linked on the start article
      if (startLinks && startLinks.has(normTitle(candidate))) continue;
      // Reachability guard: ensure target has enough incoming links
      const reachable = await hasEnoughBacklinks(candidate, 25, Math.min(3500, remaining));
      if (reachable) {
        chosenTarget = candidate;
        break;
      }
    }

    if (!chosenTarget) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ date: dateStr, fallback: true });
    }

    const payload = {
      date: dateStr,
      start,
      target: chosenTarget,
      par: 4,
      tier: 'medium',
      lang: 'en',
      source: tfaTitle && start === tfaTitle ? 'wikimedia-tfa' : 'wikimedia-featured',
      trending: mostread.slice(0, 18)
    };

    // Cache in Upstash Redis for 30 days so Daily Archive remembers historical live dailies
    await redis.set(cacheKey, payload, 86400 * 30);

    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(payload);
  } catch (err) {
    console.warn('[daily-feed] fallback:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ date: dateStr, fallback: true });
  }
}
