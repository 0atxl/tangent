import { redis } from '../_lib/redis.js';

const ROOM_TTL = 86400;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = String(req.body?.code || '').trim().toUpperCase();
  const clientId = String(req.body?.clientId || '').trim();
  const action = req.body?.action || 'start'; // 'start' | 'rematch'

  if (!code || !clientId) {
    return res.status(400).json({ error: 'Missing code or clientId' });
  }

  try {
    const room = await redis.getJSON(`room:${code}`);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.hostId !== clientId) {
      return res.status(403).json({ error: 'Only the host can start the race' });
    }

    if (action === 'rematch') {
      room.round = (room.round || 1) + 1;
      if (req.body?.start && req.body?.target) {
        room.start = String(req.body.start).trim();
        room.target = String(req.body.target).trim();
      }
      if (req.body?.par) room.par = Number(req.body.par) || room.par;
      if (req.body?.tier) room.tier = req.body.tier;
      if (req.body?.lang && /^[a-z-]{2,12}$/i.test(req.body.lang)) {
        room.lang = req.body.lang;
      }
      if (req.body?.settings) {
        room.settings = {
          ...room.settings,
          ...req.body.settings
        };
      }
    }

    room.status = 'racing';
    room.startAt = Date.now() + 3200; // Synchronized 3-2-1 countdown
    room.graceEndsAt = null;
    room.players = room.players.map((p) => ({
      ...p,
      clicks: 0,
      hints: 0,
      score: null,
      elapsedMs: null,
      finished: false,
      finishedAt: null,
      path: [],
      lastSeen: Date.now()
    }));

    await redis.set(`room:${code}`, room, ROOM_TTL);
    return res.status(200).json({ room, serverNow: Date.now() });
  } catch (err) {
    return res.status(500).json({ error: 'Could not start race', details: err.message });
  }
}
