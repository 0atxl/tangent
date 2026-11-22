import { redis } from '../_lib/redis.js';

const ROOM_TTL = 86400;

function sortStandings(players, mode) {
  return [...players].sort((a, b) => {
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) {
      if (mode === 'speed') {
        if ((a.elapsedMs ?? Infinity) !== (b.elapsedMs ?? Infinity)) {
          return (a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity);
        }
        return (a.score ?? Infinity) - (b.score ?? Infinity);
      }
      if ((a.score ?? Infinity) !== (b.score ?? Infinity)) {
        return (a.score ?? Infinity) - (b.score ?? Infinity);
      }
      return (a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity);
    }
    return (b.clicks || 0) - (a.clicks || 0);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = String(req.query?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Missing room code' });

  try {
    const room = await redis.getJSON(`room:${code}`);
    if (!room) return res.status(404).json({ error: 'Room not found or expired' });

    const now = Date.now();
    let changed = false;

    if (room.status === 'racing') {
      const allFinished = room.players.length > 0 && room.players.every((p) => p.finished);
      if (allFinished || (room.graceEndsAt && now >= room.graceEndsAt)) {
        room.status = 'finished';
        changed = true;
      }
    }

    if (changed) {
      await redis.set(`room:${code}`, room, ROOM_TTL);
    }

    // Hide other players' exact routes until the room is finished (no spoilers mid-race)
    const sanitizedPlayers = sortStandings(room.players, room.settings?.mode).map((p) => ({
      ...p,
      path: room.status === 'finished' ? p.path : []
    }));

    return res.status(200).json({
      room: {
        ...room,
        players: sanitizedPlayers
      },
      serverNow: now
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load room', details: err.message });
  }
}
