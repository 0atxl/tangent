import { redis } from '../_lib/redis.js';

const ROOM_TTL = 86400;
const GRACE_MS = 60000; // 60-second grace window after first finisher

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    code: rawCode,
    clientId,
    clicks = 0,
    hints = 0,
    finished = false,
    elapsedMs = null,
    path = []
  } = req.body || {};

  const code = String(rawCode || '').trim().toUpperCase();
  if (!code || !clientId) {
    return res.status(400).json({ error: 'Missing code or clientId' });
  }

  try {
    const room = await redis.getJSON(`room:${code}`);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const player = room.players.find((p) => p.id === String(clientId));
    if (!player) return res.status(404).json({ error: 'Player not in room' });

    player.clicks = Math.max(0, Number(clicks) || 0);
    player.hints = Math.max(0, Math.min(2, Number(hints) || 0));
    player.lastSeen = Date.now();

    if (finished && !player.finished) {
      player.finished = true;
      player.finishedAt = Date.now();
      player.score = player.clicks + player.hints;
      player.elapsedMs = Math.max(500, Number(elapsedMs) || Date.now() - (room.startAt || Date.now()));
      player.path = Array.isArray(path) ? path.slice(0, 60) : [];

      // Start the 60s grace countdown once the first player reaches the target
      if (!room.graceEndsAt) {
        room.graceEndsAt = Date.now() + GRACE_MS;
      }
    }

    // Auto-complete room if everyone finished or grace window elapsed
    const allFinished = room.players.length > 0 && room.players.every((p) => p.finished);
    if (room.status === 'racing' && (allFinished || (room.graceEndsAt && Date.now() >= room.graceEndsAt))) {
      room.status = 'finished';
    }

    await redis.set(`room:${code}`, room, ROOM_TTL);
    return res.status(200).json({ room, serverNow: Date.now() });
  } catch (err) {
    return res.status(500).json({ error: 'Could not update progress', details: err.message });
  }
}
