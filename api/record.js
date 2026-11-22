import { redis } from './_lib/redis.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pairKey = String(req.query?.pairKey || '').trim();
  if (!pairKey || pairKey.length > 260) {
    return res.status(400).json({ error: 'Missing or invalid pairKey' });
  }

  try {
    const rec = await redis.getJSON(`rec:${pairKey}`);
    const plays = Number(await redis.get(`plays:${pairKey}`)) || 0;

    return res.status(200).json({
      best: rec?.best ?? null,
      elapsedMs: rec?.elapsedMs ?? null,
      holder: rec?.holder ?? null,
      path: rec?.path ?? null,
      plays,
      persistent: redis.isPersistent
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read record', details: err.message });
  }
}
