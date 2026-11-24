import path from 'node:path';
import type { Speech, TextModel } from '../core/ports.js';
import { quote, type FlowStep } from '../plan/flows.js';
import { layout, segDuration, type Preset, type Timeline, type TimelineShot } from './timeline.js';

export interface LineContext {
  intent: string;
  title: string;
  steps: FlowStep[];
  before: string;      // page title / dialog before
  after: string;       // page title / dialog after
  audience: string;
  isIntro: boolean;
  isLast: boolean;
}

const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Deterministic line: the steps' intents joined, fields compressed when it must be short. */
export function fallbackLine(c: LineContext, maxWords: number): string {
  if (c.isIntro) return maxWords >= 8 ? `Here's ${c.title.replace(/\.$/, '')}. Let's take a quick tour.` : `Here's ${c.title.replace(/\.$/, '')}.`;
  const parts = c.steps.map((s, i) => (i ? lc(s.intent) : s.intent));
  let line = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1]}.` : `${parts[0]}.`;
  if (words(line) > maxWords) {
    const fills = c.steps.filter(s => s.op !== 'click');
    const clicks = c.steps.filter(s => s.op === 'click');
    const p: string[] = [];
    if (clicks[0]) p.push(`Click ${quote(clicks[0].label)}`);
    if (fills.length) p.push(`fill in ${fills.map(f => f.label.toLowerCase()).slice(0, 3).join(' and ')}`);
    if (clicks.length > 1) p.push(`then click ${quote(clicks[clicks.length - 1].label)}`);
    line = p.join(', ') + '.';
  }
  if (words(line) > maxWords && c.steps.length) line = `${c.steps[0].intent}.`;
  return line;
}

export const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export interface VoiceDeps { speech: Speech; llm?: TextModel }

export async function writeLine(c: LineContext, maxWords: number, llm?: TextModel, previous?: string, direction?: 'shorter' | 'longer'): Promise<string> {
  if (llm) {
    const r = await llm.json<{ line: string }>(
      'You write voice-over for product demo videos: one short, friendly spoken line per shot. Name buttons and fields exactly as they appear on screen, in “curly quotes”. No marketing fluff. No steps that are not listed.',
      JSON.stringify({ audience: c.audience, shot: c.title, intent: c.intent, steps: c.steps.map(s => ({ action: s.op, label: s.label, value: s.value })), screenBefore: c.before, screenAfter: c.after, isIntro: c.isIntro, isLast: c.isLast, maxWords, previous, direction })
    ).catch(() => null);
    if (r?.line && words(r.line) <= maxWords + 3) return r.line.trim();
  }
  return fallbackLine(c, direction === 'shorter' && previous ? Math.min(maxWords, words(previous) - 3) : maxWords);
}

const PAD = 0.6;       // voice starts 0.25 s in and should end ~0.35 s before the cut
const MAX_HOLD = 2.5;
const MAX_SPEED = 2.2;

/**
 * Voice-over for one shot with fit-to-length (B1 R1):
 *  - voice longer than the shot → ask for a shorter line (max 2 rewrites), then hold the last frame
 *  - shot longer than the voice → speed the shot up (≤ 2.2×) so silence stays under 1 s
 */
export async function voiceShot(shot: TimelineShot, c: LineContext, preset: Preset, voiceDir: string, runDir: string, deps: VoiceDeps, hint?: { direction?: 'shorter' | 'longer'; request?: string }): Promise<string[]> {
  const notes: string[] = [];
  const base = shot.segments.reduce((d, g) => d + segDuration(g), 0);
  const budget = Math.max(4, Math.floor(base * (hint?.direction === 'shorter' ? 2.2 : 2.5)));
  let line = hint ? await writeLine({ ...c, intent: hint.request ? `${c.intent} (editor's request: ${hint.request})` : c.intent }, budget, deps.llm, shot.voice?.line, hint.direction) : await writeLine(c, budget, deps.llm);
  let speech = await deps.speech.synthesize(line, voiceDir, preset.voiceSpeed);
  for (let i = 0; i < 2 && speech.duration + PAD > base + MAX_HOLD; i++) {
    const shorter = await writeLine(c, Math.max(4, Math.floor(base * 2.3)), deps.llm, line, 'shorter');
    if (shorter === line) break;
    line = shorter;
    speech = await deps.speech.synthesize(line, voiceDir, preset.voiceSpeed);
    notes.push(`${shot.shotId}: shortened the line to fit`);
  }
  const want = speech.duration + PAD;
  shot.hold = 0;
  if (want > base) {
    shot.hold = Math.round((want - base) * 1000) / 1000;
    if (shot.hold > MAX_HOLD) notes.push(`${shot.shotId}: voice is ${shot.hold.toFixed(1)}s longer than the footage; holding the last frame`);
  } else if (base > want + 0.35) {
    // Speed up the slow parts (never past 2.2×; typing is already fast) until the shot fits the voice
    for (let i = 0; i < 4; i++) {
      const now = shot.segments.reduce((d, g) => d + segDuration(g), 0);
      if (now <= want + 0.35) break;
      const slow = shot.segments.filter(g => g.speed < MAX_SPEED);
      if (!slow.length) break;
      const slowDur = slow.reduce((d, g) => d + segDuration(g), 0);
      const f = slowDur / Math.max(0.1, slowDur - (now - want));
      for (const g of slow) g.speed = Math.round(Math.min(MAX_SPEED, g.speed * f) * 1000) / 1000;
    }
    const after = shot.segments.reduce((d, g) => d + segDuration(g), 0);
    if (after > want + 1) notes.push(`${shot.shotId}: footage is ${(after - want).toFixed(1)}s longer than the voice even at ${MAX_SPEED}×`);
  }
  shot.voice = { line, file: path.relative(runDir, path.join(voiceDir, speech.file)).replace(/\\/g, '/'), duration: speech.duration, words: speech.words, offset: 0.25 };
  return notes;
}

/** Voices every shot that has none yet (or all, with force), then recomputes the layout. */
export async function voiceTimeline(tl: Timeline, contexts: Map<string, LineContext>, preset: Preset, runDir: string, deps: VoiceDeps, only?: Set<string>): Promise<string[]> {
  const notes: string[] = [];
  for (const s of tl.shots) {
    if (only && !only.has(s.shotId)) continue;
    const c = contexts.get(s.shotId);
    if (c) notes.push(...await voiceShot(s, c, preset, path.join(runDir, 'voice'), runDir, deps));
  }
  layout(tl);
  return notes;
}
