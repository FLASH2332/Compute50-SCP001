/**
 * Onboarding, phase "Show": a short narrated clip of the route, made with the
 * demo agent's own recorder, voice and renderer (one storyboard shot). The
 * same answer for the same map reuses its clip instead of recording again.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppMap } from '../core/appMap.js';
import type { Services } from '../core/ports.js';
import { renderTimeline } from '../media/render.js';
import { PRESETS } from '../media/timeline.js';
import { voiceTimeline } from '../media/voice.js';
import { Gate } from '../nav/gate.js';
import { modeFor } from '../nav/risk.js';
import { estSeconds, type Flow } from '../plan/flows.js';
import { chapterOf } from '../plan/storyboard.js';
import { closeRunner, recordBest, type RunnerEnv } from '../record/runner.js';
import { Run } from '../run/agent.js';

export interface Clip { file: string; duration: number; cached: boolean; dir: string }

/** Same site + same steps → same clip. */
export function clipKey(map: AppMap, flow: Flow): string {
  const sig = flow.steps.map(s => `${s.op}:${s.actionId || s.sectionId || s.value}:${s.to}`).join('>');
  let origin = map.startUrl;
  try { origin = new URL(map.startUrl).origin; } catch { /* keep */ }
  return createHash('sha256').update(`${origin}|${sig}`).digest('hex').slice(0, 16);
}

export interface ShowOptions {
  runsDir: string;
  headless?: boolean;
  browserChannel?: string;
  storageState?: string;
  question: string;
}

export async function showClip(map: AppMap, flow: Flow, services: Services, opts: ShowOptions): Promise<Clip> {
  const dir = path.join(opts.runsDir, 'onboarding', clipKey(map, flow));
  const done = path.join(dir, 'clip.json');
  if (fs.existsSync(done)) {
    const saved = JSON.parse(fs.readFileSync(done, 'utf8')) as Clip;
    if (fs.existsSync(saved.file)) return { ...saved, cached: true };
  }

  const run = new Run(dir);
  run.map = map;
  run.flows = [flow];
  const targetSec = Math.min(30, Math.max(6, estSeconds(flow)));
  run.storyboard = {
    goal: opts.question, audience: 'new user', targetSec, approved: true, approvedActions: [],
    shots: [{ id: 'shot1', flowId: flow.id, stepIds: flow.steps.map(s => s.id), startState: flow.startState, intent: flow.steps.map(s => s.intent).join(', then '), targetSec, chapter: chapterOf(map, flow.startState), title: flow.name }]
  };
  run.state = {
    runId: path.basename(dir), goal: opts.question, audience: 'new user', seconds: targetSec, phase: 'record', style: 'calm', version: 0, takes: {}, findings: [], notes: [],
    options: { takes: 1, headless: opts.headless ?? true, extras: false, browserChannel: opts.browserChannel, storageState: opts.storageState }
  };

  // Answers only browse: no approvals, so the gate lets nothing risky through
  const env: RunnerEnv = {
    runDir: run.dir, map, changes: run.changes, flows: run.flows,
    gate: new Gate(new Set(), new Set(), modeFor(map.startUrl)),
    headless: run.state.options.headless, browserChannel: opts.browserChannel, storageState: opts.storageState,
    log: services.log, hooks: services.hooks, llm: services.llm, vision: services.vision
  };
  try {
    run.state.takes.shot1 = await recordBest(env, run.storyboard.shots[0], 1);
  } finally {
    await closeRunner(env);
  }
  const take = run.state.takes.shot1;
  if (!take.ok) throw new Error(`Recording the answer failed: ${take.error || 'a step did not pass'}`);

  const preset = PRESETS.calm;
  await run.ensureScript(services.llm);
  const { tl } = run.buildTimeline(preset);
  await voiceTimeline(tl, run.lineContexts(), preset, run.dir, { speech: services.speech, llm: services.llm });
  const r = await renderTimeline(run.dir, tl, { name: 'answer', extras: false });
  run.save();
  const clip: Clip = { file: r.mp4, duration: r.duration, cached: false, dir };
  fs.writeFileSync(done, JSON.stringify(clip, null, 2));
  return clip;
}
