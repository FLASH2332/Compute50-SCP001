/**
 * Onboarding questions about the app itself, answered from the graph builder's analysis:
 *
 *   "what can I do here?" / "what is this app for?"   → the app's areas (or main pages), or the current page's parts
 *   "where should I start?"                           → the most central pages (PageRank), best first
 *
 * Text only, built from the map: nothing is invented, every name is on screen or in the graph.
 */
import { urlTemplate, type AppMap, type AppPage } from '../core/appMap.js';
import { startFrom, startState } from './understand.js';

export type OverviewKind = 'what' | 'start';

const WHAT = /\b(what can (i|we|you) do|what (is|does) (this|the) (app|site|website|page)|what('s| is) (here|on this page|this)|overview|what are the (main )?(features|parts|areas)|tour)\b/i;
const START = /\b(where (should|do|can) (i|we) (start|begin)|getting started|how (do|should) (i|we) (start|begin)|first steps?|new here|start here)\b/i;

export function overviewKind(question: string): OverviewKind | undefined {
  if (START.test(question)) return 'start';
  if (WHAT.test(question)) return 'what';
  return undefined;
}

const short = (title: string) => title.split(/\s+[|\-–·]\s+/)[0].trim() || title;

/** Pages ranked by PageRank when the graph has it, else start page first, then by links from it. */
export function centralPages(map: AppMap): AppPage[] {
  const start = map.pageByTemplate(urlTemplate(map.startUrl));
  const pages = Object.values(map.pages).filter(p => !p.template.includes('{id}') && p.reachable !== false);
  const linked = new Set(Object.values(map.edges).filter(e => e.kind === 'link' && e.from === (start && map.baseStateOf(start.template)?.id)).map(e => map.states[e.to]?.pageId));
  return pages.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || Number(linked.has(b.id)) - Number(linked.has(a.id)) || Number(b.id === start?.id) - Number(a.id === start?.id));
}

export interface Overview { lines: string[]; reason: string; target?: string }

export function overview(map: AppMap, kind: OverviewKind, question: string, from?: string): Overview {
  const site = map.app?.purpose ? `${map.app.purpose.replace(/\.$/, '')}. ` : '';
  if (kind === 'start') {
    const top = centralPages(map).slice(0, 3);
    if (!top.length) return { lines: [], reason: 'The map has no pages.' };
    const ranked = top.some(p => p.rank !== undefined);
    return {
      lines: top.map((p, i) => `${i + 1}. ${short(p.title)}${p.areaId && map.areas[p.areaId] ? ` (in ${map.areas[p.areaId].name})` : ''}${i === 0 ? ' — start here' : ''}`),
      reason: `${site}${ranked ? 'The most central pages of the app (PageRank)' : 'The main pages linked from the start page'}`,
      target: map.baseStateOf(top[0].template)?.id
    };
  }
  // "what can I do here?" on a known page: that page's parts; otherwise the whole app
  const here = from ? startFrom(map, from) : undefined;
  const herePage = here?.state && !here.note.startsWith('the page you are on') ? map.pages[map.states[here.state]?.pageId] : undefined;
  if (herePage && /\b(here|this page)\b/i.test(question)) {
    const parts = map.sectionsOfPage(herePage.id).filter(s => !s.hidden && !['nav', 'header', 'footer'].includes(s.role)).slice(0, 6);
    const actions = map.controlsOfPage(herePage.id).filter(c => c.visible && !c.section?.hidden && (c.type === 'button' || c.type === 'tab') && c.risk === 'safe').slice(0, 5);
    const lines = [
      ...parts.map(s => `• ${s.name}${s.summary ? ` — ${s.summary.replace(/^\w+: /, '').slice(0, 80)}` : ''}`),
      ...(actions.length ? [`You can also use: ${actions.map(c => `“${c.label}”`).join(', ')}`] : [])
    ];
    if (lines.length) return { lines, reason: `${site}What is on "${short(herePage.title)}"`, target: here!.state };
  }
  const areas = Object.values(map.areas);
  if (areas.length) {
    const byRank = (a: { pageIds: string[] }) => Math.max(0, ...a.pageIds.map(id => map.pages[id]?.rank ?? 0));
    return {
      lines: areas.sort((a, b) => byRank(b) - byRank(a)).slice(0, 8).map(a => {
        const top = a.pageIds.map(id => map.pages[id]).filter(Boolean).sort((x, y) => (y.rank ?? 0) - (x.rank ?? 0))[0];
        return `• ${a.name}${a.summary && !/^\d+ opened pages/.test(a.summary) ? ` — ${a.summary}` : top ? ` — e.g. ${short(top.title)}` : ''}`;
      }),
      reason: `${site}The app's main areas`
    };
  }
  const pages = centralPages(map).slice(0, 6);
  return { lines: pages.map(p => `• ${short(p.title)}`), reason: `${site}The app's main pages`, target: startState(map) };
}
