import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  goal?: string;       // the user's request
  site?: string;       // what the site is for (graph builder's profile), for the intro
  draft?: string;      // line from the whole-script pass
  prevLine?: string;   // neighbouring lines, so a rewrite doesn't repeat them
  nextLine?: string;
}

export interface VoiceDeps { speech: Speech; llm?: TextModel; style?: string }

export const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** House rules applied to every written line: curly double quotes around names, tidy spacing. */
export function tidy(line: string): string {
  return line
    .replace(/(^|[\s(])'([^'\n]{2,60}?)'(?=[\s.,;:!?)]|$)/g, '$1“$2”')   // 'Name' → “Name” (apostrophes untouched)
    .replace(/(^|[\s(])"([^"\n]{2,60}?)"(?=[\s.,;:!?)]|$)/g, '$1“$2”')
    .replace(/\s+/g, ' ').trim();
}
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// ── Style guide ─────────────────────────────────────────────────────────────

const STYLE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'narration-style.md');

/** The narration style guide: NARRATION_STYLE_FILE if set, else the bundled narration-style.md. */
export function loadStyle(file = process.env.NARRATION_STYLE_FILE): string {
  for (const f of [file, STYLE_FILE]) {
    if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return '';
}

/**
 * What a shot shows, for the writer. Route beats (the clicks that only get us
 * to a page: logo, menu links) are reduced to "arrive at <page>", so the
 * narration says where we are going instead of naming every click.
 */
function beats(c: LineContext) {
  const out: Record<string, unknown>[] = [];
  const route = c.steps.filter(s => s.route);
  if (route.length) out.push({ beat: 'arrive', page: c.after });
  for (const s of c.steps.filter(s => !s.route)) {
    if (s.op === 'show') out.push({ beat: 'show section', name: s.label });
    else if (s.op === 'search') out.push({ beat: 'search', query: s.value });
    else if (s.op === 'open_result') out.push({ beat: 'open result', title: s.label });
    else if (s.op === 'goto') out.push({ beat: 'arrive', page: s.label });
    else out.push({ beat: s.op, control: s.label, value: s.value });
  }
  return out;
}

const wordBudget = (sec: number) => Math.max(4, Math.floor(sec * 2.4));

// ── Whole script in one pass ───────────────────────────────────────────────

/**
 * Writes every shot's line in ONE call, so the narration reads as a single
 * story (welcome → what each part is for → the task → wrap-up) and the model
 * can see and avoid its own repetitions. Lines that come back too long or
 * empty are left to the per-shot writer.
 */
export async function writeScript(contexts: { id: string; c: LineContext; seconds: number }[], deps: VoiceDeps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!deps.llm || !contexts.length) return out;
  const first = contexts[0].c;
  const r = await deps.llm.json<Record<string, unknown>>(
    [
      'You write the voice-over script for a screen-recorded product demo: one line of narration per shot, read aloud while the shot plays.',
      'Follow this style guide exactly:', deps.style || '',
      'Each shot lists its beats (what happens on screen) and the screens before/after. aimForWords is how much fits in the shot; never exceed maxWords.',
      'Return {"lines": {"<shot id>": "<narration>", ...}} with one entry per shot.'
    ].join('\n'),
    JSON.stringify({
      goal: first.goal, audience: first.audience, site: first.site,
      shots: contexts.map(({ id, c, seconds }) => ({ id, seconds: Math.round(seconds), aimForWords: Math.round(wordBudget(seconds) * 0.9), maxWords: wordBudget(seconds), title: c.title, isIntro: c.isIntro, isLast: c.isLast, beats: beats(c), screenBefore: c.before, screenAfter: c.after }))
    })
  ).catch(() => null);
  const lines = r && typeof r.lines === 'object' && r.lines ? r.lines as Record<string, unknown> : r || {};
  for (const { id, seconds } of contexts) {
    const v = lines[id];
    if (typeof v === 'string' && v.trim() && words(v) <= Math.ceil(wordBudget(seconds) * 1.5) + 3) out.set(id, tidy(v));
  }
  return out;
}

// ── One line (rewrites, and the no-LLM fallback) ────────────────────────────

const SHOW = [(n: string) => `Here's ${n}.`, (n: string) => `Take a look at ${n}.`, (n: string) => `Next up is ${n}.`, (n: string) => `Scrolling down, you'll find ${n}.`, (n: string) => `There's also ${n}.`];
const ARRIVE = [(p: string) => `Let's head over to ${p}.`, (p: string) => `Now we're on ${p}.`, (p: string) => `Moving on to ${p}.`, (p: string) => `This is ${p}.`];
let variant = 0;

/** Deterministic line (no LLM): route clicks become "head over to", other beats get varied phrasings. */
export function fallbackLine(c: LineContext, maxWords: number): string {
  const site = c.title.replace(/\.$/, '');
  if (c.isIntro) {
    if (c.site && maxWords >= 7 + words(c.site)) return `Welcome to ${site}: ${c.site.replace(/\.$/, '')}. Let's take a quick look around.`;
    return maxWords >= 8 ? `Welcome to ${site}. Let's take a quick look around.` : `Welcome to ${site}.`;
  }
  const page = (c.after || '').split(/[|·–-]/)[0].trim();
  const parts: string[] = [];
  if (c.steps.some(s => s.route || s.op === 'goto') && page) parts.push(ARRIVE[variant++ % ARRIVE.length](page));
  const name = (s: FlowStep) => /^(form|list of|content|main|nav|section)\b/i.test(s.label) || s.label.includes(':') ? 'this section' : quote(s.label);
  for (const s of c.steps.filter(x => !x.route && x.op !== 'goto')) {
    if (s.op === 'show') parts.push(SHOW[variant++ % SHOW.length](name(s)));
    else if (s.op === 'search') parts.push(`Search for ${s.value}.`);
    else if (s.op === 'open_result') parts.push(`${quote(s.label)} looks like a good fit, so let's open it.`);
    else if (s.op === 'fill') parts.push(`Enter ${s.value} in ${quote(s.label)}.`);
    else if (s.op === 'select') parts.push(`Pick an option in ${quote(s.label)}.`);
    else parts.push(`${s.intent}.`);
  }
  let line = parts.join(' ').replace(/\.\./g, '.');
  while (words(line) > maxWords && parts.length > 1) { parts.pop(); line = parts.join(' '); }
  return line || `${c.intent}.`;
}

export async function writeLine(c: LineContext, maxWords: number, llm?: TextModel, previous?: string, direction?: 'shorter' | 'longer', style?: string, request?: string): Promise<string> {
  if (llm) {
    const r = await llm.json<Record<string, unknown>>(
      [
        'You write the voice-over for one shot of a screen-recorded product demo. Follow this style guide exactly:', style || '',
        'Write about aimForWords words, never more than maxWords. Do not repeat wording from previousLine or nextLine (the neighbouring shots), and do not start the way they start.',
        'Return {"line": "..."}.'
      ].join('\n'),
      JSON.stringify({ goal: c.goal, site: c.site, audience: c.audience, shot: c.title, isIntro: c.isIntro, isLast: c.isLast, beats: beats(c), screenBefore: c.before, screenAfter: c.after,
        aimForWords: Math.max(4, Math.round(maxWords * 0.9)), maxWords, currentLine: previous, rewrite: direction || (request ? 'reword' : undefined), editorRequest: request,
        previousLine: c.prevLine, nextLine: c.nextLine })
    ).catch(() => null);
    // Models sometimes name the field differently ({"narration": ...}): take the first text value
    const text = r && (typeof r.line === 'string' ? r.line : Object.values(r).find((v): v is string => typeof v === 'string'));
    if (text && words(text) <= Math.ceil(maxWords * 1.5) + 3) return tidy(text);
  }
  return fallbackLine(c, direction === 'shorter' && previous ? Math.min(maxWords, words(previous) - 3) : maxWords);
}

// ── Fitting a line to its shot ───────────────────────────────────────────────

const PAD = 0.6;       // voice starts 0.25 s in and should end ~0.35 s before the cut
const MAX_HOLD = 2.5;
const MAX_SPEED = 2.2;
/** Never faster than the style the user picked when an LLM can write a fuller line instead. */
const MAX_FIT = 1.0;

/**
 * Voice-over for one shot with fit-to-length:
 *  - voice longer than the shot → ask for a shorter line (max 2 rewrites), then hold the last frame
 *  - shot longer than the voice → ask for a fuller line; without an LLM, speed up a little
 */
export async function voiceShot(shot: TimelineShot, c: LineContext, preset: Preset, voiceDir: string, runDir: string, deps: VoiceDeps, hint?: { direction?: 'shorter' | 'longer'; request?: string }): Promise<string[]> {
  const notes: string[] = [];
  const style = deps.style ?? loadStyle();
  const base = shot.segments.reduce((d, g) => d + segDuration(g), 0);
  // Write for the time the shot has on screen (its footage, or its planned length if longer)
  const span = Math.max(base, c.targetSec ? Math.min(c.targetSec, base * 1.6) : 0);
  const budget = Math.max(4, Math.floor(span * (hint?.direction === 'shorter' ? 2.2 : 2.5)));
  let line = !hint && c.draft ? c.draft
    : await writeLine(c, budget, deps.llm, shot.voice?.line, hint?.direction, style, hint?.request);
  let speech = await deps.speech.synthesize(line, voiceDir, preset.voiceSpeed);
  for (let i = 0; i < 2 && speech.duration + PAD > base + MAX_HOLD; i++) {
    const shorter = await writeLine(c, Math.max(4, Math.floor(base * 2.3)), deps.llm, line, 'shorter', style);
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
    for (let i = 0; i < 1 && deps.llm && base > speech.duration + PAD + 1.2 && hint?.direction !== 'shorter'; i++) {
      const longer = await writeLine(c, Math.floor(base * 2.5), deps.llm, line, 'longer', style);
      if (longer === line || words(longer) <= words(line)) break;
      const s2 = await deps.speech.synthesize(longer, voiceDir, preset.voiceSpeed);
      if (s2.duration + PAD > base + 0.3) break;
      line = longer;
      speech = s2;
    }
    const want = speech.duration + PAD;
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
    // The video ends soon after the last line: trim the final shot's quiet tail
    if (c.isLast) {
      const last = shot.segments[shot.segments.length - 1];
      const extra = shot.segments.reduce((d, g) => d + segDuration(g), 0) - (want + 0.8);
      if (last && extra > 0) last.out = Math.round(Math.max(last.in + 0.5, last.out - extra * last.speed) * 1000) / 1000;
    }
    const after = shot.segments.reduce((d, g) => d + segDuration(g), 0);
    if (after > want + 1) notes.push(`${shot.shotId}: ${(after - want).toFixed(1)}s of footage without narration (kept at the chosen pace)`);
  }
  shot.voice = { line, file: path.relative(runDir, path.join(voiceDir, speech.file)).replace(/\\/g, '/'), duration: speech.duration, words: speech.words, offset: 0.25 };
  return notes;
}

/** Writes the script for all shots in one pass, then voices and fits each shot. */
export async function voiceTimeline(tl: Timeline, contexts: Map<string, LineContext>, preset: Preset, runDir: string, deps: VoiceDeps, only?: Set<string>): Promise<string[]> {
  const notes: string[] = [];
  const style = deps.style ?? loadStyle();
  const todo = tl.shots.filter(s => (!only || only.has(s.shotId)) && contexts.get(s.shotId));
  const script = await writeScript(todo.map(s => ({ id: s.shotId, c: contexts.get(s.shotId)!, seconds: Math.max(s.segments.reduce((d, g) => d + segDuration(g), 0), contexts.get(s.shotId)!.targetSec || 0) })), { ...deps, style });
  for (const [i, s] of tl.shots.entries()) {
    const c = contexts.get(s.shotId);
    if (!c || (only && !only.has(s.shotId))) continue;
    c.draft = script.get(s.shotId);
    c.prevLine = tl.shots[i - 1]?.voice?.line ?? script.get(tl.shots[i - 1]?.shotId ?? '');
    c.nextLine = script.get(tl.shots[i + 1]?.shotId ?? '');
    notes.push(...await voiceShot(s, c, preset, path.join(runDir, 'voice'), runDir, { ...deps, style }));
  }
  layout(tl);
  return notes;
}

export { lc };
