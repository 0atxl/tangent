/**
 * Wikipedia API client:
 * - Fast CDN-cached Parsoid REST HTML primary with cached MediaWiki action=parse fallback
 * - AbortSignal.timeout() + AbortSignal.any() cancellation, automatic retry, and in-memory LRU caching
 * - Polite hover prefetching with in-flight request deduplication
 * - Native HTML sanitizer (Document.parseHTML with lazy DOMPurify fallback)
 * - Multi-language mainspace link rewriter using cached siteinfo namespaces
 * - Section TOC & Infobox/Sidebar extraction for Tangent's 3-column collapsible reader
 */
import { BANNED_HUBS } from '../data/packs.js';

const MAX_ARTICLE_CACHE = 45;
const MAX_SUMMARY_CACHE = 200;
const NAMESPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const rawArticleCache = new Map(); // `${lang}:${normTitle}` -> { canonicalTitle, html, source }
const rawArticlePending = new Map(); // `${lang}:${normTitle}` -> { promise, refs, controller }
const summaryCache = new Map();
const summaryPending = new Map();
const namespaceCache = new Map(); // lang -> Set<string>
const namespacePending = new Map();

let domPurifyPromise = null;
let activePrefetches = 0;

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

function loadDOMPurify() {
  domPurifyPromise ??= import('dompurify').then((m) => m.default ?? m);
  return domPurifyPromise;
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

function waitWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithDeadline(url, { timeoutMs = 7000, signal = null, headers = undefined } = {}) {
  const { signal: combined, cleanup } = createDeadlineSignal(timeoutMs, signal);
  try {
    return await fetch(url, headers ? { signal: combined, headers } : { signal: combined });
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

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function extractParsoidPayload(fullHtml, fallbackTitle, finalUrl) {
  let canonicalTitle = null;

  // 1. Canonical title from Parsoid dc:isVersionOf link (exact UTF-8 Wikipedia title)
  const verMatch =
    fullHtml.match(/<link[^>]*\brel=["']dc:isVersionOf["'][^>]*\bhref=["'][^"']*\/wiki\/([^"'#?]+)["']/i) ||
    fullHtml.match(/<link[^>]*\bhref=["'][^"']*\/wiki\/([^"'#?]+)["'][^>]*\brel=["']dc:isVersionOf["']/i);
  if (verMatch?.[1]) {
    try {
      canonicalTitle = decodeURIComponent(verMatch[1]).replace(/_/g, ' ');
    } catch {
      canonicalTitle = null;
    }
  }

  // 2. Fallback to <title>
  if (!canonicalTitle) {
    const titleMatch = fullHtml.match(/<title>([\s\S]*?)<\/title>/i);
    if (titleMatch?.[1]) {
      canonicalTitle = decodeHtmlEntities(titleMatch[1]).replace(/<[^>]+>/g, '').trim();
    }
  }

  // 3. Fallback to redirected final URL path
  if (!canonicalTitle && finalUrl) {
    const urlMatch =
      finalUrl.match(/\/page\/html\/([^?#]+)/) || finalUrl.match(/\/page\/([^/?#]+)\/html/);
    if (urlMatch?.[1]) {
      try {
        canonicalTitle = decodeURIComponent(urlMatch[1]).replace(/_/g, ' ');
      } catch {
        canonicalTitle = null;
      }
    }
  }

  const bodyMatch = fullHtml.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return {
    canonicalTitle: canonicalTitle || fallbackTitle,
    html: bodyMatch ? bodyMatch[1] : fullHtml,
    source: 'rest'
  };
}

function toWikiPathTitle(title) {
  const trimmed = String(title || '').trim().replace(/ /g, '_');
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

async function fetchFromRestHtml(title, lang, { timeoutMs, signal }) {
  const pathTitle = toWikiPathTitle(title);
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(pathTitle)}`;
  const res = await fetchWithDeadline(url, { timeoutMs, signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const fullHtml = await res.text();
  if (!fullHtml || fullHtml.length < 40) {
    throw new Error('Empty Wikipedia response');
  }
  return extractParsoidPayload(fullHtml, title, res.url);
}

async function fetchFromActionParse(title, lang, { timeoutMs, signal }) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(
    title
  )}&prop=text&redirects=1&disableeditsection=1&disablelimitreport=1&disabletoc=1&format=json&formatversion=2&maxage=3600&smaxage=3600&origin=*`;
  const res = await fetchWithDeadline(url, { timeoutMs, signal });
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
    html: data.parse.text || '',
    source: 'parse'
  };
}

async function fetchRawArticleNetwork(title, lang, signal) {
  if (signal?.aborted) {
    throw signal.reason || new DOMException('Aborted', 'AbortError');
  }

  const restCtrl = new AbortController();
  const parseCtrl = new AbortController();
  const onParentAbort = () => {
    const reason = signal.reason || new DOMException('Aborted', 'AbortError');
    restCtrl.abort(reason);
    parseCtrl.abort(reason);
  };
  signal?.addEventListener('abort', onParentAbort, { once: true });

  let hedgeTimer = null;
  let settled = false;
  let parseStarted = false;
  let firstErr = null;

  try {
    return await new Promise((resolve, reject) => {
      const clearHedge = () => {
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = null;
        }
      };

      const win = (payload, loserCtrl) => {
        if (settled) return;
        settled = true;
        clearHedge();
        loserCtrl.abort(new DOMException('Superseded by faster endpoint', 'AbortError'));
        resolve(payload);
      };

      let remaining = 2;
      const onAttemptFailed = (err, source) => {
        if (settled) return;
        if (isAbortError(err, signal)) {
          settled = true;
          clearHedge();
          reject(err);
          return;
        }
        firstErr = firstErr || err;
        remaining -= 1;
        if (source === 'rest' && !parseStarted) {
          startParse();
          return;
        }
        if (remaining <= 0) {
          settled = true;
          clearHedge();
          reject(err);
        }
      };

      const startParse = () => {
        if (settled || parseStarted) return;
        parseStarted = true;
        clearHedge();
        fetchFromActionParse(title, lang, { timeoutMs: 8500, signal: parseCtrl.signal }).then(
          (payload) => win(payload, restCtrl),
          (err) => onAttemptFailed(err, 'parse')
        );
      };

      // Primary: fast CDN-cached Parsoid REST HTML
      fetchFromRestHtml(title, lang, { timeoutMs: 8000, signal: restCtrl.signal }).then(
        (payload) => win(payload, parseCtrl),
        (err) => onAttemptFailed(err, 'rest')
      );

      // Hedged fallback: if REST takes >2.5s (e.g. uncached redirect or stalled connection),
      // race cached action=parse in parallel; first valid response wins and aborts the other.
      hedgeTimer = setTimeout(startParse, 2500);
    });
  } catch (err) {
    if (isAbortError(err, signal) || err?.notFound) throw err;
    await waitWithSignal(350, signal);
    try {
      return await fetchFromActionParse(title, lang, { timeoutMs: 9000, signal });
    } catch (retryErr) {
      if (isAbortError(retryErr, signal)) throw retryErr;
      throw new Error(
        retryErr?.message || firstErr?.message || 'Could not reach Wikipedia. Check your connection and retry.',
        { cause: retryErr }
      );
    }
  } finally {
    if (hedgeTimer) clearTimeout(hedgeTimer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

function getRawArticleCached(title, lang, userSignal) {
  const key = `${lang}:${normTitle(title)}`;
  if (rawArticleCache.has(key)) {
    const hit = rawArticleCache.get(key);
    lruSet(rawArticleCache, key, hit, MAX_ARTICLE_CACHE);
    return Promise.resolve(hit);
  }

  let entry = rawArticlePending.get(key);
  if (!entry) {
    const controller = new AbortController();
    const promise = fetchRawArticleNetwork(title, lang, controller.signal)
      .then((payload) => {
        lruSet(rawArticleCache, key, payload, MAX_ARTICLE_CACHE);
        const canonKey = `${lang}:${normTitle(payload.canonicalTitle)}`;
        if (canonKey !== key) {
          lruSet(rawArticleCache, canonKey, payload, MAX_ARTICLE_CACHE);
        }
        return payload;
      })
      .finally(() => {
        if (rawArticlePending.get(key)?.controller === controller) {
          rawArticlePending.delete(key);
        }
      });

    entry = { promise, refs: 0, controller };
    rawArticlePending.set(key, entry);
  }

  entry.refs += 1;

  if (!userSignal) {
    return entry.promise.finally(() => {
      entry.refs = Math.max(0, entry.refs - 1);
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const detach = () => {
      userSignal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      detach();
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0) {
        entry.controller.abort(userSignal.reason || new DOMException('Aborted', 'AbortError'));
        if (rawArticlePending.get(key) === entry) {
          rawArticlePending.delete(key);
        }
      }
      reject(userSignal.reason || new DOMException('Aborted', 'AbortError'));
    };

    if (userSignal.aborted) {
      onAbort();
      return;
    }

    userSignal.addEventListener('abort', onAbort, { once: true });

    entry.promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        detach();
        entry.refs = Math.max(0, entry.refs - 1);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        detach();
        entry.refs = Math.max(0, entry.refs - 1);
        reject(err);
      }
    );
  });
}

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
      // Fall back silently to BASE_NON_MAINSPACE; never block article loads
    } finally {
      namespacePending.delete(lang);
    }
    namespaceCache.set(lang, base);
    return base;
  })();

  namespacePending.set(lang, req);
  return req;
}

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
  const cleanDoc = DOMPurify.sanitize(rawHtml, {
    RETURN_DOM: true,
    ALLOWED_TAGS: [...WIKI_SAFE_ELEMENTS, '#text'],
    ALLOWED_ATTR: WIKI_SAFE_ATTRS,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false
  });
  return cleanDoc;
}

const REMOVE_SELECTORS = [
  'style',
  'script',
  '#toc',
  '.toc',
  '.mw-editsection',
  '.navbox',
  '.navbox-styles',
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

function normalizeImages(root) {
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('//')) {
      img.setAttribute('src', `https:${src}`);
    }
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      img.setAttribute('srcset', srcset.replace(/(^|,\s*)\/\//g, '$1https://'));
    }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.removeAttribute('width');
    img.removeAttribute('height');
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

  // Support both Parsoid relative "./Title" and action=parse "/wiki/Title"
  const match = href.match(/^(?:\.\/|\/wiki\/)([^#?]+)/);
  if (!match) return null;

  let decoded = null;
  try {
    decoded = decodeURIComponent(match[1]).replace(/_/g, ' ').trim();
  } catch {
    return null;
  }
  if (!decoded || decoded.startsWith(':')) return null;

  // Reject self-anchor references (e.g. ./Pizza#cite_note-1)
  if (normTitle(decoded) === currentCanonicalNorm) return null;

  // Reject non-mainspace namespaces (Category:, File:, Help:, Wikipedia:, localized namespaces, etc.)
  const colonIdx = decoded.indexOf(':');
  if (colonIdx > 0) {
    const prefix = decoded.slice(0, colonIdx).trim().toLowerCase();
    if (nonMainspacePrefixes.has(prefix)) return null;
  }

  return decoded;
}

function rewriteLinks(root, { nonMainspacePrefixes, currentCanonicalNorm, banHubs, lang, lockAsInfobox = false }) {
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
      const isBanned = banHubs && lang === 'en' && BANNED_HUBS.has(normTitle(decoded));
      a.removeAttribute('href');
      a.removeAttribute('title');
      a.removeAttribute('rel');
      a.setAttribute('tabindex', '0');
      a.setAttribute('role', 'link');
      a.dataset.wikiTitle = decoded;

      if (lockAsInfobox) {
        a.dataset.lockedInfobox = 'true';
        a.classList.add('wiki-link-banned');
      } else if (isBanned) {
        a.dataset.bannedHub = 'true';
        a.classList.add('wiki-link-banned');
      } else {
        a.classList.add('wiki-link');
      }
    } else {
      a.replaceWith(...a.childNodes);
    }
  });
}

/**
 * Politely warms the raw article cache for a hovered or upcoming Wikipedia link.
 * Shares in-flight fetches seamlessly if the user clicks while prefetch is running.
 */
export function prefetchWikiArticle(title, lang = 'en') {
  if (!title) return;
  const key = `${lang}:${normTitle(title)}`;
  if (rawArticleCache.has(key) || rawArticlePending.has(key)) return;
  if (activePrefetches >= 2) return;

  activePrefetches += 1;
  getRawArticleCached(title, lang, null)
    .catch(() => {})
    .finally(() => {
      activePrefetches = Math.max(0, activePrefetches - 1);
    });
}

/**
 * Fetches and transforms a Wikipedia article for Tangent's 3-column collapsible reader:
 * - Left Rail: `sections` (Table of Contents extracted from H2/H3)
 * - Center Column: `bodyNodes` (clean uninterrupted article prose + inline figures)
 * - Right Rail: `asideNodes` (extracted Infobox & Series sidebar cards!)
 */
export async function fetchWikiArticle(
  title,
  lang = 'en',
  { banHubs = false, lockInfobox = false, signal = null } = {}
) {
  const [payload, nonMainspacePrefixes] = await Promise.all([
    getRawArticleCached(title, lang, signal),
    getNonMainspacePrefixes(lang)
  ]);

  if (signal?.aborted) {
    throw signal.reason || new DOMException('Aborted', 'AbortError');
  }

  const canonicalTitle = payload.canonicalTitle;
  const currentCanonicalNorm = normTitle(canonicalTitle);
  const container = await parseSafeHTML(payload.html);

  if (signal?.aborted) {
    throw signal.reason || new DOMException('Aborted', 'AbortError');
  }

  // Remove inline TOC, edit links, navboxes, references, hatnotes, etc.
  container.querySelectorAll(REMOVE_SELECTORS).forEach((node) => node.remove());

  // Remove boilerplate trailing sections (works for both Parsoid <section> and action=parse siblings)
  container.querySelectorAll('h2, .mw-heading2').forEach((heading) => {
    if (!heading.isConnected) return;
    const txt = (heading.textContent || '').trim().toLowerCase();
    if (txt === 'contents') {
      const next = heading.nextElementSibling;
      if (next && (next.tagName === 'UL' || next.tagName === 'OL')) next.remove();
      heading.remove();
      return;
    }
    if (/^(references|external links|further reading|notes|bibliography|sources|see also)$/.test(txt)) {
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
  normalizeImages(container);

  // Extract Infobox(es) and vertical Series Sidebars into the Right Collapsible Rail
  const asideNodes = [];
  container
    .querySelectorAll('table.infobox, table.sidebar, .sidebar, .nomobile.sidebar, .vertical-navbox')
    .forEach((box) => {
      if (box.parentElement?.closest('table.infobox, table.sidebar, .sidebar, .vertical-navbox')) {
        return;
      }
      box.remove();
      rewriteLinks(box, {
        nonMainspacePrefixes,
        currentCanonicalNorm,
        banHubs,
        lang,
        lockAsInfobox: lockInfobox
      });
      asideNodes.push(box);
    });

  // Rewrite links in main prose body
  rewriteLinks(container, {
    nonMainspacePrefixes,
    currentCanonicalNorm,
    banHubs,
    lang,
    lockAsInfobox: false
  });

  // Extract structured Table of Contents from remaining H2 & H3 headings
  const sections = [];
  let h2Count = 0;
  let h3Count = 0;

  container.querySelectorAll('h2, h3').forEach((h, idx) => {
    const text = (h.textContent || '').trim();
    if (!text) return;
    const isH2 = h.tagName === 'H2';
    if (isH2) {
      h2Count++;
      h3Count = 0;
    } else {
      h3Count++;
    }
    const number = isH2 ? `${h2Count}` : `${h2Count}.${h3Count}`;
    const secId = `wiki-sec-${idx}`;
    const targetEl = h.closest('.mw-heading2, .mw-heading3') || h;
    targetEl.id = secId;
    sections.push({
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

  return {
    title: canonicalTitle,
    sections,
    asideNodes,
    bodyNodes: [...container.childNodes]
  };
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
      const res = await fetchWithDeadline(url, { timeoutMs: 5000 });
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
