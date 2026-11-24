import fs from 'node:fs';
import path from 'node:path';
import type { TextModel } from '../core/ports.js';
import { renderTimeline } from '../media/render.js';
import { layout, loadTimeline, PRESETS, saveTimeline, timelinePath, type Timeline } from '../media/timeline.js';
import { voiceShot } from '../media/voice.js';
import { closeRunner, recordBest } from '../record/runner.js';
import { Run, type DemoAgent } from './agent.js';

export type EditOp = 're-voice' | 'retime' | 're-record';
export interface EditPlan { shotIds: string[]; op: EditOp; factor?: number; direction?: 'shorter' | 'longer'; why: string }

/** Maps a request ("shorten the intro") to the shots it touches and one operation. */
export async function planEdit(request: string, tl: Timeline, llm?: TextModel): Promise<EditPlan> {
  if (llm) {
    const r = await llm.json<EditPlan>(
      'You edit a narrated product demo video. Map the request to the shots it touches and ONE operation: "re-voice" (change narration), "retime" (factor > 1 makes the shot shorter/faster, < 1 longer), or "re-record" (record the screen again). Touch as few shots as possible.',
      JSON.stringify({ request, shots: tl.shots.map(s => ({ id: s.shotId, title: s.title, chapter: s.chapter, seconds: s.outDuration, narration: s.voice?.line })) })
    ).catch(() => null);
    if (r?.shotIds?.length && ['re-voice', 'retime', 're-record'].includes(r.op)) {
      const ids = r.shotIds.filter(id => tl.shots.some(s => s.shotId === id));
      if (ids.length) return { ...r, shotIds: ids };
    }
  }
  const q = request.toLowerCase();
  let ids: string[] = [];
  const n = q.match(/shot\s*(\d+)/);
  if (n) ids = [`shot${n[1]}`];
  else if (/\b(intro|opening|beginning|start)\b/.test(q)) ids = [tl.shots[0].shotId];
  else if (/\b(last|ending|end|outro)\b/.test(q)) ids = [tl.shots[tl.shots.length - 1].shotId];
  else {
    const words = q.match(/[a-z]{4,}/g) || [];
    ids = tl.shots.filter(s => words.some(w => `${s.title} ${s.chapter} ${s.voice?.line || ''}`.toLowerCase().includes(w))).map(s => s.shotId);
  }
  if (!ids.length) ids = tl.shots.map(s => s.shotId);
  if (/re-?record|retake|redo|record again/.test(q)) return { shotIds: ids, op: 're-record', why: 'asked to record again' };
  if (/shorten|shorter|faster|speed up|tighten|trim|quicker/.test(q)) return { shotIds: ids, op: 'retime', factor: 1.3, direction: 'shorter', why: 'asked to shorten' };
  if (/slower|slow down|longer|more time/.test(q)) return { shotIds: ids, op: 'retime', factor: 0.8, direction: 'longer', why: 'asked to slow down' };
  return { shotIds: ids, op: 're-voice', why: 'narration change' };
}

/**
 * Edit on request: only the touched shots are re-recorded, re-voiced or
 * re-timed; a new timeline version is written with a list of what changed,
 * then the video is re-rendered and re-checked.
 */
export async function editDemo(agent: DemoAgent, runId: string, request: string) {
  const log = agent.services.log;
  const run = Run.open(agent.runDir(runId));
  const s = run.state;
  const before = loadTimeline(run.dir, s.version);
  const tl: Timeline = JSON.parse(JSON.stringify(before));
  const plan = await planEdit(request, tl, agent.services.llm);
  log(`Edit: ${plan.op} on ${plan.shotIds.join(', ')} (${plan.why})`);
  const preset = PRESETS[s.style || 'calm'];
  const touched = new Set(plan.shotIds);
  const ctx = run.lineContexts();

  if (plan.op === 're-record') {
    const env = agent.env(run);
    try {
      for (const id of plan.shotIds) {
        const shot = run.storyboard!.shots.find(x => x.id === id);
        if (shot) s.takes[id] = await recordBest(env, shot, s.options.takes);
      }
    } finally { await closeRunner(env); }
    const fresh = run.buildTimeline(preset, plan.shotIds).tl.shots;
    tl.shots = tl.shots.map(x => fresh.find(f => f.shotId === x.shotId) || x);
  }
  if (plan.op === 'retime') {
    for (const sh of tl.shots) if (touched.has(sh.shotId)) for (const g of sh.segments) g.speed = Math.round(g.speed * (plan.factor || 1.3) * 1000) / 1000;
  }
  for (const sh of tl.shots) {
    if (touched.has(sh.shotId)) await voiceShot(sh, ctx.get(sh.shotId)!, preset, path.join(run.dir, 'voice'), run.dir, { speech: agent.services.speech, llm: agent.services.llm }, { direction: plan.direction, request });
  }
  layout(tl);
  tl.version = s.version + 1;
  tl.createdAt = new Date().toISOString();
  tl.note = request;
  saveTimeline(run.dir, tl);
  const changes = tl.shots.filter(x => touched.has(x.shotId)).map(x => {
    const old = before.shots.find(b => b.shotId === x.shotId);
    return { shotId: x.shotId, op: plan.op, seconds: [old?.outDuration, x.outDuration], line: [old?.voice?.line, x.voice?.line] };
  });
  run.write(`changes.v${tl.version}.json`, { request, plan, from: s.version, to: tl.version, changes, duration: [before.duration, tl.duration] });
  s.version = tl.version;
  const r = await renderTimeline(run.dir, tl, { extras: s.options.extras });
  s.findings = run.review(tl, []);
  run.save();
  log(`v${tl.version}: ${r.mp4} (${before.duration.toFixed(1)}s → ${tl.duration.toFixed(1)}s)`);
  for (const c of changes) log(`  ${c.shotId}: ${c.seconds[0]?.toFixed(1)}s → ${c.seconds[1]?.toFixed(1)}s; "${c.line[1]}"`);
  return { version: tl.version, mp4: r.mp4, changes, findings: s.findings };
}

/** Undo: make the previous version current again and re-render it. */
export async function undoDemo(agent: DemoAgent, runId: string) {
  const run = Run.open(agent.runDir(runId));
  const v = run.state.version - 1;
  if (v < 1 || !fs.existsSync(timelinePath(run.dir, v))) throw new Error('Nothing to undo.');
  const r = await renderTimeline(run.dir, loadTimeline(run.dir, v), { extras: run.state.options.extras });
  run.state.version = v;
  run.save();
  agent.services.log(`Back to v${v}: ${r.mp4}`);
  return { version: v, mp4: r.mp4 };
}

export function listVersions(agent: DemoAgent, runId: string): { version: number; note: string; duration: number; current: boolean }[] {
  const run = Run.open(agent.runDir(runId));
  return fs.readdirSync(run.dir).map(f => f.match(/^timeline\.v(\d+)\.json$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b).map(v => {
    const tl = loadTimeline(run.dir, v);
    return { version: v, note: tl.note || 'first cut', duration: tl.duration, current: v === run.state.version };
  });
}
