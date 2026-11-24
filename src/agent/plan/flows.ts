import type { AppMap, Control, UiState } from '../core/appMap.js';
import type { TextModel } from '../core/ports.js';
import type { Op } from '../nav/navigator.js';

export interface FlowStep {
  id: string;
  op: Op;
  actionId: string;
  label: string;
  value?: string;
  sectionId?: string;        // for show
  from: string;              // state the step starts in ('' = wherever the previous step left us)
  to: string;                // state it must land in ('' = a page found at record time)
  intent: string;
}

export interface Flow {
  id: string;
  name: string;
  summary: string;
  source: 'nav' | 'dialog' | 'tabs' | 'tour' | 'plan';
  startState: string;
  steps: FlowStep[];
  pages: string[];           // page templates it touches
  mutating: boolean;         // ends in a submit/save
  broken?: boolean;          // B3: a step's control went missing
  takes?: { n: number; ok: number };
}

const terms = (value: string) => [...new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
const filler = new Set(['show', 'walk', 'through', 'with', 'demo', 'make', 'create', 'about', 'the', 'how', 'and', 'for', 'this', 'that', 'from', 'new', 'minute', 'minutes', 'min', 'seconds', 'video', 'app']);
/** Goal words that carry meaning (ported from attic/demo-screen-based/plan.ts). */
export function promptTerms(prompt: string): string[] {
  return terms(prompt).filter(w => !filler.has(w) && !/^\d+$/.test(w));
}

export const quote = (s: string) => `“${s.replace(/^\+\s*/, '')}”`;

/** Demo values for form fields; passwords are never filled. */
export function demoValue(a: Control): { op: Op; value?: string } | null {
  const l = a.label.toLowerCase();
  if (a.type === 'select') return { op: 'select' };
  if (a.type === 'choice') return { op: 'check' };
  if (a.type !== 'input') return null;
  switch (a.inputType) {
    case 'password': case 'file': return null;
    case 'email': return { op: 'fill', value: 'jordan@acme.test' };
    case 'number': case 'range': return { op: 'fill', value: /amount|price|total|\$/.test(l) ? '2500' : '3' };
    case 'tel': return { op: 'fill', value: '+1 555 0100' };
    case 'url': return { op: 'fill', value: 'https://acme.test' };
    case 'date': return { op: 'fill', value: '2026-12-01' };
    case 'search': return { op: 'fill', value: 'invoice' };
  }
  if (/email/.test(l)) return { op: 'fill', value: 'jordan@acme.test' };
  if (/client|company|customer|organi[sz]ation/.test(l)) return { op: 'fill', value: 'Cyberdyne Systems' };
  if (/name/.test(l)) return { op: 'fill', value: 'Jordan Lee' };
  return { op: 'fill', value: 'Quarterly retainer' };
}

function intentOf(op: Op, label: string, value?: string): string {
  if (op === 'fill') return `Enter ${value} in ${quote(label)}`;
  if (op === 'select') return `Choose an option in ${quote(label)}`;
  if (op === 'check') return `Tick ${quote(label)}`;
  return `Click ${quote(label)}`;
}

/** Candidate flows built from observed edges only (no guessing from labels). */
export function candidateFlows(graph: AppMap, startUrlTemplate?: string): Flow[] {
  const map = graph;
  const flows: Flow[] = [];
  const states = graph.states;
  const edges = Object.values(graph.edges).filter(e => e.status === 'ok');
  const order = new Map(Object.keys(map.controls).map((id, i) => [id, i]));
  let n = 0;
  const step = (op: Op, a: Control, from: string, to: string, value?: string): FlowStep =>
    ({ id: `st${++n}`, op, actionId: a.id, label: a.label, value, from, to, intent: intentOf(op, a.label, value) });

  // 1. Dialog flows: opener → fields → submit (or close)
  const seenDialogs = new Set<string>();
  for (const e of edges) {
    const from = states[e.from], to = states[e.to];
    if (e.kind !== 'click' || !from || !to || !to.dialog || from.dialog || seenDialogs.has(to.template + to.dialog)) continue;
    if (graph.baseStateOf(from.template)?.id !== from.id && edges.some(x => x.to === e.to && x.from === graph.baseStateOf(from.template)?.id)) continue;
    seenDialogs.add(to.template + to.dialog);
    const opener = map.controls[e.actionId];
    const inFrom = new Set(from.visibleActions);
    // The dialog's own controls: newly visible, and in a section that is hidden on the plain page
    const own = to.visibleActions.filter(id => !inFrom.has(id)).map(id => map.controls[id])
      .filter(a => a && (a.section?.hidden || a.section?.role === 'dialog'))
      .sort((a, b) => (order.get(a.id)! - order.get(b.id)!));
    const steps = [step('click', opener, from.id, to.id)];
    for (const f of own) {
      const v = demoValue(f);
      if (v) steps.push(step(v.op, f, to.id, to.id, v.value));
    }
    const submit = own.find(a => a.type === 'submit');
    const close = edges.find(x => x.from === to.id && !states[x.to]?.dialog && x.kind === 'click');
    if (submit) steps.push(step('click', submit, to.id, from.id));
    else if (close) steps.push(step('click', map.controls[close.actionId], to.id, close.to));
    flows.push({ id: `flow_dialog_${flows.length + 1}`, name: opener.label.replace(/^\+\s*/, ''), summary: `Open "${to.dialog}" and fill it in`, source: 'dialog',
      startState: from.id, steps, pages: [from.template], mutating: !!submit });
  }

  // 2. Tab tours: base state → each other tab in order
  const bases = Object.values(states).filter(s => !s.dialog && graph.baseStateOf(s.template)?.id === s.id);
  for (const base of bases) {
    const tabEdges = edges.filter(e => e.from === base.id && e.kind === 'click' && map.controls[e.actionId]?.type === 'tab' && states[e.to]?.template === base.template);
    if (!tabEdges.length) continue;
    const targets = tabEdges.map(e => states[e.to]).sort((a, b) => (order.get(edgeTo(edges, base.id, a.id)!) ?? 0) - (order.get(edgeTo(edges, base.id, b.id)!) ?? 0));
    const steps: FlowStep[] = [];
    let cur = base.id;
    for (const t of targets) {
      const e = edges.find(x => x.from === cur && x.to === t.id && x.kind === 'click');
      if (!e) continue;
      steps.push(step('click', map.controls[e.actionId], cur, t.id));
      cur = t.id;
    }
    if (steps.length) flows.push({ id: `flow_tabs_${flows.length + 1}`, name: `${base.title.split('·')[0].trim()} tabs: ${steps.map(s => s.label).join(', ')}`, summary: `Switch between the ${steps.length + 1} tabs`, source: 'tabs', startState: base.id, steps, pages: [base.template], mutating: false });
  }

  // 3. Navigation: start page → every other page, and one tour through all of them
  const start = (startUrlTemplate && graph.baseStateOf(startUrlTemplate)) || bases[0];
  const linkPath = (from: string, to: string): FlowStep[] | null => {
    const prev = new Map<string, typeof edges[number]>();
    const q = [from]; const seen = new Set(q);
    while (q.length) {
      const cur = q.shift()!;
      if (cur === to) break;
      for (const e of edges.filter(x => x.from === cur && x.kind === 'link')) if (!seen.has(e.to)) { seen.add(e.to); prev.set(e.to, e); q.push(e.to); }
    }
    if (!prev.has(to)) return null;
    const out: FlowStep[] = [];
    for (let c = to; c !== from;) { const e = prev.get(c)!; out.unshift(step('click', map.controls[e.actionId], e.from, e.to)); c = e.from; }
    return out;
  };
  if (start) {
    const tour: FlowStep[] = [];
    let cur = start.id;
    for (const b of bases) {
      if (b.id === start.id) continue;
      const p = linkPath(start.id, b.id);
      if (p) flows.push({ id: `flow_nav_${flows.length + 1}`, name: `Open ${b.title.split('·')[0].trim()}`, summary: `Go from ${start.title} to ${b.title}`, source: 'nav', startState: start.id, steps: p, pages: [start.template, b.template], mutating: false });
      const leg = linkPath(cur, b.id);
      if (leg) { tour.push(...leg); cur = b.id; }
    }
    if (tour.length > 1) flows.push({ id: `flow_tour_${flows.length + 1}`, name: 'Tour of the app', summary: `Visit ${tour.length + 1} pages`, source: 'tour', startState: start.id, steps: tour, pages: [...new Set(tour.map(s => states[s.to].template))], mutating: false });
  }
  return flows;
}

function edgeTo(edges: { from: string; to: string; actionId: string }[], from: string, to: string) {
  return edges.find(e => e.from === from && e.to === to)?.actionId;
}

/** Fallback for vague goals (A3.3 stand-in until graph scores exist): coverage, dialogs, past success. */
export function demoScore(f: Flow): number {
  const success = f.takes?.n ? f.takes.ok / f.takes.n : 1;
  return 0.5 * Math.min(1, f.pages.length / 3) + 0.3 * (f.source === 'dialog' ? 1 : f.source === 'tabs' ? 0.5 : 0) + 0.2 * success;
}

export const estSeconds = (f: Flow) => 3 + f.steps.reduce((t, s) => t + (s.op === 'fill' ? 3.5 : 2.5), 0);

/**
 * Picks the flows for a goal. With an LLM: it chooses and orders them.
 * Without: goal words matched against flow names, labels and page titles;
 * a goal with no matches is "vague" and falls back to demoScore.
 */
export async function findFlows(goal: string, audience: string, targetSec: number, flows: Flow[], states: Record<string, UiState>, llm?: TextModel): Promise<{ flows: Flow[]; vague: boolean; why: string }> {
  const usable = flows.filter(f => !f.broken);
  if (llm) {
    const reply = await llm.json<{ flowIds: string[]; vague: boolean; why: string }>(
      'You plan product demo videos. Pick the flows (in demo order) that best serve the goal and audience within the time budget. Prefer fewer, complete flows. Set vague=true if the goal names no specific task. Return {"flowIds": [...], "vague": false, "why": "..."}.',
      JSON.stringify({ goal, audience, targetSeconds: targetSec, flows: usable.map(f => ({ id: f.id, name: f.name, summary: f.summary, steps: f.steps.map(s => s.intent), estSeconds: estSeconds(f) })) })
    ).catch(() => null);
    const picked = reply?.flowIds?.map(id => usable.find(f => f.id === id)).filter((f): f is Flow => !!f) || [];
    if (picked.length) return { flows: picked, vague: !!reply!.vague, why: reply!.why || '' };
  }
  const words = promptTerms(`${goal} ${audience}`);
  const text = (f: Flow) => terms([f.name, f.summary, ...f.steps.map(s => s.label), ...f.steps.map(s => states[s.to]?.title || '')].join(' ')).join(' ');
  const scored = usable.map(f => ({ f, s: words.filter(w => text(f).includes(w)).length })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.f.steps.length - b.f.steps.length);
  const vague = scored.length === 0;
  const ranked = vague ? [...usable].sort((a, b) => demoScore(b) - demoScore(a)) : scored.map(x => x.f);
  const out: Flow[] = [];
  let t = 4;
  const actions = (f: Flow) => f.steps.map(s => s.actionId).join('>');
  for (const f of ranked) {
    if (out.length && t + estSeconds(f) > targetSec * 1.15) continue;
    // Skip a flow that another picked flow already shows (or that already shows it)
    if (out.some(o => actions(o).includes(actions(f)) || actions(f).includes(actions(o)))) continue;
    out.push(f);
    t += estSeconds(f);
    if (!vague && out.length >= scored.length) break;
  }
  return { flows: out, vague, why: vague ? 'No flow matched the goal; picked the highest demo_score flows that fit the time.' : `Matched goal words: ${words.join(', ')}` };
}
