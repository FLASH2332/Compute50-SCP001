/**
 * URL → page id, the same rule the crawler on graph_base uses (src/sections/url.ts + pageIdOf), copied here so the
 * harness does not change when a graph variant changes its own code.
 */
const VOLATILE = ['_t', 't', 'timestamp', 'nocache', 'utm_source', 'utm_medium', 'utm_campaign', 'session', 'sid'];

export function pageIdOfUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const fragment = u.hash;
    for (const p of VOLATILE) u.searchParams.delete(p);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    const origin = u.origin === 'null' ? '' : u.origin;
    const canonical = origin ? origin + u.pathname + (u.search || '') : u.href;
    return canonical + (/^#(?:\/|!)/.test(fragment) ? fragment : '');
  } catch {
    return raw;
  }
}

export function pathOf(raw: string): string {
  try {
    const u = new URL(raw);
    return u.pathname + u.search + (/^#(?:\/|!)/.test(u.hash) ? u.hash : '');
  } catch {
    return raw;
  }
}
