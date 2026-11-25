/**
 * Voice first: each shot's script line is synthesized BEFORE the shot is recorded. The word timings
 * tell when each beat (step) starts in the audio; the recorder then paces the shot so each step
 * happens as its words are spoken, and assembly places the voice as is (no speeding the picture up).
 */
import path from 'node:path';
import type { Speech, Word } from '../core/ports.js';
import { RESULT, type Script, type ShotScript } from './script.js';
import type { Take, TakeEvent } from '../record/runner.js';
import { segDuration, type Preset, type Segment, type Timeline, type TimelineShot } from './timeline.js';
import { tidy, words } from './voice.js';

export interface ShotVoice {
  shotId: string;
  preset: Preset['name'];
  line: string;                       // what is spoken (result titles filled in)
  file: string;                       // relative to the run dir
  lead: number;                       // leading silence in the file (trimmed when mixing)
  duration: number;                   // first word to last word
  words: Word[];                      // times from the first word (lead removed)
  beatTimes: Record<string, number>;  // step id → seconds after the first word when its words start
  pause?: number;                     // seconds of silence between beats (SSML <break>), to fill a short shot
}

/** Voice starts this long after the shot starts; the shot ends this long after the voice. */
export const VOICE_OFFSET = 0.25;
export const VOICE_TAIL = 0.35;
/** Words lead their action by this much: the narration says what is about to happen. */
export const WORDS_LEAD = 0.5;

/** The spoken beats of a shot, with {result} filled in. */
export function spokenBeats(s: ShotScript, result?: string) {
  const title = result ? `“${result.replace(/[“”"]/g, '')}”` : 'the best match';
  return s.beats.map(b => ({ stepId: b.stepId, text: tidy(b.text.split(RESULT).join(title)) })).filter(b => b.text);
}

/** Beat start times from word timings: each beat starts at its first word (by word count). */
export function beatTimesFrom(beats: { stepId: string; text: string }[], ws: Word[]): Record<string, number> {
  const out: Record<string, number> = {};
  let index = 0;
  for (const b of beats) {
    const w = ws[Math.min(index, ws.length - 1)];
    if (w && !(b.stepId in out)) out[b.stepId] = Math.round(w.start * 1000) / 1000;
    index += words(b.text);
  }
  return out;
}

export interface NarrateDeps { speech: Speech; runDir: string }

/** Synthesizes one shot, stitched to its neighbours' lines (ElevenLabs request stitching). */
export async function synthesizeShot(sc: ShotScript, preset: Preset, deps: NarrateDeps, opts: { result?: string; previousText?: string; nextText?: string; pause?: number } = {}): Promise<ShotVoice> {
  const beats = spokenBeats(sc, opts.result);
  const line = tidy(beats.map(b => b.text).join(' '));
  // A pause between beats is an SSML break (ElevenLabs: up to 3 s; few per clip)
  const pause = opts.pause && beats.length > 1 ? Math.min(MAX_PAUSE, Math.round(opts.pause * 10) / 10) : 0;
  const said = pause ? beats.map(b => tidy(b.text)).join(` <break time="${pause}s" /> `) : line;
  const clip = await deps.speech.synthesize(said, path.join(deps.runDir, 'voice'), preset.voiceSpeed, { previousText: opts.previousText, nextText: opts.nextText });
  const lead = Math.max(0, clip.words[0]?.start ?? 0);
  const end = clip.words.length ? clip.words[clip.words.length - 1].end : clip.duration;
  const shifted = clip.words.map(w => ({ text: w.text, start: Math.max(0, w.start - lead), end: Math.max(0, w.end - lead) }));
  return {
    shotId: sc.shotId, preset: preset.name, line,
    file: path.relative(deps.runDir, path.join(deps.runDir, 'voice', clip.file)).replace(/\\/g, '/'),
    lead: Math.round(lead * 1000) / 1000, duration: Math.round((end - lead) * 1000) / 1000, words: shifted,
    beatTimes: beatTimesFrom(beats, shifted), ...(pause ? { pause } : {})
  };
}

/** Synthesizes every listed shot in order (each one stitched to the lines around it). */
export async function synthesizeShots(script: Script, order: string[], preset: Preset, deps: NarrateDeps, results: Record<string, string | undefined> = {}, pauses: Record<string, number> = {}): Promise<Record<string, ShotVoice>> {
  const out: Record<string, ShotVoice> = {};
  const all = Object.keys(script.shots);
  for (const id of order) {
    const sc = script.shots[id];
    if (!sc) continue;
    const k = all.indexOf(id);
    const prev = all[k - 1] && script.shots[all[k - 1]];
    const next = all[k + 1] && script.shots[all[k + 1]];
    out[id] = await synthesizeShot(sc, preset, deps, {
      result: results[id], pause: pauses[id],
      previousText: prev ? spokenBeats(prev, results[prev.shotId]).map(b => b.text).join(' ') : undefined,
      nextText: next ? spokenBeats(next, results[next.shotId]).map(b => b.text).join(' ') : undefined
    });
  }
  return out;
}

/** Longest pause between two beats: longer reads as dead air. */
export const MAX_PAUSE = 1.5;

/** The pause between beats that brings a shot's voice up to `target` seconds (0 if none is needed or possible). */
export function pauseFor(v: ShotVoice, beats: number, target: number): number {
  const gaps = beats - 1, short = target - shotSeconds(v) + (v.pause ?? 0) * gaps;
  if (gaps < 1 || short < 0.3 * gaps) return 0;
  return Math.min(MAX_PAUSE, Math.round((short / gaps) * 10) / 10);
}

/** How long a shot needs on screen for its voice. */
export const shotSeconds = (v: ShotVoice) => VOICE_OFFSET + v.duration + VOICE_TAIL;


/** The edit speeds a step's footage up at most this much (on top of the style's speed) to meet its words. */
export const MAX_SPEEDUP = 1.5;
const EPS = 0.03;

/**
 * Freeze-sync (the method screen-recording narration tools use): the voice is the spine and the picture is
 * edited to it. Each shot's footage is cut at its actions; the piece before each action is fitted to the
 * time until its words (plus WORDS_LEAD): idle footage is cut first, then the piece is sped up a little, and
 * a piece that is too short freezes on the frame before the cursor moves. Every action then lands on its words.
 */
export function attachVoices(tl: Timeline, voices: Record<string, ShotVoice>, takes: Record<string, Take | undefined> = {}): string[] {
  const notes: string[] = [];
  for (const s of tl.shots) {
    const v = voices[s.shotId];
    if (!v) continue;
    const drift = fitToVoice(s, v, takes[s.shotId]?.events ?? []);
    s.voice = { line: v.line, file: v.file, duration: v.duration, words: v.words, offset: VOICE_OFFSET, trimStart: v.lead };
    if (drift.length) notes.push(`${s.shotId}: could not fit ${drift.join(', ')} to its words`);
  }
  return notes;
}

/** Fits one shot's footage to its voice; returns the steps it could not fit within 0.3 s. */
export function fitToVoice(s: TimelineShot, v: ShotVoice, events: TakeEvent[]): string[] {
  if (!s.segments.length) return [];
  const start = s.segments[0].in, end = s.segments[s.segments.length - 1].out;
  // Anchors: each step's action, due when its words start (+ lead); kept in order on both clocks
  const anchors: { id: string; t: number; due: number }[] = [];
  for (const id of s.stepIds) {
    const t = events.find(e => e.type === 'act' && e.stepId === id)?.t;
    const beat = v.beatTimes[id];
    if (t === undefined || beat === undefined || t <= start + EPS || t >= end - EPS) continue;
    const due = VOICE_OFFSET + beat + WORDS_LEAD;
    const prev = anchors[anchors.length - 1];
    if (!prev || (t > prev.t + EPS && due > prev.due)) anchors.push({ id, t, due });
  }
  // Footage that can be cut, stillest first: before the cursor moves for a step, then the rest of holds
  const still: [number, number][] = [], held: [number, number][] = [];
  for (const e of events) {
    if (e.type === 'step_start' || e.type === 'shot_start') {
      const loc = events.find(x => x.type === 'located' && x.t >= e.t && (e.type === 'shot_start' || x.stepId === e.stepId));
      if (loc) still.push([e.t, loc.t - 0.25]);
    }
    if (e.type === 'hold_start') {
      const h = events.find(x => x.type === 'hold_end' && x.stepId === e.stepId && x.t >= e.t);
      if (h) held.push([e.t + 0.6, h.t - 0.2]);   // the result stays on screen for a moment
    }
  }
  const idle = [...still, ...held];
  const pieces = splitAt(s.segments, anchors.map(a => a.t));
  const drift: string[] = [];
  let done = 0;
  const out: Segment[] = [];
  anchors.forEach((a, k) => {
    const loc = events.filter(e => e.type === 'located' && e.stepId === a.id && e.t < a.t).pop();
    const piece = fitPiece(pieces[k], a.due - done, idle, loc ? loc.t - 0.25 : undefined);
    const got = dur(piece);
    if (Math.abs(got - (a.due - done)) > 0.3) drift.push(a.id);
    done += got;
    out.push(...piece);
  });
  // After the last action: the voice finishes, and the last result stays on screen at least a second
  const need = Math.max(VOICE_OFFSET + v.duration + VOICE_TAIL - done, anchors.length ? 1 : 0);
  const last = trimTailOf(pieces[anchors.length], need);
  s.hold = Math.max(0, r3(need - dur(last)));
  s.segments = [...out, ...last].filter(g => g.out - g.in > 0.01 || g.hold);
  return drift;
}

const dur = (segs: Segment[]) => segs.reduce((d, g) => d + segDuration(g), 0);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Splits segments into pieces at the given source times (increasing). */
function splitAt(segs: Segment[], cuts: number[]): Segment[][] {
  const pieces: Segment[][] = [[]];
  let c = 0;
  for (const g0 of segs) {
    let g = { ...g0 };
    while (c < cuts.length && cuts[c] < g.out - EPS) {
      if (cuts[c] > g.in + EPS) { pieces[pieces.length - 1].push({ ...g, out: cuts[c] }); g = { ...g, in: cuts[c] }; }
      pieces.push([]);
      c++;
    }
    pieces[pieces.length - 1].push(g);
  }
  while (pieces.length < cuts.length + 1) pieces.push([]);
  return pieces;
}

/** Fits a piece to `need` on-screen seconds: cut idle footage, then speed up (capped), or freeze at `freezeAt`. */
function fitPiece(piece: Segment[], need: number, idle: [number, number][], freezeAt?: number): Segment[] {
  need = Math.max(0.1, need);
  let excess = dur(piece) - need;
  for (const [x, y] of idle) {
    if (excess <= EPS) break;
    const before = dur(piece);
    piece = cutSpan(piece, x, y, excess);
    excess -= before - dur(piece);
  }
  if (excess > EPS) {
    const f = Math.min(MAX_SPEEDUP, dur(piece) / need);
    piece = piece.map(g => ({ ...g, speed: r3(g.speed * f) }));
  } else if (excess < -EPS && piece.length) {
    // Freeze on the frame before the cursor moves (the page is settled); else at the piece's start
    let i = 0;
    if (freezeAt !== undefined) {
      const inside = piece.findIndex(g => freezeAt > g.in + EPS && freezeAt < g.out - EPS);
      if (inside >= 0) {
        const g = piece[inside];
        piece.splice(inside, 1, { ...g, out: r3(freezeAt) }, { in: r3(freezeAt), out: g.out, speed: g.speed });
        i = inside + 1;
      } else i = Math.max(0, piece.findIndex(g => Math.abs(g.in - freezeAt) <= EPS));
    }
    piece[i] = { ...piece[i], hold: r3((piece[i].hold ?? 0) - excess) };
  }
  return piece;
}

/** Removes up to `max` on-screen seconds of source footage inside [x, y]. */
function cutSpan(segs: Segment[], x: number, y: number, max: number): Segment[] {
  const out: Segment[] = [];
  let left = max;
  for (const g of segs) {
    const lo = Math.max(g.in, x), hi = Math.min(g.out, y);
    if (left <= EPS || hi - lo <= EPS) { out.push(g); continue; }
    const take = Math.min(left, (hi - lo) / g.speed);
    const z = r3(lo + take * g.speed);
    left -= take;
    if (lo > g.in + EPS) out.push({ ...g, out: r3(lo) });
    if (z < g.out - EPS) out.push({ in: z, out: g.out, speed: g.speed, ...(lo <= g.in + EPS && g.hold ? { hold: g.hold } : {}) });
  }
  return out;
}

/** Shortens footage to `keep` on-screen seconds by cutting from its end. */
function trimTailOf(segs: Segment[], keep: number): Segment[] {
  const out = segs.map(g => ({ ...g }));
  let total = dur(out);
  while (out.length && total - keep > 0.05) {
    const last = out[out.length - 1];
    const span = (last.out - last.in) / last.speed;
    const cut = Math.min(total - keep, span);
    if (cut >= span - 0.05 && out.length > 1) { out.pop(); total -= segDuration(last); continue; }
    last.out = r3(last.out - cut * last.speed);
    total -= cut;
    break;
  }
  return out;
}

/** What the recorder needs to give each step enough footage (the edit then fits it exactly). */
export function paceOf(v: ShotVoice, preset: Preset) {
  return { beatTimes: v.beatTimes, voiceSec: v.duration, offset: VOICE_OFFSET, tail: VOICE_TAIL, speed: preset.speed };
}
