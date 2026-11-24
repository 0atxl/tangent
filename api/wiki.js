/**
 * Vercel CDN-cached streaming Wikipedia Parsoid HTML proxy.
 * - Streams Parsoid HTML from Wikimedia via ReadableStream
 * - Strips <style>/<script> blocks and cancels the upstream download early
 *   the instant boilerplate trailing sections (References, External links, etc.) begin
 * - Caches the trimmed HTML globally at Vercel's Edge CDN for 24h (7d SWR),
 *   cutting repeat TTFB from ~600ms to ~50-120ms without consuming Upstash Redis quota.
 */

const UA = 'TangentWikiGame/1.0 (https://playtangent.vercel.app; article-proxy)';

// Trailing appendix headings guaranteed to come at the end of Wikipedia articles (MOS:LAYOUT).
// Note: "Sources" and "Notes" are intentionally excluded from stream-abort because historical
// articles (e.g. Genghis Khan) can have real prose sections titled "Sources" near the top.
const STREAM_ABORT_HEADING_RE =
  /^(references|external links|further reading|bibliography|see also|citations|footnotes|referencias|enlaces externos|véase también|notes et références|liens externes|voir aussi|einzelnachweise|weblinks|siehe auch|collegamenti esterni|voci correlate|referências|ligações externas|ver também|примечания|ссылки|см\.\s*также|脚注|外部リンク|関連項目|参考文献|参考资料|外部链接|参见|각주|외부 링크|같이 보기|सन्दर्भ|बाहरी कड़ियाँ|इन्हें भी देखें|مراجع|وصلات خارجية|انظر أيضاً|kaynakça|dış bağlantılar|ayrıca bakınız|przypisy|linki zewnętrzne|zobacz też|externe links|zie ook)$/i;

const SKIP_IF_REF_HEADING_RE = /^(notes|note|noten|sources|explanatory notes)$/i;

function toWikiPathTitle(title) {
  const trimmed = String(title || '').trim().replace(/ /g, '_');
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function decodeBasicEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function extractCanonicalTitle(headHtml, fallbackTitle, finalUrl) {
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
    const clean = decodeBasicEntities(titleMatch[1]).replace(/<[^>]+>/g, '').trim();
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

function classifySection(sectionHtml, sectionIndex) {
  if (sectionIndex === 0) return 'keep';
  const h2Match = sectionHtml.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (!h2Match) return 'keep';
  const headingText = decodeBasicEntities(h2Match[1].replace(/<[^>]+>/g, '')).trim();
  if (STREAM_ABORT_HEADING_RE.test(headingText)) return 'abort';
  if (
    SKIP_IF_REF_HEADING_RE.test(headingText) &&
    /(?:class="[^"]*(?:reflist|mw-references)|typeof="[^"]*mw:Extension\/references)/i.test(sectionHtml)
  ) {
    return 'skip';
  }
  return 'keep';
}

function trimSectionMarkup(sectionHtml) {
  return sectionHtml
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');
}

const SECTION_TAG_RE = /<(\/?)section\b[^>]*>/gi;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawLang = String(req.query?.lang || 'en').trim().toLowerCase();
  const rawTitle = String(req.query?.title || '').trim();

  if (!/^[a-z-]{2,12}$/i.test(rawLang)) {
    return res.status(400).json({ error: 'Invalid language code' });
  }
  if (!rawTitle || rawTitle.length > 260) {
    return res.status(400).json({ error: 'Missing or invalid title' });
  }

  const pathTitle = toWikiPathTitle(rawTitle);
  const upstreamUrl = `https://${rawLang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(pathTitle)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Api-User-Agent': UA,
        Accept: 'text/html; charset=utf-8'
      }
    });

    if (!upstream.ok) {
      clearTimeout(timer);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(upstream.status).json({ error: `Wikipedia returned ${upstream.status}` });
    }

    const reader = upstream.body?.getReader?.();
    if (!reader) {
      const fullHtml = await upstream.text();
      clearTimeout(timer);
      const canonical = extractCanonicalTitle(fullHtml.slice(0, 8192), rawTitle, upstream.url);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Wiki-Canonical-Title', encodeURIComponent(canonical));
      res.setHeader('X-Wiki-Trimmed', '0');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('CDN-Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).end(fullHtml);
    }

    const decoder = new TextDecoder('utf-8');
    let headersSent = false;
    let headBuf = '';
    let scanBuf = '';
    let depth = 0;
    let currentSection = '';
    let fallbackRawBuf = '';
    let sectionIndex = 0;
    let stoppedEarly = false;
    let inBody = false;

    const sendHeadersOnce = (canonical) => {
      if (headersSent) return;
      headersSent = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Wiki-Canonical-Title', encodeURIComponent(canonical));
      res.setHeader('X-Wiki-Trimmed', '1');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('CDN-Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
    };

    const writeChunk = (chunk) => {
      if (typeof res.write === 'function') res.write(chunk);
    };

    const processScanBuffer = (isFinal = false) => {
      // Keep any potentially incomplete trailing tag (<section... or </section...) for next chunk
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
            const action = classifySection(currentSection, sectionIndex);
            if (action === 'abort') {
              stoppedEarly = true;
              currentSection = '';
              scanBuf = '';
              return;
            }
            if (action === 'keep') {
              writeChunk(trimSectionMarkup(currentSection));
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

    while (!stoppedEarly) {
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
            const canonical = extractCanonicalTitle(headBuf.slice(0, bodyIdx), rawTitle, upstream.url);
            sendHeadersOnce(canonical);
            inBody = true;
            scanBuf = headBuf.slice(bodyTagEnd + 1);
            headBuf = '';
            processScanBuffer(false);
          }
        } else if (headBuf.length > 65536) {
          // Unusual HTML without <body>: flush as-is
          const canonical = extractCanonicalTitle(headBuf, rawTitle, upstream.url);
          sendHeadersOnce(canonical);
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
    } else if (!inBody && headBuf) {
      const canonical = extractCanonicalTitle(headBuf, rawTitle, upstream.url);
      sendHeadersOnce(canonical);
      writeChunk(trimSectionMarkup(headBuf));
    } else {
      processScanBuffer(true);
      if (currentSection) {
        writeChunk(trimSectionMarkup(currentSection));
      } else if (sectionIndex === 0 && fallbackRawBuf.trim()) {
        // Fallback if page had no <section> wrapper
        writeChunk(trimSectionMarkup(fallbackRawBuf));
      }
    }

    clearTimeout(timer);
    if (!headersSent) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'Empty Wikipedia response' });
    }
    return res.end();
  } catch (err) {
    clearTimeout(timer);
    if (res.headersSent) {
      // Abort incomplete stream instead of clean end() so Edge CDN never caches a truncated 200 OK
      if (typeof res.destroy === 'function') res.destroy(err);
      else res.end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const isAbort = err?.name === 'AbortError';
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'Wikipedia proxy timed out' : 'Wikipedia proxy error',
      details: err?.message
    });
  }
}
