import { urlTemplate, type AppMap, type AppPage, type AppSection, type Control } from '../core/appMap.js';
import type { TextModel } from '../core/ports.js';
import { Gate } from '../nav/gate.js';
import { isSearchInput, modeFor } from '../nav/risk.js';
import type { Op } from '../nav/navigator.js';
import { candidateFlows, estSeconds, findFlows, promptTerms, quote, type Flow, type FlowStep } from './flows.js';

/**
 * Plans a demo from the map and the user's request. The plan is a list of
 * steps over the map's own references:
 *
 *   open_page P#        go to a page (by its links when possible)
 *   show_section S#     scroll to a section of the current page and highlight it
 *   flow F#             run a known flow (a dialog form, a tab tour...)
 *   search Q# "query"   type into a search box and press Enter
 *   open_result "text"  click the link on the current page that best matches
 *
 * An LLM writes the plan when one is configured; every reference is checked
 * against the map. Without one (or when its plan is unusable), keyword rules
 * build it. The result is a list of flows the storyboard turns into shots.
 */
export interface PlanStep { kind: 'open_page' | 'show_section' | 'flow' | 'search' | 'open_result'; ref?: string; query?: string; text?: string }
export interface DemoPlan { flows: Flow[]; why: string; by: 'llm' | 'rules'; steps: PlanStep[] }

const SHOWN_ROLES = new Set(['main', 'content', 'form', 'sidebar']);
const TOUR = /\b(all|every|overview|tour|features?|explore|explain|introduce|around|what can|walk ?through|show me around)\b/i;
const SEARCHY = /\b(search|find|look(?:ing)? for|suggest|recommend|course|courses|tutorial|article|learn|about)\b/i;
const NOT_TOPIC = new Set(['help', 'explain', 'introduce', 'then', 'there', 'here', 'all', 'features', 'feature', 'suggest', 'recommend', 'find', 'search', 'look', 'looking', 'explore', 'overview', 'tour', 'website', 'site', 'page', 'pages', 'user', 'timer', 'first', 'good', 'best', 'some', 'any', 'then', 'also', 'give']);

interface Refs {
  pages: Map<string, AppPage>;          // P# → page
  sections: Map<string, AppSection>;    // S# → section
  searches: Map<string, Control>;       // Q# → search box
  flows: Map<string, Flow>;             // F# → flow
  text: string;
}

function buildRefs(map: AppMap, flows: Flow[]): Refs {
  const start = map.pageByTemplate(urlTemplate(map.startUrl));
  const pages = [start, ...Object.values(map.pages).filter(p => p !== start)].filter((p): p is AppPage => !!p).slice(0, 60);
  const refs: Refs = { pages: new Map(), sections: new Map(), searches: new Map(), flows: new Map(), text: '' };
  const lines: string[] = [];
  const q = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').slice(0, 100));
  let si = 0, qi = 0;
  const menu = mainPages(map);
  pages.forEach((p, i) => {
    const P = `P${i + 1}`;
    refs.pages.set(P, p);
    const area = p.areaId && map.areas[p.areaId]?.name;
    lines.push(`${P} ${q(p.title)} ${new URL(p.url).pathname}${menu.get(p.id) === 2 ? ' [main menu]' : menu.has(p.id) ? ' [linked from start]' : ''}${area ? ` [area: ${area}]` : ''}${p.rank !== undefined ? ` [rank ${p.rank.toFixed(2)}]` : ''}`);
    for (const s of map.sectionsOfPage(p.id).filter(s => !s.hidden && SHOWN_ROLES.has(s.role)).slice(0, 12)) {
      const S = `S${++si}`;
      refs.sections.set(S, s);
      lines.push(`  ${S} ${s.role} ${q(s.name)}${s.summary ? ' — ' + q(s.summary) : ''}`);
    }
    for (const c of map.controlsOfPage(p.id).filter(c => isSearchInput(c) && !c.section?.hidden).slice(0, 2)) {
      const Q = `Q${++qi}`;
      refs.searches.set(Q, c);
      lines.push(`  ${Q} search box ${q(c.label)}`);
    }
  });
  flows.filter(f => f.source === 'dialog' || f.source === 'tabs').slice(0, 30).forEach((f, i) => {
    const F = `F${i + 1}`;
    refs.flows.set(F, f);
    const page = [...refs.pages].find(([, p]) => p.id === map.states[f.startState]?.pageId)?.[0] || '?';
    lines.push(`${F} on ${page}: ${q(f.name)} — ${f.steps.map(s => s.intent).join('; ')}`);
  });
  const links = new Set<string>();
  for (const e of Object.values(map.edges)) {
    if (e.kind !== 'link' || e.status !== 'ok') continue;
    const a = [...refs.pages].find(([, p]) => p.id === map.states[e.from]?.pageId)?.[0];
    const b = [...refs.pages].find(([, p]) => p.id === map.states[e.to]?.pageId)?.[0];
    if (a && b && a !== b) links.add(`${a} -> ${b} ${q(map.controls[e.actionId]?.label || '')}`);
  }
  refs.text = [...lines, 'Links:', ...[...links].slice(0, 200)].join('\n');
  return refs;
}

/** Flows the gate would block in this mode (e.g. form submits on a public site) are left out. */
function allowedFlows(map: AppMap, flows: Flow[]): Flow[] {
  const gate = new Gate(new Set(Object.keys(map.controls)), new Set(), modeFor(map.startUrl));
  return flows.filter(f => f.steps.every(s => { try { gate.check(map.controls[s.actionId], s.op); return true; } catch { return false; } }));
}

export async function planDemo(map: AppMap, request: string, audience: string, seconds: number, llm?: TextModel): Promise<DemoPlan> {
  const known = allowedFlows(map, candidateFlows(map, urlTemplate(map.startUrl)));
  const refs = buildRefs(map, known);
  let fallbackWhy = '';
  if (llm) {
    // One retry: a transient API error should not silently drop to keyword rules
    const ask = () => llm.json<{ steps: PlanStep[]; why?: string }>(
      [
        'You plan a short screen-recorded product demo of a website, from a map of the site, for the user\'s request.',
        'Use only these step kinds: open_page {ref:P#}, show_section {ref:S#} (a section of the CURRENT page), flow {ref:F#}, search {ref:Q#, query}, open_result {text}.',
        'Start on P1. Use open_page to move; show_section only for sections listed under the current page.',
        'After search, the results page is not in the map: follow it with open_result {text: what to click}, then you may open_result again on the next page.',
        'Higher [rank] pages are more central; for an overview, show one page per [area].',
        'Cover EVERY part of the request, in the order asked. If it asks for an overview, all features or to explain the site, first visit the main pages ([main menu] / [linked from start], skip pagination) and show each one\'s key section, then do the specific task.',
        `Use the whole time budget: plan about ${Math.max(4, Math.round(seconds / 6))} steps (each step is shown for ~5-7 seconds). Do not invent pages, sections or searches.`,
        'Return {"steps": [...], "why": "one sentence"}, for example {"steps": [{"kind": "open_page", "ref": "P2"}, {"kind": "show_section", "ref": "S5"}, {"kind": "search", "ref": "Q1", "query": "python"}, {"kind": "open_result", "text": "Python Tutorial"}], "why": "..."}.'
      ].join(' '),
      JSON.stringify({ request, audience, seconds, site: map.app?.purpose, areas: Object.values(map.areas).map(a => a.name), map: refs.text })
    );
    let r: { steps: PlanStep[]; why?: string } | null = null;
    for (let i = 0; i < 2 && !r; i++) r = await ask().catch(e => { fallbackWhy = `LLM call failed: ${(e as Error).message.split('\n')[0].slice(0, 160)}`; return null; });
    let steps = normalizeSteps(r?.steps);
    if (r && !steps.length) fallbackWhy = 'the LLM returned no usable steps';
    let why = r?.why || 'Planned by the LLM from the site map.';
    // An overview request must actually tour the site: add the main pages when the plan skipped them
    if (steps.length && TOUR.test(request)) {
      const visited = new Set(steps.filter(x => x.kind === 'open_page').map(x => x.ref));
      const tour = tourSteps(map, refs, Math.max(12, seconds * 0.55));
      const tourPages = tour.filter(x => x.kind === 'open_page' && x.ref !== 'P1').map(x => x.ref);
      if (tourPages.filter(P => visited.has(P)).length < Math.min(2, tourPages.length)) {
        const shown = new Set(tour.map(x => x.ref));
        steps = [...tour, ...steps.filter(x => !((x.kind === 'open_page' || x.kind === 'show_section') && shown.has(x.ref)) && !(x.kind === 'open_page' && x.ref === 'P1'))];
        why += ` Added a tour of ${tourPages.length + 1} main pages first, as the request asks for an overview.`;
      }
    }
    const built = steps.length ? toFlows(map, refs, steps, known) : null;
    if (built && built.flows.length) return { ...built, why, by: 'llm' };
  }
  const rules = await rulesPlan(map, refs, known, request, audience, seconds);
  if (fallbackWhy) rules.why += ` (Used keyword rules because ${fallbackWhy}.)`;
  return rules;
}

const KINDS = ['open_page', 'show_section', 'flow', 'search', 'open_result'] as const;

/** Accepts {kind, ref} and the shorthand models also write, e.g. {"open_page": "P1"} or {"search": "Q1", "query": "x"}. */
export function normalizeSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    let kind = str(o.kind) as PlanStep['kind'] | undefined;
    let ref = str(o.ref);
    let text = str(o.text);
    if (!kind || !(KINDS as readonly string[]).includes(kind)) {
      kind = KINDS.find(k => k in o);
      if (!kind) continue;
      const v = str(o[kind]);
      if (kind === 'open_result') text ??= v; else ref ??= v;
    }
    out.push({ kind, ref, query: str(o.query), text });
  }
  return out;
}

/** Pages linked from the start page: 2 = from its menu/header, 1 = from elsewhere on it. */
function mainPages(map: AppMap): Map<string, number> {
  const start = map.pageByTemplate(urlTemplate(map.startUrl));
  const startBase = start && map.baseStateOf(start.template);
  const out = new Map<string, number>();
  for (const e of Object.values(map.edges)) {
    if (e.kind !== 'link' || e.from !== startBase?.id) continue;
    const pid = map.states[e.to]?.pageId;
    const role = map.controls[e.actionId]?.section?.role || '';
    if (pid && pid !== start?.id) out.set(pid, Math.max(out.get(pid) || 0, ['nav', 'header'].includes(role) ? 2 : 1));
  }
  return out;
}

/** A tour: the start page, then the main pages (menu first; pagination and id pages skipped), each with its key sections. */
function tourSteps(map: AppMap, refs: Refs, seconds: number): PlanStep[] {
  const perPage = 7;
  const menu = mainPages(map);
  const candidates = [...refs.pages].filter(([P, p]) => P === 'P1' || (!p.template.includes('{id}') && !/page \d+/i.test(p.title)));
  // With the graph builder's PageRank: most central pages first; else pages from the start page's menu first
  const ranks = candidates.some(([, p]) => p.rank !== undefined);
  const score = (p: AppPage) => (ranks ? (p.rank ?? 0) : 0) * 10 + (menu.get(p.id) || 0);
  const ordered = candidates.sort(([A, a], [B, b]) => Number(B === 'P1') - Number(A === 'P1') || score(b) - score(a));
  // Cover the app's areas: the best page of each area first, then the rest by rank
  const seen = new Set<string>();
  const firstOfArea = ordered.filter(([P, p]) => { if (P === 'P1' || !p.areaId || seen.has(p.areaId)) return P === 'P1'; seen.add(p.areaId); return true; });
  const ranked = [...firstOfArea, ...ordered.filter(x => !firstOfArea.includes(x))];
  const pages = ranked.map(([P]) => P).slice(0, Math.max(2, Math.floor(seconds / perPage)));
  const steps: PlanStep[] = [];
  for (const P of pages) {
    const page = refs.pages.get(P)!;
    steps.push({ kind: 'open_page', ref: P });
    // The start page gets two sections (it is the overview), the others one
    const secs = [...refs.sections].filter(([, s]) => s.pageId === page.id && (s.role === 'main' || s.role === 'content')).slice(0, P === 'P1' ? 2 : 1);
    for (const [S] of secs) steps.push({ kind: 'show_section', ref: S });
  }
  return steps;
}

/** Keyword rules: tour the main pages for broad requests, search for topics, else match known flows. */
async function rulesPlan(map: AppMap, refs: Refs, known: Flow[], request: string, audience: string, seconds: number): Promise<DemoPlan> {
  const steps: PlanStep[] = [];
  const why: string[] = [];
  // Topic words: drop filler, request words like "explain", and the site's own name ("geeks", "geeksforgeeks")
  const siteWords = promptTerms(`${new URL(map.startUrl).hostname.replace(/^www\./, '').split('.')[0]} ${refs.pages.get('P1')?.title || ''}`);
  const siteName = new URL(map.startUrl).hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  const topic = promptTerms(request).filter(w => !NOT_TOPIC.has(w) && !siteWords.includes(w) && !siteName.includes(w));
  // Prefer a search box on the start page, then any labelled as search
  const startPage = refs.pages.get('P1');
  const search = [...refs.searches].sort(([, a], [, b]) => Number(b.pageId === startPage?.id) - Number(a.pageId === startPage?.id)
    || Number(/search/i.test(b.label)) - Number(/search/i.test(a.label)))[0]?.[0];
  let budget = seconds - 4;
  const wantsSearch = !!search && topic.length > 0 && SEARCHY.test(request);
  const wantsTour = TOUR.test(request) || (!wantsSearch && !topic.length);
  if (wantsTour) {
    const tour = tourSteps(map, refs, wantsSearch ? budget * 0.6 : budget);
    steps.push(...tour);
    budget -= tour.filter(x => x.kind === 'open_page').length * 7;
    why.push(`a tour of ${tour.filter(x => x.kind === 'open_page').length} main page(s)`);
  }
  if (wantsSearch) {
    const query = topic.slice(0, 4).join(' ');
    steps.push({ kind: 'open_page', ref: [...refs.pages].find(([, p]) => p.id === refs.searches.get(search)!.pageId)![0] });
    steps.push({ kind: 'search', ref: search, query }, { kind: 'open_result', text: query });
    why.push(`a search for "${query}" and its best result`);
  } else if (!wantsTour) {
    const picked = await findFlows(request, audience, seconds, known, map.states, undefined, map);
    const F = picked.flows.map(f => [...refs.flows].find(([, g]) => g.id === f.id)?.[0]).filter(Boolean) as string[];
    if (F.length) { steps.push(...F.map(ref => ({ kind: 'flow' as const, ref }))); why.push(picked.why); }
    else return { flows: picked.flows, why: picked.why, by: 'rules', steps: [] };
  }
  const built = toFlows(map, refs, steps, known);
  return { ...built, why: `Keyword plan: ${why.join(', then ')}.`, by: 'rules' };
}

/** Turns plan steps into flows (one per shot), keeping state continuity after searches. */
function toFlows(map: AppMap, refs: Refs, plan: PlanStep[], _known: Flow[]): { flows: Flow[]; steps: PlanStep[] } {
  const flows: Flow[] = [];
  const used: PlanStep[] = [];
  let n = 0;
  const id = () => `pst${++n}`;
  const startPage = map.pageByTemplate(urlTemplate(map.startUrl));
  const baseOf = (p: AppPage) => map.baseStateOf(p.template);
  let cur = startPage && baseOf(startPage)?.id;        // known state we are in, or '' after a search
  let curPage = startPage;
  let chain: Flow | null = null;                       // flow being extended after a search
  let last: Flow | null = null;
  const newFlow = (name: string, startState: string): Flow => {
    const f: Flow = { id: `flow_plan_${flows.length + 1}`, name, summary: name, source: 'plan', startState, steps: [], pages: [], mutating: false };
    flows.push(f);
    last = f;
    return f;
  };
  const step = (op: Op, from: string, to: string, extra: Partial<FlowStep>): FlowStep =>
    ({ id: id(), op, actionId: '', label: '', from, to, intent: '', ...extra });
  const linkPath = (from: string, to: string): FlowStep[] | null => {
    const prev = new Map<string, string>();
    const q = [from];
    const seen = new Set(q);
    while (q.length) {
      const c = q.shift()!;
      if (c === to) break;
      for (const e of Object.values(map.edges)) if (e.from === c && e.kind === 'link' && e.status === 'ok' && !seen.has(e.to)) { seen.add(e.to); prev.set(e.to, e.id); q.push(e.to); }
    }
    if (!prev.has(to)) return null;
    const out: FlowStep[] = [];
    for (let c = to; c !== from;) { const e = map.edges[prev.get(c)!]; const a = map.controls[e.actionId]; out.unshift(step('click', e.from, e.to, { actionId: a.id, label: a.label, intent: `Click ${quote(a.label)}` })); c = e.from; }
    return out;
  };
  const goPage = (p: AppPage) => {
    const target = baseOf(p);
    if (!target) return false;
    if (cur === target.id) return true;
    if (chain || !cur) {
      // After a search we are on a page the map did not know: load the page by URL
      (chain || newFlow(`Open ${p.title}`, target.id)).steps.push(step('goto', '', target.id, { value: p.url, label: p.title, intent: `Go to ${p.title}`, route: true }));
      chain = null;
    } else {
      const path = linkPath(cur, target.id);
      const f = newFlow(`Open ${p.title}`, cur);
      f.steps.push(...(path ? path.map(x => ({ ...x, route: true })) : [step('goto', cur, target.id, { value: p.url, label: p.title, intent: `Go to ${p.title}`, route: true })]));
    }
    cur = target.id;
    curPage = p;
    return true;
  };

  for (const s of plan.slice(0, 30)) {
    if (s.kind === 'open_page') {
      const p = s.ref && refs.pages.get(s.ref);
      if (p && goPage(p)) used.push(s);
    } else if (s.kind === 'show_section') {
      const sec = s.ref && refs.sections.get(s.ref);
      const p = sec && map.pages[sec.pageId];
      if (!sec || !p || (!chain && curPage?.id !== p.id && !goPage(p)) || chain) continue;
      const f: Flow = last && (last as Flow).steps.length && (last as Flow).steps[(last as Flow).steps.length - 1].to === cur ? last : newFlow(`${p.title}: ${sec.name}`, cur!);
      f.steps.push(step('show', cur!, cur!, { sectionId: sec.id, label: sec.name, intent: `Here's the ${quote(sec.name)} section` }));
      used.push(s);
    } else if (s.kind === 'flow') {
      const f = s.ref && refs.flows.get(s.ref);
      if (!f) continue;
      const copy: Flow = JSON.parse(JSON.stringify(f));
      copy.id = `flow_plan_${flows.length + 1}`;
      for (const st of copy.steps) st.id = id();
      flows.push(copy);
      last = copy;
      chain = null;
      cur = copy.steps[copy.steps.length - 1]?.to || copy.startState;
      curPage = map.pages[map.states[cur]?.pageId] || curPage;
      used.push(s);
    } else if (s.kind === 'search') {
      const box = s.ref && refs.searches.get(s.ref);
      const query = (s.query || '').trim().slice(0, 80);
      if (!box || !query) continue;
      const p = map.pages[box.pageId];
      if (!chain && curPage?.id !== p.id && !goPage(p)) continue;
      const from = chain ? '' : cur!;
      const f: Flow = chain || (last && (last as Flow).source === 'plan' && (last as Flow).steps[(last as Flow).steps.length - 1]?.to === cur ? last : newFlow(`Search for ${query}`, cur!));
      f.steps.push(step('search', from, '', { actionId: box.id, label: box.label, value: query, intent: `Type ${query} into the search box and press Enter` }));
      f.name = `Search for ${query}`;
      chain = f;
      cur = '';
      used.push(s);
    } else if (s.kind === 'open_result') {
      const text = (s.text || '').trim().slice(0, 100);
      if (!text) continue;
      const f: Flow | null = chain || (cur ? newFlow(`Open ${text}`, cur) : null);
      if (!f) continue;
      f.steps.push(step('open_result', chain ? '' : cur!, '', { value: text, label: text, intent: `Open the result for ${text}` }));
      chain = f;
      cur = '';
      used.push(s);
    }
  }
  const out = flows.filter(f => f.steps.length);
  for (const f of out) f.pages = [...new Set(f.steps.map(s => map.states[s.to]?.template).filter(Boolean) as string[])];
  return { flows: out, steps: used };
}

export { estSeconds };
