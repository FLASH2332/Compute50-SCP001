/**
 * When the map has no route to what was asked, use the site's own search box:
 * go to the page with the search box, search for the question's key words,
 * open the best-matching result. These are real controls on the site, so
 * nothing is invented; the clip (when recorded) shows what the search found,
 * and the last step then names the result that was actually opened.
 */
import { urlTemplate, type AppMap, type Control } from '../core/appMap.js';
import { isSearchInput } from '../nav/risk.js';
import type { Flow, FlowStep } from '../plan/flows.js';
import { flowFromRoute } from './answer.js';
import { bestRoute, terms } from './understand.js';

// Words that ask for help rather than name the topic
const ASKING = new Set(['find', 'search', 'look', 'looking', 'learn', 'about', 'help', 'want', 'need', 'there', 'any', 'some', 'page', 'site', 'app', 'which', 'when', 'why', 'should', 'would', 'could', 'please']);

/** The topic words of a question ("how do I find a python course?" → "python course"). */
export function searchQuery(question: string, map: AppMap): string {
  const site = new URL(map.startUrl).hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  return terms(question).filter(w => !ASKING.has(w) && w.length > 2 && !site.includes(w)).slice(0, 4).join(' ');
}

/**
 * The site-wide search box. A generic "Search…" in the header beats a narrow one ("Search problems…",
 * "Filter products"), even if the crawl saw it collapsed; then visible ones, then the start page's.
 */
export function searchBox(map: AppMap): Control | undefined {
  const start = map.pageByTemplate(urlTemplate(map.startUrl));
  const score = (c: Control) =>
    (/^(search|search\s*(the\s+)?(site|all)|what are you looking for)\W*$/i.test(c.label.trim()) ? 3 : 0)
    + (['header', 'nav', 'banner'].includes(c.section?.role ?? '') || /^search\b/i.test(c.section?.name ?? '') ? 2 : 0)
    + (c.visible ? 1 : 0) + (c.pageId === start?.id ? 1 : 0);
  const boxes = Object.values(map.controls).filter(c => isSearchInput(c) && !c.section?.hidden && c.status !== 'missing');
  return boxes.sort((a, b) => score(b) - score(a))[0];
}

export function searchFlow(map: AppMap, question: string, start: string): Flow | null {
  const box = searchBox(map);
  const query = searchQuery(question, map);
  const page = box && map.pages[box.pageId];
  const target = page && map.baseStateOf(page.template)?.id;
  if (!box || !query || !target) return null;
  const route = bestRoute(map, start, [{ ref: 'search', kind: 'page', label: page.title, aliases: [], text: '', state: target }]);
  if (!route) return null;
  const flow = flowFromRoute(map, route, question);
  const n = flow.steps.length;
  const steps: FlowStep[] = [
    { id: `ob${n + 1}`, op: 'search', actionId: box.id, label: box.label, value: query, from: target, to: '', intent: `Type ${query} into the search box and press Enter` },
    { id: `ob${n + 2}`, op: 'open_result', actionId: '', label: query, value: query, from: '', to: '', intent: `Open the best result for ${query}` }
  ];
  flow.steps.push(...steps);
  flow.name = `Search for ${query}`;
  return flow;
}
