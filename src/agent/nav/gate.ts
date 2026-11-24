import type { Control } from '../core/appMap.js';
import { isSearchInput, type SiteMode } from './risk.js';

export class GateError extends Error {}

/**
 * Risk gate. On public sites (see modeFor) only browsing and searching pass.
 * Otherwise: safe actions always pass. Mutating actions (submit,
 * save, send) pass only if the approved storyboard uses them. Destructive
 * ones need a one-time approval for that exact action, used up on first run.
 */
export class Gate {
  constructor(public approved: Set<string> = new Set(), public oneTime: Set<string> = new Set(), public mode: SiteMode = 'full') {}

  /** Checks a control before acting on it with `op`. */
  check(a: Control, op: string = 'click'): void {
    if (this.mode === 'public') {
      // Public sites: only search boxes may be typed into, and nothing that changes data
      if ((op === 'fill' || op === 'search') && !isSearchInput(a)) throw new GateError(`"${a.label}" is not a search box; on a public site the agent only types into search boxes`);
      if (op === 'select' || op === 'check') throw new GateError(`"${a.label}": the agent does not change form fields on a public site`);
      if (a.type === 'submit' && op !== 'search') throw new GateError(`"${a.label}" submits a form; not allowed on a public site`);
      if ((a.risk || 'safe') !== 'safe') throw new GateError(`"${a.label}" could change data; not allowed on a public site`);
      return;
    }
    const risk = a.risk || 'safe';
    if (risk === 'safe') return;
    if (risk === 'mutating') {
      if (this.approved.has(a.id)) return;
      throw new GateError(`"${a.label}" changes data and is not part of the approved storyboard`);
    }
    if (this.oneTime.delete(a.id)) return;
    throw new GateError(`"${a.label}" is destructive and needs a one-time approval for this step`);
  }
}
