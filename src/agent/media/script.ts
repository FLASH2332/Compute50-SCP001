/**
 * The voice-over script, written ONCE, right after the storyboard is approved and before anything is recorded.
 *
 * Every shot gets one beat of text per step: the words spoken while that step happens on screen. The recording
 * is then paced to the voice (picture follows the voice), so the click lands when the narration mentions it.
 * Style samples, the final video and edits all reuse this one script.
 */
import type { TextModel } from '../core/ports.js';
import { repetitionInLines } from './check.js';
import { beatList, fallbackBeats, loadStyle, tidy, words, type LineContext } from './voice.js';

export interface BeatText { stepId: string; text: string }
export interface ShotScript {
  shotId: string;
  beats: BeatText[];       // in step order; '' = the intro (no step)
  line: string;            // the beats joined: what is spoken
  by: 'llm' | 'rules';
  dynamic?: boolean;       // names something only known after recording (a search result): re-voiced then
}
export interface Script { shots: Record<string, ShotScript>; wps: number; notes: string[] }

/** Speaking pace (words per second) for instructional narration: ~140 wpm calm, ~155 wpm fast. */
export const WPS = { calm: 2.3, fast: 2.6 } as const;
/** Placeholder the writer uses for a result title not known until recording. */
export const RESULT = '{result}';

export interface ScriptItem { shotId: string; c: LineContext; seconds: number }

const maxWordsFor = (seconds: number, wps: number) => Math.max(5, Math.floor(Math.max(0, seconds - 0.8) * wps));
const joinBeats = (beats: BeatText[]) => tidy(beats.map(b => b.text.trim()).filter(Boolean).join(' '));

/** Accepts {"shots": {"shot1": {"beats": [{"step": "st1", "text": "…"}]}}} and the shapes models also return. */
function parseShot(raw: unknown, allowed: Set<string>): BeatText[] | null {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as any).beats) ? (raw as any).beats : null;
  if (!list) return typeof raw === 'string' && raw.trim() ? [{ stepId: [...allowed][0] ?? '', text: raw }] : null;
  const out: BeatText[] = [];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const stepId = String((b as any).step ?? (b as any).stepId ?? '');
    const text = String((b as any).text ?? '').trim();
    if (text && (allowed.has(stepId) || (!stepId && allowed.has('')))) out.push({ stepId, text });
  }
  return out.length ? out : null;
}

async function askScript(items: ScriptItem[], wps: number, llm: TextModel, style: string, fix?: { lines: Record<string, string>; problems: Record<string, string> }) {
  const first = items[0].c;
  return llm.json<Record<string, unknown>>(
    [
      'You write the voice-over script for a screen-recorded product demo, before it is recorded. The recording will be paced to your words.',
      'Follow this style guide exactly:', style,
      'Each shot lists its beats in order: one per step that happens on screen (an "arrive" beat covers the clicks that only get us to a page).',
      `Write the words spoken during each beat. Keep each shot within maxWords (pace: ${wps} words per second). The words of a beat are said as its step starts.`,
      `For an "open result" beat whose title is not known yet, write ${RESULT} where the title goes (e.g. "${RESULT} looks like a good fit").`,
      fix ? 'Some lines broke the repetition rules: rewrite ONLY the listed shots, keeping their beats.' : '',
      'Return {"shots": {"<shot id>": {"beats": [{"step": "<step id>", "text": "..."}]}}}. Use "" as the step of a shot with no steps.'
    ].filter(Boolean).join('\n'),
    JSON.stringify({
      goal: first.goal, audience: first.audience, site: first.site,
      shots: items.filter(i => !fix || fix.problems[i.shotId]).map(({ shotId, c, seconds }) => ({
        id: shotId, seconds: Math.round(seconds), maxWords: maxWordsFor(seconds, wps), title: c.title, isIntro: c.isIntro, isLast: c.isLast,
        beats: c.isIntro && !c.steps.length ? [{ step: '', beat: 'welcome' }] : beatList(c), screenBefore: c.before, screenAfter: c.after,
        ...(fix ? { currentLine: fix.lines[shotId], problem: fix.problems[shotId] } : {})
      })),
      ...(fix ? { otherLines: fix.lines } : {})
    })
  );
}

/**
 * Writes the whole script in one LLM call (a second call only to fix repetition), with a deterministic
 * fallback per shot. Lines that come back too long fall back to the rules for that shot.
 */
export async function writeScript(items: ScriptItem[], opts: { llm?: TextModel; style?: string; wps?: number }): Promise<Script> {
  const wps = opts.wps ?? WPS.calm;
  const style = opts.style ?? loadStyle();
  const shots: Record<string, ShotScript> = {};
  const notes: string[] = [];
  const allowedOf = (i: ScriptItem) => new Set(i.c.isIntro && !i.c.steps.length ? [''] : beatList(i.c).map(b => b.step));
  const accept = (i: ScriptItem, beats: BeatText[] | null, by: 'llm' | 'rules') => {
    if (!beats) return false;
    const line = joinBeats(beats);
    if (!line || words(line) > Math.ceil(maxWordsFor(i.seconds, wps) * 1.4) + 3) return false;
    shots[i.shotId] = { shotId: i.shotId, beats: beats.map(b => ({ ...b, text: tidy(b.text) })), line, by, dynamic: line.includes(RESULT) || undefined };
    return true;
  };

  if (opts.llm && items.length) {
    const r = await askScript(items, wps, opts.llm, style).catch(e => { notes.push(`script: model failed (${(e as Error).message.slice(0, 120)}); using rules`); return null; });
    const all = r && typeof r.shots === 'object' && r.shots ? r.shots as Record<string, unknown> : r ?? {};
    for (const i of items) accept(i, parseShot(all[i.shotId], allowedOf(i)), 'llm');
  }
  for (const i of items) {
    if (shots[i.shotId]) continue;
    accept(i, fallbackBeats(i.c, maxWordsFor(i.seconds, wps)), 'rules') || accept(i, fallbackBeats(i.c, 9999), 'rules');
    if (opts.llm) notes.push(`script: ${i.shotId} written by rules`);
  }

  // Repetition across the whole script: one rewrite of the offending shots
  const problems = Object.fromEntries(repetitionInLines(items.map(i => ({ id: i.shotId, text: shots[i.shotId].line }))).map(f => [f.shotId!, f.message]));
  if (opts.llm && Object.keys(problems).length) {
    const lines = Object.fromEntries(items.map(i => [i.shotId, shots[i.shotId].line]));
    const r = await askScript(items, wps, opts.llm, style, { lines, problems }).catch(() => null);
    const all = r && typeof r.shots === 'object' && r.shots ? r.shots as Record<string, unknown> : r ?? {};
    for (const i of items) if (problems[i.shotId]) {
      const before = shots[i.shotId];
      if (!accept(i, parseShot(all[i.shotId], allowedOf(i)), 'llm')) shots[i.shotId] = before;
    }
    const left = repetitionInLines(items.map(i => ({ id: i.shotId, text: shots[i.shotId].line })));
    notes.push(...left.map(f => `script: ${f.shotId} ${f.message}`));
  }
  return { shots, wps, notes };
}

/** The spoken text once the result is known ({result} → its on-screen title). */
export function resolveLine(s: ShotScript, result?: string): string {
  const title = result ? `“${result.replace(/[“”"]/g, '')}”` : 'the best match';
  return tidy(s.line.split(RESULT).join(title));
}
