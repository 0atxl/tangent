/**
 * Two-tier processed Wikipedia article cache:
 * - L1: In-memory LRU Map (0ms hits for Back moves & rapid revisits)
 * - L2: IndexedDB (persists across reloads for 24h, ~5-15ms hits)
 * Stores already-sanitized, reference-stripped HTML with neutral link markup
 * so one cached entry works seamlessly across Easy / Medium / Hardcore / Boss tiers.
 */

const DB_NAME = 'tangent_wiki_cache';
const STORE_NAME = 'articles';
const DB_VERSION = 1;
const CACHE_SCHEMA_VERSION = 2;
const MAX_MEM_ENTRIES = 60;
const MAX_IDB_ENTRIES = 150;
const TTL_MS = 24 * 60 * 60 * 1000;

const memCache = new Map(); // key -> entry
let dbPromise = null;
let idbWritesSincePrune = 0;

function lruSet(map, key, value, maxSize) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function isFresh(entry) {
  return Boolean(
    entry &&
      entry.v === CACHE_SCHEMA_VERSION &&
      typeof entry.title === 'string' &&
      typeof entry.bodyHtml === 'string' &&
      Date.now() - (entry.savedAt || 0) <= TTL_MS
  );
}

function openDB() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

export function hasMemCachedArticle(key) {
  const hit = memCache.get(key);
  if (!hit) return false;
  if (!isFresh(hit)) {
    memCache.delete(key);
    return false;
  }
  return true;
}

export function getMemCachedArticle(key) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (!isFresh(hit)) {
    memCache.delete(key);
    return null;
  }
  lruSet(memCache, key, hit, MAX_MEM_ENTRIES);
  return hit;
}

export async function getCachedArticle(key) {
  const memHit = getMemCachedArticle(key);
  if (memHit) return memHit;

  const db = await openDB();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (isFresh(entry)) {
          lruSet(memCache, key, entry, MAX_MEM_ENTRIES);
          resolve(entry);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function pruneOldIdbEntries(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const excess = countReq.result - MAX_IDB_ENTRIES;
        if (excess <= 0) {
          resolve();
          return;
        }
        let deleted = 0;
        const idx = store.index('savedAt');
        const cursorReq = idx.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || deleted >= excess) {
            resolve();
            return;
          }
          cursor.delete();
          deleted += 1;
          cursor.continue();
        };
        cursorReq.onerror = () => resolve();
      };
      countReq.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function setCachedArticle(key, canonicalKey, data) {
  const entry = {
    key,
    v: CACHE_SCHEMA_VERSION,
    title: data.title,
    sections: Array.isArray(data.sections) ? data.sections : [],
    asideHtml: data.asideHtml || '',
    bodyHtml: data.bodyHtml || '',
    savedAt: Date.now()
  };

  lruSet(memCache, key, entry, MAX_MEM_ENTRIES);
  if (canonicalKey && canonicalKey !== key) {
    lruSet(memCache, canonicalKey, { ...entry, key: canonicalKey }, MAX_MEM_ENTRIES);
  }

  // Persist asynchronously to IndexedDB without blocking rendering
  openDB().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry);
      if (canonicalKey && canonicalKey !== key) {
        store.put({ ...entry, key: canonicalKey });
      }
      idbWritesSincePrune += 1;
      if (idbWritesSincePrune >= 12) {
        idbWritesSincePrune = 0;
        tx.oncomplete = () => {
          pruneOldIdbEntries(db).catch(() => {});
        };
      }
    } catch {
      // Ignore quota / private mode failures
    }
  });
}
