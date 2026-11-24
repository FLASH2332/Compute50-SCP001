import type { Control, Risk } from '../core/appMap.js';

const DESTRUCTIVE = /\b(delete|remove|destroy|deactivate|revoke|terminate|erase|wipe|unsubscribe|pay|purchase|buy|checkout|transfer|cancel (subscription|order|plan|account))\b/i;
const MUTATING = /\b(save|send|submit|confirm|publish|update|apply|invite|create|add|post|upload|import|approve|reject|archive|sign ?out|log ?out|reset)\b/i;
// A button outside a form whose label reads like "open something" usually opens UI (a dialog, a drawer)
const OPENER = /^\s*(\+|add\b|new\b|create\b|invite\b|open\b|edit\b|view\b|show\b|toggle\b|filter|more\b|menu\b|details\b|settings\b)/i;
const RISKY_HREF = /(logout|log-out|signout|sign-out|delete|remove|unsubscribe)/i;

/**
 * Risk class of an action (A1.2). Safe actions may be clicked by the
 * interaction explorer; mutating ones only during an approved recording;
 * destructive ones need a one-time approval for that exact step.
 */
export function riskOf(a: Pick<Control, 'type' | 'label' | 'href'>, sectionRole?: string): Risk {
  const label = a.label || '';
  if (a.type === 'link') return a.href && RISKY_HREF.test(a.href) ? 'mutating' : 'safe';
  if (DESTRUCTIVE.test(label)) return 'destructive';
  if (a.type === 'submit') return 'mutating';
  if (a.type === 'input' || a.type === 'select' || a.type === 'choice') return 'safe';
  if (a.type === 'tab') return 'safe';
  if (sectionRole !== 'form' && OPENER.test(label)) return 'safe';
  if (MUTATING.test(label)) return 'mutating';
  return 'safe';
}

/** ARIA role used by getByRole for this action type. */
export function ariaRoleOf(a: Pick<Control, 'type' | 'inputType'>): string {
  switch (a.type) {
    case 'link': return 'link';
    case 'tab': return 'tab';
    case 'select': return 'combobox';
    case 'choice': return a.inputType === 'radio' ? 'radio' : 'checkbox';
    case 'input': return a.inputType === 'number' ? 'spinbutton' : a.inputType === 'search' ? 'searchbox' : 'textbox';
    default: return 'button';
  }
}

export function allowedHosts(): string[] {
  return (process.env.DEMO_ALLOW_HOSTS || 'localhost,127.0.0.1,[::1]').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

export type SiteMode = 'full' | 'public';

/**
 * Hosts in DEMO_ALLOW_HOSTS (your own apps; default localhost) run in full
 * mode: forms can be filled and submit/save steps run once the storyboard is
 * approved. Any other host runs in public mode: follow links, switch tabs,
 * open dialogs and type into search boxes — nothing else is typed or
 * submitted, and form POSTs are blocked.
 */
export function modeFor(url: string): SiteMode {
  const host = new URL(url).hostname.toLowerCase();
  return allowedHosts().some(h => { const x = h.replace(/^\[|\]$/g, ''); return host === x || host.endsWith('.' + x); }) ? 'full' : 'public';
}

const SEARCH_LABEL = /(search|find|look ?up|query|what are you looking for)/i;
const SEARCH_NAME = /\[(?:name|id|aria-label)="(?:q|query|s|search|keywords?|term|search[-_]?(?:input|box|field|query|term)?)"\]|#(?:q|query|search[-_a-z]*)/i;

/** A field that only searches (safe to type into on a public site). */
export function isSearchInput(c: Pick<Control, 'type' | 'inputType' | 'label' | 'selector'> & { section?: { role: string; name: string } }): boolean {
  if (c.type !== 'input') return false;
  if (c.inputType === 'search') return true;
  if (c.inputType && !['text', 'search'].includes(c.inputType)) return false;
  return SEARCH_LABEL.test(c.label) || SEARCH_NAME.test(c.selector) || /search/i.test(c.section?.name || '');
}
