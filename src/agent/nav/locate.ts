import type { Locator, Page } from 'playwright';
import type { Box, Control } from '../core/appMap.js';
import type { TextModel } from '../core/ports.js';
import { ariaRoleOf } from './risk.js';
import type { ChangeLog } from './changes.js';

export class ActionMissingError extends Error {
  constructor(public actionId: string, label: string) {
    super(`"${label}" (${actionId}) is no longer on the page`);
  }
}

interface Candidate { idx: number; label: string; role: string; box: Box; selector: string }

export const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Dice similarity over character bigrams of normalized labels (0..1). */
export function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const gx = grams(x), gy = grams(y);
  let inter = 0;
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) || 0);
  return (2 * inter) / (Math.max(1, x.length - 1) + Math.max(1, y.length - 1));
}

// In-page helpers (stringified into page.evaluate)
const DESCRIBE = `
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const shown = el => { const b = el.getBoundingClientRect(); if (!b.width || !b.height) return false;
    for (let n = el; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } return true; };
  const labelOf = el => { const id = el.id; const f = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    if (['SELECT', 'TEXTAREA', 'INPUT'].includes(el.tagName) && f && !el.getAttribute('aria-label')) return clean(f.textContent);
    return clean(el.getAttribute('aria-label')) || clean(el.innerText) || clean(f && f.textContent) || clean(['submit','button'].includes(el.type) ? el.value : '')
      || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) || clean(el.getAttribute('name')); };
  const roleOf = el => { const r = el.getAttribute('role'); if (r) return r; const t = el.tagName;
    if (t === 'A') return 'link'; if (t === 'SELECT') return 'combobox'; if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') { const ty = (el.type || 'text').toLowerCase(); if (['submit','button','reset','image'].includes(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox'; if (ty === 'radio') return 'radio'; if (ty === 'number') return 'spinbutton'; if (ty === 'search') return 'searchbox'; return 'textbox'; }
    return 'button'; };
  const selectorOf = (el, label) => { const tag = el.tagName.toLowerCase();
    for (const a of ['data-testid', 'data-test', 'id', 'name', 'aria-label']) { const v = el.getAttribute(a); if (v && v.length < 60) return a === 'id' ? '#' + CSS.escape(v) : tag + '[' + a + '="' + v.replace(/"/g, '\\\\"') + '"]'; }
    if (tag === 'a' && el.getAttribute('href')) return 'a[href="' + el.getAttribute('href').replace(/"/g, '\\\\"') + '"]';
    return label && label.length < 40 ? tag + ':has-text("' + label.replace(/"/g, '\\\\"') + '")' : tag; };
`;

async function candidates(page: Page): Promise<Candidate[]> {
  return page.evaluate(`(() => { ${DESCRIBE}
    const out = [];
    document.querySelectorAll('[data-demo-pick]').forEach(e => e.removeAttribute('data-demo-pick'));
    const els = document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"]');
    els.forEach(el => { if (!shown(el) || el.disabled) return; const b = el.getBoundingClientRect(); const label = labelOf(el);
      el.setAttribute('data-demo-pick', String(out.length));
      out.push({ idx: out.length, label, role: roleOf(el), box: { x: b.x, y: b.y, width: b.width, height: b.height }, selector: selectorOf(el, label) }); });
    return out; })()`);
}

export async function describeLocator(loc: Locator): Promise<{ label: string; box: Box; selector: string } | null> {
  const fn = new Function('el', `${DESCRIBE}
    const b = el.getBoundingClientRect(); const label = labelOf(el);
    return { label, box: { x: b.x, y: b.y, width: b.width, height: b.height }, selector: selectorOf(el, label) };`) as (el: Element) => { label: string; box: Box; selector: string };
  return loc.evaluate(fn).catch(() => null);
}

export interface Located { locator: Locator; via: string; tier: 1 | 3 | 6; box: Box; healed: boolean }

/**
 * Finds an action on the live page (A1.5): tier 1 stored locators ordered by
 * hit count, tier 3 fingerprint score (≥ 0.65 with a 0.05 lead), tier 6 an LLM
 * pick among the top 5. Fallback hits update the stored selector and the heal
 * log (A1.6); a changed label is a rename (B3); nothing found → missing (B3).
 */
export async function locateAction(page: Page, action: Control, changes: ChangeLog, llm?: TextModel): Promise<Located> {
  const role = ariaRoleOf(action) as any;
  const names = [action.label, ...(action.aliases || [])];
  const isField = action.type === 'input' || action.type === 'select';
  const tier1: { key: string; make: () => Locator }[] = [
    { key: 'css', make: () => page.locator(action.selector) },
    ...names.map((n, i) => ({ key: i ? `role:alias${i}` : 'role', make: () => page.getByRole(role, { name: n, exact: true }) })),
    { key: isField ? 'label' : 'text', make: () => isField ? page.getByLabel(action.label, { exact: true }) : page.getByText(action.label, { exact: true }) }
  ];
  const hits = action.hits || (action.hits = {});
  tier1.sort((a, b) => (hits[b.key] || 0) - (hits[a.key] || 0));

  let cssFailed = false;
  for (const t of tier1) {
    let loc: Locator;
    try { loc = t.make().first(); } catch { if (t.key === 'css') cssFailed = true; continue; }
    if (!(await loc.count().catch(() => 0)) || !(await loc.isVisible().catch(() => false))) { if (t.key === 'css') cssFailed = true; continue; }
    const d = await describeLocator(loc);
    if (!d) continue;
    // The stored selector may now point at a control with a new label (B3 rename)
    if (t.key === 'css' && similarity(d.label, action.label) < 0.5 && !(action.aliases || []).some(a => similarity(a, d.label) >= 0.8)) {
      if (!d.label || isField) { /* fields/icons: trust the stable selector */ }
      else rename(action, d.label, changes, 'css');
    }
    hits[t.key] = (hits[t.key] || 0) + 1;
    action.box = d.box;
    action.status = 'ok';
    let healed = false;
    if (cssFailed && t.key !== 'css') {
      // The stored selector broke but another locator found it: store a fresh selector
      changes.add({ kind: 'heal', actionId: action.id, from: action.selector, to: d.selector, via: t.key });
      action.selector = d.selector;
      if (t.key.startsWith('role:alias')) rename(action, d.label, changes, t.key);
      healed = true;
    }
    return { locator: loc, via: t.key, tier: 1, box: d.box, healed };
  }

  // Tier 3: fingerprint
  const cands = await candidates(page);
  const scored = cands.map(c => {
    const labelSim = Math.max(...names.map(n => similarity(n, c.label)));
    const roleMatch = c.role === role ? 1 : (role === 'button' && c.role === 'link') || (role === 'link' && c.role === 'button') ? 0.5 : 0;
    let pos = 0.5;
    if (action.box) {
      const dx = (c.box.x + c.box.width / 2) - (action.box.x + action.box.width / 2);
      const dy = (c.box.y + c.box.height / 2) - (action.box.y + action.box.height / 2);
      pos = Math.max(0, 1 - Math.hypot(dx, dy) / 600);
    }
    return { c, score: 0.6 * labelSim + 0.2 * roleMatch + 0.2 * pos, labelSim };
  }).sort((a, b) => b.score - a.score);
  let pick: Candidate | undefined;
  let tier: 3 | 6 = 3;
  if (scored[0] && scored[0].score >= 0.65 && scored[0].score - (scored[1]?.score ?? 0) >= 0.05) pick = scored[0].c;

  // Tier 6: ask the LLM among the top 5
  if (!pick && llm && scored.length) {
    const top = scored.slice(0, 5);
    const reply = await llm.json<{ index: number }>(
      'You match a UI control from an old app map to the live page. Reply {"index": n} with the candidate index that is the same control, or {"index": -1} if none is.',
      JSON.stringify({ wanted: { label: action.label, type: action.type, aliases: action.aliases || [] }, candidates: top.map(s => ({ index: s.c.idx, label: s.c.label, role: s.c.role })) })
    ).catch(() => null);
    if (reply && top.some(s => s.c.idx === reply.index)) { pick = cands[reply.index]; tier = 6; }
  }

  if (!pick) {
    action.status = 'missing';
    changes.add({ kind: 'removed', actionId: action.id, from: action.label, note: 'no locator tier found it' });
    throw new ActionMissingError(action.id, action.label);
  }

  const loc = page.locator(`[data-demo-pick="${pick.idx}"]`).first();
  const oldSelector = action.selector;
  action.selector = pick.selector;
  hits.css = 1;
  action.box = pick.box;
  action.status = 'ok';
  if (similarity(pick.label, action.label) < 0.95) rename(action, pick.label, changes, `tier${tier}`);
  changes.add({ kind: 'heal', actionId: action.id, from: oldSelector, to: pick.selector, via: `tier${tier}` });
  return { locator: loc, via: `tier${tier}`, tier, box: pick.box, healed: true };
}

function rename(action: Control, newLabel: string, changes: ChangeLog, via: string) {
  if (!newLabel || norm(newLabel) === norm(action.label)) return;
  action.aliases = [...new Set([...(action.aliases || []), action.label])];
  changes.add({ kind: 'rename', actionId: action.id, from: action.label, to: newLabel, via });
  action.label = newLabel;
}
