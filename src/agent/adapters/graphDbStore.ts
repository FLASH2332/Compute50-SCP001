/**
 * MapStore on Memgraph or Neo4j (Bolt). The site's map lives in the database:
 *
 *   (:App {origin})-[:HAS_PAGE]->(:Page {url})-[:HAS_SECTION]->(:Section {id})-[:HAS_ACTION]->(:Action {id})
 *   (:Action)-[:NAVIGATES_TO]->(:Page)
 *   (:State {id})-[:STATE_OF]->(:Page)
 *   (:State)-[:ACTION {id, actionId, kind, risk, n, s, reliability, cost, status}]->(:State)
 *
 * Page/Section/Action use the same labels and keys as the section graph's
 * Cypher export (studio "sync"), so both write to the same nodes.
 */
import neo4j, { type Driver } from 'neo4j-driver';
import { AppMap, type ActionEdge, type AppPage, type AppSection, type Control, type UiState } from '../core/appMap.js';
import type { MapStore } from '../core/ports.js';

export interface GraphDbConfig { uri?: string; username?: string; password?: string; database?: string }

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | undefined => (typeof v === 'string' && v ? JSON.parse(v) : undefined);
export const originOf = (url: string) => new URL(url).origin;

export class GraphDbStore implements MapStore {
  readonly name: string;
  private driver: Driver;
  private database?: string;
  private indexed = false;

  constructor(cfg: GraphDbConfig = {}, env = process.env) {
    const uri = cfg.uri || env.NEO4J_URI || 'bolt://localhost:7687';
    this.name = `graph db at ${uri}`;
    this.database = cfg.database || env.NEO4J_DATABASE || undefined;
    this.driver = neo4j.driver(uri, neo4j.auth.basic(cfg.username ?? env.NEO4J_USERNAME ?? '', cfg.password ?? env.NEO4J_PASSWORD ?? ''),
      { disableLosslessIntegers: true, connectionAcquisitionTimeout: 8000 });
  }

  private async run(query: string, params: Record<string, unknown> = {}) {
    const session = this.driver.session(this.database ? { database: this.database } : {});
    try { return (await session.run(query, params)).records; } finally { await session.close(); }
  }

  /** Throws a clear error when the database is not reachable. */
  async check(): Promise<void> {
    try { await this.run('RETURN 1'); }
    catch (e) { throw new Error(`Cannot reach the graph database (${this.name}): ${(e as Error).message.split('\n')[0]}. Start Memgraph/Neo4j or set NEO4J_URI.`); }
  }

  private async ensureIndexes() {
    if (this.indexed) return;
    this.indexed = true;
    for (const [label, key] of [['App', 'origin'], ['Page', 'url'], ['Section', 'id'], ['Action', 'id'], ['State', 'id']]) {
      // Memgraph syntax first, then Neo4j's; one of them works, the other is ignored
      await this.run(`CREATE INDEX ON :${label}(${key})`).catch(() => this.run(`CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${key})`).catch(() => {}));
    }
  }

  async find(url: string): Promise<AppMap | null> {
    await this.check();
    const origin = originOf(url);
    const app = (await this.run('MATCH (a:App {origin: $origin}) RETURN a', { origin }))[0]?.get('a').properties;
    if (!app) return null;
    const pages: Record<string, AppPage> = {};
    for (const r of await this.run('MATCH (:App {origin: $origin})-[:HAS_PAGE]->(p:Page) RETURN p', { origin })) {
      const p = r.get('p').properties;
      pages[p.url] = { id: p.url, url: p.loadedUrl || p.url, title: p.title || '', template: p.template || '' };
    }
    if (!Object.keys(pages).length) return null;
    const sections: Record<string, AppSection> = {};
    const controls: Record<string, Control> = {};
    for (const r of await this.run(`MATCH (:App {origin: $origin})-[:HAS_PAGE]->(p:Page)-[:HAS_SECTION]->(s:Section)
      OPTIONAL MATCH (s)-[:HAS_ACTION]->(a:Action) OPTIONAL MATCH (a)-[:NAVIGATES_TO]->(t:Page)
      RETURN p.url AS pageId, s, a, t.url AS target`, { origin })) {
      const pageId = r.get('pageId');
      const s = r.get('s').properties;
      sections[s.id] ??= { id: s.id, pageId, name: s.name || '', role: s.role || 'content', hidden: !!s.hidden, order: Number(s.order ?? 0), selector: s.regionSelector || undefined, summary: s.summary || undefined };
      const a = r.get('a')?.properties;
      if (!a) continue;
      const target = r.get('target');
      controls[a.id] = {
        id: a.id, pageId, label: a.label || '', type: a.type, inputType: a.inputType || undefined, selector: a.selector, href: a.href || undefined,
        navigatesTo: target && pages[target] ? target : undefined, visible: a.visible !== false,
        section: { id: s.id, name: s.name || '', role: s.role || 'content', hidden: !!s.hidden },
        risk: a.risk || undefined, aliases: a.aliases || undefined, hits: parse(a.hits), status: a.status || undefined, box: parse(a.box)
      };
    }
    const states: Record<string, UiState> = {};
    for (const r of await this.run('MATCH (:App {origin: $origin})-[:HAS_PAGE]->(p:Page)<-[:STATE_OF]-(st:State) RETURN p.url AS pageId, st', { origin })) {
      const st = r.get('st').properties;
      states[st.id] = { id: st.id, template: st.template, pageId: r.get('pageId'), url: st.url, title: st.title || '', dialog: st.dialog || '', tab: st.tab || '',
        visibleActions: st.visibleActions || [], base: !!st.base, seeded: st.seeded || undefined, preActions: st.preActions?.length ? st.preActions : undefined };
    }
    const edges: Record<string, ActionEdge> = {};
    for (const r of await this.run('MATCH (:App {origin: $origin})-[:HAS_PAGE]->(:Page)<-[:STATE_OF]-(a:State)-[e:ACTION]->(b:State) RETURN a.id AS from, b.id AS to, e', { origin })) {
      const e = r.get('e').properties;
      edges[e.id] = { id: e.id, from: r.get('from'), to: r.get('to'), actionId: e.actionId || '', kind: e.kind, risk: e.risk || 'safe', n: Number(e.n || 0), s: Number(e.s || 0),
        fails: Number(e.fails || 0), reliability: Number(e.reliability ?? 0.5), cost: Number(e.cost ?? 1), status: e.status || 'ok' };
    }
    return new AppMap({ source: `${app.source || 'unknown'} (from ${this.name})`, startUrl: app.startUrl, pages, sections, controls, states, edges });
  }

  async save(map: AppMap): Promise<void> {
    await this.check();
    await this.ensureIndexes();
    const origin = originOf(map.startUrl);
    const d = map.data;
    const sectionOf = (c: Control) => c.section?.id || `sec_${c.pageId}#${c.section?.name || 'page'}`;
    const sections = new Map<string, Record<string, unknown>>();
    for (const s of Object.values(d.sections)) sections.set(s.id, { id: s.id, pageId: s.pageId, name: s.name, role: s.role, hidden: s.hidden, order: s.order, selector: s.selector ?? null, summary: s.summary ?? null });
    for (const c of Object.values(d.controls)) {
      const id = sectionOf(c);
      if (!sections.has(id)) sections.set(id, { id, pageId: c.pageId, name: c.section?.name || 'page', role: c.section?.role || 'content', hidden: !!c.section?.hidden, order: 999, selector: null, summary: null });
    }
    await this.run('MERGE (a:App {origin: $origin}) SET a.startUrl = $startUrl, a.source = $source, a.updatedAt = $now',
      { origin, startUrl: d.startUrl, source: d.source.replace(/ \(from .*\)$/, ''), now: new Date().toISOString() });
    await this.run(`UNWIND $pages AS p MERGE (n:Page {url: p.id}) SET n.title = p.title, n.loadedUrl = p.url, n.template = p.template, n.crawled = true, n.status = 'ok'
      WITH n MATCH (a:App {origin: $origin}) MERGE (a)-[:HAS_PAGE]->(n)`, { origin, pages: Object.values(d.pages) });
    await this.run(`UNWIND $sections AS s MATCH (p:Page {url: s.pageId}) MERGE (n:Section {id: s.id})
      SET n.name = s.name, n.role = s.role, n.hidden = s.hidden, n.order = s.order, n.regionSelector = s.selector, n.summary = s.summary MERGE (p)-[:HAS_SECTION]->(n)`,
      { sections: [...sections.values()] });
    await this.run(`UNWIND $controls AS c MATCH (s:Section {id: c.sectionId}) MERGE (a:Action {id: c.id})
      SET a.label = c.label, a.type = c.type, a.inputType = c.inputType, a.selector = c.selector, a.href = c.href, a.visible = c.visible,
          a.risk = c.risk, a.aliases = c.aliases, a.hits = c.hits, a.status = c.status, a.box = c.box
      MERGE (s)-[:HAS_ACTION]->(a)`, {
      controls: Object.values(d.controls).map(c => ({ id: c.id, sectionId: sectionOf(c), label: c.label, type: c.type, inputType: c.inputType ?? null, selector: c.selector, href: c.href ?? null,
        visible: c.visible, risk: c.risk ?? null, aliases: c.aliases ?? [], hits: json(c.hits), status: c.status ?? 'ok', box: json(c.box) }))
    });
    await this.run('UNWIND $links AS l MATCH (a:Action {id: l.id}), (t:Page {url: l.to}) MERGE (a)-[:NAVIGATES_TO]->(t)',
      { links: Object.values(d.controls).filter(c => c.navigatesTo).map(c => ({ id: c.id, to: c.navigatesTo })) });
    await this.run(`UNWIND $states AS st MATCH (p:Page {url: st.pageId}) MERGE (n:State {id: st.id})
      SET n.template = st.template, n.url = st.url, n.title = st.title, n.dialog = st.dialog, n.tab = st.tab, n.visibleActions = st.visibleActions,
          n.base = st.base, n.seeded = st.seeded, n.preActions = st.preActions MERGE (n)-[:STATE_OF]->(p)`, {
      states: Object.values(d.states).filter(s => d.pages[s.pageId]).map(s => ({ ...s, base: !!s.base, seeded: !!s.seeded, preActions: s.preActions ?? [] }))
    });
    await this.run(`UNWIND $edges AS e MATCH (a:State {id: e.from}), (b:State {id: e.to}) MERGE (a)-[r:ACTION {id: e.id}]->(b)
      SET r.actionId = e.actionId, r.kind = e.kind, r.risk = e.risk, r.n = e.n, r.s = e.s, r.fails = e.fails, r.reliability = e.reliability, r.cost = e.cost, r.status = e.status`,
      { edges: Object.values(d.edges) });
  }

  /** Removes a site's agent map (App + its pages' states). Pages/sections/actions are kept for other tools. */
  async forget(url: string): Promise<void> {
    await this.run('MATCH (a:App {origin: $origin}) OPTIONAL MATCH (a)-[:HAS_PAGE]->(:Page)<-[:STATE_OF]-(s:State) DETACH DELETE s, a', { origin: originOf(url) });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
