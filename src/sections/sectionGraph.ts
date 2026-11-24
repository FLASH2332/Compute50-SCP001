import type { PageSection, SectionAction, SectionGraphModel, SitePage } from './types.js';

export class SectionGraph {
  private model: SectionGraphModel = { startUrl: '', domain: '', pages: {}, sections: {}, actions: {} };

  clear(startUrl = '', domain = ''): void {
    this.model = { startUrl, domain, pages: {}, sections: {}, actions: {} };
  }

  getModel(): SectionGraphModel {
    return this.model;
  }

  /** Adds a page we only know through a link (not opened yet). */
  addLinkedPage(id: string, url: string, depth: number): void {
    if (this.model.pages[id]) return;
    this.model.pages[id] = { id, url, title: url, depth, crawled: false, status: 'not-crawled', discoveredAt: new Date().toISOString() };
  }

  /** Stores a crawled page and replaces its sections/actions (re-crawl safe). */
  setPage(page: SitePage, sections: PageSection[], actions: SectionAction[]): void {
    const oldSections = Object.values(this.model.sections).filter(s => s.pageId === page.id).map(s => s.id);
    for (const sid of oldSections) {
      delete this.model.sections[sid];
      for (const a of Object.values(this.model.actions)) if (a.sectionId === sid) delete this.model.actions[a.id];
    }
    this.model.pages[page.id] = page;
    for (const s of sections) this.model.sections[s.id] = s;
    for (const a of actions) this.model.actions[a.id] = a;
  }

  stats() {
    const pages = Object.values(this.model.pages);
    const navEdges = Object.values(this.model.actions).filter(a => a.navigatesTo).length;
    return {
      pagesCount: pages.filter(p => p.crawled).length,
      linkedPagesCount: pages.filter(p => !p.crawled).length,
      sectionsCount: Object.keys(this.model.sections).length,
      actionsCount: Object.keys(this.model.actions).length,
      linksCount: navEdges
    };
  }

  /**
   * Cytoscape elements.
   *  - 'sections': pages + their sections (repeated menus/footers drawn once),
   *                and one arrow per page from the section that first links to it
   *  - 'actions':  also every action under the drawn sections
   *  - 'pages':    pages only, page -> page arrows (site map)
   */
  toCytoscape(mode: 'sections' | 'actions' | 'pages' = 'sections') {
    const nodes: any[] = [];
    const edges: any[] = [];
    const { pages, sections, actions } = this.model;

    for (const p of Object.values(pages)) {
      // Pages that were only linked (not opened) clutter the section views;
      // they appear in the site map view only.
      if (!p.crawled && mode !== 'pages') continue;
      let path = p.url;
      try { const u = new URL(p.url); path = u.pathname + u.search; } catch { /* keep */ }
      nodes.push({
        group: 'nodes',
        data: { id: p.id, label: p.crawled ? `${p.title || path}\n${path}` : path, type: 'Page', url: p.url, path, title: p.title, crawled: p.crawled, status: p.status, error: p.error, depth: p.depth, hasScreenshot: !!p.screenshotBase64 },
        classes: p.crawled ? (p.status === 'ok' ? 'node-page' : 'node-page node-page-blocked') : 'node-page node-page-linked'
      });
    }

    if (mode === 'pages') {
      const seen = new Map<string, number>();
      for (const a of Object.values(actions)) {
        if (!a.navigatesTo) continue;
        const from = sections[a.sectionId]?.pageId;
        if (!from || from === a.navigatesTo || !pages[a.navigatesTo]) continue;
        const key = `${from}->${a.navigatesTo}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      for (const [key, n] of seen) {
        const [source, target] = key.split('->');
        edges.push({ group: 'edges', data: { id: `nav-${key}`, source, target, label: n > 1 ? `${n} links` : 'link', type: 'NAVIGATES_TO' }, classes: 'edge-nav' });
      }
      return [...nodes, ...edges];
    }

    // Pages in the order they were reached (start page first)
    const crawled = Object.values(pages).filter(p => p.crawled)
      .sort((x, y) => x.depth - y.depth || x.discoveredAt.localeCompare(y.discoveredAt));
    const actionsBySection = new Map<string, SectionAction[]>();
    for (const a of Object.values(actions)) actionsBySection.set(a.sectionId, [...(actionsBySection.get(a.sectionId) || []), a]);

    // 1. Sections that repeat on every page (menu, footer, cookie bar) are
    //    drawn once, on the first page they appear on; later copies are skipped.
    const signature = (sec: PageSection) => sec.role + '|' + (actionsBySection.get(sec.id) || []).map(a => `${a.type}:${a.label}:${a.href || ''}`).sort().join('|');
    const firstBySig = new Map<string, PageSection>();
    const drawn = new Map<string, PageSection>();   // section id -> drawn section (itself or its first copy)
    const repeats = new Map<string, number>();      // drawn section id -> pages it repeats on
    for (const page of crawled) {
      const own = Object.values(sections).filter(sec => sec.pageId === page.id).sort((x, y) => x.order - y.order);
      for (const sec of own) {
        const sig = signature(sec);
        const first = firstBySig.get(sig);
        if (first) {
          drawn.set(sec.id, first);
          repeats.set(first.id, (repeats.get(first.id) || 1) + 1);
          continue;
        }
        firstBySig.set(sig, sec);
        drawn.set(sec.id, sec);
      }
    }
    for (const sec of firstBySig.values()) {
      const shared = repeats.get(sec.id);
      nodes.push({
        group: 'nodes',
        data: {
          id: sec.id, type: 'Section',
          label: `${sec.name.startsWith(sec.role + ':') ? sec.name : `${sec.role}: ${sec.name}`}
${sec.actionCount} action${sec.actionCount === 1 ? '' : 's'}${sec.totalActions > sec.actionCount ? ` (of ${sec.totalActions})` : ''}${shared ? ` · on ${shared} pages` : ''}`,
          name: sec.name, role: sec.role, pageId: sec.pageId, summary: sec.summary, hidden: sec.hidden,
          actionCount: sec.actionCount, totalActions: sec.totalActions, sharedOnPages: shared || 1
        },
        classes: `node-section node-section-${sec.role}${sec.hidden ? ' node-section-hidden' : ''}${shared ? ' node-section-shared' : ''}`
      });
      edges.push({ group: 'edges', data: { id: `has-${sec.id}`, source: sec.pageId, target: sec.id, type: 'HAS_SECTION', label: '' }, classes: 'edge-has-section' });
    }

    // 2. One arrow per page: from the section that first linked to it.
    //    (Every link is still in the model, the Inspector and the site map.)
    const placed = new Set<string>(crawled.length ? [crawled[0].id] : []);
    for (const page of crawled.slice(1)) {
      let via: SectionAction | undefined;
      for (const parent of crawled) {
        if (!placed.has(parent.id) || parent.depth >= page.depth) continue;
        via = Object.values(actions).find(a => a.navigatesTo === page.id && sections[a.sectionId]?.pageId === parent.id);
        if (via) break;
      }
      placed.add(page.id);
      if (!via) continue;
      const fromSection = drawn.get(via.sectionId);
      edges.push({
        group: 'edges',
        data: { id: `nav-${via.id}-${page.id}`, source: fromSection ? fromSection.id : sections[via.sectionId].pageId, target: page.id, type: 'NAVIGATES_TO', label: via.label.slice(0, 24), actions: [via.label] },
        classes: 'edge-nav'
      });
    }

    // 3. Actions view: actions of the drawn sections only
    if (mode === 'actions') {
      for (const sec of firstBySig.values()) {
        for (const a of actionsBySection.get(sec.id) || []) {
          nodes.push({
            group: 'nodes',
            data: { id: a.id, type: 'Action', label: `${a.label}${a.groupSize ? ` (×${a.groupSize})` : ''}`, actionType: a.type, inputType: a.inputType, selector: a.selector, href: a.href, external: a.external, visible: a.visible, groupSize: a.groupSize },
            classes: `node-action node-action-${a.type}`
          });
          edges.push({ group: 'edges', data: { id: `hasact-${a.id}`, source: sec.id, target: a.id, type: 'HAS_ACTION', label: '' }, classes: 'edge-has-action' });
        }
      }
    }
    return [...nodes, ...edges];
  }
}

const q = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Cypher script (works in Neo4j and Memgraph). Idempotent: MERGE on ids, and
 * each crawled page's old sections/actions are removed first so re-imports
 * don't leave stale nodes behind.
 */
export function sectionGraphToCypher(model: SectionGraphModel): string {
  const lines: string[] = [
    '// Website section graph',
    '// (:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(:Action)-[:NAVIGATES_TO]->(:Page)',
    `// Start URL: ${model.startUrl}`,
    ''
  ];
  for (const p of Object.values(model.pages)) {
    lines.push(`MERGE (p:Page {url: ${q(p.id)}}) SET p.title = ${q(p.title)}, p.loadedUrl = ${q(p.url)}, p.crawled = ${p.crawled}, p.status = ${q(p.status)}, p.depth = ${p.depth};`);
    if (p.crawled) lines.push(`MATCH (p:Page {url: ${q(p.id)}})-[:HAS_SECTION]->(s:Section) OPTIONAL MATCH (s)-[:HAS_ACTION]->(a:Action) DETACH DELETE s, a;`);
  }
  for (const s of Object.values(model.sections)) {
    lines.push(`MATCH (p:Page {url: ${q(s.pageId)}}) MERGE (s:Section {id: ${q(s.id)}}) SET s.name = ${q(s.name)}, s.role = ${q(s.role)}, s.order = ${s.order}, s.hidden = ${s.hidden}, s.summary = ${q(s.summary)}, s.actionCount = ${s.actionCount}, s.totalActions = ${s.totalActions} MERGE (p)-[:HAS_SECTION]->(s);`);
  }
  for (const a of Object.values(model.actions)) {
    lines.push(`MATCH (s:Section {id: ${q(a.sectionId)}}) MERGE (a:Action {id: ${q(a.id)}}) SET a.label = ${q(a.label)}, a.type = ${q(a.type)}, a.inputType = ${q(a.inputType)}, a.selector = ${q(a.selector)}, a.href = ${q(a.href)}, a.external = ${q(a.external ?? false)}, a.visible = ${a.visible}, a.groupSize = ${q(a.groupSize ?? 1)} MERGE (s)-[:HAS_ACTION]->(a);`);
    if (a.navigatesTo) lines.push(`MATCH (a:Action {id: ${q(a.id)}}), (t:Page {url: ${q(a.navigatesTo)}}) MERGE (a)-[:NAVIGATES_TO]->(t);`);
  }
  return lines.join('\n') + '\n';
}
