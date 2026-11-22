/**
 * 3-mode Theme Manager: 'light' | 'dark' | 'oled'
 * Synchronizes <meta name="color-scheme">, data-theme attribute,
 * localStorage, and cross-tab storage events without retroactively
 * clearing a user's pinned choice when OS preference changes.
 */

const STORAGE_KEY = 'tangent:theme';
const ORDER = ['light', 'dark', 'oled'];

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function getStoredTheme() {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    return ORDER.includes(val) ? val : null;
  } catch {
    return null;
  }
}

export function getEffectiveTheme() {
  const stored = getStoredTheme();
  if (stored) return stored;
  return systemPrefersDark() ? 'dark' : 'light';
}

export function applyTheme(mode) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const root = document.documentElement;

  if (mode === 'light') {
    if (meta) meta.content = 'light';
    root.dataset.theme = 'light';
  } else if (mode === 'dark') {
    if (meta) meta.content = 'dark';
    root.dataset.theme = 'dark';
  } else if (mode === 'oled') {
    if (meta) meta.content = 'dark';
    root.dataset.theme = 'oled';
  } else {
    // System fallback
    if (meta) meta.content = 'light dark';
    delete root.dataset.theme;
  }
}

export function setTheme(mode) {
  try {
    if (mode && ORDER.includes(mode)) {
      localStorage.setItem(STORAGE_KEY, mode);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Still apply theme even when storage is blocked
  }
  applyTheme(mode);
  window.dispatchEvent(new CustomEvent('tangent:themechange', { detail: { theme: getEffectiveTheme() } }));
}

export function cycleTheme() {
  const current = getEffectiveTheme();
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  setTheme(next);
  return next;
}

export function initThemeSync() {
  applyTheme(getStoredTheme());

  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(getStoredTheme());
      window.dispatchEvent(new CustomEvent('tangent:themechange', { detail: { theme: getEffectiveTheme() } }));
    }
  });
}
