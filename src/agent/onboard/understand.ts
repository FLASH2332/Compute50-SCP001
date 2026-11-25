/**
 * Onboarding, phase "Understand": question → a route in the AppMap, or "no path".
 *
 * Reads only the AppMap (src/agent/core/appMap.ts), so it works with any graph
 * an adapter can turn into one: the section graph JSON, a crawl, or the map
 * saved in Memgraph / Neo4j. A model (any TextModel port) picks the target;
 * every reference it returns is checked against the map, and the route comes
 * from AppMap.route(), never from the model. Never invents steps.
 */
import { urlTemplate, type AppMap, type Control, type RouteStep } from '../core/appMap.js';
import type { TextModel } from '../core/ports.js';

export const NOT_FOUND = "I can't find that in this app.";

/** One thing the question can point at. */
export interface Ref {
  ref: string;                 // P1, S1, A1, D1 (stable within one map)
  kind: 'page' | 'section' | 'control' | 'state';
  label: string;               // on-screen name
  aliases: string[];           // earlier names of the control (renamed buttons)
  text: string;                // one line for the model
  state: string;               // UI state the answer must reach
  show?: { sectionId: string; label: string; actionId?: string }; // last step: point at this (not clicked)
}

export interface Route {
  start: string;               // start state id
  target: string;              // state reached
  steps: RouteStep[];          // from AppMap.route()
  show?: Ref['show'];
  cost: number;
}

export type Understood =
  | { found: true; route: Route; reason: string; by: string; refs: string[] }
  | { found: false; message: string; reason: string; by: string };

const FILLER = new Set(['how', 'do', 'does', 'i', 'can', 'we', 'to', 'the', 'a', 'an', 'in', 'on', 'at', 'for', 'of', 'my', 'your', 'this', 'that', 'with', 'about', 'show', 'where', 'is', 'are', 'me', 'what', 'find', 'get']);
// Questions about actions an onboarding answer must never walk through
const DESTRUCTIVE = /\b(delete|remove|cancel|destroy|close my account|unsubscribe|deactivate)\b/i;

export const terms = (value: string) =>
  [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter(w => !FILLER.has(w));

/** The start state: the base state of the start URL's page. */
export function startState(map: AppMap): string | undefined {
  return map.baseStateOf(urlTemplate(map.startUrl))?.id
    ?? Object.values(map.states).find(s => s.base)?.id
    ?? Object.keys(map.states)[0];
}

/** Numbered references for every page, visible section, control and opened dialog/tab state. */
export function buildRefs(map: AppMap): Ref[] {
  const refs: Ref[] = [];
  let p = 0, s = 0, a = 0, d = 0;
  const okEdges = Object.values(map.edges).filter(e => e.status === 'ok');
  const pages = Object.values(map.pages);
  const startTpl = urlTemplate(map.startUrl);
  pages.sort((x, y) => Number(y.template === startTpl) - Number(x.template === startTpl));
  const pageRef = new Map<string, string>();

  for (const page of pages) {
    const base = map.baseStateOf(page.template);
    if (!base) continue;
    const pr = `P${++p}`;
    pageRef.set(page.id, pr);
    refs.push({ ref: pr, kind: 'page', label: page.title, aliases: [], state: base.id, text: `${pr} page "${page.title}" ${pathOf(page.url)}` });

    for (const sec of map.sectionsOfPage(page.id).filter(x => !x.hidden)) {
      const sr = `S${++s}`;
      refs.push({ ref: sr, kind: 'section', label: sec.name, aliases: [], state: base.id, show: { sectionId: sec.id, label: sec.name },
        text: `${sr} section "${sec.name}" (${sec.role}) on ${pr}${sec.summary ? ` - ${sec.summary.slice(0, 100)}` : ''}` });
    }

    for (const c of map.controlsOfPage(page.id).filter(x => x.visible && x.status !== 'missing')) {
      const ar = `A${++a}`;
      // A control whose effect was observed leads to that state; otherwise the
      // answer ends by pointing at it on its page (e.g. "Sign In" is never clicked).
      const edge = okEdges.find(e => e.actionId === c.id && e.from === base.id) ?? okEdges.find(e => e.actionId === c.id);
      // A control whose only recorded effects are broken (failed repeatedly) is
      // never offered: pointing at it would send the user to a dead button.
      const brokenOnly = !edge && Object.values(map.edges).some(e => e.actionId === c.id && e.status === 'broken');
      const target = brokenOnly ? '' : edge && edge.to !== base.id ? edge.to : base.id;
      const show = !brokenOnly && target === base.id && c.section?.id ? { sectionId: c.section.id, label: c.label, actionId: c.id } : undefined;
      refs.push({ ref: ar, kind: 'control', label: c.label, aliases: c.aliases ?? [], state: target, show,
        text: `${ar} ${c.type} "${c.label}"${c.aliases?.length ? ` (was ${c.aliases.map(x => `"${x}"`).join(', ')})` : ''}${c.section ? ` in "${c.section.name}"` : ''} on ${pr}${edge ? ` -> ${describe(map, edge.to)}` : ''}` });
    }
  }

  for (const st of Object.values(map.states)) {
    if (!st.dialog && !st.tab) continue;
    const dr = `D${++d}`;
    const page = map.pages[st.pageId];
    refs.push({ ref: dr, kind: 'state', label: st.dialog || st.tab, aliases: [], state: st.id,
      text: `${dr} ${st.dialog ? `dialog "${st.dialog}"` : `tab "${st.tab}"`} on ${page ? pageRef.get(page.id) ?? page.title : st.title}` });
  }
  return refs;
}

const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };
function describe(map: AppMap, stateId: string): string {
  const st = map.states[stateId];
  if (!st) return stateId;
  return st.dialog ? `opens "${st.dialog}"` : st.tab ? `shows tab "${st.tab}"` : `goes to "${st.title}"`;
}

/** How well a reference's on-screen label (or alias) answers the question. */
export function relevance(question: string, r: Ref): number {
  const wanted = terms(question);
  if (!wanted.length) return 0;
  const q = ' ' + question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
  const near = (w: string, t: string) => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t));
  let best = 0;
  for (const name of [r.label, ...r.aliases]) {
    const label = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const lt = terms(name);
    const overlap = wanted.filter(w => lt.some(t => near(w, t))).length;
    const coverage = lt.length ? lt.filter(t => wanted.some(w => near(w, t))).length / lt.length : 0;
    const exact = label.length >= 3 && q.includes(' ' + label + ' ') ? 10 : 0;
    best = Math.max(best, exact + overlap * 2 + coverage * 3);
  }
  const ctx = terms(r.text).filter(t => wanted.some(w => near(w, t))).length * 0.5;
  return best + ctx;
}

/** Keyword fallback: a real label match (exact phrase, or half the label's words). */
export function keywordTargets(question: string, refs: Ref[]): string[] {
  const wanted = terms(question);
  if (!wanted.length) return [];
  const strong = refs.map(r => {
    const score = relevance(question, r);
    const ok = [r.label, ...r.aliases].some(name => {
      const lt = terms(name);
      return lt.length > 0 && lt.filter(t => wanted.some(w => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t)))).length / lt.length >= 0.5;
    });
    return { r, score, ok: ok || score >= 10 };
  }).filter(x => x.ok && x.score > 0).sort((a, b) => b.score - a.score);
  if (!strong.length) return [];
  return strong.filter(x => x.score >= strong[0].score - 0.01).map(x => x.r.ref);
}

/** Site map for the model, kept under a size budget (pages and dialogs first, then most relevant). */
export function siteMapText(question: string, refs: Ref[], budget = 18000): string {
  const all = refs.map(r => r.text).join('\n');
  if (all.length <= budget) return all;
  const keep = new Set<number>();
  let used = 0;
  const take = (i: number) => { const n = refs[i].text.length + 1; if (!keep.has(i) && used + n <= budget) { keep.add(i); used += n; } };
  refs.forEach((r, i) => { if (r.kind === 'page' || r.kind === 'state') take(i); });
  refs.map((r, i) => ({ i, v: relevance(question, r) })).sort((x, y) => y.v - x.v).forEach(x => take(x.i));
  return [...keep].sort((x, y) => x - y).map(i => refs[i].text).join('\n');
}

const SYSTEM = [
  'You are an onboarding guide for a web app. You get a user question and a site map of pages (P#),',
  'sections (S#), controls (A#) with what they do, and dialogs or tabs (D#).',
  'Return the refs a new user should reach to do what they ask, best first: {"targets":["A1"],"reason":"..."}.',
  'Prefer the control that does the task over the page it is on. Only use refs from the map.',
  'If nothing in the map does what they ask, return {"targets":[],"reason":"not found"}. Never invent refs.'
].join(' ');

/** Cheapest route to each candidate; a candidate already at the start only wins if nothing else is reachable. */
export function bestRoute(map: AppMap, start: string, candidates: Ref[]): Route | null {
  let best: Route | null = null;
  let here: Route | null = null;
  for (const c of candidates) {
    // Same control on several pages (menus): every copy is a candidate, the cheapest wins
    const copies = c.kind === 'control' && c.show
      ? Object.values(map.controls).filter(x => x.visible && x.label.trim().toLowerCase() === c.label.trim().toLowerCase() && x.section?.id)
        .map(x => ({ state: map.baseStateOf(map.pages[x.pageId]?.template ?? '')?.id, show: { sectionId: x.section!.id!, label: x.label, actionId: x.id } }))
        .filter(x => !!x.state) as { state: string; show: { sectionId: string; label: string; actionId?: string } }[]
      : [{ state: c.state, show: c.show }];
    for (const copy of copies) {
      const steps = map.route(start, copy.state);
      if (!steps) continue;
      const cost = steps.reduce((t, s) => t + (s.kind === 'edge' ? s.edge.cost : 4), 0) + (copy.show ? 1 : 0);
      const r: Route = { start, target: copy.state, steps, show: copy.show, cost };
      if (!steps.length && !copy.show) { here ??= r; continue; }
      if (!best || cost < best.cost) best = r;
    }
  }
  return best ?? here;
}

/** Question → route, using the model when there is one and keyword rules otherwise. */
export async function understand(map: AppMap, question: string, llm?: TextModel): Promise<Understood> {
  const refs = buildRefs(map);
  const byRef = new Map(refs.map(r => [r.ref, r]));
  const start = startState(map);
  if (!start) return { found: false, message: NOT_FOUND, reason: 'The map has no start page.', by: 'rules' };
  if (DESTRUCTIVE.test(question) && !refs.some(r => DESTRUCTIVE.test(r.label))) {
    return { found: false, message: NOT_FOUND, reason: 'No such action in the map.', by: 'rules' };
  }

  let picked: string[] = [];
  let reason = '';
  let by = 'keyword rules';
  if (llm) {
    try {
      const reply = await llm.json<{ targets?: unknown; reason?: unknown }>(SYSTEM, JSON.stringify({ question, siteMap: siteMapText(question, refs) }));
      picked = Array.isArray(reply.targets) ? reply.targets.map(String) : [];
      reason = String(reply.reason ?? '');
      by = 'model';
      if (!picked.length) return { found: false, message: NOT_FOUND, reason: reason || 'The model found nothing that does this.', by };
    } catch (err) {
      // Never hide a model failure: say why the keyword rules answered instead
      reason = `model unavailable (${(err instanceof Error ? err.message : String(err)).slice(0, 140)}); `;
    }
  }
  if (by === 'keyword rules') {
    picked = keywordTargets(question, refs);
    reason += picked.length ? 'matched on-screen names' : 'no on-screen name matched';
  }

  const candidates = picked.map(r => byRef.get(r.trim().toUpperCase())).filter((r): r is Ref => !!r);
  if (!candidates.length) return { found: false, message: NOT_FOUND, reason: reason || 'Unknown references.', by };
  const route = bestRoute(map, start, candidates);
  if (!route) return { found: false, message: NOT_FOUND, reason: 'No recorded route reaches it.', by };
  return { found: true, route, reason, by, refs: candidates.map(c => c.ref) };
}

/** Label of a control, for steps and checks. */
export const labelOf = (c: Control | undefined) => c?.label ?? '';
