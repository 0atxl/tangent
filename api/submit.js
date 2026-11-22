import { redis } from './_lib/redis.js';
import { getClientIp, verifyRun } from './_lib/wiki.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    clientId,
    nickname = 'Player',
    pairKey,
    start,
    target,
    lang = 'en',
    dailyDate = null,
    hints = 0,
    elapsedMs = 0,
    moves = [],
    path = []
  } = req.body || {};

  if (!clientId || !pairKey || !start || !target) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const safeHints = Number(hints);
  const safeElapsed = Number(elapsedMs);
  if (!Number.isInteger(safeHints) || safeHints < 0 || safeHints > 2) {
    return res.status(400).json({ error: 'Invalid hints count' });
  }

  const clicks = Array.isArray(moves) ? moves.length : 0;
  if (clicks < 1 || clicks > 60) {
    return res.status(400).json({ error: 'Invalid click count' });
  }

  // Plausible human speed floor (800ms per click)
  if (!Number.isFinite(safeElapsed) || safeElapsed < clicks * 800) {
    return res.status(400).json({ valid: false, error: 'Run speed below human floor' });
  }

  try {
    // Rate limit: 30 submissions/hour per IP+client
    const ip = getClientIp(req);
    const rateKey = `rl:sub:${ip}:${String(clientId).slice(0, 36)}`;
    const count = await redis.incr(rateKey, 3600);
    if (count > 30) {
      return res.status(429).json({ valid: false, error: 'Rate limit exceeded' });
    }

    // Server-side link-graph verification
    const check = await verifyRun({ start, target, lang, moves });
    if (!check.valid) {
      return res.status(400).json({ valid: false, error: check.reason });
    }

    const score = clicks + safeHints;
    const cleanName = String(nickname || 'Player').trim().slice(0, 20) || 'Player';
    const finalPath = check.verifiedPath || path;

    await redis.incr(`plays:${pairKey}`);

    // Update global record for this pair
    const recKey = `rec:${pairKey}`;
    const existing = await redis.getJSON(recKey);
    let isGlobalRecord = false;
    let record = existing;

    if (
      !existing ||
      score < existing.best ||
      (score === existing.best && safeElapsed < (existing.elapsedMs ?? Infinity))
    ) {
      isGlobalRecord = true;
      record = {
        best: score,
        clicks,
        hints: safeHints,
        elapsedMs: safeElapsed,
        holder: cleanName,
        path: finalPath,
        updatedAt: new Date().toISOString()
      };
      await redis.set(recKey, record);
    }

    // Update daily leaderboard sorted set if this is a daily run
    let dailyRank = null;
    let dailyTotal = null;
    let percentile = null;

    if (dailyDate && /^\d{4}-\d{2}-\d{2}$/.test(dailyDate)) {
      const dailyKey = `daily:${dailyDate}`;
      // Composite score: primary = clicks+hints, secondary = elapsedMs (capped at 999999ms)
      const composite = score * 1000000 + Math.min(Math.round(safeElapsed), 999999);
      await redis.zadd(dailyKey, composite, String(clientId), 86400 * 120);
      const rank0 = await redis.zrank(dailyKey, String(clientId));
      dailyTotal = await redis.zcard(dailyKey);
      if (rank0 !== null && dailyTotal > 0) {
        dailyRank = rank0 + 1;
        percentile = Math.max(1, Math.round((dailyRank / dailyTotal) * 100));
      }
    }

    return res.status(200).json({
      valid: true,
      score,
      isGlobalRecord,
      record: {
        best: record.best,
        elapsedMs: record.elapsedMs,
        holder: record.holder
      },
      dailyRank,
      dailyTotal,
      percentile,
      persistent: redis.isPersistent
    });
  } catch (err) {
    return res.status(500).json({ error: 'Submission failed', details: err.message });
  }
}
