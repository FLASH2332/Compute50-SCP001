/**
 * Voice first: each shot's script line is synthesized BEFORE the shot is recorded. The word timings
 * tell when each beat (step) starts in the audio; the recorder then paces the shot so each step
 * happens as its words are spoken, and assembly places the voice as is (no speeding the picture up).
 */
import path from 'node:path';
import type { Speech, Word } from '../core/ports.js';
import { RESULT, type Script, type ShotScript } from './script.js';
import { segDuration, type Preset, type Timeline } from './timeline.js';
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
export const VOICE_TAIL = 0.5;

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
export function attachVoices(tl: Timeline, voices: Record<string, ShotVoice>): string[] {
  const notes: string[] = [];
  for (const s of tl.shots) {
    const v = voices[s.shotId];
    if (!v) continue;
    const footage = s.segments.reduce((d, g) => d + segDuration(g), 0);
    s.voice = { line: v.line, file: v.file, duration: v.duration, words: v.words, offset: VOICE_OFFSET, trimStart: v.lead };
    s.hold = Math.max(0, Math.round((shotSeconds(v) - footage) * 1000) / 1000);
    if (footage > shotSeconds(v) + 1.5) notes.push(`${s.shotId}: ${(footage - shotSeconds(v)).toFixed(1)}s of footage after the voice ends`);
  }
  return notes;
}
