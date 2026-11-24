/**
 * The benchmark sites. Local ones are served from a folder while they are crawled or used by the agent.
 * Crawl budget is the same for every variant: `pages` pages opened, `hops` link hops from the start page.
 */
import http from 'node:http';
import { serveFolder } from './serve.js';

export interface Site {
  name: string;
  url: string;
  pages: number;
  hops: number;
  serve?: { folder: string; port: number };
  about: string;
}

export const SITES: Site[] = [
  { name: 'testsite', url: 'http://127.0.0.1:4101/', pages: 25, hops: 3, serve: { folder: 'test-site', port: 4101 },
    about: "Teammate's one-page invoice app: buttons, a dialog, tabs, a filter panel (local)" },
  { name: 'fixture', url: 'http://127.0.0.1:4102/start.html', pages: 25, hops: 3, serve: { folder: 'bench/sites/fixture', port: 4102 },
    about: 'Old SiteGraph fixture shop (18 pages + a hub page): lists, GET forms, hover and account menus, implicit clickables (local)' },
  { name: 'books', url: 'https://books.toscrape.com/', pages: 25, hops: 3,
    about: 'Static book catalogue: 50 categories, product lists, pagination' },
  { name: 'quotes', url: 'https://quotes.toscrape.com/', pages: 25, hops: 3,
    about: 'Quotes with author pages, tag pages and Next pagination' },
  { name: 'internet', url: 'https://the-internet.herokuapp.com/', pages: 25, hops: 2,
    about: 'Many small UI examples: dynamic controls, checkboxes, dropdowns, add/remove buttons' },
  { name: 'demoblaze', url: 'https://www.demoblaze.com/', pages: 25, hops: 3,
    about: 'JS-rendered phone shop: product cards, category filters, modals, button pagination' },
  { name: 'pst', url: 'https://practicesoftwaretesting.com/', pages: 25, hops: 3,
    about: 'Angular tool shop SPA with data-test attributes: categories, product pages, filters' },
];

export function siteByName(name: string): Site {
  const s = SITES.find(x => x.name === name);
  if (!s) throw new Error(`unknown site '${name}' (known: ${SITES.map(x => x.name).join(', ')})`);
  return s;
}

const servers = new Map<number, http.Server>();

/** Serves a local site's folder (once). A port already in use is assumed to serve the same folder. */
export async function ensureServed(site: Site): Promise<void> {
  if (!site.serve || servers.has(site.serve.port)) return;
  const up = await fetch(site.url, { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false);
  if (up) return;
  servers.set(site.serve.port, await serveFolder(site.serve.folder, site.serve.port));
}

export async function stopServers(): Promise<void> {
  for (const s of servers.values()) await new Promise(r => s.close(() => r(null)));
  servers.clear();
}
