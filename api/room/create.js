import { redis } from '../_lib/redis.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = [
  '#5372F8',
  '#F5B82E',
  '#F46D8A',
  '#3DBE8B',
  '#9D7DF8',
  '#FF8A4C',
  '#3AA8E8',
  '#E056A0',
  '#68C151',
  '#E8A838'
];
const ROOM_TTL = 86400; // 24 hours auto-cleanup

function makeCode() {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    clientId,
    name = 'Host',
    start,
    target,
    lang = 'en',
    par = 4,
    tier = 'medium',
    mode = 'clicks',
    previews = true,
    banHubs = false,
    lockInfobox = false,
    maxHints = 2,
    backCost = 1
  } = req.body || {};

  if (!clientId || !start || !target) {
    return res.status(400).json({ error: 'Missing required room fields' });
  }

  try {
    let code = makeCode();
    for (let tries = 0; tries < 5; tries++) {
      const exists = await redis.get(`room:${code}`);
      if (!exists) break;
      code = makeCode();
    }

    const cleanName = String(name).trim().slice(0, 18) || 'Host';
    const room = {
      code,
      hostId: String(clientId),
      round: 1,
      status: 'lobby', // lobby | racing | finished
      start: String(start).trim(),
      target: String(target).trim(),
      lang: /^[a-z-]{2,12}$/i.test(lang) ? lang : 'en',
      par: Number(par) || 4,
      tier: ['easy', 'medium', 'hardcore', 'boss'].includes(tier) ? tier : 'medium',
      settings: {
        mode: mode === 'speed' ? 'speed' : 'clicks',
        previews: Boolean(previews),
        banHubs: Boolean(banHubs),
        lockInfobox: Boolean(lockInfobox),
        maxHints: Number.isInteger(Number(maxHints)) ? Number(maxHints) : 2,
        backCost: Number(backCost) === 2 ? 2 : 1
      },
      createdAt: Date.now(),
      startAt: null,
      graceEndsAt: null,
      players: [
        {
          id: String(clientId),
          name: cleanName,
          color: COLORS[0],
          isHost: true,
          clicks: 0,
          hints: 0,
          score: null,
          elapsedMs: null,
          finished: false,
          finishedAt: null,
          path: [],
          lastSeen: Date.now()
        }
      ]
    };

    await redis.set(`room:${code}`, room, ROOM_TTL);
    return res.status(200).json({ room, persistent: redis.isPersistent });
  } catch (err) {
    return res.status(500).json({ error: 'Could not create room', details: err.message });
  }
}
