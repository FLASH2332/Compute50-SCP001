/**
 * Voice first: each shot's script line is synthesized BEFORE the shot is recorded. The word timings
 * tell when each beat (step) starts in the audio; the recorder then paces the shot so each step
 * happens as its words are spoken, and assembly places the voice as is (no speeding the picture up).
 */
import path from 'node:path';
import type { Speech, Word } from '../core/ports.js';
import { RESULT, type Script, type ShotScript } from './script.js';
import { segDuration, toOut, type Preset, type Segment, type Timeline } from './timeline.js';
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
}

/** Voice starts this long after the shot starts; the shot ends this long after the voice. */
export const VOICE_OFFSET = 0.25;
export const VOICE_TAIL = 0.35;
/** Words lead their action by this much (must match the recorder's WORDS_LEAD). */
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
export async function synthesizeShot(sc: ShotScript, preset: Preset, deps: NarrateDeps, opts: { result?: string; previousText?: string; nextText?: string } = {}): Promise<ShotVoice> {
  const beats = spokenBeats(sc, opts.result);
  const line = tidy(beats.map(b => b.text).join(' '));
  const clip = await deps.speech.synthesize(line, path.join(deps.runDir, 'voice'), preset.voiceSpeed, { previousText: opts.previousText, nextText: opts.nextText });
  const lead = Math.max(0, clip.words[0]?.start ?? 0);
  const end = clip.words.length ? clip.words[clip.words.length - 1].end : clip.duration;
  const shifted = clip.words.map(w => ({ text: w.text, start: Math.max(0, w.start - lead), end: Math.max(0, w.end - lead) }));
  return {
    shotId: sc.shotId, preset: preset.name, line,
    file: path.relative(deps.runDir, path.join(deps.runDir, 'voice', clip.file)).replace(/\\/g, '/'),
    lead: Math.round(lead * 1000) / 1000, duration: Math.round((end - lead) * 1000) / 1000, words: shifted,
    beatTimes: beatTimesFrom(beats, shifted)
  };
}

/** Synthesizes every listed shot in order (each one stitched to the lines around it). */
export async function synthesizeShots(script: Script, order: string[], preset: Preset, deps: NarrateDeps, results: Record<string, string | undefined> = {}): Promise<Record<string, ShotVoice>> {
  const out: Record<string, ShotVoice> = {};
  const all = Object.keys(script.shots);
  for (const id of order) {
    const sc = script.shots[id];
    if (!sc) continue;
    const k = all.indexOf(id);
    const prev = all[k - 1] && script.shots[all[k - 1]];
    const next = all[k + 1] && script.shots[all[k + 1]];
    out[id] = await synthesizeShot(sc, preset, deps, {
      result: results[id],
      previousText: prev ? spokenBeats(prev, results[prev.shotId]).map(b => b.text).join(' ') : undefined,
      nextText: next ? spokenBeats(next, results[next.shotId]).map(b => b.text).join(' ') : undefined
    });
  }
  return out;
}

/** How long a shot needs on screen for its voice. */
export const shotSeconds = (v: ShotVoice) => VOICE_OFFSET + v.duration + VOICE_TAIL;

/**
 * Places each shot's voice as recorded: no speeding the picture up. If the footage is shorter than the
 * voice, the last frame holds; a much longer footage is reported (the recorder normally prevents it).
 */
export function attachVoices(tl: Timeline, voices: Record<string, ShotVoice>, lastAct: Record<string, number | undefined> = {}, offsets: Record<string, number | undefined> = {}, firstMove: Record<string, number | undefined> = {}, acts: Record<string, Record<string, number>> = {}): string[] {
  const notes: string[] = [];
  for (const s of tl.shots) {
    const v = voices[s.shotId];
    if (!v) continue;
    // Quiet footage after the voice is trimmed, but the last action's result stays on screen for a second
    const act = lastAct[s.shotId];
    let offset = offsets[s.shotId] ?? VOICE_OFFSET;   // where the recording anchored the voice
    // Still footage before the cursor first moves is cut, and the voice moves up with it
    const move = firstMove[s.shotId];
    if (move !== undefined && offsets[s.shotId] !== undefined) offset = Math.max(0.1, offset - trimHead(s.segments, move - 0.25, offset - 0.1));
    // Final placement from the edited footage: the voice starts so its beats land WORDS_LEAD before their actions (median over steps)
    const gaps = Object.entries(acts[s.shotId] ?? {}).filter(([id]) => v.beatTimes[id] !== undefined).map(([id, t]) => toOut(s, t) - s.outStart - v.beatTimes[id] - WORDS_LEAD).sort((a, b) => a - b);
    if (gaps.length) offset = Math.min(4, Math.max(0.1, gaps[Math.floor((gaps.length - 1) / 2)]));
    const need = offset + v.duration + VOICE_TAIL;
    const keep = Math.max(need, act !== undefined ? toOut(s, act) - s.outStart + 1 : 0);
    trimTail(s.segments, keep);
    const footage = s.segments.reduce((d, g) => d + segDuration(g), 0);
    s.voice = { line: v.line, file: v.file, duration: v.duration, words: v.words, offset, trimStart: v.lead };
    s.hold = Math.max(0, Math.round((need - footage) * 1000) / 1000);
    if (footage > need + 1.5) notes.push(`${s.shotId}: ${(footage - need).toFixed(1)}s of footage after the voice ends`);
  }
  return notes;
}

/** What the recorder needs to pace a shot to its voice. */
export function paceOf(v: ShotVoice, preset: Preset) {
  return { beatTimes: v.beatTimes, voiceSec: v.duration, offset: VOICE_OFFSET, tail: VOICE_TAIL, speed: preset.speed };
}

/** Shortens a shot's footage to `keep` on-screen seconds by cutting from its end. */
function trimTail(segs: Segment[], keep: number) {
  let total = segs.reduce((d, g) => d + segDuration(g), 0);
  while (segs.length && total - keep > 0.05) {
    const last = segs[segs.length - 1];
    const cut = Math.min(total - keep, segDuration(last));
    if (cut >= segDuration(last) - 0.05 && segs.length > 1) { segs.pop(); total -= segDuration(last); continue; }
    last.out = Math.round((last.out - cut * last.speed) * 1000) / 1000;
    total -= cut;
    break;
  }
}

/** Cuts footage from a shot's start up to `until` (source seconds), at most `max` on-screen seconds; returns what was cut. */
function trimHead(segs: Segment[], until: number, max: number): number {
  let cut = 0;
  while (segs.length && max - cut > 0.05) {
    const first = segs[0];
    if (until <= first.in) break;
    const end = Math.min(until, first.out, first.in + (max - cut) * first.speed);
    cut += (end - first.in) / first.speed;
    if (end >= first.out - 0.05 && segs.length > 1) { segs.shift(); continue; }
    first.in = Math.round(end * 1000) / 1000;
    break;
  }
  return cut;
}
