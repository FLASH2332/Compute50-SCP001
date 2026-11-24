/**
 * Adapter: the section graph (src/sections, demo-studio) → the agent's AppMap.
 *
 * This is the ONLY agent file that imports the graph engine. Swap it for
 * another adapter (a Memgraph query, another crawler) and the agent is
 * unchanged.
 *
 *   (:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(:Action)   → pages + controls
 *   links (page → page)                                            → link edges
 *   interactions (what a probed button did: dialog / navigate)     → seeded states + edges
 */
import fs from 'node:fs';
import { SectionCrawler, pageIdOf } from '../../sections/sectionCrawler.js';
import { SectionGraph } from '../../sections/sectionGraph.js';
import { dismissCookieBanner, preventFormSubmission } from '../../sections/interactions.js';
import type { SectionGraphModel } from '../../sections/types.js';
import { AppMap, stateIdOf, urlTemplate, type Control, type ControlType, type UiState } from '../core/appMap.js';
import type { BrowserHooks, MapSource } from '../core/ports.js';
import { similarity } from '../nav/locate.js';
import { riskOf } from '../nav/risk.js';

export function appMapFromSectionGraph(model: SectionGraphModel): AppMap {
  const resolve = (id: string) => model.pages[id]?.redirectedTo || id;
  const map = new AppMap({ source: 'section-graph', startUrl: model.pages[resolve(pageIdOf(model.startUrl))]?.url || model.startUrl });

  for (const p of Object.values(model.pages)) {
    if (!p.crawled || p.status !== 'ok' || p.redirectedTo) continue;
    map.pages[p.id] = { id: p.id, url: p.url, title: p.title, template: urlTemplate(p.url) };
  }
  for (const sec of Object.values(model.sections)) {
    if (!map.pages[sec.pageId]) continue;
    map.sections[sec.id] = { id: sec.id, pageId: sec.pageId, name: sec.name, role: sec.role, hidden: sec.hidden, order: sec.order, selector: sec.regionSelector, summary: sec.summary };
  }
  for (const a of Object.values(model.actions)) {
    const sec = model.sections[a.sectionId];
    if (!sec || !map.pages[sec.pageId]) continue;
    const target = a.navigatesTo ? resolve(a.navigatesTo) : undefined;
    const c: Control = {
      id: a.id, pageId: sec.pageId, label: a.label, type: a.type as ControlType, inputType: a.inputType, selector: a.selector,
      href: a.href, navigatesTo: target && map.pages[target] ? target : undefined, visible: a.visible,
      section: { id: sec.id, name: sec.name, role: sec.role, hidden: sec.hidden }
    };
    c.risk = riskOf(c, sec.role);
    map.controls[c.id] = c;
  }

  // Seeded states: each page as it loads, plus the dialogs its probed buttons opened
  const base = new Map<string, UiState>();
  for (const p of Object.values(map.pages)) {
    const own = map.controlsOfPage(p.id);
    const s = map.addState({ id: stateIdOf(p.template, '', ''), template: p.template, pageId: p.id, url: p.url, title: p.title, dialog: '', tab: '',
      visibleActions: own.filter(c => c.visible && !c.section?.hidden).map(c => c.id), base: true, seeded: true });
    base.set(p.id, s);
  }
  for (const it of Object.values(model.interactions || {})) {
    const from = base.get(it.pageId);
    const control = map.controls[it.actionId];
    if (!from || !control) continue;
    if (it.kind === 'dialog') {
      const name = it.result.match(/^Opens "(.*)"$/)?.[1] || it.label;
      const own = map.controlsOfPage(it.pageId).filter(c => c.section?.hidden);
      const close = own.filter(c => c.section && similarity(c.section.name, name) >= 0.5);
      const d = map.addState({ id: stateIdOf(from.template, name, ''), template: from.template, pageId: from.pageId, url: from.url, title: from.title, dialog: name, tab: '',
        visibleActions: [...from.visibleActions, ...(close.length ? close : own).map(c => c.id)], seeded: true });
      map.addEdge(from.id, d.id, control.id, 'click', control.risk || 'safe');
    } else if (it.kind === 'navigate' && it.resultUrl) {
      const to = base.get(resolve(pageIdOf(it.resultUrl)));
      if (to) map.addEdge(from.id, to.id, control.id, 'click', control.risk || 'safe');
    }
  }
  return map;
}

/** A graph saved by the studio (.demo-runs/<id>/graph.json) or by SectionGraph.getModel(). */
export function appMapFromGraphFile(file: string): AppMap {
  return appMapFromSectionGraph(JSON.parse(fs.readFileSync(file, 'utf8')) as SectionGraphModel);
}

/** Crawls with the section crawler (read-only, probing buttons), then adapts. */
export function crawlSource(url: string, opts: { maxPages?: number; maxDepth?: number; browserChannel?: string } = {}): MapSource {
  return async log => {
    const graph = new SectionGraph();
    const crawler = new SectionCrawler({ startUrl: url, maxPages: opts.maxPages ?? 20, maxDepth: opts.maxDepth ?? 4, browserChannel: opts.browserChannel,
      readOnly: true, probeClicks: true, buttonPagination: true }, graph);
    crawler.on('crawler_event', e => { if (e.type === 'log') log(e.data.message); if (e.type === 'error') log(`crawl: ${e.data.error}`); });
    await crawler.start();
    return appMapFromSectionGraph(graph.getModel());
  };
}

/** The graph engine's page helpers, offered to the agent as hooks. */
export const sectionGraphHooks: BrowserHooks = {
  exploreInitScripts: [preventFormSubmission],
  afterLoad: page => dismissCookieBanner(page, 1500)
};
