/**
 * Loads a graph snapshot (the crawler's SectionGraphModel, saved as JSON) into Memgraph.
 *
 * The harness owns this mapping so both variants land in the database the same way. Core schema:
 *
 *   (:Site {startUrl, domain, startPage})
 *   (:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(:Action)-[:NAVIGATES_TO]->(:Page)
 *   (:Page)-[:LINKS_TO {label, next, via, ...}]->(:Page)
 *   (:Page)-[:REDIRECTS_TO]->(:Page)
 *   (:Action)-[:HAS_RESULT]->(:Interaction)-[:OPENS]->(:Page)
 *
 * Every property the crawler stored is copied (objects and mixed arrays become JSON strings; screenshots are
 * dropped), so a variant that adds properties gets them into the database without changes here. A variant that adds
 * node or edge types lists them in `model.extraNodes` / `model.extraEdges` (see bench/README.md).
 */
import { query } from './db.js';
import { pageIdOfUrl } from './url.js';

export interface ExtraNode { label: string; id: string; props?: Record<string, unknown> }
export interface ExtraEdge {
  type: string;
  from: { label: string; id: string };
  to: { label: string; id: string };
  props?: Record<string, unknown>;
}

export interface Snapshot {
  site: string;
  variant: string;
  createdAt: string;
  model: any;              // SectionGraphModel (+ optional extraNodes / extraEdges)
  metrics?: Record<string, unknown>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKIP_KEYS = new Set(['screenshotBase64']);

/** A flat property map Memgraph can store. */
export function toProps(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null || SKIP_KEYS.has(k) || !NAME.test(k)) continue;
    if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v) && v.length && v.every(x => typeof x === typeof v[0] && ['string', 'number', 'boolean'].includes(typeof x))) out[k] = v;
    else if (Array.isArray(v) && !v.length) out[k] = [];
    else out[k] = JSON.stringify(v);
  }
  return out;
}

async function batch(cypher: string, rows: unknown[], size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await query(cypher, { rows: rows.slice(i, i + size) });
}

export async function clearDb(): Promise<void> {
  await query('MATCH (n) DETACH DELETE n');
}

export async function loadSnapshot(snap: Snapshot): Promise<Record<string, number>> {
  const m = snap.model;
  await clearDb();
  for (const label of ['Page', 'Section', 'Action', 'Interaction']) {
    await query(`CREATE INDEX ON :${label}(id)`).catch(() => undefined);
  }

  const pages: Record<string, any> = { ...(m.pages ?? {}) };
  const ensurePage = (id: string | undefined) => {
    if (id && !pages[id]) pages[id] = { id, url: id, title: id, crawled: false, status: 'not-crawled' };
  };
  for (const a of Object.values<any>(m.actions ?? {})) ensurePage(a.navigatesTo);
  for (const l of m.links ?? []) { ensurePage(l.source); ensurePage(l.target); }

  const startPage = pageIdOfUrl(m.startUrl ?? '');
  await query('CREATE (s:Site) SET s = $p', {
    p: toProps({ startUrl: m.startUrl, domain: m.domain, startPage: pages[startPage]?.redirectedTo || startPage, coverage: m.coverage, site: snap.site, variant: snap.variant }),
  });

  await batch('UNWIND $rows AS r CREATE (n:Page) SET n = r', Object.values(pages).map(p => toProps(p)));
  await batch('UNWIND $rows AS r CREATE (n:Section) SET n = r', Object.values<any>(m.sections ?? {}).map(s => toProps(s)));
  await batch('UNWIND $rows AS r CREATE (n:Action) SET n = r', Object.values<any>(m.actions ?? {}).map(a => toProps(a)));
  await batch('UNWIND $rows AS r CREATE (n:Interaction) SET n = r', Object.values<any>(m.interactions ?? {}).map(i => toProps(i)));

  await batch('UNWIND $rows AS r MATCH (p:Page {id: r.p}), (s:Section {id: r.s}) CREATE (p)-[:HAS_SECTION]->(s)',
    Object.values<any>(m.sections ?? {}).map(s => ({ p: s.pageId, s: s.id })));
  await batch('UNWIND $rows AS r MATCH (s:Section {id: r.s}), (a:Action {id: r.a}) CREATE (s)-[:HAS_ACTION]->(a)',
    Object.values<any>(m.actions ?? {}).map(a => ({ s: a.sectionId, a: a.id })));
  await batch('UNWIND $rows AS r MATCH (a:Action {id: r.a}), (p:Page {id: r.p}) CREATE (a)-[:NAVIGATES_TO]->(p)',
    Object.values<any>(m.actions ?? {}).filter(a => a.navigatesTo).map(a => ({ a: a.id, p: a.navigatesTo })));
  await batch('UNWIND $rows AS r MATCH (a:Page {id: r.s}), (b:Page {id: r.t}) CREATE (a)-[e:LINKS_TO]->(b) SET e = r.props',
    (m.links ?? []).map((l: any) => ({ s: l.source, t: l.target, props: toProps({ ...l, source: undefined, target: undefined }) })));
  await batch('UNWIND $rows AS r MATCH (a:Page {id: r.s}), (b:Page {id: r.t}) CREATE (a)-[:REDIRECTS_TO]->(b)',
    Object.values(pages).filter(p => p.redirectedTo).map(p => ({ s: p.id, t: p.redirectedTo })));
  await batch('UNWIND $rows AS r MATCH (a:Action {id: r.a}), (i:Interaction {id: r.i}) CREATE (a)-[:HAS_RESULT]->(i)',
    Object.values<any>(m.interactions ?? {}).map(i => ({ a: i.actionId, i: i.id })));
  await batch('UNWIND $rows AS r MATCH (i:Interaction {id: r.i}), (p:Page {id: r.p}) CREATE (i)-[:OPENS]->(p)',
    Object.values<any>(m.interactions ?? {}).filter(i => i.resultUrl).map(i => ({ i: i.id, p: pageIdOfUrl(i.resultUrl) })));

  // Variant-specific node and edge types.
  const extraNodes: ExtraNode[] = (m.extraNodes ?? []).filter((n: ExtraNode) => NAME.test(n.label));
  const byLabel = new Map<string, ExtraNode[]>();
  for (const n of extraNodes) byLabel.set(n.label, [...(byLabel.get(n.label) ?? []), n]);
  for (const [label, list] of byLabel) {
    await query(`CREATE INDEX ON :${label}(id)`).catch(() => undefined);
    await batch(`UNWIND $rows AS r CREATE (n:${label}) SET n = r`, list.map(n => toProps({ ...n.props, id: n.id })));
  }
  const extraEdges: ExtraEdge[] = (m.extraEdges ?? []).filter((e: ExtraEdge) =>
    NAME.test(e.type) && NAME.test(e.from?.label) && NAME.test(e.to?.label));
  const byShape = new Map<string, ExtraEdge[]>();
  for (const e of extraEdges) {
    const key = `${e.from.label}|${e.type}|${e.to.label}`;
    byShape.set(key, [...(byShape.get(key) ?? []), e]);
  }
  for (const [key, list] of byShape) {
    const [fl, type, tl] = key.split('|');
    await batch(`UNWIND $rows AS r MATCH (a:${fl} {id: r.f}), (b:${tl} {id: r.t}) CREATE (a)-[e:${type}]->(b) SET e = r.props`,
      list.map(e => ({ f: e.from.id, t: e.to.id, props: toProps(e.props) })));
  }

  const counts = await query<{ label: string; n: number }>('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n');
  return Object.fromEntries(counts.map(c => [c.label, c.n]));
}
