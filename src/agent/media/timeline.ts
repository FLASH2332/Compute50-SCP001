import fs from 'node:fs';
import path from 'node:path';
import type { Box } from '../core/appMap.js';
import type { Take, TakeEvent } from '../record/runner.js';

export interface Preset {
  name: 'fast' | 'calm';
  speed: number;       // base playback speed
  zoomDepth: number;   // max zoom factor
  holdAfter: number;   // seconds the zoom holds after the action
  voiceSpeed: number;  // TTS speaking rate
}

export const PRESETS: Record<Preset['name'], Preset> = {
  fast: { name: 'fast', speed: 1.25, zoomDepth: 1.3, holdAfter: 0.4, voiceSpeed: 1.1 },
  calm: { name: 'calm', speed: 1.0, zoomDepth: 1.6, holdAfter: 1.0, voiceSpeed: 0.9 }
};

/** Source seconds; `hold` freezes the segment's first frame this long before it plays (freeze-sync). */
export interface Segment { in: number; out: number; speed: number; hold?: number }
export interface ZoomKey { t: number; until: number; box: Box; depth: number } // source seconds
export interface Word { text: string; start: number; end: number }       // seconds from clip start
export interface Voice { line: string; file: string; duration: number; words: Word[]; offset: number; trimStart?: number }

export interface TimelineShot {
  shotId: string;
  title: string;
  chapter: string;
  stepIds: string[];
  take: string;            // video path relative to the run dir
  takeAttempt: number;
  segments: Segment[];
  zooms: ZoomKey[];
  hold: number;            // freeze the last frame this long (s)
  voice?: Voice;
  outStart: number;        // computed: start in the final video
  outDuration: number;     // computed
}

export interface Timeline {
  version: number;
  style: Preset['name'];
  createdAt: string;
  shots: TimelineShot[];
  duration: number;
  note?: string;
}

export const ZOOM = { ramp: 0.4, minGap: 3, maxCover: 0.4, frameW: 1280, frameH: 720 };

/**
 * Cuts (B1 video decisions): drop page loads (keep 0.15 s each side),
 * squeeze idle gaps over 1.6 s, play typing 3× faster.
 */
export function cutSegments(take: Take, preset: Preset): Segment[] {
  const { start, end } = take.window;
  const ev = take.events.filter(e => e.t >= start && e.t <= end).sort((a, b) => a.t - b.t);
  const cuts: [number, number][] = [];
  const fast: [number, number][] = [];
  // Planned holds (the runner pacing a shot to its length) are kept, never cut as idle
  const holds: [number, number][] = [];
  for (const e of ev) if (e.type === 'hold_start') { const h = ev.find(x => x.type === 'hold_end' && x.stepId === e.stepId && x.t >= e.t); if (h) holds.push([e.t, h.t]); }
  for (const e of ev) {
    if (e.type === 'nav_start') {
      const ready = ev.find(r => r.type === 'ready' && r.t >= e.t && r.stepId === e.stepId);
      if (ready && ready.t - e.t > 0.3) cuts.push([e.t + 0.15, ready.t - 0.15]);
    }
    if (e.type === 'typing_start') {
      const done = ev.find(r => r.type === 'typing_end' && r.t >= e.t && r.stepId === e.stepId);
      if (done && done.t - e.t > 0.3) fast.push([e.t, done.t]);
    }
  }
  if (take.steps.length) {
    const marks = [start, ...ev.map(e => e.t), end];
    for (let i = 1; i < marks.length; i++) {
      const gap = marks[i] - marks[i - 1];
      const busy = [...fast, ...holds].some(([x, y]) => marks[i - 1] < y && marks[i] > x); // typing and holds are activity
      if (gap > 1.6 && !busy) cuts.push([marks[i - 1] + 0.6, marks[i] - 0.6]);
    }
  }
  // Sweep the window, splitting at every cut/fast boundary
  const points = [...new Set([start, end, ...cuts.flat(), ...fast.flat()].filter(p => p >= start && p <= end))].sort((a, b) => a - b);
  const segs: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const mid = (a + b) / 2;
    if (b - a < 0.05 || cuts.some(([x, y]) => mid > x && mid < y)) continue;
    const speed = preset.speed * (fast.some(([x, y]) => mid > x && mid < y) ? 3 : 1);
    const last = segs[segs.length - 1];
    if (last && Math.abs(last.out - a) < 1e-6 && last.speed === speed) last.out = b;
    else segs.push({ in: round(a), out: round(b), speed });
  }
  return segs;
}

/** Zoom keyframes: ease in on the target, hold through the action, ease out; limited depth and frequency. */
export function zoomKeys(take: Take, preset: Preset, segs: Segment[]): ZoomKey[] {
  const ev = take.events;
  const keys: ZoomKey[] = [];
  const W = ZOOM.frameW, H = ZOOM.frameH;
  for (const e of ev) {
    if (e.type !== 'located' || !e.stepId || !e.box || e.t < take.window.start) continue;
    const b = e.box;
    if (b.width * b.height > W * H * ZOOM.maxCover) continue;
    if (keys.length && e.t - keys[keys.length - 1].t < ZOOM.minGap) continue;
    if (!segs.some(s => e.t >= s.in && e.t <= s.out)) continue;
    const depth = Math.max(1, Math.min(preset.zoomDepth, (W * 0.6) / b.width, (H * 0.6) / b.height));
    if (depth < 1.08) continue;
    const mine = ev.filter(x => x.stepId === e.stepId && x.t >= e.t);
    const done = mine.find(x => x.type === 'typing_end') ?? mine.find(x => x.type === 'act') ?? e;
    // Fully zoomed out before the shot's last kept frame (it may be frozen as a hold)
    const lastOut = segs.length ? segs[segs.length - 1].out : take.window.end;
    const until = Math.min(done.t + preset.holdAfter, lastOut - ZOOM.ramp - 0.15);
    keys.push({ t: round(e.t), until: round(Math.max(until, e.t + 0.3)), box: b, depth: round(depth) });
  }
  return keys;
}

export const segDuration = (s: Segment) => (s.hold ?? 0) + (s.out - s.in) / s.speed;

/** Recomputes output start/duration of every shot. */
export function layout(tl: Timeline): Timeline {
  let t = 0;
  for (const s of tl.shots) {
    s.outStart = round(t);
    s.outDuration = round(s.segments.reduce((d, g) => d + segDuration(g), 0) + s.hold);
    t += s.outDuration;
  }
  tl.duration = round(t);
  return tl;
}

/** Source time in a shot's take → seconds into the final video. */
export function toOut(shot: TimelineShot, t: number): number {
  let out = shot.outStart;
  for (const g of shot.segments) {
    if (t <= g.in) break;
    out += (g.hold ?? 0) + (Math.min(t, g.out) - g.in) / g.speed;
  }
  return out;
}

export const round = (n: number) => Math.round(n * 1000) / 1000;

export function timelinePath(runDir: string, v: number) {
  return path.join(runDir, `timeline.v${v}.json`);
}

export function saveTimeline(runDir: string, tl: Timeline) {
  fs.writeFileSync(timelinePath(runDir, tl.version), JSON.stringify(tl, null, 2));
}

export function loadTimeline(runDir: string, v: number): Timeline {
  return JSON.parse(fs.readFileSync(timelinePath(runDir, v), 'utf8'));
}

export function latestVersion(runDir: string): number {
  const vs = fs.existsSync(runDir) ? fs.readdirSync(runDir).map(f => f.match(/^timeline\.v(\d+)\.json$/)?.[1]).filter(Boolean).map(Number) : [];
  return vs.length ? Math.max(...vs) : 0;
}

export type { TakeEvent };
