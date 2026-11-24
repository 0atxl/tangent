import { PACKS, DAILY_POOL, POOL_BUCKETS } from '../src/data/packs.js';

const UA = 'TangentWikiGame/1.0 (https://playtangent.vercel.app; pack-verifier)';

async function verifyTitle(title, lang) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(
    title
  )}&redirects=1&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { 'Api-User-Agent': UA, 'User-Agent': UA } });
  const data = await res.json();
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return { ok: false, input: title, lang };
  return { ok: true, input: title, canonical: page.title, redirected: page.title !== title, lang };
}

async function main() {
  const checks = [];
  const seen = new Set();

  for (const pack of PACKS) {
    for (const [a, b] of pack.pairs) {
      for (const title of [a, b]) {
        const k = `${pack.lang}:${title}`;
        if (!seen.has(k)) {
          seen.add(k);
          checks.push({ title, lang: pack.lang });
        }
      }
    }
  }
  for (const [a, b] of DAILY_POOL) {
    for (const title of [a, b]) {
      const k = `en:${title}`;
      if (!seen.has(k)) {
        seen.add(k);
        checks.push({ title, lang: 'en' });
      }
    }
  }
  for (const bucket of Object.values(POOL_BUCKETS || {})) {
    for (const tier of ['iconic', 'deep']) {
      for (const title of bucket[tier] || []) {
        const k = `en:${title}`;
        if (!seen.has(k)) {
          seen.add(k);
          checks.push({ title, lang: 'en' });
        }
      }
    }
  }

  console.log(`Verifying ${checks.length} unique Wikipedia titles...`);
  let failed = 0;
  let redirected = 0;

  // Batch in groups of 8 to be polite to Wikipedia API
  for (let i = 0; i < checks.length; i += 8) {
    const batch = checks.slice(i, i + 8);
    const results = await Promise.all(batch.map((c) => verifyTitle(c.title, c.lang)));
    for (const r of results) {
      if (!r.ok) {
        failed++;
        console.error(`  [MISSING] (${r.lang}) ${r.input}`);
      } else if (r.redirected) {
        redirected++;
        console.warn(`  [REDIRECT] (${r.lang}) "${r.input}" -> "${r.canonical}"`);
      }
    }
  }

  console.log(`Done. Checked: ${checks.length}, Redirects: ${redirected}, Missing: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
