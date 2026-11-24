/**
 * Vercel CDN-cached streaming Wikipedia Parsoid HTML proxy (Web Standard Fetch handler).
 * - Uses `export async function GET(request)` returning `new Response(ReadableStream)` for
 *   true unbuffered cold-miss edge streaming on Vercel's Node.js runtime
 * - Streams Parsoid HTML from Wikimedia via ReadableStream, stripping <style>/<script>/<link>
 *   blocks and cancelling the upstream download early the instant boilerplate trailing sections
 *   (References, External links, etc.) begin
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
const SECTION_TAG_RE = /<(\/?)section\b[^>]*>/gi;

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

function buildSuccessHeaders(canonical, trimmed = '1') {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Wiki-Canonical-Title': encodeURIComponent(canonical),
    'X-Wiki-Trimmed': trimmed,
    'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
    'CDN-Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
    'Vercel-CDN-Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800'
  };
}

export async function GET(request) {
  const url = new URL(request.url);
  const rawLang = String(url.searchParams.get('lang') || 'en').trim().toLowerCase();
  const rawTitle = String(url.searchParams.get('title') || '').trim();

  if (!/^[a-z-]{2,12}$/i.test(rawLang)) {
    return Response.json(
      { error: 'Invalid language code' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  if (!rawTitle || rawTitle.length > 260) {
    return Response.json(
      { error: 'Missing or invalid title' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const pathTitle = toWikiPathTitle(rawTitle);
  const upstreamUrl = `https://${rawLang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(pathTitle)}`;
  const upstreamCtrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    upstreamCtrl.abort(new DOMException('Wikipedia proxy timed out', 'TimeoutError'));
  }, 9000);

  const onReqAbort = () => upstreamCtrl.abort(request.signal?.reason || new DOMException('Client disconnected', 'AbortError'));
  if (request.signal) {
    if (request.signal.aborted) {
      clearTimeout(timer);
      return new Response(null, { status: 499, headers: { 'Cache-Control': 'no-store' } });
    }
    request.signal.addEventListener('abort', onReqAbort, { once: true });
  }

  const cleanupUpstreamListeners = () => {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onReqAbort);
  };

  try {
    const upstream = await fetch(upstreamUrl, {
      signal: upstreamCtrl.signal,
      headers: {
        'User-Agent': UA,
        'Api-User-Agent': UA,
        Accept: 'text/html; charset=utf-8'
      }
    });

    if (!upstream.ok) {
      cleanupUpstreamListeners();
      return Response.json(
        { error: `Wikipedia returned ${upstream.status}` },
        { status: upstream.status, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const reader = upstream.body?.getReader?.();
    if (!reader) {
      const fullHtml = await upstream.text();
      cleanupUpstreamListeners();
      const canonical = extractCanonicalTitle(fullHtml.slice(0, 8192), rawTitle, upstream.url);
      return new Response(fullHtml, {
        status: 200,
        headers: buildSuccessHeaders(canonical, '0')
      });
    }

    // Read only the tiny leading <head> bytes (~1-4 KB) so we can resolve the canonical
    // redirect title into X-Wiki-Canonical-Title before returning the streaming Response.
    const decoder = new TextDecoder('utf-8');
    let headBuf = '';
    let initialScanBuf = '';
    let canonical = rawTitle;
    let reachedBody = false;

    while (!reachedBody) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) headBuf += tail;
        break;
      }

      headBuf += decoder.decode(value, { stream: true });
      const bodyIdx = headBuf.search(/<body\b[^>]*>/i);
      if (bodyIdx !== -1) {
        const bodyTagEnd = headBuf.indexOf('>', bodyIdx);
        if (bodyTagEnd !== -1) {
          canonical = extractCanonicalTitle(headBuf.slice(0, bodyIdx), rawTitle, upstream.url);
          initialScanBuf = headBuf.slice(bodyTagEnd + 1);
          headBuf = '';
          reachedBody = true;
        }
      } else if (headBuf.length > 65536) {
        // Unusual HTML without <body>: stream as-is
        canonical = extractCanonicalTitle(headBuf, rawTitle, upstream.url);
        initialScanBuf = headBuf;
        headBuf = '';
        reachedBody = true;
      }
    }

    if (!reachedBody) {
      cleanupUpstreamListeners();
      if (!headBuf.trim()) {
        return Response.json(
          { error: 'Empty Wikipedia response' },
          { status: 502, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      canonical = extractCanonicalTitle(headBuf, rawTitle, upstream.url);
      return new Response(trimSectionMarkup(headBuf), {
        status: 200,
        headers: buildSuccessHeaders(canonical, '1')
      });
    }

    const encoder = new TextEncoder();
    let cancelled = false;

    const stream = new ReadableStream({
      async start(streamController) {
        let scanBuf = initialScanBuf;
        let depth = 0;
        let currentSection = '';
        let fallbackRawBuf = '';
        let sectionIndex = 0;
        let stoppedEarly = false;

        const enqueueHtml = (html) => {
          if (!cancelled && html) {
            streamController.enqueue(encoder.encode(html));
          }
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
                  enqueueHtml(trimSectionMarkup(currentSection));
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
          if (scanBuf) {
            processScanBuffer(false);
          }

          while (!stoppedEarly && !cancelled) {
            const { value, done } = await reader.read();
            if (done) {
              const tail = decoder.decode();
              if (tail) scanBuf += tail;
              break;
            }
            scanBuf += decoder.decode(value, { stream: true });
            processScanBuffer(false);
          }

          if (stoppedEarly || cancelled) {
            await reader.cancel().catch(() => {});
          } else {
            processScanBuffer(true);
            if (currentSection) {
              enqueueHtml(trimSectionMarkup(currentSection));
            } else if (sectionIndex === 0 && fallbackRawBuf.trim()) {
              // Fallback if page had no <section> wrapper
              enqueueHtml(trimSectionMarkup(fallbackRawBuf));
            }
          }

          if (!cancelled) {
            streamController.close();
          }
        } catch (err) {
          await reader.cancel().catch(() => {});
          // Error the stream instead of closing cleanly so Edge CDN never caches a truncated 200 OK
          if (!cancelled) {
            streamController.error(err);
          }
        } finally {
          cleanupUpstreamListeners();
        }
      },
      cancel() {
        cancelled = true;
        cleanupUpstreamListeners();
        upstreamCtrl.abort(new DOMException('Downstream cancelled', 'AbortError'));
        reader.cancel().catch(() => {});
      }
    });

    return new Response(stream, {
      status: 200,
      headers: buildSuccessHeaders(canonical, '1')
    });
  } catch (err) {
    cleanupUpstreamListeners();
    const isTimeout = timedOut || err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return Response.json(
      {
        error: isTimeout ? 'Wikipedia proxy timed out' : 'Wikipedia proxy error',
        details: err?.message
      },
      { status: isTimeout ? 504 : 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
