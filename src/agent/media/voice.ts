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
  targetSec?: number;  // the shot's planned length: the line is written to fill it
  site?: string;       // what the site is for (graph builder's profile), for the intro
}

const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Deterministic line: the steps' intents joined, fields compressed when it must be short. */
export function fallbackLine(c: LineContext, maxWords: number): string {
  if (c.isIntro) {
    const name = c.title.replace(/\.$/, '');
    if (c.site && maxWords >= 6 + c.site.split(/\s+/).length) return `Here's ${name}: ${c.site.replace(/\.$/, '')}. Let's take a quick tour.`;
    return maxWords >= 8 ? `Here's ${name}. Let's take a quick tour.` : `Here's ${name}.`;
  }
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
    const r = await llm.json<Record<string, unknown>>(
      'You write voice-over for product demo videos: the spoken narration for one shot. Write about aimForWords words (never more than maxWords) so the narration fills the shot: say what is being done and briefly why it is useful to this audience. Name buttons, fields and sections exactly as they appear on screen, in “curly quotes”. No marketing fluff. No steps that are not listed. Return {"line": "..."}.',
      JSON.stringify({ site: c.site, audience: c.audience, shot: c.title, intent: c.intent, aimForWords: Math.max(4, Math.round(maxWords * 0.9)), steps: c.steps.map(s => ({ action: s.op, label: s.label, value: s.value })), screenBefore: c.before, screenAfter: c.after, isIntro: c.isIntro, isLast: c.isLast, maxWords, previous, direction })
    ).catch(() => null);
    // Slightly long lines are fine: the fit loop shortens them or holds the last frame
    // Models sometimes name the field differently ({"narration": ...}): take the first text value
    const text = r && (typeof r.line === 'string' ? r.line : Object.values(r).find((v): v is string => typeof v === 'string'));
    if (text && words(text) <= Math.ceil(maxWords * 1.5) + 3) return text.trim();
  }
  return fallbackLine(c, direction === 'shorter' && previous ? Math.min(maxWords, words(previous) - 3) : maxWords);
}

const PAD = 0.6;       // voice starts 0.25 s in and should end ~0.35 s before the cut
const MAX_HOLD = 2.5;
const MAX_SPEED = 2.2;
/** At most this much faster than the chosen style when fitting footage to the voice. */
const MAX_FIT = 1.0;  // never faster than the style the user picked

/**
 * Voice-over for one shot with fit-to-length (B1 R1):
 *  - voice longer than the shot → ask for a shorter line (max 2 rewrites), then hold the last frame
 *  - shot longer than the voice → speed the shot up (≤ 2.2×) so silence stays under 1 s
 */
export async function voiceShot(shot: TimelineShot, c: LineContext, preset: Preset, voiceDir: string, runDir: string, deps: VoiceDeps, hint?: { direction?: 'shorter' | 'longer'; request?: string }): Promise<string[]> {
  const notes: string[] = [];
  const base = shot.segments.reduce((d, g) => d + segDuration(g), 0);
  // Write for the time the shot has on screen (its footage, or its planned length if longer)
  const span = Math.max(base, c.targetSec ? Math.min(c.targetSec, base * 1.6) : 0);
  const budget = Math.max(4, Math.floor(span * (hint?.direction === 'shorter' ? 2.2 : 2.5)));
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
    // Footage longer than the voice: first ask for a fuller line (LLM), then speed up a little
    for (let i = 0; i < 2 && deps.llm && base > speech.duration + PAD + 1.2 && !hint?.direction; i++) {
      const longer = await writeLine(c, Math.floor(base * 2.5), deps.llm, line, 'longer');
      if (longer === line || words(longer) <= words(line)) break;
      const s2 = await deps.speech.synthesize(longer, voiceDir, preset.voiceSpeed);
      if (s2.duration + PAD > base + 0.3) break;
      line = longer;
      speech = s2;
    }
    const want = speech.duration + PAD;
    // With an LLM the line was written to fill the shot, so keep the user's pace; without one, tighten a little
    const fit = deps.llm ? MAX_FIT : 1.3;
    const cap = (g: { speed: number }) => Math.max(g.speed, Math.min(MAX_SPEED, preset.speed * fit));
    for (let i = 0; i < 4; i++) {
      const now = shot.segments.reduce((d, g) => d + segDuration(g), 0);
      if (now <= want + 0.35) break;
      const slow = shot.segments.filter(g => g.speed < cap(g) - 1e-6);
      if (!slow.length) break;
      const slowDur = slow.reduce((d, g) => d + segDuration(g), 0);
      const f = slowDur / Math.max(0.1, slowDur - (now - want));
      for (const g of slow) g.speed = Math.round(Math.min(cap(g), g.speed * f) * 1000) / 1000;
    }
    const after = shot.segments.reduce((d, g) => d + segDuration(g), 0);
    if (after > want + 1) notes.push(`${shot.shotId}: ${(after - want).toFixed(1)}s of footage without narration (kept at the chosen pace)`);
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
