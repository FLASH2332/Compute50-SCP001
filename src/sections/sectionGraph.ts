import type { Interaction, PageSection, SectionAction, SectionGraphModel, SiteLink, SitePage } from './types.js';

const suffixSeparator = /\s+[|\-·]\s+/;

function decodeLabel(text: string): string {
  try { return decodeURIComponent(text); } catch {
    return text.replace(/(?:%[\da-f]{2})+/gi, encoded => new URLSearchParams('label=' + encoded).get('label')!);
  }
}

function clipLabel(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : text;
}

function pathLabel(pathname: string): string {
  return pathname === '/' ? 'Home' : clipLabel(decodeLabel(pathname).replace(/\s+/g, ' '), 32);
}

function cleanLabel(text: string): string {
  const tokens = /https?(?::\/\/|%3a%2f%2f)[^\s<>"']+|(?<![^\s:(])(?:\/|%2f)[^\s<>"']*|(?:%[\da-f]{2})+/gi;
  return text.replace(tokens, token => {
    if (!/^(?:https?(?::\/\/|%3a%2f%2f)|\/|%2f)/i.test(token)) return decodeLabel(token);
    const url = /^(?:https?%3a|%2f)/i.test(token) ? decodeLabel(token) : token;
    try { return pathLabel(new URL(url, 'https://label.invalid').pathname); }
    catch { return pathLabel(url.split(/[?#]/, 1)[0]); }
  }).replace(/\s+/g, ' ').trim();
}

function pageTitle(page: SitePage): string {
  const title = page.title?.trim() || '';
  return /^https?:\/\/\S+$/i.test(title) || title === page.url ? '' : title;
}

function commonTitleSuffix(pages: SitePage[]): string | undefined {
  const counts = new Map<string, number>();
  const titles = pages.map(pageTitle).filter(Boolean);
  for (const title of titles) {
    const parts = title.split(suffixSeparator);
    // A synthetic pagination title can end in "· Page 2" after the site name.
    if (parts.length > 1 && /^Page \d+$/i.test(parts.at(-1)!)) parts.pop();
    if (parts.length < 2) continue;
    const suffix = parts.at(-1)!.toLowerCase();
    counts.set(suffix, (counts.get(suffix) || 0) + 1);
  }
  return [...counts].find(([, count]) => count >= 2 && count > titles.length / 2)?.[0];
}

function stripTitleSuffix(title: string, suffix?: string): string {
  const parts = title.split(suffixSeparator);
  const separators = title.match(/\s+[|\-·]\s+/g) ?? [];
  const index = parts.length - (/^Page \d+$/i.test(parts.at(-1)!) ? 2 : 1);
  if (index <= 0 || parts[index].toLowerCase() !== suffix) return title;
  return parts.map((part, i) => i === index ? '' : (i ? separators[i - 1] : '') + part).join('');
}

function redirectHint(url?: URL): string {
  for (const key of ['next', 'redirect', 'return']) {
    const target = url?.searchParams.get(key);
    if (!target) continue;
    try {
      const segment = new URL(target, url).pathname.split('/').filter(Boolean).at(-1);
      if (segment) return clipLabel(decodeLabel(segment).replace(/[^\p{L}\p{N}._ -]/gu, '').trim(), 20);
    } catch { /* Try the next parameter. */ }
  }
  return '';
}

function pageLabels(pages: SitePage[], suffix?: string): Map<string, string> {
  const groups = new Map<string, { id: string; hint: string }[]>();
  for (const page of pages) {
    let url: URL | undefined;
    try { url = new URL(page.url); } catch { /* An invalid URL has no path or query. */ }
    const title = cleanLabel(stripTitleSuffix(pageTitle(page), suffix));
    const path = url ? pathLabel(url.pathname) : 'Unknown path';
    const label = title ? `${title}\n${path}` : path;
    const group = groups.get(label) ?? [];
    group.push({ id: page.id, hint: redirectHint(url) });
    groups.set(label, group);
  }
  const labels = new Map<string, string>();
  const used = new Set(groups.keys());
  for (const [label, group] of groups) {
    let number = 2;
    for (const [index, { id, hint }] of group.entries()) {
      const hinted = hint ? `${label} (from: ${hint})` : '';
      let unique = group.length > 1 && hinted && !used.has(hinted) ? hinted : label;
      if (index > 0 && unique === label) {
        do { unique = `${label} (${number++})`; } while (used.has(unique));
      }
      used.add(unique);
      labels.set(id, unique);
    }
  }
  return labels;
}

export class SectionGraph {
  private model: SectionGraphModel = { startUrl: '', domain: '', pages: {}, sections: {}, actions: {} };

  clear(startUrl = '', domain = ''): void {
    this.model = { startUrl, domain, pages: {}, sections: {}, actions: {} };
  }

  /** Records what clicking buttons on a page did (replaces earlier results for that page). */
  setInteractions(pageId: string, list: Interaction[]): void {
    const all = this.model.interactions ?? (this.model.interactions = {});
    for (const [id, it] of Object.entries(all)) if (it.pageId === pageId) delete all[id];
    for (const it of list) all[it.id] = it;
  }

  getModel(): SectionGraphModel {
    return this.model;
  }

  pageList() {
    return Object.values(this.model.pages).filter(p => p.crawled)
      .map(({ id, title, url, status, depth }) => ({ id, title, url, status, depth }));
  }

  pageDetails(id: string) {
    const { pages, sections, actions, links } = this.model;
    if (!Object.hasOwn(pages, id) || !pages[id].crawled) return undefined;
    const own = Object.values(sections).filter(s => s.pageId === id).sort((a, b) => a.order - b.order);
    const ids = new Set(own.map(s => s.id));
    return {
      sections: own,
      actions: Object.values(actions).filter(a => ids.has(a.sectionId)),
      links: (links ?? []).filter(link => link.source === id).map(link => {
        const destination = pages[link.target];
        const target = destination?.redirectedTo ? pages[destination.redirectedTo] : destination;
        return { label: link.label, url: link.url, next: link.next, status: target?.status ?? 'not-crawled',
          opened: !!target?.crawled, title: target?.pagination ? target.title : undefined };
      })
    };
  }

  addLink(link: SiteLink): void {
    (this.model.links ??= []).push(link);
  }

  addRedirect(source: string, target: string, url: string, depth: number): void {
    this.addLinkedPage(source, url, depth);
    this.model.pages[source].redirectedTo = target;
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
      linkedPagesCount: pages.filter(p => !p.crawled && !p.redirectedTo).length,
      sectionsCount: Object.keys(this.model.sections).length,
      actionsCount: Object.keys(this.model.actions).length,
      linksCount: navEdges
    };
  }

  /**
   * Cytoscape elements.
   *  - 'sections': pages + their sections (repeated menus/footers drawn once),
   *                and one arrow per page from the section that first links to it
   *  - 'pages':    opened pages only, one arrow per page pair (site map)
   *  (Actions are not drawn: select a section to see them in the inspector.)
   */
  toCytoscape(mode: 'sections' | 'pages' = 'sections') {
    const nodes: any[] = [];
    const edges: any[] = [];
    const { pages, sections, actions } = this.model;
    const allPages = Object.values(pages);
    const suffix = commonTitleSuffix(allPages);
    // Only pages that were opened are drawn; links to unopened pages stay in the data
    const visiblePages = allPages.filter(page => page.crawled);
    const labels = pageLabels(visiblePages, suffix);

    for (const p of visiblePages) {
      let path = p.url;
      try { const u = new URL(p.url); path = u.pathname + u.search; } catch { /* keep */ }
      nodes.push({
        group: 'nodes',
        data: { id: p.id, label: labels.get(p.id), type: 'Page', url: p.url, path, title: p.title, crawled: p.crawled, status: p.status, error: p.error, depth: p.depth, hasScreenshot: !!p.screenshotBase64 },
        classes: p.crawled ? (p.status === 'ok' ? 'node-page' : 'node-page node-page-blocked') : 'node-page node-page-linked'
      });
    }

    if (mode === 'pages') {
      const seen = new Map<string, number>();
      const links = this.model.links ?? Object.values(actions).map(a => ({
        source: sections[a.sectionId]?.pageId, target: a.navigatesTo, next: false
      }));
      const pagination = new Set<string>();
      // Menu/footer links appear on most pages and point everywhere; drawing
      // them turns the site map into a web. A link (same text, same target)
      // found on at least 60% of opened pages (min 3) is a menu link: not drawn.
      const opened = Object.values(pages).filter(p => p.crawled).length;
      const menuThreshold = Math.max(3, Math.ceil(opened * 0.6));
      const sourcesOf = new Map<string, Set<string>>();
      for (const link of links) {
        if (!link.source || !link.target) continue;
        const key = `${(link as { label?: string }).label ?? ''}|${pages[link.target]?.redirectedTo || link.target}`;
        sourcesOf.set(key, (sourcesOf.get(key) ?? new Set()).add(link.source));
      }
      const isMenu = (link: { source?: string; target?: string; label?: string; next?: boolean }) =>
        !link.next && (sourcesOf.get(`${link.label ?? ''}|${pages[link.target!]?.redirectedTo || link.target}`)?.size ?? 0) >= menuThreshold;
      for (const link of links) {
        if (isMenu(link as any)) continue;
        const target = link.target && (pages[link.target]?.redirectedTo || link.target);
        if (!link.source || !target || link.source === target || !pages[target]?.crawled || !pages[link.source]?.crawled) continue;
        const key = JSON.stringify([link.source, target]);
        seen.set(key, (seen.get(key) || 0) + 1);
        if (link.next) pagination.add(key);
      }
      for (const [key, n] of seen) {
        const [source, target] = JSON.parse(key);
        edges.push({ group: 'edges', data: { id: `nav-${key}`, source, target, label: pagination.has(key) ? 'Next page' : n > 1 ? `${n} links` : 'link', type: 'NAVIGATES_TO' }, classes: 'edge-nav' });
      }
      return [...nodes, ...edges];
    }

    // Pages in the order they were reached (start page first)
    const crawled = Object.values(pages).filter(p => p.crawled)
      .sort((x, y) => x.depth - y.depth || x.discoveredAt.localeCompare(y.discoveredAt));
    const actionsBySection = new Map<string, SectionAction[]>();
    const firstRoute = new Map<string, Map<string, SectionAction>>();
    for (const a of Object.values(actions)) {
      const controls = actionsBySection.get(a.sectionId);
      if (controls) controls.push(a);
      else actionsBySection.set(a.sectionId, [a]);
      const source = sections[a.sectionId]?.pageId;
      if (source && a.navigatesTo && pages[a.navigatesTo]?.crawled) {
        let routes = firstRoute.get(source);
        if (!routes) firstRoute.set(source, routes = new Map());
        if (!routes.has(a.navigatesTo)) routes.set(a.navigatesTo, a);
      }
    }

    // 1. Sections that repeat on every page (menu, footer, cookie bar) are
    //    drawn once, on the first page they appear on; later copies are skipped.
    const signature = (sec: PageSection) => {
      const controls = actionsBySection.get(sec.id);
      return sec.role + '|' + (controls?.length ? controls.map(a => `${a.type}:${a.label}:${a.href || ''}`).sort().join('|') : sec.name);
    };
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
      const name = cleanLabel(stripTitleSuffix(sec.name, suffix));
      nodes.push({
        group: 'nodes',
        data: {
          id: sec.id, type: 'Section',
          label: `${name.startsWith(sec.role + ':') ? name : `${sec.role}: ${name}`}
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
        via = firstRoute.get(parent.id)?.get(page.id);
        if (via) break;
      }
      placed.add(page.id);
      if (!via) {
        const discovered = this.model.links?.find(link =>
          (pages[link.target]?.redirectedTo || link.target) === page.id && link.source !== page.id && placed.has(link.source));
        if (discovered) edges.push({
          group: 'edges',
          data: { id: `observed-${page.id}`, source: discovered.source, target: page.id, type: 'NAVIGATES_TO', label: discovered.next ? 'Next page' : discovered.label.slice(0, 24) },
          classes: 'edge-nav'
        });
        continue;
      }
      const fromSection = drawn.get(via.sectionId);
      edges.push({
        group: 'edges',
        data: { id: `nav-${via.id}-${page.id}`, source: fromSection ? fromSection.id : sections[via.sectionId].pageId, target: page.id, type: 'NAVIGATES_TO', label: via.label.slice(0, 24), actions: [via.label] },
        classes: 'edge-nav'
      });
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
  for (const link of model.links ?? []) {
    lines.push(`MATCH (p:Page {url: ${q(link.source)}}), (t:Page {url: ${q(link.target)}}) MERGE (p)-[r:LINKS_TO]->(t) SET r.label = ${q(link.label)}, r.nextPage = ${link.next}, r.via = ${q(link.via || 'link')};`);
  }
  return lines.join('\n') + '\n';
}
