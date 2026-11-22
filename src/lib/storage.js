import { formatUtcDate } from '../data/packs.js';

const PREFIX = 'tangent:v1:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, val) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(val));
  } catch {
    // Private browsing or quota full — silently keep in-memory behavior
  }
}

function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Ignore storage errors
  }
}

export function getClientId() {
  let id = read('clientId', null);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    write('clientId', id);
  }
  return id;
}

export function getNickname() {
  return read('nickname', '');
}

export function setNickname(name) {
  write('nickname', String(name || '').trim().slice(0, 20));
}

export function getDailyHistory() {
  return read('dailyHistory', {});
}

export function saveDailyResult(dateStr, result) {
  const hist = getDailyHistory();
  const prev = hist[dateStr];
  const isFirstCompletion = !prev;

  // Keep best score on replay, but streak & official daily score reflect completion
  if (!prev || result.score < prev.score || (result.score === prev.score && result.elapsedMs < prev.elapsedMs)) {
    hist[dateStr] = {
      ...result,
      firstCompletedAt: prev?.firstCompletedAt || new Date().toISOString()
    };
    write('dailyHistory', hist);
  }

  if (isFirstCompletion && dateStr === formatUtcDate()) {
    updateStreak(dateStr);
  }
  return { isFirstCompletion, streak: getStreak() };
}

export function getStreak() {
  const st = read('streak', { lastDate: '', count: 0, max: 0 });
  const today = formatUtcDate();
  const yestDate = new Date(Date.now() - 86400000);
  const yesterday = formatUtcDate(yestDate);
  const active = st.lastDate === today || st.lastDate === yesterday ? st.count : 0;
  return { count: active, max: st.max || active, lastDate: st.lastDate };
}

function updateStreak(todayStr) {
  const st = read('streak', { lastDate: '', count: 0, max: 0 });
  if (st.lastDate === todayStr) return;
  const yestDate = new Date(Date.now() - 86400000);
  const yesterdayStr = formatUtcDate(yestDate);
  const nextCount = st.lastDate === yesterdayStr ? (st.count || 0) + 1 : 1;
  write('streak', {
    lastDate: todayStr,
    count: nextCount,
    max: Math.max(st.max || 0, nextCount)
  });
}

export function getPersonalBests() {
  return read('personalBests', {});
}

export function savePersonalBest(pairKey, result) {
  const all = getPersonalBests();
  const prev = all[pairKey];
  const isNewPB =
    !prev ||
    result.score < prev.score ||
    (result.score === prev.score && result.elapsedMs < (prev.elapsedMs ?? Infinity));
  if (isNewPB) {
    all[pairKey] = {
      score: result.score,
      clicks: result.clicks,
      hints: result.hints,
      elapsedMs: result.elapsedMs,
      path: result.path
    };
    write('personalBests', all);
  }
  return { isNewPB, best: all[pairKey] };
}

export function getPrefs() {
  return {
    sound: true,
    previews: true,
    highContrast: false,
    vipPaidZero: false,
    tutorialDone: false,
    pauseIndex: 0,
    ...read('prefs', {})
  };
}

export function updatePrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  write('prefs', next);
  return next;
}

const ACTIVE_GAME_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function getActiveGame() {
  const saved = read('activeGame', null);
  if (!saved || typeof saved !== 'object') return null;
  if (!saved.start || !saved.target || !Array.isArray(saved.path) || saved.path.length === 0) {
    remove('activeGame');
    return null;
  }
  if (saved.savedAt && Date.now() - saved.savedAt > ACTIVE_GAME_MAX_AGE_MS) {
    remove('activeGame');
    return null;
  }
  return saved;
}

export function saveActiveGame(snapshot) {
  if (!snapshot || !snapshot.start || !snapshot.target) return;
  write('activeGame', {
    ...snapshot,
    savedAt: Date.now()
  });
}

export function clearActiveGame() {
  remove('activeGame');
}
