import fs from 'node:fs';

/**
 * AppMap: everything the demo agent knows about an app, in the agent's own
 * terms. Any graph source can feed it through an adapter (see
 * ../adapters/), so the agent never depends on how the graph was built.
 *
 *   pages     the screens that have a URL
 *   controls  what a visitor can press, fill or pick on a page
 *   states    what a page can look like (page + open dialog + selected tab)
 *   edges     which control moves between which states, with its track record
 */

export type ControlType = 'link' | 'button' | 'submit' | 'input' | 'select' | 'choice' | 'tab';
export type Risk = 'safe' | 'mutating' | 'destructive';
export interface Box { x: number; y: number; width: number; height: number }

export interface AppPage {
  id: string;
  url: string;
  title: string;
  template: string;          // URL template: /invoice/123 → /invoice/{id}
  // From the graph builder's analysis (new_graph_base enrich), when present
  rank?: number;             // PageRank
  betweenness?: number;
  areaId?: string;           // the Area this page belongs to
  reachable?: boolean;
  deadEnd?: boolean;
}

/** A named part of the app (a community of pages), from the graph builder. */
export interface AppArea {
  id: string;
  name: string;
  summary?: string;
  pageIds: string[];
  medoid?: string;           // its most central page
}

/** What the site is for, from the graph builder's bootstrap (one model call). */
export interface AppProfile {
  purpose?: string;
  size?: string;
  flows?: string[];
}

/** A part of a page a visitor sees (header, nav, main, a titled block, a dialog...). */
export interface AppSection {
  id: string;
  pageId: string;
  name: string;
  role: string;
  hidden: boolean;
  order: number;
  selector?: string;         // CSS selector of the region, when the source measured one
  summary?: string;
}

export interface Control {
  id: string;
  pageId: string;
  label: string;
  type: ControlType;
  inputType?: string;
  selector: string;
  href?: string;
  navigatesTo?: string;      // page id, for same-site links
  visible: boolean;
  section?: { id?: string; name: string; role: string; hidden: boolean };
  risk?: Risk;
  aliases?: string[];        // earlier labels, kept when the app renames a control
  hits?: Record<string, number>; // locator → times it found this control
  status?: 'ok' | 'missing';
  box?: Box;
  locators?: string[];       // from the graph builder: role=…|name=…, testid=…, css=…, text=…
  samples?: string[];        // list templates: texts of a few items
  count?: number;            // list templates: how many items
}

export interface UiState {
  id: string;
  template: string;
  pageId: string;
  url: string;
  title: string;
  dialog: string;            // open dialog ('' = none)
  tab: string;               // selected tab(s) ('' = none)
  visibleActions: string[];  // control ids visible in this state
  base?: boolean;            // the page as it loads
  preActions?: string[];     // learned fixes to run on arrival (A2.4)
  seeded?: boolean;          // came from the graph source, not seen by the agent yet
}

export type EdgeKind = 'click' | 'link' | 'escape';

export interface ActionEdge {
  id: string;
  from: string;
  to: string;
  actionId: string;
  kind: EdgeKind;
  risk: Risk;
  n: number;
  s: number;
  fails: number;
  reliability: number;       // (s+1)/(n+2)
  cost: number;              // 1 + 2·(−ln reliability) + risk cost
  status: 'ok' | 'broken';   // broken = BROKEN_ACTION, skipped by routing, never deleted
}

export interface AppMapData {
  source: string;            // where the map came from (adapter name)
  startUrl: string;
  pages: Record<string, AppPage>;
  sections: Record<string, AppSection>;
  controls: Record<string, Control>;
  areas: Record<string, AppArea>;
  app?: AppProfile;
  states: Record<string, UiState>;
  edges: Record<string, ActionEdge>;
}

const RISK_COST: Record<Risk, number> = { safe: 0, mutating: 2, destructive: 10 };
export const GOTO_COST = 4;
export const BREAK_AFTER = 3;

export function stateIdOf(template: string, dialog: string, tab: string): string {
  return `${template}|d=${dialog}|t=${tab}`;
}

/** URL template: ids in the path become {id}; query and hash are dropped. */
export function urlTemplate(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Drop tracking tails some sites put in the path itself (/explore&ref=x, /page;jsessionid=y)
    let path = u.pathname.replace(/[&;].*$/, '').replace(/\/index\.html?$/i, '/');
    path = path.split('/').map(seg =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
        || (/^[0-9a-z_-]{16,}$/i.test(seg) && /\d/.test(seg)) ? '{id}' : seg).join('/');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return u.host + path;
  } catch {
    return rawUrl;
  }
}

export type RouteStep = { kind: 'goto'; to: string } | { kind: 'edge'; edge: ActionEdge };

export class AppMap {
  data: AppMapData;

  constructor(data?: Partial<AppMapData>) {
    this.data = { source: 'empty', startUrl: '', pages: {}, sections: {}, controls: {}, areas: {}, states: {}, edges: {}, ...data };
    this.data.areas ??= {};
  }

  static load(file: string): AppMap {
    return new AppMap(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  save(file: string): void {
    fs.writeFileSync(file, JSON.stringify(this.data, null, 2));
  }

  get pages() { return this.data.pages; }
  get controls() { return this.data.controls; }
  get sections() { return this.data.sections; }
  get areas() { return this.data.areas; }
  get app() { return this.data.app; }
  get states() { return this.data.states; }
  get edges() { return this.data.edges; }
  get startUrl() { return this.data.startUrl; }

  controlsOfPage(pageId: string): Control[] {
    return Object.values(this.data.controls).filter(c => c.pageId === pageId);
  }

  sectionsOfPage(pageId: string): AppSection[] {
    return Object.values(this.data.sections).filter(s => s.pageId === pageId).sort((a, b) => a.order - b.order);
  }

  /** Adds a page found while recording (e.g. a search results page) with its base state. */
  addPage(url: string, title: string): { page: AppPage; state: UiState } {
    const template = urlTemplate(url);
    const page = this.pageByTemplate(template) || (this.data.pages[url] = { id: url, url, title, template });
    const state = this.baseStateOf(template) || this.addState({ id: stateIdOf(template, '', ''), template, pageId: page.id, url: page.url, title, dialog: '', tab: '', visibleActions: [], base: true });
    return { page, state };
  }

  pageByTemplate(template: string): AppPage | undefined {
    return Object.values(this.data.pages).find(p => p.template === template);
  }

  addState(s: UiState): UiState {
    const prev = this.data.states[s.id];
    if (prev) {
      prev.visibleActions = [...new Set([...prev.visibleActions, ...s.visibleActions])];
      if (!s.seeded) delete prev.seeded;
      return prev;
    }
    this.data.states[s.id] = s;
    return s;
  }

  /** The page as it loads: no dialog, default tab. */
  baseStateOf(template: string): UiState | undefined {
    const all = Object.values(this.data.states).filter(s => s.template === template && !s.dialog);
    return all.find(s => s.base && !s.seeded) || all.find(s => s.base) || all[0];
  }

  addEdge(from: string, to: string, actionId: string, kind: EdgeKind, risk: Risk): ActionEdge {
    const id = `${from}->${to}::${actionId || kind}`;
    const existing = this.data.edges[id];
    if (existing) return existing;
    const e: ActionEdge = { id, from, to, actionId, kind, risk, n: 0, s: 0, fails: 0, reliability: 0.5, cost: 0, status: 'ok' };
    e.cost = costOf(e);
    this.data.edges[id] = e;
    return e;
  }

  /** Updates reliability and cost after a run; quarantines after repeated failures. */
  record(edgeId: string, ok: boolean): ActionEdge | undefined {
    const e = this.data.edges[edgeId];
    if (!e) return;
    e.n++;
    if (ok) { e.s++; e.fails = 0; if (e.status === 'broken') e.status = 'ok'; } else e.fails++;
    if (e.fails >= BREAK_AFTER) e.status = 'broken';
    e.reliability = (e.s + 1) / (e.n + 2);
    e.cost = costOf(e);
    return e;
  }

  /** Cheapest route (Dijkstra); any page's base state is also reachable by loading its URL. */
  route(fromId: string | null, toId: string, avoid: Set<string> = new Set()): RouteStep[] | null {
    if (!this.data.states[toId]) return null;
    const dist = new Map<string, number>();
    const prev = new Map<string, { node: string; step: RouteStep }>();
    const START = '__start__';
    const origin = fromId && this.data.states[fromId] ? fromId : START;
    dist.set(origin, 0);
    const done = new Set<string>();
    const out = new Map<string, ActionEdge[]>();
    for (const e of Object.values(this.data.edges)) {
      if (e.status === 'broken' || avoid.has(e.id)) continue;
      out.set(e.from, [...(out.get(e.from) || []), e]);
    }
    const bases = Object.values(this.data.states).filter(s => !s.dialog && this.baseStateOf(s.template)?.id === s.id);
    while (true) {
      let node: string | null = null;
      let best = Infinity;
      for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; node = k; }
      if (node === null) return null;
      if (node === toId) break;
      done.add(node);
      const from = node;
      const relax = (to: string, cost: number, step: RouteStep) => {
        if (best + cost < (dist.get(to) ?? Infinity)) { dist.set(to, best + cost); prev.set(to, { node: from, step }); }
      };
      for (const e of out.get(node) || []) relax(e.to, e.cost, { kind: 'edge', edge: e });
      for (const b of bases) if (b.id !== node) relax(b.id, GOTO_COST, { kind: 'goto', to: b.id });
    }
    const steps: RouteStep[] = [];
    for (let n = toId; n !== origin;) {
      const p = prev.get(n);
      if (!p) break;
      steps.unshift(p.step);
      n = p.node;
    }
    return steps;
  }

  /** Cypher for the state layer, matching (:Page {url}) nodes of the section graph. */
  toCypher(): string {
    const q = (v: unknown) => JSON.stringify(v ?? null);
    const lines = ['// UI states and actions', '// (:State)-[:ACTION]->(:State)'];
    for (const s of Object.values(this.data.states)) {
      lines.push(`MERGE (s:State {id: ${q(s.id)}}) SET s.template = ${q(s.template)}, s.url = ${q(s.url)}, s.title = ${q(s.title)}, s.dialog = ${q(s.dialog)}, s.tab = ${q(s.tab)};`);
      lines.push(`MATCH (s:State {id: ${q(s.id)}}), (p:Page {url: ${q(s.pageId)}}) MERGE (s)-[:STATE_OF]->(p);`);
    }
    for (const e of Object.values(this.data.edges)) {
      const rel = e.status === 'broken' ? 'BROKEN_ACTION' : 'ACTION';
      lines.push(`MATCH (a:State {id: ${q(e.from)}}), (b:State {id: ${q(e.to)}}) MERGE (a)-[r:${rel} {id: ${q(e.id)}}]->(b) SET r.actionId = ${q(e.actionId)}, r.kind = ${q(e.kind)}, r.risk = ${q(e.risk)}, r.n = ${e.n}, r.s = ${e.s}, r.reliability = ${e.reliability}, r.cost = ${e.cost};`);
    }
    return lines.join('\n') + '\n';
  }
}

function costOf(e: ActionEdge): number {
  return 1 + 2 * -Math.log(e.reliability) + RISK_COST[e.risk];
}
