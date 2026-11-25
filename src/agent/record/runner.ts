import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { urlTemplate, type AppMap, type Box } from '../core/appMap.js';
import type { BrowserHooks, TextModel, VisionModel } from '../core/ports.js';
import type { ChangeLog } from '../nav/changes.js';
import type { Gate } from '../nav/gate.js';
import { ActionMissingError } from '../nav/locate.js';
import { locateState } from '../nav/locateState.js';
import { driveTo, performAction, TakeFailed, type NavContext } from '../nav/navigator.js';
import { modeFor } from '../nav/risk.js';
import { similarity, norm } from '../nav/locate.js';
import { load } from '../nav/navigator.js';
import type { Flow, FlowStep } from '../plan/flows.js';
import type { Shot } from '../plan/storyboard.js';
import { settle } from '../util/pageReady.js';

const OVERLAY = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'overlay.js'), 'utf8');
export const VIDEO = { width: 1280, height: 720 };

export type TakeEventType = 'setup_end' | 'shot_start' | 'step_start' | 'located' | 'act' | 'typing_start' | 'typing_end' | 'nav_start' | 'ready' | 'step_end' | 'shot_end' | 'busy' | 'replan' | 'hold_start' | 'hold_end';
export interface TakeEvent { t: number; type: TakeEventType; stepId?: string; box?: Box; via?: string }

export interface StepResult { stepId: string; status: 'pass' | 'fail'; via?: string; healed?: boolean; start: number; end: number; box?: Box; reason?: string; label?: string; url?: string }

export interface Take {
  shotId: string;
  attempt: number;
  video: string;             // relative to the run directory
  events: TakeEvent[];
  steps: StepResult[];
  ok: boolean;
  error?: string;
  missing?: string[];        // action ids that disappeared (B3)
  window: { start: number; end: number };  // the shot's part of the video (setup cut away)
  score: number;             // lower is cleaner
  review?: string;           // A2.6 vision verdict
  labels?: string[];         // names shown on screen that came from the live page (results, sections)
  paced?: ShotPace;          // the voice this take was paced to (checked by beat_sync)
}

export interface RunnerEnv {
  runDir: string;
  map: AppMap;
  changes: ChangeLog;
  gate: Gate;
  flows: Flow[];
  headless?: boolean;
  browserChannel?: string;
  storageState?: string;
  resetUrl?: string;
  log: (m: string) => void;
  browser?: Browser;
  hooks?: BrowserHooks;
  llm?: TextModel;
  vision?: VisionModel;
  /** Voice-first pacing per shot: each step waits for its words (picture follows the voice). */
  paces?: Record<string, ShotPace>;
}

/** The voice a shot is paced to, in on-screen seconds from the shot's start. */
export interface ShotPace {
  beatTimes: Record<string, number>;  // step id → when its words start, from the first word
  voiceSec: number;                   // first word to last word
  offset: number;                     // the voice starts this long into the shot
  tail: number;                       // the shot ends this long after the voice
  speed: number;                      // the style's playback speed (raw seconds = on-screen × speed)
}

export async function closeRunner(env: RunnerEnv) {
  await env.browser?.close().catch(() => {});
  env.browser = undefined;
}

const stepIndex = (flows: Flow[]) => new Map(flows.flatMap(f => f.steps).map(s => [s.id, s]));

/** Records one take of one shot: drive to the shot's start (cut later), then run its steps on camera. */
export async function recordShot(env: RunnerEnv, shot: Shot, attempt = 1): Promise<Take> {
  const start = env.map.states[shot.startState];
  if (!start) throw new Error(`Unknown start state ${shot.startState}`);
  const mode = modeFor(start.url);
  if (env.resetUrl) await fetch(env.resetUrl).catch(() => {});
  env.browser ??= await chromium.launch({ headless: env.headless ?? true, channel: env.browserChannel || undefined });
  const tmp = path.join(env.runDir, 'takes', `tmp-${shot.id}-${attempt}-${Date.now()}`);
  const context = await env.browser.newContext({ viewport: VIDEO, recordVideo: { dir: tmp, size: VIDEO }, storageState: env.storageState });
  await context.addInitScript('globalThis.__name = (t) => t;');
  await context.addInitScript(OVERLAY);
  // Public sites: never send a form with POST (sign-ups, comments...), whatever happens
  if (mode === 'public') await context.route('**/*', route => (route.request().isNavigationRequest() && route.request().method() !== 'GET' ? route.abort() : route.continue()));
  const page = await context.newPage();
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const events: TakeEvent[] = [];
  const ev = (type: TakeEventType, extra: Partial<TakeEvent> = {}) => events.push({ t: now(), type, ...extra });
  const steps = stepIndex(env.flows);
  const results: StepResult[] = [];
  const missing: string[] = [];
  let current: { step?: FlowStep; op?: string } = {};
  let score = 0;

  const ctx: NavContext = {
    page, map: env.map, changes: env.changes, gate: env.gate, log: env.log, llm: env.llm, browser: env.hooks,
    act: {
      beforeAct: async (_a, at) => {
        const cx = at.box.x + at.box.width / 2, cy = at.box.y + at.box.height / 2;
        ev('located', { stepId: current.step?.id, box: at.box, via: at.via });
        if (at.healed) score += 10;
        if (!current.step) return; // setup moves are cut, keep them quick
        await page.evaluate(([x, y]) => (window as any).__demo?.cursorTo(x, y), [cx, cy]).catch(() => {});
        await page.evaluate(b => (window as any).__demo?.highlight(b), at.box).catch(() => {});
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(250);
        if (current.op === 'click' || current.op === 'check') await page.evaluate(([x, y]) => (window as any).__demo?.ripple(x, y), [cx, cy]).catch(() => {});
        if (current.op === 'fill' || current.op === 'search') ev('typing_start', { stepId: current.step.id });
        ev('act', { stepId: current.step.id });
      },
      afterAct: async () => {
        if (current.op === 'fill' || current.op === 'search') ev('typing_end', { stepId: current.step?.id });
        // A click can close what was highlighted (a dialog's submit), so drop the ring now
        if (current.op === 'click') await page.evaluate(() => (window as any).__demo?.clear()).catch(() => {});
      }
    }
  };

  let ok = true;
  let error: string | undefined;
  let windowStart = 0;
  try {
    await driveTo(ctx, shot.startState, 'setup');
    await page.evaluate(() => (window as any).__demo?.clear()).catch(() => {});
    await page.waitForTimeout(300);
    ev('setup_end');
    windowStart = now();
    ev('shot_start');
    const pace = env.paces?.[shot.id];
    await page.waitForTimeout(shot.stepIds.length ? 700 * (pace?.speed ?? 1)
      : (pace ? (pace.offset + pace.voiceSec + pace.tail) * pace.speed : shot.targetSec) * 1000);

    for (const [i, id] of shot.stepIds.entries()) {
      const step = steps.get(id);
      if (!step) throw new TakeFailed(id, 'step not found in flows');
      current = { step, op: step.op };
      const res: StepResult = { stepId: id, status: 'fail', start: now(), end: 0 };
      results.push(res);
      ev('step_start', { stepId: id });
      await page.evaluate(t => (window as any).__demo?.badge(t), `${i + 1}/${shot.stepIds.length} · ${shot.title}`).catch(() => {});
      // Make sure we are where the step starts (an earlier step may have landed elsewhere).
      // Steps after a search or a result click start wherever that left us (from = '').
      if (step.from) {
        const here = (await locateState(page, env.map)).state?.id;
        if (here !== step.from) { ev('replan', { stepId: id }); score += 20; await driveTo(ctx, step.from, id); }
      }
      if (pace && pace.beatTimes[step.id] !== undefined) {
        // Picture follows the voice: start the step just before its words (the cursor moves while they are said)
        const wait = pace.offset + pace.beatTimes[step.id] - 0.3 - onScreenTime(events, windowStart, now(), pace.speed);
        if (wait > 0.05) { ev('hold_start', { stepId: id }); await page.waitForTimeout(Math.min(15, wait) * pace.speed * 1000); ev('hold_end', { stepId: id }); }
      }
      const urlBefore = page.url();
      try {
        if (step.op === 'show') await showSection(page, env, step, ev, res);
        else if (step.op === 'open_result') await openResult(page, step, ev, res);
        else if (step.op === 'goto') { if (urlTemplate(page.url()) !== urlTemplate(step.value!)) { ev('act', { stepId: id }); await load(ctx, step.value!); } }
        else {
          const at = await performAction(ctx, env.map.controls[step.actionId], step.op, step.value);
          res.via = at.via; res.healed = at.healed; res.box = at.box;
          if (step.op === 'search') res.label = step.value;   // the typed query is on screen too
        }
      } catch (err) {
        if (err instanceof ActionMissingError) { missing.push(err.actionId); throw new TakeFailed(id, err.message); }
        throw new TakeFailed(id, (err as Error).message.split('\n')[0]);
      }
      const dynamic = !step.to;
      if (page.url() !== urlBefore) ev('nav_start', { stepId: id });
      await settle(page, dynamic ? 10000 : 6000);
      if (page.url() !== urlBefore) { await env.hooks?.afterLoad?.(page); ev('ready', { stepId: id }); }
      if (await page.evaluate(() => (window as any).__demo?.busy()).catch(() => false)) { ev('busy', { stepId: id }); score += 5; }
      if (dynamic) {
        // A search or a result click must lead somewhere real; the new page joins the map
        const blocked = await page.evaluate(() => /just a moment|verify you are (a )?human|access denied|captcha/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 300))).catch(() => false);
        if (blocked) throw new TakeFailed(id, `the site showed a bot check at ${page.url()}; the agent does not bypass these`);
        if (step.op === 'open_result' && page.url() === urlBefore) throw new TakeFailed(id, 'the page did not change');
        if (page.url() !== urlBefore) { env.map.addPage(page.url(), await page.title().catch(() => '')); res.url = page.url(); }
      } else {
        const landed = (await locateState(page, env.map)).state?.id;
        if (landed !== step.to) throw new TakeFailed(id, `expected to land in ${step.to}, got ${landed ?? 'an unknown state'}`);
      }
      await hold(page, step, shot, i, windowStart, now, events, ev, res, pace);
      await page.evaluate(() => (window as any).__demo?.clear()).catch(() => {});
      res.status = 'pass';
      res.end = now();
      ev('step_end', { stepId: id });
    }
    await page.evaluate(() => (window as any).__demo?.badge('')).catch(() => {});
    await page.waitForTimeout(900);
  } catch (err) {
    ok = false;
    error = (err as Error).message.split('\n')[0];
    score += 1000;
    env.log(`  ${shot.id} take ${attempt} failed: ${error}`);
  }
  ev('shot_end');
  const windowEnd = now();

  // A2.6 review_take: a vision model checks the frame at each highlighted step
  let review: string | undefined;
  if (ok && env.vision && shot.stepIds.length) {
    try {
      const shotPng = (await page.screenshot()).toString('base64');
      const r = await env.vision.json<{ clean: boolean; problem?: string }>(
        'You review frames of product demo recordings for visual problems: covered content, error messages, spinners, popups in the way.',
        `This is the end of a demo shot: "${shot.intent}". Is the frame clean? Reply {"clean": bool, "problem": string}.`, [shotPng]);
      if (!r.clean) { score += 200; review = r.problem || 'not clean'; }
    } catch { /* review is best effort */ }
  }

  await context.close();
  const video = await page.video()?.path();
  const dest = path.join(env.runDir, 'takes', `${shot.id}-a${attempt}.webm`);
  if (video && fs.existsSync(video)) fs.renameSync(video, dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  score += (windowEnd - windowStart) * 0.1;
  const labels = results.map(r => r.label).filter((l): l is string => !!l);
  const take: Take = { shotId: shot.id, attempt, paced: env.paces?.[shot.id], labels: labels.length ? labels : undefined, video: path.relative(env.runDir, dest).replace(/\\/g, '/'), events, steps: results, ok, error, missing: missing.length ? missing : undefined, window: { start: windowStart, end: windowEnd }, score: Math.round(score * 10) / 10, review };
  fs.writeFileSync(dest.replace(/\.webm$/, '.json'), JSON.stringify(take, null, 2));
  return take;
}

/** Records up to `takes` attempts and keeps the cleanest (F: several takes). Stops early on a perfect take. */
export async function recordBest(env: RunnerEnv, shot: Shot, takes = 1): Promise<Take> {
  let best: Take | undefined;
  for (let a = 1; a <= takes; a++) {
    const t = await recordShot(env, shot, a);
    const flow = env.flows.find(f => f.id === shot.flowId);
    if (flow) { flow.takes ??= { n: 0, ok: 0 }; flow.takes.n++; if (t.ok) flow.takes.ok++; if (t.missing) flow.broken = true; }
    if (!best || t.score < best.score) best = t;
    env.log(`  ${shot.id} take ${a}: ${t.ok ? 'ok' : 'FAILED'} (score ${t.score})`);
    if (t.missing) break;                       // B3 removed: retrying will not help
    if (t.ok && t.score < (t.window.end - t.window.start) * 0.1 + 1) break; // nothing to improve
  }
  return best!;
}

type Emit = (type: TakeEventType, extra?: Partial<TakeEvent>) => void;

async function pointAt(page: Page, box: Box, ripple: boolean) {
  const cx = box.x + box.width / 2, cy = box.y + Math.min(box.height / 2, 40);
  await page.evaluate(([x, y]) => (window as any).__demo?.cursorTo(x, y), [cx, cy]).catch(() => {});
  await page.evaluate(b => (window as any).__demo?.highlight(b), box).catch(() => {});
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(250);
  if (ripple) await page.evaluate(([x, y]) => (window as any).__demo?.ripple(x, y), [cx, cy]).catch(() => {});
}

/** Scrolls a page section into view and highlights it for a moment. */
async function showSection(page: Page, env: RunnerEnv, step: FlowStep, ev: Emit, res: StepResult) {
  const sec = step.sectionId ? env.map.sections[step.sectionId] : undefined;
  if (!sec) throw new Error('section not in the map');
  // Pointing at one control (onboarding): find the control itself first
  const ctl = step.actionId ? env.map.controls[step.actionId] : undefined;
  const tries = [
    ctl?.selector ? page.locator(ctl.selector).first() : null,
    ctl ? page.getByRole(ctl.type === 'link' ? 'link' : 'button', { name: ctl.label }).first() : null,
    ctl ? page.getByText(ctl.label, { exact: true }).first() : null,
    sec.selector ? page.locator(sec.selector).first() : null,
    page.getByRole('heading', { name: sec.name }).first(),
    page.getByRole('region', { name: sec.name }).first(),
    page.getByText(sec.name, { exact: true }).first()
  ].filter(Boolean) as ReturnType<Page['locator']>[];
  let box: Box | null = null;
  for (const loc of tries) {
    if (!(await loc.count().catch(() => 0))) continue;
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
    box = await loc.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) break;
    box = null;
  }
  if (!box) throw new Error(`could not find the "${sec.name}" section on the page`);
  const top = Math.max(0, box.y);
  const shown = { x: Math.max(0, box.x), y: top, width: Math.min(box.width, VIDEO.width), height: Math.max(20, Math.min(box.height, VIDEO.height - top)) };
  ev('located', { stepId: step.id, box: shown, via: 'section' });
  await pointAt(page, shown, false);
  ev('act', { stepId: step.id });
  res.box = shown;
  res.label = ctl?.label ?? sec.name;
  await page.waitForTimeout(1800);
}

/** Clicks the visible same-site link that best matches the step's text (a search result, a course card...). */
async function openResult(page: Page, step: FlowStep, ev: Emit, res: StepResult) {
  const want = step.value || step.label;
  const stem = (w: string) => w.replace(/(es|s)$/, '');
  const words = norm(want).split(' ').filter(w => w.length > 2).map(stem);
  const links = page.getByRole('link');
  const site = new URL(page.url()).hostname.replace(/^www\./, '');
  let best: { i: number; score: number; text: string } | null = null;
  // Results often load after the page ("Searching…"): look again for a few seconds before giving up
  for (let attempt = 0; attempt < 4 && (!best || best.score < 0.3); attempt++) {
  if (attempt) await page.waitForTimeout(2000);
  best = null;
  const n = Math.min(await links.count(), 300);
  for (let i = 0; i < n; i++) {
    const l = links.nth(i);
    if (!(await l.isVisible().catch(() => false))) continue;
    const text = ((await l.innerText().catch(() => '')) || (await l.getAttribute('aria-label').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;
    const href = await l.getAttribute('href').catch(() => null);
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    try { if (!new URL(href, page.url()).hostname.endsWith(site)) continue; } catch { continue; }
    const t = norm(text);
    const covered = words.length ? words.filter(w => t.includes(w)).length / words.length : 0;
    if (!covered && similarity(text, want) < 0.5) continue;
    // Results live in the page body: menu, header, footer and sidebar links rank lower
    const chrome = await l.evaluate(el => !!el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]')).catch(() => false);
    // Ties go to the link higher on the page (the top result)
    const score = 0.6 * covered + 0.4 * similarity(text, want) - (chrome ? 0.35 : 0) + Math.min(0.1, text.length / 400) - i * 0.0005;
    if (!best || score > best.score) best = { i, score, text };
  }
  }
  if (!best || best.score < 0.3) throw new Error(`no link on the page matches "${want}"`);
  const link = links.nth(best.i);
  await link.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const box = await link.boundingBox();
  if (!box) throw new Error(`the "${best.text}" link is not visible`);
  ev('located', { stepId: step.id, box, via: 'result' });
  await pointAt(page, box, true);
  ev('act', { stepId: step.id });
  res.box = box;
  res.label = best.text;
  // The narration names what was actually clicked
  step.label = best.text;
  step.intent = `Open “${best.text}”`;
  // Results often open in a new tab; keep everything in the recorded tab
  await link.evaluate(el => el.removeAttribute('target')).catch(() => {});
  const popup = page.context().waitForEvent('page', { timeout: 2500 }).catch(() => null);
  await link.click({ timeout: 5000 });
  const opened = await popup;
  if (opened) {
    await opened.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    const url = opened.url();
    await opened.close().catch(() => {});
    if (url && url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
}

/** On-screen seconds since the shot started: what survives the cuts (page loads removed, typing at 3×), at the style's speed. */
export function onScreenTime(events: TakeEvent[], windowStart: number, nowT: number, speed = 1): number {
  let cut = 0;
  for (const e of events) {
    if (e.t < windowStart) continue;
    if (e.type === 'nav_start') { const r = events.find(x => x.type === 'ready' && x.stepId === e.stepId && x.t >= e.t); if (r && r.t - e.t > 0.3) cut += r.t - e.t - 0.3; }
    if (e.type === 'typing_start') { const d = events.find(x => x.type === 'typing_end' && x.stepId === e.stepId && x.t >= e.t); if (d) cut += (d.t - e.t) * (2 / 3); }
  }
  return (nowT - windowStart - cut) / speed;
}

/**
 * Holds after a step. With a voice (voice first): a short pause, and after the last step until the voice
 * ends; the next step's own wait lines it up with its words. Without one: until the shot's on-screen time
 * reaches its share of the planned length. Holds are marked so the cutter keeps them; while holding on a
 * section or a new page, scroll gently through it.
 */
async function hold(page: Page, step: FlowStep, shot: Shot, i: number, windowStart: number, now: () => number, events: TakeEvent[], ev: Emit, res: StepResult, pace?: ShotPace) {
  const n = shot.stepIds.length;
  const speed = pace?.speed ?? 1;
  const onScreen = onScreenTime(events, windowStart, now(), speed);
  const due = pace ? (i === n - 1 ? pace.offset + pace.voiceSec + pace.tail : onScreen + 0.4) : (shot.targetSec * (i + 1)) / n;
  const wait = Math.max(pace ? 0.3 : 0.6, Math.min(14, due - onScreen)) * speed;
  ev('hold_start', { stepId: step.id });
  const browsing = step.op === 'show' || step.op === 'goto' || step.op === 'open_result' || step.op === 'search' || (res.url !== undefined);
  if (browsing && wait > 2.5) {
    // Let the viewer read: scroll down through the content, a little at a time
    const tall = step.op === 'show' && res.box ? Math.max(0, res.box.height - 500) : 600;
    const ticks = Math.max(1, Math.floor((wait - 1.2) / 0.6));
    const by = Math.min(220, Math.max(60, tall / ticks));
    await page.waitForTimeout(800);
    for (let k = 0; k < ticks; k++) { await page.mouse.wheel(0, by); await page.waitForTimeout(600); }
    await page.waitForTimeout(Math.max(0, (wait - 0.8 - ticks * 0.6) * 1000));
  } else {
    await page.waitForTimeout(wait * 1000);
  }
  ev('hold_end', { stepId: step.id });
}
