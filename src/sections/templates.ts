/**
 * URL templates and action risk (ports of the old SiteGraph `normalize.url_template` and `risk.classify_risk`).
 *
 *   /catalogue/a-light-in-the-attic_1000/index.html  →  /catalogue/:id/index.html
 *   /product/123?color=red&size=m                    →  /product/:id?color&size
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const NUM = /^\d+$/;
const TRAILING_NUM = /^.+[-_]\d+$/;
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+){2,}$/i;

function templateSegment(seg: string): string {
  const dot = seg.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [seg.slice(0, dot), seg.slice(dot)] : [seg, ''];
  return base && [NUM, UUID, HEX, TRAILING_NUM, SLUG].some(p => p.test(base)) ? ':id' + ext : seg;
}

/** Path template plus the sorted query keys. A `#/route` fragment (SPA) is templated like a path. */
export function urlTemplate(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').map(templateSegment).join('/') || '/';
    const keys = [...new Set([...u.searchParams.keys()])].sort();
    const route = /^#[/!]/.test(u.hash) ? '#' + u.hash.slice(1).split('?')[0].split('/').map(templateSegment).join('/') : '';
    return path.replace(/(.)\/$/, '$1') + (keys.length ? '?' + keys.join('&') : '') + route;
  } catch {
    return url;
  }
}

/** True when the template has a variable part (so pages can share it). */
export const isVariable = (template: string) => template.includes(':id') || template.includes('?');

/** A regex that matches the URLs of one template's pages (any origin-relative query values). */
export function templatePattern(origin: string, template: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [pathAndQuery, route = ''] = template.split('#');
  const [path, query] = pathAndQuery.split('?');
  const seg = (p: string) => p.split(':id').map(esc).join('[^/?#]+');
  let re = '^' + esc(origin) + seg(path) + '/?';
  re += query ? '\\?[^#]*' : '(?:\\?[^#]*)?';
  re += route ? '#' + seg(route) + '(?:\\?.*)?$' : '(?:#.*)?$';
  return re;
}

export type Risk = 'read' | 'navigate' | 'input' | 'submit_safe' | 'submit_mutating' | 'external' | 'destructive';
export const RISK_COST: Record<Risk, number> = {
  read: 0, navigate: 0, input: 0, submit_safe: 1, submit_mutating: 100, destructive: 10000, external: 1000,
};

const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch']);
const NAV_ROLES = new Set(['link', 'tab', 'option', 'menuitem', 'menuitemradio', 'menuitemcheckbox']);
const DESTRUCTIVE = /\b(delete|remove|deactivate|unsubscribe|empty cart|clear (all|cart|history)|cancel (order|subscription|account))\b/i;
const MUTATING = /\b(buy|pay|purchase|checkout|check out|place order|order now|subscribe|sign ?up|register|log ?in|sign ?in|post|send|submit|publish|donate|book now|reserve|confirm|follow|vote|apply now|add to (cart|basket|bag))\b/i;

export function classifyRisk(role: string, name: string, href: string | undefined, isSameSite: (url: string) => boolean): Risk {
  if (INPUT_ROLES.has(role)) return 'input';
  if (href) {
    if (/^(mailto|tel|javascript):/i.test(href)) return 'external';
    if (/^https?:/i.test(href) && !isSameSite(href)) return 'external';
  }
  if (DESTRUCTIVE.test(name)) return 'destructive';
  // A same-site link only opens a page (a GET): "Log in" or "Sign up" links lead to a form, they change nothing.
  // (The old SiteGraph rated them submit_mutating, which made routes to a login page look 100x more expensive.)
  if (role === 'link' && href && /^https?:/i.test(href)) return 'navigate';
  if (MUTATING.test(name)) return 'submit_mutating';
  if (NAV_ROLES.has(role)) return 'navigate';
  return 'submit_safe';
}

/** Edge reliability from s successes in n tries (Laplace), and the routing cost the old SiteGraph used. */
export function reliability(s: number, n: number): number {
  return (s + 1) / (n + 2);
}
export function edgeCost(rel: number, risk: Risk = 'navigate'): number {
  return Math.round((1 + 2 * -Math.log(rel) + RISK_COST[risk]) * 1000) / 1000;
}
