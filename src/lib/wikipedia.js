/**
 * High-performance streaming Wikipedia client:
 * - Vercel Edge CDN proxy (/api/wiki) primary with direct Wikimedia Parsoid REST streaming
 *   & cached action=parse fallback
 * - True section-by-section ReadableStream rendering (Lead + Infobox render immediately on Section 0)
 * - Early HTTP stream cancellation at boilerplate trailing sections (References, External links, etc.)
 * - Two-tier processed article cache (L1 in-memory LRU + L2 IndexedDB, 24h TTL)
 * - Strict max-1 intent-driven prefetching (priority: 'low', aborted on new hover or real click)
 * - Yielding to the main thread via scheduler.yield() (setTimeout fallback) to eliminate INP jank
 * - Clean stripping of Wikipedia template navbars (v·t·e) and compact horizontal image strips
 */
import { BANNED_HUBS } from '../data/packs.js';
import {
  getCachedArticle,
  getMemCachedArticle,
  hasMemCachedArticle,
  setCachedArticle
} from './articleCache.js';

const MAX_RAW_BUFFER_CACHE = 16;
const MAX_SUMMARY_CACHE = 200;
const NAMESPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const rawBufferCache = new Map(); // `${lang}:${normTitle}` -> { canonicalTitle, sections: string[], source }
const activeStreams = new Map(); // `${lang}:${normTitle}` -> StreamEntry
const summaryCache = new Map();
const summaryPending = new Map();
const namespaceCache = new Map();
const namespacePending = new Map();

let domPurifyPromise = null;
let currentPrefetchEntry = null;

// Built-in baseline non-mainspace namespaces (augmented dynamically per language via siteinfo)
const BASE_NON_MAINSPACE = [
  'media', 'special', 'talk', 'user', 'user talk',
  'wikipedia', 'wikipedia talk', 'wp', 'project', 'project talk',
  'file', 'file talk', 'image', 'image talk',
  'mediawiki', 'mediawiki talk', 'template', 'template talk',
  'help', 'help talk', 'category', 'category talk',
  'portal', 'portal talk', 'draft', 'draft talk',
  'timedtext', 'timedtext talk', 'module', 'module talk',
  'book', 'book talk', 'gadget', 'gadget talk',
  'gadget definition', 'gadget definition talk', 'topic', 'mos'
];

// Trailing appendix headings guaranteed to come at the end of Wikipedia articles (MOS:LAYOUT).
// "Sources" and "Notes" are handled selectively so real prose sections (like Genghis Khan's "Sources") are kept.
const STREAM_ABORT_HEADING_RE =
  /^(references|external links|further reading|bibliography|see also|citations|footnotes|referencias|enlaces externos|véase también|notes et références|liens externes|voir aussi|einzelnachweise|weblinks|siehe auch|collegamenti esterni|voci correlate|referências|ligações externas|ver também|примечания|ссылки|см\.\s*также|脚注|外部リンク|関連項目|参考文献|参考资料|外部链接|参见|각주|외부 링크|같이 보기|सन्दर्भ|बाहरी कड़ियाँ|इन्हें भी देखें|مراجع|وصلات خارجية|انظر أيضاً|kaynakça|dış bağlantılar|ayrıca bakınız|przypisy|linki zewnętrzne|zobacz też|externe links|zie ook)$/i;

const SKIP_IF_REF_HEADING_RE = /^(notes|note|noten|sources|explanatory notes)$/i;

const SECTION_TAG_RE = /<(\/?)section\b[^>]*>/gi;

function loadDOMPurify() {
  domPurifyPromise ??= import('dompurify').then((m) => m.default ?? m);
  return domPurifyPromise;
}

async function yieldToMain() {
  if (typeof window !== 'undefined' && 'scheduler' in window && 'yield' in window.scheduler) {
    await window.scheduler.yield();
  } else {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function normTitle(t) {
  return String(t || '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}

export function isAbortError(err, userSignal) {
  if (userSignal?.aborted) return true;
  return Boolean(err && err.name === 'AbortError');
}

function isTimeoutError(err) {
  return Boolean(err && err.name === 'TimeoutError');
}

function lruSet(map, key, value, maxSize) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function toWikiPathTitle(title) {
  const trimmed = String(title || '').trim().replace(/ /g, '_');
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function createDeadlineSignal(timeoutMs, parentSignal) {
  const hasTimeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
  const hasAny = typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function';

  if (hasTimeout) {
    const timeoutSig = AbortSignal.timeout(timeoutMs);
    if (!parentSignal) return { signal: timeoutSig, cleanup() {} };
    if (hasAny) return { signal: AbortSignal.any([parentSignal, timeoutSig]), cleanup() {} };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new DOMException(`Timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);

  const onParentAbort = () => ctrl.abort(parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer);
      ctrl.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  return {
    signal: ctrl.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  };
}

async function fetchWithDeadline(
  url,
  { timeoutMs = 8000, signal = null, headers = undefined, priority = undefined } = {}
) {
  const { signal: combined, cleanup } = createDeadlineSignal(timeoutMs, signal);
  const opts = { signal: combined };
  if (headers) opts.headers = headers;
  if (priority) opts.priority = priority;

  try {
    return await fetch(url, opts);
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`Wikipedia took too long to respond (${Math.round(timeoutMs / 1000)}s timeout)`, {
        cause: err
      });
    }
    throw err;
  } finally {
    cleanup();
  }
}

/**
 * Fetch helper for streaming responses: enforces a deadline ONLY while waiting
 * for response headers (TTFB), then clears the timer so slow full-body streams
 * are never prematurely aborted mid-read.
 */
async function fetchStreamWithTtfbTimeout(url, { ttfbTimeoutMs = 3000, signal = null, priority = undefined } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new DOMException(`Timed out waiting for headers (${ttfbTimeoutMs}ms)`, 'TimeoutError'));
  }, ttfbTimeoutMs);

  const onParentAbort = () => ctrl.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw signal.reason || new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const opts = { signal: ctrl.signal };
  if (priority) opts.priority = priority;

  try {
    const res = await fetch(url, opts);
    clearTimeout(timer);
    return {
      res,
      cleanup() {
        signal?.removeEventListener('abort', onParentAbort);
      }
    };
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
    if (timedOut && !signal?.aborted) {
      throw new DOMException(`Timed out waiting for headers (${ttfbTimeoutMs}ms)`, 'TimeoutError');
    }
    throw err;
  }
}
function extractCanonicalFromHead(headHtml, fallbackTitle, finalUrl) {
  const verMatch =
    headHtml.match(/<link[^>]*\brel=["']dc:isVersionOf["'][^>]*\bhref=["'][^"']*\/wiki\/([^"'#?]+)["']/i) ||
    headHtml.match(/<link[^>]*\bhref=["'][^"']*\/wiki\/([^"'#?]+)["'][^>]*\brel=["']dc:isVersionOf["']/i);
  if (verMatch?.[1]) {
    try {
      return decodeURIComponent(verMatch[1]).replace(/_/g, ' ');
    } catch {
      // fall through
    }
  }

  const titleMatch = headHtml.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const clean = decodeHtmlEntities(titleMatch[1]).replace(/<[^>]+>/g, '').trim();
    if (clean) return clean;
  }

  if (finalUrl) {
    const urlMatch =
      finalUrl.match(/\/page\/html\/([^?#]+)/) || finalUrl.match(/\/page\/([^/?#]+)\/html/);
    if (urlMatch?.[1]) {
      try {
        return decodeURIComponent(urlMatch[1]).replace(/_/g, ' ');
      } catch {
        // fall through
      }
    }
  }

  return fallbackTitle;
}

function classifySectionHtml(sectionHtml, sectionIndex) {
  if (sectionIndex === 0) return 'keep';
  const h2Match = sectionHtml.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (!h2Match) return 'keep';
  const text = decodeHtmlEntities(h2Match[1].replace(/<[^>]+>/g, '')).trim();
  if (STREAM_ABORT_HEADING_RE.test(text)) return 'abort';
  if (
    SKIP_IF_REF_HEADING_RE.test(text) &&
    /(?:class="[^"]*(?:reflist|mw-references)|typeof="[^"]*mw:Extension\/references)/i.test(sectionHtml)
  ) {
    return 'skip';
  }
  return 'keep';
}

/**
 * Incrementally parses a ReadableStream of Parsoid HTML (from /api/wiki or Wikimedia rest_v1)
 * emitting top-level <section> strings as packets arrive and cancelling the HTTP stream
 * the moment boilerplate trailing sections (References, External links, etc.) begin.
 */
async function pumpParsoidResponse(res, fallbackTitle, { hasBodyWrapper, headerCanonical, onCanonical, onSection, signal }) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    const canonical =
      headerCanonical || extractCanonicalFromHead(text.slice(0, 8192), fallbackTitle, res.url);
    onCanonical(canonical);
    const bodyMatch = hasBodyWrapper ? text.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) : null;
    onSection(bodyMatch ? bodyMatch[1] : text);
    return;
  }

  const decoder = new TextDecoder('utf-8');
  let headBuf = '';
  let scanBuf = '';
  let depth = 0;
  let currentSection = '';
  let fallbackRawBuf = '';
  let sectionIndex = 0;
  let stoppedEarly = false;
  let inBody = !hasBodyWrapper;
  let emittedCanonical = false;

  if (headerCanonical) {
    emittedCanonical = true;
    onCanonical(headerCanonical);
  }

  const processScanBuffer = (isFinal = false) => {
    let limit = scanBuf.length;
    if (!isFinal) {
      const lastLt = scanBuf.lastIndexOf('<');
      if (lastLt !== -1 && scanBuf.indexOf('>', lastLt) === -1) {
        limit = lastLt;
      }
    }

    const slice = scanBuf.slice(0, limit);
    const remainder = scanBuf.slice(limit);

    SECTION_TAG_RE.lastIndex = 0;
    let cursor = 0;
    let match;

    while ((match = SECTION_TAG_RE.exec(slice)) !== null) {
      const isClosing = match[1] === '/';
      const tagStart = match.index;
      const tagEnd = SECTION_TAG_RE.lastIndex;

      if (!isClosing) {
        if (depth === 0) {
          fallbackRawBuf = '';
          currentSection = slice.slice(tagStart, tagEnd);
        } else {
          currentSection += slice.slice(cursor, tagEnd);
        }
        depth += 1;
      } else if (depth > 0) {
        currentSection += slice.slice(cursor, tagEnd);
        depth -= 1;

        if (depth === 0) {
          const action = classifySectionHtml(currentSection, sectionIndex);
          if (action === 'abort') {
            stoppedEarly = true;
            currentSection = '';
            scanBuf = '';
            return;
          }
          if (action === 'keep') {
            onSection(currentSection);
          }
          currentSection = '';
          sectionIndex += 1;
        }
      }
      cursor = tagEnd;
    }

    if (depth > 0 && cursor < slice.length) {
      currentSection += slice.slice(cursor);
    } else if (sectionIndex === 0 && depth === 0 && cursor < slice.length && fallbackRawBuf.length < 524288) {
      fallbackRawBuf += slice.slice(cursor);
    }

    scanBuf = remainder;
  };

  try {
    while (!stoppedEarly) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw signal.reason || new DOMException('Aborted', 'AbortError');
      }
      const { value, done } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          if (!inBody) headBuf += tail;
          else scanBuf += tail;
        }
        break;
      }

      const text = decoder.decode(value, { stream: true });
      if (!inBody) {
        headBuf += text;
        const bodyIdx = headBuf.search(/<body\b[^>]*>/i);
        if (bodyIdx !== -1) {
          const bodyTagEnd = headBuf.indexOf('>', bodyIdx);
          if (bodyTagEnd !== -1) {
            if (!emittedCanonical) {
              emittedCanonical = true;
              onCanonical(extractCanonicalFromHead(headBuf.slice(0, bodyIdx), fallbackTitle, res.url));
            }
            inBody = true;
            scanBuf = headBuf.slice(bodyTagEnd + 1);
            headBuf = '';
            processScanBuffer(false);
          }
        } else if (headBuf.length > 65536) {
          if (!emittedCanonical) {
            emittedCanonical = true;
            onCanonical(extractCanonicalFromHead(headBuf, fallbackTitle, res.url));
          }
          inBody = true;
          scanBuf = headBuf;
          headBuf = '';
          processScanBuffer(false);
        }
      } else {
        scanBuf += text;
        processScanBuffer(false);
      }
    }

    if (stoppedEarly) {
      await reader.cancel().catch(() => {});
      return;
    }

    if (!inBody && headBuf) {
      if (!emittedCanonical) {
        emittedCanonical = true;
        onCanonical(extractCanonicalFromHead(headBuf, fallbackTitle, res.url));
      }
      onSection(headBuf);
      return;
    }

    processScanBuffer(true);
    if (currentSection) {
      onSection(currentSection);
    } else if (sectionIndex === 0 && fallbackRawBuf.trim()) {
      if (!emittedCanonical) {
        emittedCanonical = true;
        onCanonical(fallbackTitle);
      }
      onSection(fallbackRawBuf);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}

async function fetchActionParseFallback(title, lang, { timeoutMs = 8500, signal, priority }) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(
    title
  )}&prop=text&redirects=1&disableeditsection=1&disablelimitreport=1&disabletoc=1&format=json&formatversion=2&maxage=3600&smaxage=3600&origin=*`;
  const res = await fetchWithDeadline(url, { timeoutMs, signal, priority });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (data.error || !data.parse) {
    const err = new Error(data.error?.info || 'Article not found');
    err.notFound = data.error?.code === 'missingtitle';
    throw err;
  }
  return {
    canonicalTitle: data.parse.title || title,
    html: data.parse.text || ''
  };
}

/**
 * Starts a shared raw section stream for (title, lang):
 * 1. Tries Vercel Edge CDN proxy (/api/wiki) first for ~50-120ms edge hits & server-trimmed streaming
 * 2. Seamlessly falls back to direct Wikimedia Parsoid REST streaming (with client-side early abort)
 * 3. Ultimate fallback to MediaWiki action=parse
 */
function startRawStream(title, lang, { isPrefetch = false, priority = undefined } = {}) {
  const key = `${lang}:${normTitle(title)}`;
  const existing = activeStreams.get(key);
  if (existing) {
    if (!isPrefetch) existing.promoted = true;
    return existing;
  }

  const controller = new AbortController();
  const entry = {
    key,
    title,
    lang,
    canonicalTitle: null,
    sections: [],
    source: null,
    done: false,
    error: null,
    promoted: !isPrefetch,
    controller,
    listeners: new Set()
  };

  const notify = () => {
    for (const fn of entry.listeners) {
      try {
        fn();
      } catch {
        // isolate listener errors
      }
    }
  };

  const emitCanonical = (canon) => {
    if (!entry.canonicalTitle && canon) {
      entry.canonicalTitle = canon;
      notify();
    }
  };

  const emitSection = (secHtml) => {
    if (!secHtml || !secHtml.trim()) return;
    entry.sections.push(secHtml);
    notify();
  };

  const pathTitle = toWikiPathTitle(title);
  const fetchPriority = priority || (isPrefetch ? 'low' : 'high');

  (async () => {
    let lastErr = null;

    // 1. Primary: Vercel CDN streaming proxy (/api/wiki)
    let proxyCleanup = null;
    try {
      const proxyUrl = `/api/wiki?lang=${encodeURIComponent(lang)}&title=${encodeURIComponent(pathTitle)}`;
      const fetched = await fetchStreamWithTtfbTimeout(proxyUrl, {
        ttfbTimeoutMs: isPrefetch ? 4500 : 2800,
        signal: controller.signal,
        priority: fetchPriority
      });
      proxyCleanup = fetched.cleanup;
      const proxyRes = fetched.res;
      const canonHeader = proxyRes.headers.get('X-Wiki-Canonical-Title');
      if (proxyRes.ok && canonHeader) {
        let decodedCanon = title;
        try {
          decodedCanon = decodeURIComponent(canonHeader);
        } catch {
          decodedCanon = title;
        }
        entry.source = 'cdn-proxy';
        await pumpParsoidResponse(proxyRes, title, {
          hasBodyWrapper: proxyRes.headers.get('X-Wiki-Trimmed') !== '1',
          headerCanonical: decodedCanon,
          onCanonical: emitCanonical,
          onSection: emitSection,
          signal: controller.signal
        });
        if (entry.sections.length > 0) {
          finishStreamSuccess();
          return;
        }
      }
    } catch (err) {
      if (isAbortError(err, controller.signal) || entry.sections.length > 0) {
        finishStreamError(err);
        return;
      }
      lastErr = err;
    } finally {
      proxyCleanup?.();
    }

    // 2. Secondary: Direct Wikimedia Parsoid REST HTML streaming (with early References abort)
    let restCleanup = null;
    try {
      const restUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(pathTitle)}`;
      const fetched = await fetchStreamWithTtfbTimeout(restUrl, {
        ttfbTimeoutMs: 7000,
        signal: controller.signal,
        priority: fetchPriority
      });
      restCleanup = fetched.cleanup;
      const restRes = fetched.res;
      if (restRes.ok) {
        entry.source = 'rest-direct';
        await pumpParsoidResponse(restRes, title, {
          hasBodyWrapper: true,
          headerCanonical: null,
          onCanonical: emitCanonical,
          onSection: emitSection,
          signal: controller.signal
        });
        if (entry.sections.length > 0) {
          finishStreamSuccess();
          return;
        }
      } else {
        const err = new Error(`HTTP ${restRes.status}`);
        err.status = restRes.status;
        lastErr = err;
      }
    } catch (err) {
      if (isAbortError(err, controller.signal) || entry.sections.length > 0) {
        finishStreamError(err);
        return;
      }
      lastErr = err;
    } finally {
      restCleanup?.();
    }

    // 3. Fallback: MediaWiki action=parse (handles edge redirects & non-standard titles)
    if (entry.promoted && entry.sections.length === 0) {
      try {
        const parsed = await fetchActionParseFallback(title, lang, {
          timeoutMs: 9000,
          signal: controller.signal,
          priority: fetchPriority
        });
        entry.source = 'parse-fallback';
        emitCanonical(parsed.canonicalTitle);
        emitSection(parsed.html);
        finishStreamSuccess();
        return;
      } catch (err) {
        if (isAbortError(err, controller.signal)) {
          finishStreamError(err);
          return;
        }
        lastErr = err;
      }
    }

    finishStreamError(
      lastErr || new Error('Could not reach Wikipedia. Check your connection and retry.')
    );
  })();

  function finishStreamSuccess() {
    entry.done = true;
    const payload = {
      canonicalTitle: entry.canonicalTitle || title,
      sections: [...entry.sections],
      source: entry.source
    };
    lruSet(rawBufferCache, key, payload, MAX_RAW_BUFFER_CACHE);
    const canonKey = `${lang}:${normTitle(payload.canonicalTitle)}`;
    if (canonKey !== key) {
      lruSet(rawBufferCache, canonKey, payload, MAX_RAW_BUFFER_CACHE);
    }
    if (activeStreams.get(key) === entry) activeStreams.delete(key);
    if (currentPrefetchEntry === entry) currentPrefetchEntry = null;
    notify();
  }

  function finishStreamError(err) {
    entry.error = err;
    entry.done = true;
    if (activeStreams.get(key) === entry) activeStreams.delete(key);
    if (currentPrefetchEntry === entry) currentPrefetchEntry = null;
    notify();
  }

  activeStreams.set(key, entry);
  return entry;
}

/**
 * Cancels any background prefetch currently in flight (unless it matches keepKey,
 * so a clicked link can seamlessly promote its own in-flight prefetch).
 */
export function cancelActivePrefetches(keepKey = null) {
  if (!currentPrefetchEntry) return;
  if (keepKey && currentPrefetchEntry.key === keepKey) {
    currentPrefetchEntry.promoted = true;
    currentPrefetchEntry = null;
    return;
  }
  if (!currentPrefetchEntry.promoted) {
    currentPrefetchEntry.controller.abort(new DOMException('Preempted by navigation', 'AbortError'));
    if (activeStreams.get(currentPrefetchEntry.key) === currentPrefetchEntry) {
      activeStreams.delete(currentPrefetchEntry.key);
    }
  }
  currentPrefetchEntry = null;
}

function shouldSkipLowPriorityPrefetch() {
  const conn = typeof navigator !== 'undefined' ? navigator.connection : null;
  if (!conn) return false;
  if (conn.saveData) return true;
  return conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';
}

/**
 * Strict max-1 intent-driven prefetcher:
 * - Never crawls all links on a page
 * - Aborts any previous unpromoted prefetch before starting a new one
 * - Uses priority: 'low' on hover (or 'high' on pointerdown)
 * - Does ZERO DOM sanitization during prefetch — only buffers compact trimmed sections
 */
export function prefetchWikiArticle(title, lang = 'en', { highIntent = false } = {}) {
  if (!title) return;
  if (!highIntent && shouldSkipLowPriorityPrefetch()) return;

  const key = `${lang}:${normTitle(title)}`;
  if (hasMemCachedArticle(key) || rawBufferCache.has(key)) return;

  const existing = activeStreams.get(key);
  if (existing) {
    if (highIntent) existing.promoted = true;
    return;
  }

  // Enforce max-1 background prefetch by aborting any stale unpromoted prefetch
  cancelActivePrefetches(key);

  const entry = startRawStream(title, lang, {
    isPrefetch: !highIntent,
    priority: highIntent ? 'high' : 'low'
  });
  if (!highIntent) {
    currentPrefetchEntry = entry;
  }
}

// ==================== Non-Mainspace Namespaces ====================
function readStoredNamespaces(lang) {
  try {
    const raw = localStorage.getItem(`tangent:v1:ns:${lang}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.list) || Date.now() - (parsed.savedAt || 0) > NAMESPACE_TTL_MS) {
      return null;
    }
    return new Set(parsed.list);
  } catch {
    return null;
  }
}

function writeStoredNamespaces(lang, set) {
  try {
    localStorage.setItem(
      `tangent:v1:ns:${lang}`,
      JSON.stringify({ list: [...set], savedAt: Date.now() })
    );
  } catch {
    // Ignore storage quota errors
  }
}

async function getNonMainspacePrefixes(lang) {
  if (namespaceCache.has(lang)) return namespaceCache.get(lang);

  const stored = readStoredNamespaces(lang);
  if (stored) {
    namespaceCache.set(lang, stored);
    return stored;
  }

  const base = new Set(BASE_NON_MAINSPACE);
  if (lang === 'en') {
    namespaceCache.set(lang, base);
    return base;
  }

  if (namespacePending.has(lang)) return namespacePending.get(lang);

  const req = (async () => {
    try {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=namespaces|namespacealiases&format=json&formatversion=2&maxage=86400&smaxage=86400&origin=*`;
      const res = await fetchWithDeadline(url, { timeoutMs: 3000 });
      if (res.ok) {
        const data = await res.json();
        const namespaces = data?.query?.namespaces || {};
        for (const ns of Object.values(namespaces)) {
          if (ns && ns.id !== 0) {
            if (ns.name) base.add(normTitle(ns.name));
            if (ns.canonical) base.add(normTitle(ns.canonical));
          }
        }
        const aliases = data?.query?.namespacealiases || [];
        for (const a of aliases) {
          if (a && a.id !== 0 && a.alias) {
            base.add(normTitle(a.alias));
          }
        }
        writeStoredNamespaces(lang, base);
      }
    } catch {
      // Fall back silently to BASE_NON_MAINSPACE
    } finally {
      namespacePending.delete(lang);
    }
    namespaceCache.set(lang, base);
    return base;
  })();

  namespacePending.set(lang, req);
  return req;
}

// ==================== HTML Sanitizer & Section Transformer ====================
const WIKI_SAFE_ELEMENTS = [
  'section', 'article', 'aside', 'div', 'span', 'p', 'br', 'hr', 'wbr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'small', 'big', 'center', 'tt',
  'sub', 'sup', 'mark', 'abbr', 'cite', 'code', 'pre', 'q', 'blockquote', 'time',
  'bdi', 'bdo', 'ruby', 'rt', 'rp', 'dfn', 'var', 'kbd', 'samp',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'figure', 'figcaption', 'img', 'picture', 'source'
];

const WIKI_SAFE_ATTRS = [
  'class', 'id', 'href', 'rel', 'src', 'srcset', 'alt', 'title',
  'width', 'height',
  'colspan', 'rowspan', 'scope', 'headers', 'dir', 'lang',
  'loading', 'decoding', 'typeof'
];

let nativeParseHTMLSupportsMedia = null;

function checkNativeParseHTML() {
  if (nativeParseHTMLSupportsMedia !== null) return nativeParseHTMLSupportsMedia;
  if (typeof Document === 'undefined' || !('parseHTML' in Document)) {
    nativeParseHTMLSupportsMedia = false;
    return false;
  }
  try {
    const probe = Document.parseHTML(
      '<section><table class="infobox"><tbody><tr><td><a rel="mw:WikiLink" href="./Italy">Italy</a><img class="mw-file-element" src="https://upload.wikimedia.org/test.png" alt="t"></td></tr></tbody></table></section>',
      { sanitizer: { elements: WIKI_SAFE_ELEMENTS, attributes: WIKI_SAFE_ATTRS } }
    );
    const sec = probe.body?.querySelector('section');
    const tbl = probe.body?.querySelector('table.infobox');
    const img = probe.body?.querySelector('img[src]');
    const link = probe.body?.querySelector('a[rel="mw:WikiLink"][href]');
    nativeParseHTMLSupportsMedia = Boolean(sec && tbl && img && link);
  } catch {
    nativeParseHTMLSupportsMedia = false;
  }
  return nativeParseHTMLSupportsMedia;
}

async function parseSafeHTML(rawHtml) {
  if (checkNativeParseHTML()) {
    const doc = Document.parseHTML(rawHtml, {
      sanitizer: { elements: WIKI_SAFE_ELEMENTS, attributes: WIKI_SAFE_ATTRS }
    });
    return doc.body;
  }

  const DOMPurify = await loadDOMPurify();
  return DOMPurify.sanitize(rawHtml, {
    RETURN_DOM: true,
    ALLOWED_TAGS: [...WIKI_SAFE_ELEMENTS, '#text'],
    ALLOWED_ATTR: WIKI_SAFE_ATTRS,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false
  });
}

const REMOVE_SELECTORS = [
  'style',
  'script',
  '#toc',
  '.toc',
  '.mw-editsection',
  '.navbox',
  '.navbox-styles',
  '.navbar',
  '.sidebar-navbar',
  '.infobox-navbar',
  '.navbar-mini',
  '.navbar-ct-mini',
  '.nv-view',
  '.nv-talk',
  '.nv-edit',
  '.mw-collapsible-toggle',
  '.reflist',
  '.mw-references-wrap',
  '.mw-references-columns',
  'ol.mw-references',
  'ol.references',
  '[typeof*="mw:Extension/references"]',
  'sup.reference',
  'sup.mw-ref',
  '.hatnote',
  '.metadata',
  '.noprint',
  '.sistersitebox',
  '.printfooter',
  '.catlinks',
  '.ambox',
  '.tmbox',
  '.ombox',
  '.cmbox',
  '.fmbox',
  '.mbox-small',
  '.mw-empty-elt',
  '.mw-jump-link',
  '.shortdescription',
  '.spoken-wikipedia',
  '#coordinates',
  '.portalbox',
  '.side-box',
  '.authority-control',
  'audio',
  '.phonos'
].join(',');

function stripThemeClashingStyles(root) {
  root.querySelectorAll('[bgcolor],[color]').forEach((el) => {
    el.removeAttribute('bgcolor');
    el.removeAttribute('color');
  });

  root.querySelectorAll('[style]').forEach((el) => {
    const raw = el.getAttribute('style') || '';
    const cleaned = raw
      .split(';')
      .map((decl) => decl.trim())
      .filter((decl) => {
        if (!decl) return false;
        const prop = decl.split(':')[0]?.trim().toLowerCase() || '';
        if (
          prop.startsWith('background') ||
          prop === 'color' ||
          prop.startsWith('border') ||
          prop === 'box-shadow' ||
          prop === 'font-family' ||
          prop === 'font-size' ||
          prop === 'line-height' ||
          prop === 'float' ||
          prop === 'clear' ||
          prop === 'width' ||
          prop === 'max-width' ||
          prop === 'min-width' ||
          prop === 'margin' ||
          prop === 'margin-left' ||
          prop === 'margin-right'
        ) {
          return false;
        }
        return true;
      })
      .join('; ');

    if (cleaned) el.setAttribute('style', cleaned);
    else el.removeAttribute('style');
  });
}

function normalizeImages(root, { isBelowFold = false } = {}) {
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('//')) {
      img.setAttribute('src', `https:${src}`);
    }
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      img.setAttribute('srcset', srcset.replace(/(^|,\s*)\/\//g, '$1https://'));
    }

    const w = parseInt(img.getAttribute('width') || '0', 10);
    const h = parseInt(img.getAttribute('height') || '0', 10);
    const isTinyIcon =
      img.classList.contains('mwe-math-fallback-image-inline') ||
      Boolean(img.closest('.flagicon, .noviewer')) ||
      (w > 0 && w <= 36) ||
      (h > 0 && h <= 36);

    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    if (isBelowFold || img.closest('.gallery, .tmulti')) {
      img.setAttribute('fetchpriority', 'low');
    }

    if (isTinyIcon) {
      img.classList.add('wiki-inline-icon');
    }
    // Keep intrinsic width/height attributes on all images so lazy-loaded figures reserve
    // their exact aspect-ratio height before download (prevents layout shifts during TOC jumps).
  });
}

/**
 * Turns Wikipedia multi-image lists (ul.gallery, div.tmulti, and runs of 2+ consecutive <figure>s)
 * into sleek, compact horizontal scrollable strips so image lists never hijack vertical space.
 */
function normalizeImageLists(root) {
  // 1. Galleries (ul.gallery / div.gallery)
  root.querySelectorAll('ul.gallery').forEach((gal) => {
    gal.classList.add('wiki-media-strip');
    gal.setAttribute('tabindex', '0');
  });

  // 2. Multi-image templates (div.thumb.tmulti)
  root.querySelectorAll('.tmulti').forEach((multi) => {
    multi.classList.add('wiki-tmulti-strip');
    const row = multi.querySelector('.trow');
    if (row) row.setAttribute('tabindex', '0');
  });

  // 3. Runs of 2+ consecutive <figure> elements inside the same parent
  const parents = new Set();
  root.querySelectorAll('figure').forEach((fig) => {
    if (fig.parentElement && !fig.closest('.wiki-figure-strip, .gallery, .tmulti, table')) {
      parents.add(fig.parentElement);
    }
  });

  parents.forEach((parent) => {
    const children = [...parent.childNodes];
    let run = [];

    const flushRun = () => {
      if (run.length >= 2) {
        const strip = document.createElement('div');
        strip.className = 'wiki-figure-strip';
        strip.setAttribute('tabindex', '0');
        parent.insertBefore(strip, run[0]);
        for (const fig of run) {
          strip.appendChild(fig);
        }
      }
      run = [];
    };

    for (const node of children) {
      if (node.nodeType === 1 && node.tagName === 'FIGURE') {
        run.push(node);
      } else if (node.nodeType === 3 && !node.textContent.trim()) {
        // Ignore pure whitespace between consecutive figures
        continue;
      } else {
        flushRun();
      }
    }
    flushRun();
  });
}

function cleanEmptyTableRows(box) {
  box.querySelectorAll('tr').forEach((tr) => {
    if (!tr.querySelector('img') && !(tr.textContent || '').trim()) {
      tr.remove();
    }
  });
}

function extractInternalTarget(a, currentCanonicalNorm, nonMainspacePrefixes) {
  const href = a.getAttribute('href') || '';
  if (!href || href.startsWith('#')) return null;

  const rel = a.getAttribute('rel') || '';
  if (
    a.classList.contains('new') ||
    a.classList.contains('extiw') ||
    a.classList.contains('external') ||
    rel.includes('mw:WikiLink/Interwiki') ||
    rel.includes('mw:ExtLink') ||
    href.includes('redlink=1') ||
    href.includes('action=edit')
  ) {
    return null;
  }

  const match = href.match(/^(?:\.\/|\/wiki\/)([^#?]+)/);
  if (!match) return null;

  let decoded = null;
  try {
    decoded = decodeURIComponent(match[1]).replace(/_/g, ' ').trim();
  } catch {
    return null;
  }
  if (!decoded || decoded.startsWith(':')) return null;

  if (normTitle(decoded) === currentCanonicalNorm) return null;

  const colonIdx = decoded.indexOf(':');
  if (colonIdx > 0) {
    const prefix = decoded.slice(0, colonIdx).trim().toLowerCase();
    if (nonMainspacePrefixes.has(prefix)) return null;
  }

  return decoded;
}

function rewriteLinksNeutral(root, { nonMainspacePrefixes, currentCanonicalNorm }) {
  root.querySelectorAll('a').forEach((a) => {
    if (a.querySelector('img')) {
      const span = document.createElement('span');
      span.className = 'wiki-media-wrap';
      span.append(...a.childNodes);
      a.replaceWith(span);
      return;
    }

    const decoded = extractInternalTarget(a, currentCanonicalNorm, nonMainspacePrefixes);

    if (decoded) {
      a.removeAttribute('href');
      a.removeAttribute('title');
      a.removeAttribute('rel');
      a.setAttribute('tabindex', '0');
      a.setAttribute('role', 'link');
      a.dataset.wikiTitle = decoded;
      a.classList.add('wiki-link');
    } else {
      a.replaceWith(...a.childNodes);
    }
  });
}

/**
 * Applies tier-specific link rules (banHubs / lockInfobox) to neutral cached/rendered nodes in <1ms.
 */
function applyGameLinkRules(nodes, { banHubs = false, lockAsInfobox = false, lang = 'en' }) {
  for (const node of nodes) {
    if (!node || node.nodeType !== 1) continue;
    const links = node.matches?.('a[data-wiki-title]')
      ? [node]
      : [...node.querySelectorAll('a[data-wiki-title]')];

    for (const a of links) {
      const target = a.dataset.wikiTitle || '';
      const isBanned = banHubs && lang === 'en' && BANNED_HUBS.has(normTitle(target));
      delete a.dataset.lockedInfobox;
      delete a.dataset.bannedHub;
      a.classList.remove('wiki-link', 'wiki-link-banned');

      if (lockAsInfobox) {
        a.dataset.lockedInfobox = 'true';
        a.classList.add('wiki-link-banned');
      } else if (isBanned) {
        a.dataset.bannedHub = 'true';
        a.classList.add('wiki-link-banned');
      } else {
        a.classList.add('wiki-link');
      }
    }
  }
}

function serializeNodes(nodes) {
  const wrap = document.createElement('div');
  for (const n of nodes) wrap.appendChild(n.cloneNode(true));
  return wrap.innerHTML;
}

function hydrateNodesFromHtml(html) {
  if (!html) return [];
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return [...tpl.content.childNodes];
}

async function transformSectionChunk(sectionHtml, ctx) {
  const container = await parseSafeHTML(sectionHtml);

  // Strip navboxes, template navbars (v·t·e), edit links, references, hatnotes, etc.
  container.querySelectorAll(REMOVE_SELECTORS).forEach((node) => node.remove());

  // Remove any boilerplate trailing sections (handles action=parse single-chunk fallback)
  container.querySelectorAll('h2, .mw-heading2').forEach((heading) => {
    if (!heading.isConnected) return;
    const txt = (heading.textContent || '').trim().toLowerCase();
    if (txt === 'contents') {
      const next = heading.nextElementSibling;
      if (next && (next.tagName === 'UL' || next.tagName === 'OL')) next.remove();
      heading.remove();
      return;
    }
    if (STREAM_ABORT_HEADING_RE.test(txt)) {
      const parentSection = heading.parentElement?.tagName === 'SECTION' ? heading.parentElement : null;
      if (parentSection) {
        parentSection.remove();
        return;
      }
      let cur = heading;
      while (cur) {
        const next = cur.nextElementSibling;
        if (cur !== heading && (cur.tagName === 'H2' || cur.classList?.contains('mw-heading2'))) break;
        cur.remove();
        cur = next;
      }
    }
  });

  stripThemeClashingStyles(container);
  normalizeImages(container, { isBelowFold: ctx.sectionIndex > 0 });

  // Extract Infobox(es) and vertical Series Sidebars into the Right Collapsible Rail
  const asideNodes = [];
  container
    .querySelectorAll('table.infobox, table.sidebar, .sidebar, .nomobile.sidebar, .vertical-navbox')
    .forEach((box) => {
      if (box.parentElement?.closest('table.infobox, table.sidebar, .sidebar, .vertical-navbox')) {
        return;
      }
      box.remove();
      cleanEmptyTableRows(box);
      rewriteLinksNeutral(box, {
        nonMainspacePrefixes: ctx.nonMainspacePrefixes,
        currentCanonicalNorm: ctx.currentCanonicalNorm
      });
      asideNodes.push(box);
    });

  // Compact multi-image lists & consecutive figures
  normalizeImageLists(container);

  // Rewrite prose links neutrally (before caching)
  rewriteLinksNeutral(container, {
    nonMainspacePrefixes: ctx.nonMainspacePrefixes,
    currentCanonicalNorm: ctx.currentCanonicalNorm
  });

  // Extract structured Table of Contents headings
  const newSections = [];
  container.querySelectorAll('h2, h3').forEach((h) => {
    const text = (h.textContent || '').trim();
    if (!text) return;
    const isH2 = h.tagName === 'H2';
    if (isH2) {
      ctx.tocCounter.h2 += 1;
      ctx.tocCounter.h3 = 0;
    } else {
      ctx.tocCounter.h3 += 1;
    }
    const number = isH2 ? `${ctx.tocCounter.h2}` : `${ctx.tocCounter.h2}.${ctx.tocCounter.h3}`;
    const secId = `wiki-sec-${ctx.tocCounter.idx++}`;
    const targetEl = h.closest('.mw-heading2, .mw-heading3') || h;
    targetEl.id = secId;
    newSections.push({
      id: secId,
      title: text,
      level: isH2 ? 2 : 3,
      number
    });
  });

  // Wrap wide tables in a clean scroll wrapper
  container.querySelectorAll('table.wikitable').forEach((table) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'wiki-table-scroll';
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });

  const bodyNodes = [...container.childNodes];

  // Mark strictly below-the-fold sections (Section 1+) for content-visibility: auto
  if (ctx.sectionIndex > 0) {
    for (const node of bodyNodes) {
      if (node.nodeType === 1 && node.tagName === 'SECTION') {
        node.classList.add('wiki-section-deferred');
      }
    }
  }

  // Capture neutral HTML for two-tier cache BEFORE applying tier-specific banned/locked classes
  const asideHtml = asideNodes.length ? serializeNodes(asideNodes) : '';
  const bodyHtml = bodyNodes.length ? serializeNodes(bodyNodes) : '';

  // Apply tier-specific rules to the live DOM nodes
  applyGameLinkRules(asideNodes, {
    banHubs: ctx.banHubs,
    lockAsInfobox: ctx.lockInfobox,
    lang: ctx.lang
  });
  applyGameLinkRules(bodyNodes, {
    banHubs: ctx.banHubs,
    lockAsInfobox: false,
    lang: ctx.lang
  });

  return { asideNodes, bodyNodes, asideHtml, bodyHtml, newSections };
}

/**
 * Streams and transforms a Wikipedia article for Tangent's 3-column collapsible reader:
 * - Instant hit from L1 RAM / L2 IndexedDB cache (<15ms)
 * - Otherwise streams section-by-section, invoking:
 *     onCanonical(canonicalTitle) — at TTFB (enables instant win detection!)
 *     onLead({ title, asideNodes, bodyNodes, sections }) — as soon as Section 0 arrives
 *     onSection({ asideNodes, bodyNodes, sections }) — incrementally for each trailing section
 * - Yields to the main thread between sections using scheduler.yield() (setTimeout fallback)
 */
export async function fetchWikiArticle(
  title,
  lang = 'en',
  {
    banHubs = false,
    lockInfobox = false,
    signal = null,
    onCanonical = null,
    onLead = null,
    onSection = null
  } = {}
) {
  const key = `${lang}:${normTitle(title)}`;

  // Cancel any unrelated background prefetch so 100% of bandwidth goes to this real click
  cancelActivePrefetches(key);

  // 1. Check L1 RAM / L2 IndexedDB processed cache first
  const cached = getMemCachedArticle(key) || (await getCachedArticle(key));
  if (signal?.aborted) {
    throw signal.reason || new DOMException('Aborted', 'AbortError');
  }

  if (cached) {
    if (onCanonical) onCanonical(cached.title);
    if (signal?.aborted) {
      throw signal.reason || new DOMException('Aborted', 'AbortError');
    }
    const asideNodes = hydrateNodesFromHtml(cached.asideHtml);
    const bodyNodes = hydrateNodesFromHtml(cached.bodyHtml);
    applyGameLinkRules(asideNodes, { banHubs, lockAsInfobox: lockInfobox, lang });
    applyGameLinkRules(bodyNodes, { banHubs, lockAsInfobox: false, lang });

    const result = {
      title: cached.title,
      sections: cached.sections || [],
      asideNodes,
      bodyNodes,
      fromCache: true
    };
    if (onLead) onLead(result);
    return result;
  }

  // 2. Check if we already buffered raw trimmed sections from a hover/pointerdown prefetch
  const rawHit = rawBufferCache.get(key);
  const nonMainspacePrefixes = await getNonMainspacePrefixes(lang);
  if (signal?.aborted) {
    throw signal.reason || new DOMException('Aborted', 'AbortError');
  }

  if (rawHit && rawHit.sections.length > 0) {
    const canonicalTitle = rawHit.canonicalTitle || title;
    if (onCanonical) onCanonical(canonicalTitle);

    const ctx = {
      sectionIndex: 0,
      canonicalTitle,
      currentCanonicalNorm: normTitle(canonicalTitle),
      nonMainspacePrefixes,
      lang,
      banHubs,
      lockInfobox,
      tocCounter: { h2: 0, h3: 0, idx: 0 }
    };

    const allSections = [];
    const allAsideNodes = [];
    const allBodyNodes = [];
    const asideHtmlParts = [];
    const bodyHtmlParts = [];
    let deadline = performance.now() + 50;

    for (let i = 0; i < rawHit.sections.length; i++) {
      if (signal?.aborted) {
        throw signal.reason || new DOMException('Aborted', 'AbortError');
      }
      ctx.sectionIndex = i;
      const chunk = await transformSectionChunk(rawHit.sections[i], ctx);
      allSections.push(...chunk.newSections);
      allAsideNodes.push(...chunk.asideNodes);
      allBodyNodes.push(...chunk.bodyNodes);
      if (chunk.asideHtml) asideHtmlParts.push(chunk.asideHtml);
      if (chunk.bodyHtml) bodyHtmlParts.push(chunk.bodyHtml);

      if (i === 0) {
        onLead?.({
          title: canonicalTitle,
          asideNodes: chunk.asideNodes,
          bodyNodes: chunk.bodyNodes,
          sections: chunk.newSections
        });
      } else {
        onSection?.({
          asideNodes: chunk.asideNodes,
          bodyNodes: chunk.bodyNodes,
          sections: chunk.newSections
        });
      }

      if (performance.now() >= deadline && i < rawHit.sections.length - 1) {
        await yieldToMain();
        deadline = performance.now() + 50;
      }
    }

    const canonKey = `${lang}:${normTitle(canonicalTitle)}`;
    setCachedArticle(key, canonKey, {
      title: canonicalTitle,
      sections: allSections,
      asideHtml: asideHtmlParts.join(''),
      bodyHtml: bodyHtmlParts.join('')
    });

    return {
      title: canonicalTitle,
      sections: allSections,
      asideNodes: allAsideNodes,
      bodyNodes: allBodyNodes,
      fromCache: false
    };
  }

  // 3. Attach to an in-flight stream (from hover/pointerdown) or start a high-priority stream
  const stream = startRawStream(title, lang, { isPrefetch: false, priority: 'high' });

  const onUserAbort = () => {
    if (stream.listeners.size <= 1) {
      stream.controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
      if (activeStreams.get(key) === stream) activeStreams.delete(key);
    }
  };
  signal?.addEventListener('abort', onUserAbort, { once: true });

  const waitForNextUpdate = () =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onNotify = () => {
        cleanup();
        resolve();
      };
      const onSigAbort = () => {
        cleanup();
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      const cleanup = () => {
        stream.listeners.delete(onNotify);
        signal?.removeEventListener('abort', onSigAbort);
      };
      stream.listeners.add(onNotify);
      signal?.addEventListener('abort', onSigAbort, { once: true });
    });

  let processedCount = 0;
  let canonicalAnnounced = false;
  let canonicalTitle = title;
  const allSections = [];
  const allAsideNodes = [];
  const allBodyNodes = [];
  const asideHtmlParts = [];
  const bodyHtmlParts = [];
  const tocCounter = { h2: 0, h3: 0, idx: 0 };

  try {
    let deadline = performance.now() + 50;

    while (true) {
      if (signal?.aborted) {
        throw signal.reason || new DOMException('Aborted', 'AbortError');
      }

      if (!canonicalAnnounced && stream.canonicalTitle) {
        canonicalAnnounced = true;
        canonicalTitle = stream.canonicalTitle;
        onCanonical?.(canonicalTitle);
        if (signal?.aborted) {
          throw signal.reason || new DOMException('Aborted', 'AbortError');
        }
      }

      if (processedCount < stream.sections.length) {
        const rawSec = stream.sections[processedCount];
        const secIndex = processedCount;
        processedCount += 1;

        if (!canonicalAnnounced) {
          canonicalAnnounced = true;
          canonicalTitle = stream.canonicalTitle || title;
          onCanonical?.(canonicalTitle);
          if (signal?.aborted) {
            throw signal.reason || new DOMException('Aborted', 'AbortError');
          }
        }

        const chunk = await transformSectionChunk(rawSec, {
          sectionIndex: secIndex,
          canonicalTitle,
          currentCanonicalNorm: normTitle(canonicalTitle),
          nonMainspacePrefixes,
          lang,
          banHubs,
          lockInfobox,
          tocCounter
        });

        if (signal?.aborted) {
          throw signal.reason || new DOMException('Aborted', 'AbortError');
        }

        allSections.push(...chunk.newSections);
        allAsideNodes.push(...chunk.asideNodes);
        allBodyNodes.push(...chunk.bodyNodes);
        if (chunk.asideHtml) asideHtmlParts.push(chunk.asideHtml);
        if (chunk.bodyHtml) bodyHtmlParts.push(chunk.bodyHtml);

        if (secIndex === 0) {
          onLead?.({
            title: canonicalTitle,
            asideNodes: chunk.asideNodes,
            bodyNodes: chunk.bodyNodes,
            sections: chunk.newSections
          });
        } else {
          onSection?.({
            asideNodes: chunk.asideNodes,
            bodyNodes: chunk.bodyNodes,
            sections: chunk.newSections
          });
        }

        if (performance.now() >= deadline) {
          await yieldToMain();
          deadline = performance.now() + 50;
        }
        continue;
      }

      if (stream.done) {
        if (stream.error && processedCount === 0) {
          throw stream.error;
        }
        break;
      }

      await waitForNextUpdate();
      deadline = performance.now() + 50;
    }

    if (processedCount === 0) {
      throw stream.error || new Error('Empty Wikipedia response');
    }

    if (!stream.error) {
      const canonKey = `${lang}:${normTitle(canonicalTitle)}`;
      setCachedArticle(key, canonKey, {
        title: canonicalTitle,
        sections: allSections,
        asideHtml: asideHtmlParts.join(''),
        bodyHtml: bodyHtmlParts.join('')
      });
    }

    return {
      title: canonicalTitle,
      sections: allSections,
      asideNodes: allAsideNodes,
      bodyNodes: allBodyNodes,
      fromCache: false
    };
  } finally {
    signal?.removeEventListener('abort', onUserAbort);
  }
}

export async function fetchWikiSummary(title, lang = 'en') {
  const key = `${lang}:${normTitle(title)}`;
  if (summaryCache.has(key)) return summaryCache.get(key);
  if (summaryPending.has(key)) return summaryPending.get(key);

  const req = (async () => {
    try {
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        toWikiPathTitle(title)
      )}`;
      const res = await fetchWithDeadline(url, { timeoutMs: 5000, priority: 'low' });
      if (!res.ok) return null;
      const data = await res.json();
      const summary = {
        title: data.title || title,
        description: data.description || '',
        extract: data.extract || '',
        thumbnail: data.thumbnail?.source || null
      };
      lruSet(summaryCache, key, summary, MAX_SUMMARY_CACHE);
      return summary;
    } catch {
      return null;
    } finally {
      summaryPending.delete(key);
    }
  })();

  summaryPending.set(key, req);
  return req;
}

export function getCachedWikiSummary(title, lang = 'en') {
  return summaryCache.get(`${lang}:${normTitle(title)}`) || null;
}

export async function searchWikiTitles(query, lang = 'en', limit = 7) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
      q
    )}&limit=${limit}&namespace=0&redirects=resolve&format=json&origin=*`;
    const res = await fetchWithDeadline(url, { timeoutMs: 5000 });
    if (!res.ok) return [];
    const data = await res.json();
    const titles = Array.isArray(data?.[1]) ? data[1] : [];
    const descs = Array.isArray(data?.[2]) ? data[2] : [];
    return titles.map((t, i) => ({ title: t, description: descs[i] || '' }));
  } catch {
    return [];
  }
}

export async function fetchBacklinkHint(target, lang = 'en') {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=backlinks&bltitle=${encodeURIComponent(
      target
    )}&bllimit=45&blnamespace=0&blfilterredir=nonredirects&format=json&origin=*`;
    const res = await fetchWithDeadline(url, { timeoutMs: 6000 });
    if (!res.ok) return [];
    const data = await res.json();
    const list = (data?.query?.backlinks || []).map((b) => b.title);
    return list.sort(() => Math.random() - 0.5).slice(0, 6);
  } catch {
    return [];
  }
}
