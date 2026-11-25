/**
 * Onboarding, phase "Answer": the route as a Flow (what the recorder plays)
 * and as short numbered text steps that use the on-screen names.
 */
import type { AppMap } from '../core/appMap.js';
import type { TextModel } from '../core/ports.js';
import { quote, type Flow, type FlowStep } from '../plan/flows.js';
import type { Route } from './understand.js';

/** The route as one Flow: click edges, page loads, and a final "show" for a control that is pointed at. */
export function flowFromRoute(map: AppMap, route: Route, name: string): Flow {
  const steps: FlowStep[] = [];
  let n = 0;
  let cur = route.start;
  for (const s of route.steps) {
    if (s.kind === 'goto') {
      const st = map.states[s.to];
      steps.push({ id: `ob${++n}`, op: 'goto', actionId: '', label: st?.title ?? s.to, value: st?.url, from: cur, to: s.to, intent: `Open ${st?.title ?? 'the page'}` });
      cur = s.to;
    } else {
      const c = map.controls[s.edge.actionId];
      const label = c?.label ?? s.edge.actionId;
      steps.push({ id: `ob${++n}`, op: 'click', actionId: s.edge.actionId, label, from: s.edge.from, to: s.edge.to, intent: `Click ${quote(label)}` });
      cur = s.edge.to;
    }
  }
  if (route.show) {
    steps.push({ id: `ob${++n}`, op: 'show', actionId: route.show.actionId ?? '', label: route.show.label, sectionId: route.show.sectionId, from: cur, to: cur,
      intent: map.sections[route.show.sectionId]?.name === route.show.label ? `Here is ${quote(route.show.label)}` : `Click ${quote(route.show.label)}` });
  }
  const pages = [...new Set(steps.map(s => map.states[s.to]?.template).filter((t): t is string => !!t))];
  return { id: 'flow_onboard', name, summary: name, source: 'plan', startState: route.start, steps, pages, mutating: false };
}

/** Names a step may use: the control's label and its earlier names (aliases). */
export function allowedNames(map: AppMap, flow: Flow): string[] {
  return flow.steps.flatMap(s => [s.label, ...(map.controls[s.actionId]?.aliases ?? [])]).filter(Boolean);
}

/** Plain steps straight from the flow (no model). */
export function baseSteps(map: AppMap, flow: Flow): string[] {
  return flow.steps.map((s, i) => {
    const where = s.op === 'click' ? map.controls[s.actionId]?.section?.name : undefined;
    const text = s.op === 'goto' ? `Open ${s.label}.`
      : s.op === 'search' ? `Type “${s.value}” into the search box and press Enter.`
      : s.op === 'open_result' ? (s.label !== s.value ? `Open ${quote(s.label)}.` : `Open the result that best matches “${s.value}”.`)
      : s.op === 'show' ? (s.intent.startsWith('Here') ? `Go to the ${quote(s.label)} section.` : `Click ${quote(s.label)}.`)
      : where && !/^(nav|header|footer|content|main)\b|:/.test(where) ? `In ${quote(where)}, click ${quote(s.label)}.` : `Click ${quote(s.label)}.`;
    return `${i + 1}. ${text}`;
  });
}

/**
 * Text steps. A model may rephrase them; a rephrased step is kept only if it
 * still names its own step's control (label or alias), otherwise the plain
 * step is used. The number of steps never changes.
 */
export async function answerSteps(map: AppMap, flow: Flow, question: string, llm?: TextModel): Promise<string[]> {
  const plain = baseSteps(map, flow);
  if (!llm || !plain.length) return plain;
  try {
    const reply = await llm.json<{ steps?: unknown }>(
      'Rewrite these numbered onboarding steps to be friendly and short. Keep the same number of steps, in order, and keep every quoted on-screen name exactly. Return {"steps":["1. ..."]}.',
      JSON.stringify({ question, steps: plain })
    );
    const out = Array.isArray(reply.steps) ? reply.steps.map(String) : [];
    if (out.length !== plain.length) return plain;
    return out.map((text, i) => {
      const s = flow.steps[i];
      const names = [s.label, ...(map.controls[s.actionId]?.aliases ?? [])].map(x => x.toLowerCase());
      return names.some(nm => nm && text.toLowerCase().includes(nm)) ? text : plain[i];
    });
  } catch {
    return plain;
  }
}
