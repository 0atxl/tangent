/**
 * Lightweight client for Tangent's Vercel Serverless / Upstash Redis API
 * with graceful offline fallback.
 */

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export async function fetchGlobalRecord(pairKey) {
  try {
    return await request(`/api/record?pairKey=${encodeURIComponent(pairKey)}`);
  } catch {
    return { best: null, plays: 0, offline: true };
  }
}

export async function submitScore(payload) {
  try {
    return await request('/api/submit', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return { valid: false, offline: true, error: err.message };
  }
}

export async function createRoom(payload) {
  return request('/api/room/create', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function joinRoom(payload) {
  return request('/api/room/join', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function startRoom(payload) {
  return request('/api/room/start', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function syncRoomProgress(payload) {
  return request('/api/room/progress', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function getRoomState(code) {
  return request(`/api/room/${encodeURIComponent(code)}`);
}
