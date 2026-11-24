/**
 * Lightweight Upstash Redis REST wrapper with automatic in-memory fallback
 * for zero-config local development (`npm run dev`).
 */

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const HAS_UPSTASH = Boolean(REST_URL && REST_TOKEN);

// Persist in-memory store across HMR/reloads in local dev
const mem = (globalThis.__TANGENT_MEM_REDIS ??= {
  kv: new Map(), // key -> { val, exp }
  zsets: new Map() // key -> Map(member -> score)
});

function isExpired(entry) {
  return entry && entry.exp && Date.now() > entry.exp;
}

async function upstashCmd(...args) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    throw new Error(`Upstash error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export const redis = {
  isPersistent: HAS_UPSTASH,

  async get(key) {
    if (HAS_UPSTASH) return upstashCmd('GET', key);
    const entry = mem.kv.get(key);
    if (!entry || isExpired(entry)) {
      mem.kv.delete(key);
      return null;
    }
    return entry.val;
  },

  async getJSON(key) {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  },

  async set(key, value, ttlSeconds = null) {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (HAS_UPSTASH) {
      return ttlSeconds
        ? upstashCmd('SET', key, str, 'EX', String(ttlSeconds))
        : upstashCmd('SET', key, str);
    }
    mem.kv.set(key, {
      val: str,
      exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null
    });
    return 'OK';
  },

  async incr(key, ttlSeconds = null) {
    if (HAS_UPSTASH) {
      const n = await upstashCmd('INCR', key);
      if (n === 1 && ttlSeconds) await upstashCmd('EXPIRE', key, String(ttlSeconds));
      return Number(n);
    }
    const existing = await this.get(key);
    const next = (Number(existing) || 0) + 1;
    const prev = mem.kv.get(key);
    mem.kv.set(key, {
      val: String(next),
      exp: prev?.exp ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : null)
    });
    return next;
  },

  async zadd(key, score, member, ttlSeconds = null) {
    if (HAS_UPSTASH) {
      const r = await upstashCmd('ZADD', key, String(score), String(member));
      if (ttlSeconds) await upstashCmd('EXPIRE', key, String(ttlSeconds));
      return r;
    }
    let z = mem.zsets.get(key);
    if (!z) {
      z = new Map();
      mem.zsets.set(key, z);
    }
    z.set(String(member), Number(score));
    return 1;
  },

  async zrank(key, member) {
    if (HAS_UPSTASH) {
      const r = await upstashCmd('ZRANK', key, String(member));
      return r === null ? null : Number(r);
    }
    const z = mem.zsets.get(key);
    if (!z || !z.has(String(member))) return null;
    const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]);
    return sorted.findIndex(([m]) => m === String(member));
  },

  async zcard(key) {
    if (HAS_UPSTASH) {
      const r = await upstashCmd('ZCARD', key);
      return Number(r) || 0;
    }
    const z = mem.zsets.get(key);
    return z ? z.size : 0;
  }
};
