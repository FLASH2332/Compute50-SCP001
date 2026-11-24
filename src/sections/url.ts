/** Removes tracking/cache-busting params and a trailing slash so one page has one id. */
export function normalizeUrl(rawUrl: string): { canonicalUrl: string; path: string; domain: string } {
  try {
    const urlObj = new URL(rawUrl);
    const volatileParams = ['_t', 't', 'timestamp', 'nocache', 'utm_source', 'utm_medium', 'utm_campaign', 'session', 'sid'];
    for (const p of volatileParams) {
      urlObj.searchParams.delete(p);
    }
    if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    const origin = urlObj.origin === 'null' ? '' : urlObj.origin;
    const canonical = origin ? (origin + urlObj.pathname + (urlObj.search || '')) : urlObj.href;
    return {
      canonicalUrl: canonical,
      path: urlObj.pathname + (urlObj.search || ''),
      domain: urlObj.hostname || (origin ? '' : 'local')
    };
  } catch {
    return {
      canonicalUrl: rawUrl,
      path: rawUrl,
      domain: 'unknown'
    };
  }
}
