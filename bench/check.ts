/**
 * Automatic task checks, and a short failure reason for the report.
 */
import type { AgentResult } from './agent/agent.js';
import type { Task } from './tasks.js';

export type Failure =
  | 'budget'          // ran out of tool calls or time
  | 'error'           // the model server or a tool failed
  | 'no-finish'       // answered in text without calling finish (still checked)
  | 'wrong-page'      // ended on another page
  | 'no-action'       // the required click / fill did not happen (or failed)
  | 'wrong-answer'    // the answer lacks something
  | 'gave-up'         // said NOT FOUND on a task that is possible
  | 'invented';       // did not say NOT FOUND on an impossible task

export interface Verdict { pass: boolean; reasons: string[]; failure?: Failure }

const re = (s: string) => new RegExp(s, 'i');
const json = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
const NOT_FOUND = /not\s*found/i;

/** `labelOf(action_id)` maps an action id to its label in the variant's graph (for `performed`). */
export function checkTask(task: Task, r: AgentResult, labelOf: (id: string) => string | undefined): Verdict {
  const reasons: string[] = [];
  const kinds: Failure[] = [];
  const c = task.check;
  const answer = r.answer ?? '';
  const finalUrl = String((r.finalPage as any)?.url ?? '');

  if (c.notFound) {
    if (!NOT_FOUND.test(answer)) { reasons.push('did not say NOT FOUND'); kinds.push('invented'); }
  } else if (NOT_FOUND.test(answer) && !c.answer) {
    reasons.push('said NOT FOUND'); kinds.push('gave-up');
  }
  if (c.url && !re(c.url).test(finalUrl)) {
    reasons.push(`ended on ${finalUrl || '(no page)'}, wanted /${c.url}/`); kinds.push('wrong-page');
  }
  const done = r.calls.filter(k => (k.name === 'perform' || k.name === 'fill') && json(k.result)?.done === true);
  if (c.performed) {
    const labels = done.map(k => labelOf(String((k.args as any)?.action_id ?? '')) ?? '');
    if (!labels.some(l => re(c.performed!).test(l))) {
      reasons.push(`no completed action like /${c.performed}/ (did: ${labels.filter(Boolean).join(', ') || 'none'})`); kinds.push('no-action');
    }
  }
  if (c.filled) {
    const texts = done.filter(k => k.name === 'fill').map(k => String((k.args as any)?.text ?? ''));
    if (!texts.some(t => re(c.filled!).test(t))) { reasons.push(`no completed fill with /${c.filled}/`); kinds.push('no-action'); }
  }
  for (const a of c.answer ?? []) if (!re(a).test(answer)) { reasons.push(`answer lacks /${a}/`); kinds.push('wrong-answer'); }

  const pass = reasons.length === 0;
  // The most telling reason first: a run that hit its budget or crashed is reported as such
  let failure: Failure | undefined;
  if (!pass) {
    if (r.stop === 'max_calls' || r.stop === 'timeout') failure = 'budget';
    else if (r.stop === 'error') failure = 'error';
    else failure = kinds[0];
  }
  if (r.stop !== 'finish') reasons.unshift(`stopped: ${r.stop}${r.error ? ' (' + r.error.slice(0, 120) + ')' : ''}`);
  return { pass, reasons, failure: pass ? undefined : failure ?? (r.stop === 'text' ? 'no-finish' : 'wrong-answer') };
}
