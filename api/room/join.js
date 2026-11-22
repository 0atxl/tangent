import { redis } from '../_lib/redis.js';

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
const MAX_PLAYERS = 10;
const ROOM_TTL = 86400;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = String(req.body?.code || '').trim().toUpperCase();
  const clientId = String(req.body?.clientId || '').trim();
  const cleanName = String(req.body?.name || 'Player').trim().slice(0, 18) || 'Player';

  if (!code || !clientId) {
    return res.status(400).json({ error: 'Missing code or clientId' });
  }

  try {
    const room = await redis.getJSON(`room:${code}`);
    if (!room) {
      return res.status(404).json({ error: 'Room not found or expired' });
    }

    const existing = room.players.find((p) => p.id === clientId);
    if (existing) {
      existing.name = cleanName;
      existing.lastSeen = Date.now();
    } else {
      if (room.players.length >= MAX_PLAYERS) {
        return res.status(409).json({ error: 'Room is full (max 10 players)' });
      }
      if (room.status === 'finished') {
        // Allow joining between rounds so they can play the next rematch
      }
      const usedColors = new Set(room.players.map((p) => p.color));
      const nextColor = COLORS.find((c) => !usedColors.has(c)) || COLORS[room.players.length % COLORS.length];
      room.players.push({
        id: clientId,
        name: cleanName,
        color: nextColor,
        isHost: false,
        clicks: 0,
        hints: 0,
        score: null,
        elapsedMs: null,
        finished: false,
        finishedAt: null,
        path: [],
        lastSeen: Date.now()
      });
    }

    await redis.set(`room:${code}`, room, ROOM_TTL);
    return res.status(200).json({ room });
  } catch (err) {
    return res.status(500).json({ error: 'Could not join room', details: err.message });
  }
}
