import type { AppMap } from '../core/appMap.js';
import type { Take } from '../record/runner.js';
import { norm } from '../nav/locate.js';
import type { Timeline } from './timeline.js';

export interface Finding { rule: 'silence' | 'voice_fits' | 'label_match' | 'passing_take'; shotId?: string; message: string }

const SILENCE = 1.0;
const FIT_TOLERANCE = 0.3;

/** Quoted names in a voice line: “…”, "…" or ‘…’. */
export function quotedNames(line: string): string[] {
  return [...line.matchAll(/[“"‘]([^”"’]{1,60})[”"’]/g)].map(m => m[1].trim());
}

/**
 * media.check (B1 R1 rules):
 *  - no silence over 1 s (from voice placement on the final timeline)
 *  - every voice clip fits inside its shot (0.3 s tolerance)
 *  - every quoted button/field name matches a label or alias in the graph
 *  - every shot only uses flow steps that have a passing take (A1.12)
 */
export function checkTimeline(tl: Timeline, takes: Record<string, Take>, map: AppMap): Finding[] {
  const out: Finding[] = [];
  const spans = tl.shots.filter(s => s.voice).map(s => ({ id: s.shotId, a: s.outStart + s.voice!.offset, b: s.outStart + s.voice!.offset + s.voice!.duration })).sort((x, y) => x.a - y.a);
  let t = 0;
  let prev = 'start';
  for (const sp of spans) {
    // Blame the shot whose voice ends early (its tail is the silent part)
    if (sp.a - t > SILENCE) out.push({ rule: 'silence', shotId: prev === 'start' ? sp.id : prev, message: `${(sp.a - t).toFixed(1)}s of silence before ${sp.id}${prev === 'start' ? '' : ` (end of ${prev})`}` });
    t = Math.max(t, sp.b);
    prev = sp.id;
  }
  // A short quiet tail is a natural ending; only a long one is flagged
  if (tl.duration - t > SILENCE * 2) out.push({ rule: 'silence', message: `${(tl.duration - t).toFixed(1)}s of silence at the end` });

  for (const s of tl.shots) {
    if (s.voice && s.voice.offset + s.voice.duration > s.outDuration + FIT_TOLERANCE)
      out.push({ rule: 'voice_fits', shotId: s.shotId, message: `voice runs ${(s.voice.offset + s.voice.duration - s.outDuration).toFixed(1)}s past the end of the shot` });
  }

  const known = new Set<string>();
  for (const a of Object.values(map.controls)) for (const l of [a.label, ...(a.aliases || [])]) known.add(norm(l));
  for (const sec of Object.values(map.sections)) known.add(norm(sec.name));
  for (const t of Object.values(takes)) for (const l of t?.labels || []) known.add(norm(l));
  for (const s of tl.shots) {
    for (const name of quotedNames(s.voice?.line || '')) {
      const n = norm(name);
      if (!known.has(n)) out.push({ rule: 'label_match', shotId: s.shotId, message: `narration names “${name}”, which is not a label on screen` });
    }
  }

  for (const s of tl.shots) {
    const take = takes[s.shotId];
    if (!take?.ok) { out.push({ rule: 'passing_take', shotId: s.shotId, message: `no passing take${take?.error ? `: ${take.error}` : ''}` }); continue; }
    const passed = new Set(take.steps.filter(r => r.status === 'pass').map(r => r.stepId));
    const bad = s.stepIds.filter(id => !passed.has(id));
    if (bad.length) out.push({ rule: 'passing_take', shotId: s.shotId, message: `steps without a passing take: ${bad.join(', ')}` });
  }
  return out;
}
