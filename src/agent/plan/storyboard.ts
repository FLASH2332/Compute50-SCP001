import type { AppMap } from '../core/appMap.js';
import type { Approver, TextModel } from '../core/ports.js';
import type { Flow } from './flows.js';

export interface Shot {
  id: string;
  flowId: string;            // '' for the intro shot
  stepIds: string[];
  startState: string;
  intent: string;
  targetSec: number;
  chapter: string;
  title: string;
}

export interface Storyboard {
  goal: string;
  audience: string;
  targetSec: number;
  shots: Shot[];
  approved: boolean;
  approvedActions: string[];  // mutating actions the approval covers (A1.11)
  why?: string;
}

const MAX_STEPS_PER_SHOT = 4;
const MIN_SHOT_SEC = 3;

/** Chapter of a state: the page's title (until A3.4 Features exist). */
export function chapterOf(graph: AppMap, stateId: string): string {
  const s = graph.states[stateId];
  return (s?.title || s?.template || 'App').split(/[·|–-]/)[0].trim();
}

/** Plan phase: intro shot plus one shot per ≤4 steps; seconds split by step count. */
export function buildStoryboard(goal: string, audience: string, targetSec: number, flows: Flow[], graph: AppMap, startState: string): Storyboard {
  const map = graph;
  const shots: Shot[] = [];
  const startTitle = chapterOf(graph, startState);
  shots.push({ id: 'shot1', flowId: '', stepIds: [], startState, intent: `This is ${startTitle}.`, targetSec: MIN_SHOT_SEC, chapter: startTitle, title: 'Intro' });
  for (const f of flows) {
    // Each shot is its own take, so a flow that fills a form stays in one shot
    // (typed values would be gone in a fresh take). Only click-only flows are split.
    const per = f.steps.some(s => s.op !== 'click') || f.source === 'dialog' ? f.steps.length : MAX_STEPS_PER_SHOT;
    for (let i = 0; i < f.steps.length; i += per) {
      const chunk = f.steps.slice(i, i + per);
      shots.push({
        id: `shot${shots.length + 1}`, flowId: f.id, stepIds: chunk.map(s => s.id), startState: chunk[0].from || f.startState,
        intent: chunk.map(s => s.intent).join(', then '), targetSec: 0, chapter: chapterOf(graph, chunk[0].from || f.startState),
        title: f.steps.length > per ? `${f.name} (${i / per + 1})` : f.name
      });
    }
  }
  // Group shots by chapter, keeping first-appearance order (intro stays first)
  const chapters = [...new Set(shots.slice(1).map(s => s.chapter))];
  const body = shots.slice(1).sort((a, b) => chapters.indexOf(a.chapter) - chapters.indexOf(b.chapter));
  shots.splice(1, shots.length, ...body);
  shots.forEach((s, i) => { s.id = `shot${i + 1}`; });
  allocate(shots, flows, targetSec);
  const steps = new Map(flows.flatMap(f => f.steps).map(s => [s.id, s]));
  const approvedActions = [...new Set(shots.flatMap(s => s.stepIds).map(id => steps.get(id)!.actionId).filter(id => map.controls[id]?.risk && map.controls[id].risk !== 'safe'))];
  return { goal, audience, targetSec, shots, approved: false, approvedActions };
}

export function allocate(shots: Shot[], flows: Flow[], targetSec: number) {
  const steps = new Map(flows.flatMap(f => f.steps).map(s => [s.id, s]));
  const weight = (s: Shot) => 1 + s.stepIds.reduce((t, id) => t + (steps.get(id)?.op === 'fill' ? 1.4 : 1), 0);
  const rest = shots.filter(s => s.flowId);
  const intro = shots.find(s => !s.flowId);
  const budget = Math.max(targetSec - (intro ? MIN_SHOT_SEC : 0), rest.length * MIN_SHOT_SEC);
  const total = rest.reduce((t, s) => t + weight(s), 0) || 1;
  for (const s of rest) s.targetSec = Math.max(MIN_SHOT_SEC, Math.round((budget * weight(s)) / total * 10) / 10);
  if (intro) intro.targetSec = MIN_SHOT_SEC;
}

export function formatStoryboard(sb: Storyboard, flows: Flow[]): string {
  const steps = new Map(flows.flatMap(f => f.steps).map(s => [s.id, s]));
  const lines = [`Storyboard for "${sb.goal}"${sb.audience ? ` (audience: ${sb.audience})` : ''}, about ${sb.targetSec}s`];
  if (sb.why) lines.push(`  why: ${sb.why}`);
  let chapter = '';
  for (const s of sb.shots) {
    if (s.chapter !== chapter) { chapter = s.chapter; lines.push(`  ── ${chapter}`); }
    lines.push(`  ${s.id.padEnd(7)} ${String(s.targetSec).padStart(5)}s  ${s.title}`);
    for (const id of s.stepIds) lines.push(`             · ${steps.get(id)?.intent}`);
  }
  if (sb.approvedActions.length) lines.push(`  Note: approving lets the recording press ${sb.approvedActions.length} control(s) that change data in the app (submit/save).`);
  return lines.join('\n');
}

export const APPROVAL = /^\s*(approve|approved|lgtm|yes|y|ok|okay|ship it|go|looks good)\s*[.!]*\s*$/i;

/** Applies a change request; LLM if available, else a few simple commands. */
export async function reviseStoryboard(sb: Storyboard, request: string, flows: Flow[], llm?: TextModel): Promise<string> {
  const drop = request.match(/(?:drop|remove|delete|cut)\s+(?:shot\s*)?(\d+)/i);
  const secs = request.match(/(\d+)\s*(?:s|sec|seconds?)\b/i) || request.match(/(\d+)\s*min/i);
  if (drop) {
    const id = `shot${drop[1]}`;
    sb.shots = sb.shots.filter(s => s.id !== id);
    allocate(sb.shots, flows, sb.targetSec);
    return `Removed ${id}.`;
  }
  if (secs) {
    sb.targetSec = /min/i.test(secs[0]) ? Number(secs[1]) * 60 : Number(secs[1]);
    allocate(sb.shots, flows, sb.targetSec);
    return `Length set to ${sb.targetSec}s.`;
  }
  if (llm) {
    const r = await llm.json<{ keep: string[]; targetSec?: number; titles?: Record<string, string> }>(
      'Revise a demo storyboard per the request. Return the shot ids to keep in the new order, optionally a new total length and new shot titles. Return {"keep": ["shot1", ...], "targetSec": 60, "titles": {"shot2": "..."}}.',
      JSON.stringify({ request, targetSec: sb.targetSec, shots: sb.shots.map(s => ({ id: s.id, title: s.title, intent: s.intent })) })
    ).catch(() => null);
    if (r?.keep?.length) {
      sb.shots = r.keep.map(id => sb.shots.find(s => s.id === id)).filter((s): s is Shot => !!s);
      if (r.targetSec) sb.targetSec = r.targetSec;
      for (const [id, t] of Object.entries(r.titles || {})) { const s = sb.shots.find(x => x.id === id); if (s) s.title = t; }
      allocate(sb.shots, flows, sb.targetSec);
      return 'Storyboard revised.';
    }
  }
  return 'I could not apply that. Try "drop 3", "90 seconds", or approve.';
}

/** Approval gate: show the storyboard through the Approver, apply change requests until approved. */
export async function approveStoryboard(sb: Storyboard, flows: Flow[], approver: Approver, llm?: TextModel, log: (m: string) => void = () => {}): Promise<Storyboard> {
  for (let round = 0; round < 20; round++) {
    const answer = await approver.storyboard(formatStoryboard(sb, flows));
    if (APPROVAL.test(answer)) { sb.approved = true; return sb; }
    log(await reviseStoryboard(sb, answer, flows, llm));
  }
  throw new Error('Storyboard not approved after 20 rounds.');
}
