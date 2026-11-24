/**
 * The agent's tools. Read tools only query Memgraph; act tools drive the read-only live browser and report back
 * only graph facts (which graph page the browser is on) and locator match counts. No HTML or page text is returned.
 *
 * The same code runs against every graph variant. A tool shows whatever properties the graph has, so a richer
 * graph gives richer answers without any change here.
 */
import { query } from '../graph/db.js';
import { pageIdOfUrl, pathOf } from '../graph/url.js';
import { LiveBrowser } from './browser.js';

type Props = Record<string, any>;

// Properties the agent never needs (locator internals, bookkeeping).
const HIDDEN = new Set(['selector', 'locators', 'fingerprint', 'sectionId', 'pageId', 'path', 'regionSelector', 'discoveredAt',
  'itemKey', 'itemId', 'screenshotBase64']);
const PAGE_CORE = new Set(['id', 'url', 'loadedUrl', 'title', 'depth', 'crawled', 'status', 'error', 'discoveredAt', 'redirectedTo', 'pagination']);
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'how', 'do', 'i', 'can', 'what', 'where',
  'which', 'page', 'with', 'my', 'me', 'find', 'go', 'show', 'there', 'this', 'that', 'it', 'are', 'from', 'at', 'by', 'be']);

const clean = (p: Props, hide = HIDDEN) => Object.fromEntries(Object.entries(p).filter(([k, v]) => !hide.has(k) && v !== '' && v !== null));
const parseList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('[')) { try { return JSON.parse(v).map(String); } catch { /* not a list */ } }
  return [];
};

export class GraphTools {
  private browser?: LiveBrowser;
  private site?: Props;

  async siteInfo(): Promise<Props> {
    if (!this.site) this.site = (await query<{ s: Props }>('MATCH (s:Site) RETURN properties(s) AS s'))[0]?.s ?? {};
    return this.site;
  }

  private async live(): Promise<LiveBrowser> {
    if (!this.browser) {
      const site = await this.siteInfo();
      this.browser = new LiveBrowser(new URL(site.startUrl).hostname.replace(/^www\./, ''));
    }
    return this.browser;
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  // ---------- resolving ids ----------

  /** Accepts a page id, a full URL or a path, and returns the page's properties. */
  async resolvePage(ref: string | undefined): Promise<Props | undefined> {
    const site = await this.siteInfo();
    const raw = (ref || site.startPage || '').trim();
    const candidates = [raw, pageIdOfUrl(raw)];
    try { candidates.push(pageIdOfUrl(new URL(raw, site.startUrl).href)); } catch { /* not a URL */ }
    const rows = await query<{ p: Props }>('MATCH (p:Page) WHERE p.id IN $c OR p.loadedUrl IN $c RETURN properties(p) AS p', { c: candidates });
    let page = rows.find(r => r.p.crawled)?.p ?? rows[0]?.p;
    if (page?.redirectedTo) page = (await query<{ p: Props }>('MATCH (p:Page {id: $id}) RETURN properties(p) AS p', { id: page.redirectedTo }))[0]?.p ?? page;
    return page;
  }

  /** Which graph page a browser URL is: exact id, loaded URL, redirect, then a page's `urlPattern` (regex) if any. */
  async pageForUrl(url: string): Promise<Props> {
    const page = await this.resolvePage(url);
    if (page) return { in_graph: true, page_id: page.id, title: page.title, ...(page.crawled ? {} : { opened_by_crawler: false }) };
    const patterned = await query<{ p: Props }>('MATCH (p:Page) WHERE p.urlPattern IS NOT NULL RETURN properties(p) AS p');
    for (const { p } of patterned) {
      try {
        if (new RegExp(p.urlPattern).test(url)) return { in_graph: true, page_id: p.id, title: p.title, matched_by: 'url pattern' };
      } catch { /* bad pattern */ }
    }
    return { in_graph: false, path: pathOf(url) };
  }

  // ---------- read tools ----------

  async siteOverview(): Promise<Props> {
    const site = await this.siteInfo();
    const start = await this.resolvePage(site.startPage);
    const labels = await query<{ label: string; n: number }>('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC');
    const pages = await query<{ opened: boolean; n: number }>('MATCH (p:Page) RETURN coalesce(p.crawled, false) AS opened, count(*) AS n');
    const roles = await query<{ role: string; n: number }>('MATCH (s:Section) RETURN s.role AS role, count(*) AS n ORDER BY n DESC');
    const core = new Set(['Site', 'Page', 'Section', 'Action', 'Interaction']);
    const extraLabels = labels.filter(l => !core.has(l.label));
    const extras: Props = {};
    for (const { label } of extraLabels) {
      const sample = await query<{ n: Props }>(`MATCH (n:\`${label}\`) RETURN properties(n) AS n LIMIT 3`);
      extras[label] = sample.map(s => clean(s.n));
    }
    return {
      start_page: start ? { page_id: start.id, title: start.title } : site.startPage,
      pages_opened: pages.find(p => p.opened)?.n ?? 0,
      pages_known_only_by_link: pages.find(p => !p.opened)?.n ?? 0,
      counts: Object.fromEntries(labels.map(l => [l.label, l.n])),
      section_roles: Object.fromEntries(roles.map(r => [r.role, r.n])),
      coverage: typeof site.coverage === 'string' ? JSON.parse(site.coverage) : site.coverage,
      ...(extraLabels.length ? { other_node_types: extras } : {}),
    };
  }

  async listPages(filter?: string, includeUnopened = false, limit = 60): Promise<Props> {
    const rows = await query<{ p: Props }>(
      'MATCH (p:Page) WHERE ($all OR p.crawled = true) AND p.redirectedTo IS NULL RETURN properties(p) AS p ORDER BY p.depth, p.id',
      { all: includeUnopened });
    const f = filter?.toLowerCase().trim();
    const hits = rows.map(r => r.p).filter(p => !f || `${p.title} ${p.id}`.toLowerCase().includes(f));
    return {
      total: hits.length,
      pages: hits.slice(0, limit).map(p => ({
        page_id: p.id, title: p.title, path: pathOf(p.id), depth: p.depth,
        ...(p.crawled ? {} : { opened: false }),
        ...clean(Object.fromEntries(Object.entries(p).filter(([k]) => !PAGE_CORE.has(k)))),
      })),
      ...(hits.length > limit ? { more: hits.length - limit } : {}),
    };
  }

  async getPage(ref: string, sectionId?: string): Promise<Props> {
    const page = await this.resolvePage(ref);
    if (!page) return { error: `no page '${ref}' in the graph` };
    const sections = await query<{ s: Props; actions: Props[] }>(
      `MATCH (:Page {id: $id})-[:HAS_SECTION]->(s:Section) ${sectionId ? 'WHERE s.id = $sid' : ''}
       OPTIONAL MATCH (s)-[:HAS_ACTION]->(a:Action)
       WITH s, a ORDER BY a.id
       RETURN properties(s) AS s, collect(properties(a)) AS actions ORDER BY s.order`,
      { id: page.id, sid: sectionId ?? null });
    const perSection = sectionId ? 200 : 25;
    const interactions = await query<{ i: Props; opens: string | null }>(
      `MATCH (:Page {id: $id})-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(:Action)-[:HAS_RESULT]->(i:Interaction)
       OPTIONAL MATCH (i)-[:OPENS]->(t:Page) RETURN properties(i) AS i, t.id AS opens`, { id: page.id });
    const links = await query<{ t: string; title: string; label: string; next: boolean; opened: boolean }>(
      `MATCH (:Page {id: $id})-[e:LINKS_TO]->(t:Page) RETURN DISTINCT t.id AS t, t.title AS title, e.label AS label,
       coalesce(e.next, false) AS next, coalesce(t.crawled, false) AS opened`, { id: page.id });
    return {
      page: { page_id: page.id, ...clean(page, new Set([...HIDDEN, 'id', 'url'])) },
      sections: sections.map(({ s, actions }) => ({
        section_id: s.id, ...clean(s, new Set([...HIDDEN, 'id'])),
        actions: actions.slice(0, perSection).map(a => ({
          action_id: a.id, ...clean(a, new Set([...HIDDEN, 'id'])),
          ...(a.href ? { href: pathOf(a.href) } : {}),
        })),
        ...(actions.length > perSection ? { more_actions: `${actions.length - perSection} more: call get_page with section_id` } : {}),
      })),
      clicks_recorded: interactions.map(({ i, opens }) => ({
        action_id: i.actionId, label: i.label, kind: i.kind, result: i.result, ...(opens ? { opens_page: opens } : {}),
      })),
      links_to_pages: links.map(l => ({ page_id: l.t, label: l.label, ...(l.next ? { next_page: true } : {}), ...(l.opened ? {} : { opened_by_crawler: false }) })),
    };
  }

  async search(text: string, limit = 15): Promise<Props> {
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(w => w.length > 1 && !STOP.has(w)) ?? [];
    if (!words.length) return { error: 'give a few words to search for' };
    const textOf = (p: Props) => Object.entries(p)
      .filter(([k, v]) => !HIDDEN.has(k) && k !== 'id' && k !== 'href' && (typeof v === 'string' || Array.isArray(v)))
      .map(([, v]) => (Array.isArray(v) ? v.join(' ') : v)).join(' ').toLowerCase();
    const rows = await query<{ label: string; n: Props; page: string | null }>(
      `MATCH (n) WHERE NOT n:Site
       OPTIONAL MATCH (pg:Page)-[:HAS_SECTION]->(n)
       OPTIONAL MATCH (pa:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(n)
       OPTIONAL MATCH (pi:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(:Action)-[:HAS_RESULT]->(n)
       RETURN labels(n)[0] AS label, properties(n) AS n, coalesce(pg.id, pa.id, pi.id) AS page`);
    const scored = rows.map(r => {
      const t = textOf(r.n) + (r.label === 'Page' ? ' ' + pathOf(r.n.id).toLowerCase() : '');
      const hit = words.filter(w => t.includes(w)).length;
      return { r, score: hit / words.length + (t.includes(words.join(' ')) ? 0.25 : 0) };
    }).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.r.label === 'Page' ? -1 : 1));
    return {
      results: scored.slice(0, limit).map(({ r, score }) => {
        const n = r.n;
        const base = { type: r.label, score: Math.round(score * 100) / 100 };
        if (r.label === 'Page') return { ...base, page_id: n.id, title: n.title, ...(n.crawled ? {} : { opened_by_crawler: false }) };
        if (r.label === 'Section') return { ...base, section_id: n.id, page_id: r.page, name: n.name, role: n.role };
        if (r.label === 'Action') return { ...base, action_id: n.id, page_id: r.page, label: n.label, kind: n.type, ...(n.navigatesTo ? { navigates_to: n.navigatesTo } : {}) };
        if (r.label === 'Interaction') return { ...base, action_id: n.actionId, page_id: r.page, label: n.label, result: n.result };
        return { ...base, id: n.id, ...clean(n, new Set([...HIDDEN, 'id'])) };
      }),
    };
  }

  /** Cheapest route between two pages. Edge cost = the edge's `cost` property when the graph has one, else 1. */
  async findPath(fromRef: string | undefined, toRef: string): Promise<Props> {
    const from = await this.resolvePage(fromRef);
    const to = await this.resolvePage(toRef);
    if (!from) return { error: `no page '${fromRef}' in the graph` };
    if (!to) return { error: `no page '${toRef}' in the graph` };
    const edges = await query<{ s: string; t: string; action: string | null; label: string | null; cost: number | null; via: string }>(
      `MATCH (p:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(a:Action)-[r:NAVIGATES_TO]->(t:Page)
       RETURN p.id AS s, coalesce(t.redirectedTo, t.id) AS t, a.id AS action, a.label AS label,
              coalesce(r.cost, a.cost) AS cost, 'action' AS via
       UNION ALL
       MATCH (p:Page)-[e:LINKS_TO]->(t:Page)
       RETURN p.id AS s, coalesce(t.redirectedTo, t.id) AS t, null AS action, e.label AS label, e.cost AS cost, 'link' AS via
       UNION ALL
       MATCH (p:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(a:Action)-[:HAS_RESULT]->(i:Interaction)-[:OPENS]->(t:Page)
       RETURN p.id AS s, coalesce(t.redirectedTo, t.id) AS t, a.id AS action, a.label AS label, i.cost AS cost, 'click' AS via`);
    // Best edge per page pair: cheapest, and one with an action id beats a bare link.
    const best = new Map<string, typeof edges[number]>();
    for (const e of edges) {
      if (e.s === e.t) continue;
      const k = e.s + '\u0000' + e.t;
      const c = typeof e.cost === 'number' ? e.cost : 1;
      const cur = best.get(k);
      const cc = cur ? (typeof cur.cost === 'number' ? cur.cost : 1) : Infinity;
      if (!cur || c < cc || (c === cc && !cur.action && e.action)) best.set(k, { ...e, cost: c });
    }
    const adj = new Map<string, typeof edges>();
    for (const e of best.values()) adj.set(e.s, [...(adj.get(e.s) ?? []), e]);
    const dist = new Map<string, number>([[from.id, 0]]);
    const prev = new Map<string, typeof edges[number]>();
    const open = new Set<string>([from.id]);
    while (open.size) {
      let u = '';
      for (const n of open) if (!u || dist.get(n)! < dist.get(u)!) u = n;
      open.delete(u);
      if (u === to.id) break;
      for (const e of adj.get(u) ?? []) {
        const d = dist.get(u)! + (e.cost as number);
        if (d < (dist.get(e.t) ?? Infinity)) { dist.set(e.t, d); prev.set(e.t, e); open.add(e.t); }
      }
    }
    if (from.id === to.id) return { from: from.id, to: to.id, steps: [], note: 'already there' };
    if (!prev.has(to.id)) return { from: from.id, to: to.id, found: false, note: 'no route in the graph between these pages' };
    const steps: Props[] = [];
    for (let n = to.id; n !== from.id;) {
      const e = prev.get(n)!;
      steps.unshift({ on_page: e.s, ...(e.action ? { do: 'perform', action_id: e.action } : { do: 'open_page' }), label: e.label, arrives_at: e.t });
      n = e.s;
    }
    return { from: from.id, to: to.id, found: true, cost: Math.round(dist.get(to.id)! * 100) / 100, steps };
  }

  async listAreas(): Promise<Props> {
    const rows = await query<{ a: Props; pages: Props[] }>(
      `MATCH (a:Area) OPTIONAL MATCH (a)-[:CONTAINS]->(p:Page)
       RETURN properties(a) AS a, collect({page_id: p.id, title: p.title}) AS pages`);
    if (!rows.length) return { areas: [], note: 'this graph has no named areas; use site_overview, list_pages or search' };
    return { areas: rows.map(r => ({ area_id: r.a.id, ...clean(r.a, new Set([...HIDDEN, 'id'])), pages: r.pages.filter(p => p.page_id) })) };
  }

  // ---------- act tools ----------

  async whereAmI(): Promise<Props> {
    const url = this.browser?.url();
    if (!url || url === 'about:blank') return { browser: 'not opened yet; call open_page' };
    return this.pageForUrl(url);
  }

  async openPage(ref: string): Promise<Props> {
    const page = await this.resolvePage(ref);
    if (!page) return { error: `no page '${ref}' in the graph` };
    const b = await this.live();
    try {
      const url = await b.goto(page.loadedUrl || page.url || page.id);
      return { opened: true, now_on: await this.pageForUrl(url) };
    } catch (e: any) {
      return { opened: false, error: String(e?.message || e).split('\n')[0] };
    }
  }

  private async actionWithPage(actionId: string): Promise<{ a?: Props; page?: string }> {
    const r = await query<{ a: Props; page: string }>(
      'MATCH (p:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(a:Action {id: $id}) RETURN properties(a) AS a, p.id AS page', { id: actionId });
    return r[0] ?? {};
  }

  private async prepare(actionId: string, item?: string) {
    const { a, page } = await this.actionWithPage(actionId);
    if (!a || !page) return { error: `no action '${actionId}' in the graph` } as const;
    const b = await this.live();
    const notes: string[] = [];
    const here = b.url() ? await this.pageForUrl(b.url()!) : undefined;
    if (here?.page_id !== page) {
      const opened = await this.openPage(page);
      if (!opened.opened) return { error: `could not open the action's page ${page}: ${opened.error}` } as const;
      notes.push(`opened ${page} first`);
    }
    const specs = parseList(a.locators);
    if (a.selector && !specs.includes(a.selector)) specs.push(a.selector);
    const found = await b.locate(specs, item);
    return { a, page, b, notes, found } as const;
  }

  async perform(actionId: string, item?: string): Promise<Props> {
    const p = await this.prepare(actionId, item);
    if ('error' in p) return { done: false, error: p.error };
    const { a, b, notes, found } = p;
    if (['input', 'select'].includes(a.type)) return { done: false, error: 'this is a field: use fill' };
    if (!found.locator) return { done: false, error: 'element not found on the live page', locator_matches: found.tried.map(t => t.matches), notes };
    const before = b.url();
    try {
      await b.click(found.locator);
    } catch (e: any) {
      return { done: false, error: 'click failed: ' + String(e?.message || e).split('\n')[0], notes };
    }
    const after = b.url()!;
    return {
      done: true, ...(notes.length ? { notes } : {}),
      ...(found.tried.length > 1 ? { locator_used: found.tried.length } : {}),
      url_changed: before !== after, now_on: await this.pageForUrl(after),
    };
  }

  async fill(actionId: string, text: string, submit = false): Promise<Props> {
    const p = await this.prepare(actionId);
    if ('error' in p) return { done: false, error: p.error };
    const { b, notes, found } = p;
    if (!found.locator) return { done: false, error: 'field not found on the live page', locator_matches: found.tried.map(t => t.matches), notes };
    const before = b.url();
    try {
      await b.fill(found.locator, text, submit);
    } catch (e: any) {
      return { done: false, error: 'fill failed: ' + String(e?.message || e).split('\n')[0], notes };
    }
    const after = b.url()!;
    return { done: true, ...(notes.length ? { notes } : {}), url_changed: before !== after, now_on: await this.pageForUrl(after) };
  }
}
