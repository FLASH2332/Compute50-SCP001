import type { Page } from 'playwright';
import type { AppMap, Control } from '../core/appMap.js';
import type { BrowserHooks, Logger, TextModel } from '../core/ports.js';
import { gotoWithRetry, settle } from '../util/pageReady.js';
import type { ChangeLog } from './changes.js';
import { Gate, GateError } from './gate.js';
import { ActionMissingError, locateAction, type Located } from './locate.js';
import { locateState } from './locateState.js';

export class TakeFailed extends Error {
  constructor(public stepId: string, public reason: string) {
    super(`Step ${stepId} failed: ${reason}`);
  }
}

export interface ActHooks {
  beforeAct?: (control: Control, at: Located) => Promise<void>;
  afterAct?: (control: Control) => Promise<void>;
}

export interface NavContext {
  page: Page;
  map: AppMap;
  changes: ChangeLog;
  gate: Gate;
  act?: ActHooks;
  browser?: BrowserHooks;
  llm?: TextModel;
  log?: Logger;
  recoveryBudget?: { left: number };   // at most 5 recovery calls per run
}

/**
 * Step operations. click/fill/select/check act on a known control; search
 * types into a search box and presses Enter; open_result clicks the result
 * link that best matches a text; show scrolls to a page section and
 * highlights it; goto loads a known page by URL.
 */
export type Op = 'click' | 'fill' | 'select' | 'check' | 'search' | 'open_result' | 'show' | 'goto';

/** Locates (with healing), passes the risk gate, then acts. */
export async function performAction(ctx: NavContext, control: Control, op: Op = 'click', value?: string): Promise<Located> {
  ctx.gate.check(control, op);
  const at = await locateAction(ctx.page, control, ctx.changes, ctx.llm);
  await ctx.act?.beforeAct?.(control, at);
  const loc = at.locator;
  const click = (l: typeof loc) => clickThroughOverlays(ctx, control, l);
  if (op === 'search') {
    await click(loc);
    await loc.fill('');
    await ctx.page.keyboard.type(value ?? '', { delay: 55 });
    await ctx.act?.afterAct?.(control);
    await ctx.page.keyboard.press('Enter');
    return at;
  } else if (op === 'fill') {
    await click(loc);
    await loc.fill('');
    await ctx.page.keyboard.type(value ?? '', { delay: 55 });
  } else if (op === 'select') {
    if (value) await loc.selectOption({ label: value }).catch(() => loc.selectOption({ index: 1 }));
    else await loc.selectOption({ index: 1 });
  } else if (op === 'check') {
    await loc.check({ timeout: 5000 });
  } else {
    await click(loc);
  }
  await ctx.act?.afterAct?.(control);
  return at;
}

/**
 * Clicks; when a popup or banner covers the target (Playwright reports that
 * another element "intercepts pointer events"), clears it like a person
 * would: its close button, then Escape, then hides it from view (it is not
 * part of the demo). The fix is remembered for the page as a pre-action. A
 * link that still can't be clicked is followed by loading its URL.
 */
async function clickThroughOverlays(ctx: NavContext, control: Control, loc: import('playwright').Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await loc.click({ timeout: attempt ? 4000 : 5000 }); return; } catch (err) {
      const msg = (err as Error).message.replace(/\u001b\[[0-9;]*m/g, '');
      const cls = msg.match(/<(\w+)[^>]*\bclass="([^"]+)"[^>]*>[^<]*<\/\w+>(?: from <[^>]+>…<\/\w+> subtree)? intercepts pointer events/);
      const id = msg.match(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>[^<]*<\/\w+>(?: from <[^>]+>…<\/\w+> subtree)? intercepts pointer events/);
      if (!/intercepts pointer events/.test(msg)) break;
      const selector = id ? `#${cssEscape(id[2])}` : cls ? `${cls[1]}.${cls[2].trim().split(/\s+/).map(cssEscape).join('.')}` : '';
      if (await clearOverlay(ctx, selector)) continue;
      break;
    }
  }
  if (control.type === 'link' && control.href) {
    ctx.log?.(`  "${control.label}" could not be clicked; opening ${control.href}`);
    await ctx.page.goto(control.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ctx.browser?.afterLoad?.(ctx.page);
    return;
  }
  await loc.click({ timeout: 5000 });
}

const cssEscape = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);

async function clearOverlay(ctx: NavContext, selector: string): Promise<boolean> {
  const page = ctx.page;
  if (selector) {
    const overlay = page.locator(selector).first();
    const close = overlay.locator('button, [role="button"], a, span, div, svg').filter({ hasText: /^(×|✕|x|close|no thanks|not now|skip|maybe later|dismiss)$/i }).first();
    const aria = overlay.locator('[aria-label*="close" i], [title*="close" i], [class*="close" i]').first();
    for (const b of [aria, close]) {
      if (await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
        if (!(await overlay.isVisible().catch(() => false))) return remember(ctx, `click:${selector}`), true;
      }
    }
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  if (!selector) return false;
  if (!(await page.locator(selector).first().isVisible().catch(() => false))) return true;
  const hidden = await page.evaluate(sel => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.style.setProperty('display', 'none', 'important');
    return true;
  }, selector).catch(() => false);
  if (hidden) { ctx.log?.(`  hid an overlay that covered the page (${selector})`); remember(ctx, `hide:${selector}`); }
  return hidden;
}

/** Stores an overlay fix on the current page's base state so later visits apply it on arrival. */
function remember(ctx: NavContext, fix: string) {
  const s = Object.values(ctx.map.states).find(st => st.base && st.url && ctx.page.url().startsWith(st.url.replace(/\/$/, '')));
  if (!s || (s.preActions || []).includes(fix)) return;
  s.preActions = [...(s.preActions || []), fix];
  ctx.changes.add({ kind: 'pre_action', stateId: s.id, to: fix, note: 'overlay fix' });
}

/** Loads a URL, then runs the environment's page hook (e.g. dismiss a cookie banner). */
export async function load(ctx: Pick<NavContext, 'page' | 'browser'> & Partial<Pick<NavContext, 'map'>>, url: string): Promise<void> {
  await gotoWithRetry(ctx.page, url, 2, 30000);
  await ctx.browser?.afterLoad?.(ctx.page);
}

/** Replays learned fixes (e.g. close a tour popup) on arriving in a state. */
async function runPreActions(ctx: NavContext, stateId: string) {
  for (const label of ctx.map.states[stateId]?.preActions || []) {
    if (label.startsWith('hide:')) {
      await ctx.page.evaluate(sel => document.querySelectorAll(sel).forEach(el => (el as HTMLElement).style.setProperty('display', 'none', 'important')), label.slice(5)).catch(() => {});
      continue;
    }
    const b = label.startsWith('click:') ? ctx.page.locator(label.slice(6)).locator('[aria-label*="close" i], [title*="close" i], [class*="close" i]').first() : ctx.page.getByRole('button', { name: label }).first();
    if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 2000 }).catch(() => {}); await settle(ctx.page, 1500); }
  }
}

const DISMISS = /^(close|×|✕|x|dismiss|got it|ok|okay|no thanks|not now|skip|later|continue|decline|reject all)$/i;
const UNSAFE = /delete|remove|save|send|submit|pay|buy|confirm|accept/i;

/**
 * Recovery (restricted): Escape, then a dismiss-style button, then (with an
 * LLM) one pick among visible buttons. Never clicks anything that changes
 * data. A fix that works is learned as a pre-action of the state.
 */
async function recover(ctx: NavContext, wantedId: string, fromStateId: string | null): Promise<boolean> {
  const budget = ctx.recoveryBudget || (ctx.recoveryBudget = { left: 5 });
  if (budget.left <= 0) return false;
  budget.left--;
  const page = ctx.page;
  const known = async () => (await locateState(page, ctx.map)).state;
  await page.keyboard.press('Escape');
  await settle(page, 1500);
  if (await known()) return true;
  const buttons = page.getByRole('button');
  const n = Math.min(await buttons.count(), 40);
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const label = ((await b.innerText().catch(() => '')) || (await b.getAttribute('aria-label')) || '').trim();
    if (label) labels.push(label);
  }
  let pick = labels.find(l => DISMISS.test(l));
  if (!pick && ctx.llm && labels.length) {
    const r = await ctx.llm.json<{ label: string | null }>(
      'An app automation is stuck: an unexpected overlay or screen is in the way. Pick the one button that dismisses it without changing any data, or null.',
      JSON.stringify({ goal: ctx.map.states[wantedId]?.title, buttons: labels })
    ).catch(() => null);
    if (r?.label && labels.includes(r.label) && !UNSAFE.test(r.label)) pick = r.label;
  }
  if (!pick) return false;
  await page.getByRole('button', { name: pick, exact: true }).first().click({ timeout: 2000 }).catch(() => {});
  await settle(page, 1500);
  const now = await known();
  if (now && fromStateId) {
    const s = ctx.map.states[fromStateId];
    if (s && !(s.preActions || []).includes(pick)) {
      s.preActions = [...(s.preActions || []), pick];
      ctx.changes.add({ kind: 'pre_action', stateId: s.id, to: pick, note: 'learned while recovering' });
    }
  }
  return !!now;
}

/**
 * Drives the app to a state: route from the located current state, run each
 * step, check where it landed, re-plan from wherever we are (up to 3 times).
 * Edge stats update on every run; an edge that keeps failing is quarantined.
 */
export async function driveTo(ctx: NavContext, targetId: string, stepId = 'setup', maxReplans = 3): Promise<void> {
  const { page, map } = ctx;
  const avoid = new Set<string>();
  let recovered = false;
  for (let attempt = 0; attempt <= maxReplans; attempt++) {
    const { state } = await locateState(page, map);
    if (state?.id === targetId) return;
    const route = map.route(state?.id ?? null, targetId, avoid);
    if (!route) break;
    let ok = true;
    for (const step of route) {
      if (step.kind === 'goto') {
        await load(ctx, map.states[step.to].url);
        await runPreActions(ctx, step.to);
        if ((await locateState(page, map)).state?.id !== step.to) { ok = false; break; }
        continue;
      }
      const e = step.edge;
      let landed: string | undefined;
      try {
        if (e.kind === 'escape') await page.keyboard.press('Escape');
        else await performAction(ctx, map.controls[e.actionId], 'click');
        await settle(page, e.kind === 'link' ? 8000 : 3000);
        if (e.kind === 'link') await ctx.browser?.afterLoad?.(page);
        landed = (await locateState(page, map)).state?.id;
        if (landed) await runPreActions(ctx, landed);
      } catch (err) {
        if (err instanceof GateError) throw err;
        if (!(err instanceof ActionMissingError)) ctx.log?.(`  step "${map.controls[e.actionId]?.label}" threw: ${(err as Error).message.split('\n')[0]}`);
      }
      const success = landed === e.to;
      const before = map.edges[e.id]?.status;
      map.record(e.id, success);
      if (before === 'ok' && map.edges[e.id]?.status === 'broken') ctx.changes.add({ kind: 'broken_edge', edgeId: e.id, actionId: e.actionId, note: 'failed 3 times in a row' });
      if (success) { const s = map.states[e.to]; if (s?.seeded) delete s.seeded; }
      if (!success) {
        ctx.log?.(`  expected ${e.to}, landed in ${landed ?? 'an unknown state'}; re-planning`);
        avoid.add(e.id);
        ok = false;
        break;
      }
    }
    if (ok && (await locateState(page, map)).state?.id === targetId) return;
    if (!(await locateState(page, map)).state && !recovered) {
      recovered = true;
      await recover(ctx, targetId, state?.id ?? null);
    }
  }
  throw new TakeFailed(stepId, `could not reach ${targetId}`);
}
