import { redis } from './redis.js';

const UA = 'TangentWikiGame/1.0 (https://playtangent.vercel.app; server-verifier)';

export function normTitle(t) {
  return String(t || '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}

export function getClientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'local';
}

export async function resolveCanonical(title, lang = 'en') {
  const safeLang = /^[a-z-]{2,12}$/i.test(lang) ? lang : 'en';
  const cacheKey = `canon:${safeLang}:${normTitle(title)}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const url = `https://${safeLang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(
    title
  )}&redirects=1&format=json&formatversion=2`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(4000),
    headers: { 'Api-User-Agent': UA, 'User-Agent': UA }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return null;
  await redis.set(cacheKey, page.title, 86400);
  return page.title;
}

export async function getOutgoingLinks(title, lang = 'en') {
  const safeLang = /^[a-z-]{2,12}$/i.test(lang) ? lang : 'en';
  const cacheKey = `links:${safeLang}:${normTitle(title)}`;
  const cached = await redis.getJSON(cacheKey);
  if (cached && Array.isArray(cached)) return new Set(cached);

  const url = `https://${safeLang}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(
    title
  )}&prop=links&redirects=1&format=json&formatversion=2`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(4500),
    headers: { 'Api-User-Agent': UA, 'User-Agent': UA }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const links = data?.parse?.links;
  if (!Array.isArray(links)) return null;

  const mainspace = links
    .filter((l) => l.ns === 0 && l.exists !== false)
    .map((l) => normTitle(l.title));

  // Cache for 24h to be fast and polite to Wikimedia
  await redis.set(cacheKey, mainspace, 86400);
  return new Set(mainspace);
}

/**
 * Verifies a full move sequence (including Back moves) against Wikipedia's link graph.
 */
export async function verifyRun({ start, target, lang = 'en', moves = [] }) {
  if (!Array.isArray(moves) || moves.length === 0 || moves.length > 60) {
    return { valid: false, reason: 'Invalid move count' };
  }

  try {
    const [canonStart, canonTarget] = await Promise.all([
      resolveCanonical(start, lang),
      resolveCanonical(target, lang)
    ]);
    if (!canonStart || !canonTarget) {
      return { valid: false, reason: 'Unknown Wikipedia title' };
    }

    const stack = [canonStart];

    // Collect unique pages whose links we need
    const linkMoves = moves.filter((m) => m.type === 'link');
    const uniquePages = [...new Set(linkMoves.map((m) => m.from))];
    const linkMaps = new Map();

    await Promise.all(
      uniquePages.map(async (page) => {
        const set = await getOutgoingLinks(page, lang);
        linkMaps.set(normTitle(page), set);
      })
    );

    for (const move of moves) {
      const current = stack[stack.length - 1];
      if (move.type === 'back') {
        if (stack.length < 2) return { valid: false, reason: 'Invalid back move' };
        stack.pop();
        continue;
      }

      if (move.type !== 'link') {
        return { valid: false, reason: 'Unknown move type' };
      }

      const links = linkMaps.get(normTitle(current));
      if (!links) {
        // Fallback if Wikipedia parse temporarily errored for a page
        const fallbackLinks = await getOutgoingLinks(current, lang);
        if (!fallbackLinks) return { valid: true, unverified: true };
        linkMaps.set(normTitle(current), fallbackLinks);
      }

      const outLinks = linkMaps.get(normTitle(current));
      const clickedNorm = normTitle(move.clicked);
      const toNorm = normTitle(move.to);

      if (!outLinks.has(clickedNorm) && !outLinks.has(toNorm)) {
        return {
          valid: false,
          reason: `Link "${move.clicked}" not found on "${current}"`
        };
      }

      const nextCanon = (await resolveCanonical(move.clicked, lang)) || move.to;
      stack.push(nextCanon);
    }

    const finalPage = stack[stack.length - 1];
    if (normTitle(finalPage) !== normTitle(canonTarget)) {
      return { valid: false, reason: 'Final page does not match target' };
    }

    return { valid: true, verifiedPath: stack };
  } catch (err) {
    // Do not block legitimate players if Wikimedia API has a momentary hiccup
    console.warn('[wiki-verify] network fallback:', err.message);
    return { valid: true, unverified: true };
  }
}
