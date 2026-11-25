import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { AppMap, BREAK_AFTER, urlTemplate } from '../src/agent/core/appMap.js';
import { crawlSource, appMapFromSectionGraph } from '../src/agent/adapters/sectionGraph.js';
import { exploreInteractions } from '../src/agent/explore/interact.js';
import { ChangeLog } from '../src/agent/nav/changes.js';
import { Gate, GateError } from '../src/agent/nav/gate.js';
import { ActionMissingError, locateAction } from '../src/agent/nav/locate.js';
import { locateState } from '../src/agent/nav/locateState.js';
import { driveTo, performAction } from '../src/agent/nav/navigator.js';
import { isSearchInput, modeFor, riskOf } from '../src/agent/nav/risk.js';
import { candidateFlows, findFlows } from '../src/agent/plan/flows.js';
import { buildStoryboard } from '../src/agent/plan/storyboard.js';
import { closeRunner, recordShot, type Take } from '../src/agent/record/runner.js';
import { buildCues } from '../src/agent/media/captions.js';
import { checkRepetition, checkTimeline } from '../src/agent/media/check.js';
import { fallbackLine } from '../src/agent/media/voice.js';
import { probeDuration, renderTimeline } from '../src/agent/media/render.js';
import { cutSegments, layout, PRESETS, zoomKeys, type Timeline } from '../src/agent/media/timeline.js';
import { voiceTimeline } from '../src/agent/media/voice.js';
import { SilentSpeech } from '../src/agent/providers/speech.js';
import { AutoApprover } from '../src/agent/providers/approvers.js';
import { createDemoAgent } from '../src/agent/index.js';
import { planDemo } from '../src/agent/plan/planner.js';
import { GraphDbStore } from '../src/agent/adapters/graphDbStore.js';
import { serveDir } from '../src/agent/util/staticServer.js';
import { ensureMap } from '../src/agent/core/mapProvider.js';
import { createOnboardingAgent } from '../src/agent/onboard/agent.js';

const quiet = () => {};

// ── Isolation ──────────────────────────────────────────────────────────────

test('only the adapter and the CLI import code outside src/agent', () => {
  const root = path.resolve('src/agent');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { walk(full); continue; }
      if (!/\.ts$/.test(f.name)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (rel.startsWith('adapters/') || rel === 'cli.ts') continue;
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
        if (!path.resolve(path.dirname(full), m[1]).startsWith(root)) offenders.push(`${rel} → ${m[1]}`);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

// ── Pure units ─────────────────────────────────────────────────────────────

test('risk classes: openers are safe, submit/save mutate, delete is destructive', () => {
  assert.equal(riskOf({ type: 'button', label: '+ Create Invoice' }), 'safe');
  assert.equal(riskOf({ type: 'button', label: 'Invite member' }), 'safe');
  assert.equal(riskOf({ type: 'submit', label: 'Send invite' }), 'mutating');
  assert.equal(riskOf({ type: 'button', label: 'Save Changes' }), 'mutating');
  assert.equal(riskOf({ type: 'button', label: 'Delete account' }), 'destructive');
  assert.equal(riskOf({ type: 'link', label: 'Sign out', href: 'https://x.test/logout' }), 'mutating');
});

test('URL templates turn ids into placeholders', () => {
  assert.equal(urlTemplate('https://a.test/invoice/123?x=1'), 'a.test/invoice/{id}');
  assert.equal(urlTemplate('https://a.test/u/3f2b9c1e-1111-4a4a-9b9b-0123456789ab/edit'), 'a.test/u/{id}/edit');
  assert.equal(urlTemplate('http://127.0.0.1:5050/index.html'), '127.0.0.1:5050/');
});

test('adapter reads the graph builder\'s fields: ranks, areas, profile, locators, stricter risk, reliability', () => {
  const page = (id: string, extra: Record<string, unknown> = {}) => ({ id, url: id, title: id.split('/').pop() || 'Home', depth: 0, crawled: true, status: 'ok', discoveredAt: '', ...extra });
  const model: any = {
    startUrl: 'https://app.test/', domain: 'app.test',
    pages: { 'https://app.test/': page('https://app.test/', { pagerank: 0.6, betweenness: 0.2 }), 'https://app.test/team': page('https://app.test/team', { pagerank: 0.4 }) },
    sections: { s1: { id: 's1', pageId: 'https://app.test/', name: 'Main', role: 'main', order: 0, hidden: false, actionCount: 2, totalActions: 2, summary: '' } },
    actions: {
      a1: { id: 'a1', sectionId: 's1', label: 'Team', type: 'link', selector: 'a[href="/team"]', href: 'https://app.test/team', navigatesTo: 'https://app.test/team', visible: true,
            risk: 'navigate', locators: ['role=link|name=Team', 'css=nav > a:nth-child(2)'], reliability: 0.9 },
      a2: { id: 'a2', sectionId: 's1', label: 'Go', type: 'button', selector: '#go', visible: true, risk: 'submit_mutating' }
    },
    extraNodes: [
      { label: 'App', id: 'app', props: { purpose: 'Team chat', size: 'small', flows: ['invite someone'] } },
      { label: 'Area', id: 'area_x', props: { name: 'People', medoid: 'https://app.test/team' } }
    ],
    extraEdges: [{ type: 'CONTAINS', from: { label: 'Area', id: 'area_x' }, to: { label: 'Page', id: 'https://app.test/team' } }]
  };
  const map = appMapFromSectionGraph(model);
  assert.equal(map.pages['https://app.test/'].rank, 0.6);
  assert.deepEqual(map.app, { purpose: 'Team chat', size: 'small', flows: ['invite someone'] });
  assert.deepEqual(map.areas.area_x.pageIds, ['https://app.test/team']);
  assert.equal(map.pages['https://app.test/team'].areaId, 'area_x');
  assert.deepEqual(map.controls.a1.locators, ['role=link|name=Team', 'css=nav > a:nth-child(2)']);
  assert.equal(map.controls.a1.risk, 'safe');
  assert.equal(map.controls.a2.risk, 'mutating', '"Go" looks safe by label, but the builder saw it change data');
});

test('demo tours follow PageRank, cover each area once, and use areas as chapters', async () => {
  const map = new AppMap({ source: 'test', startUrl: 'https://app.test/' });
  const add = (path: string, title: string, rank: number, areaId?: string) => {
    const url = `https://app.test${path}`;
    const template = urlTemplate(url);
    map.pages[url] = { id: url, url, title, template, rank, areaId };
    map.sections[`s${path}`] = { id: `s${path}`, pageId: url, name: `${title} overview`, role: 'main', hidden: false, order: 0 };
    map.addState({ id: `${template}|d=|t=`, template, pageId: url, url, title, dialog: '', tab: '', visibleActions: [], base: true });
    return map.states[`${template}|d=|t=`];
  };
  const home = add('/', 'Home', 0.1);
  const pages = [add('/a', 'Billing', 0.5, 'bill'), add('/b', 'Invoices', 0.4, 'bill'), add('/c', 'Team', 0.3, 'team'), add('/d', 'Help', 0.05)];
  map.data.areas = { bill: { id: 'bill', name: 'Money', pageIds: [] }, team: { id: 'team', name: 'People', pageIds: [] } };
  for (const p of pages) {
    const id = `link${p.pageId}`;
    map.controls[id] = { id, pageId: home.pageId, label: p.title, type: 'link', selector: `a[href="${p.url}"]`, visible: true, navigatesTo: p.pageId, risk: 'safe' };
    home.visibleActions.push(id);
    map.addEdge(home.id, p.id, id, 'link', 'safe');
  }
  const plan = await planDemo(map, 'show all features', '', 28);
  const titles = plan.flows.flatMap(f => f.steps).filter(s => s.op === 'show').map(s => s.label.replace(' overview', ''));
  assert.deepEqual(titles.slice(0, 3), ['Home', 'Billing', 'Team'], `tour: ${titles.join(', ')}`);
  const sb = buildStoryboard('tour', '', 28, plan.flows, map, home.id);
  assert.ok(sb.shots.some(s => s.chapter === 'Money') && sb.shots.some(s => s.chapter === 'People'), sb.shots.map(s => s.chapter).join(', '));
});

test('site modes: allow-listed hosts are full, everything else is public', () => {
  assert.equal(modeFor('https://www.example.com/'), 'public');
  assert.equal(modeFor('http://127.0.0.1:5050/'), 'full');
  assert.equal(modeFor('http://localhost:3000/x'), 'full');
});

test('public mode: only browsing and search boxes pass the gate', () => {
  const g = new Gate(new Set(['save']), new Set(), 'public');
  const search = { id: 's', label: 'Search', type: 'input', inputType: 'search', selector: 'input[name="q"]', risk: 'safe' } as any;
  const email = { id: 'e', label: 'Email', type: 'input', inputType: 'email', selector: '#email', risk: 'safe' } as any;
  assert.ok(isSearchInput(search) && !isSearchInput(email));
  g.check(search, 'search');
  g.check({ id: 'l', label: 'Courses', type: 'link', risk: 'safe' } as any, 'click');
  assert.throws(() => g.check(email, 'fill'), GateError);
  assert.throws(() => g.check({ id: 'save', label: 'Save', type: 'submit', risk: 'mutating' } as any, 'click'), GateError, 'approval does not unlock writes on a public site');
});

test('risk gate: safe passes, mutating needs the storyboard, destructive is one-time', () => {
  const g = new Gate(new Set(['save']), new Set(['del']));
  g.check({ id: 'x', risk: 'safe', label: 'x' } as any);
  g.check({ id: 'save', risk: 'mutating', label: 'Save' } as any);
  assert.throws(() => g.check({ id: 'send', risk: 'mutating', label: 'Send' } as any), GateError);
  g.check({ id: 'del', risk: 'destructive', label: 'Delete' } as any);
  assert.throws(() => g.check({ id: 'del', risk: 'destructive', label: 'Delete' } as any), GateError);
});

test('edges: reliability/cost update, quarantine after repeated failures, routing around it', () => {
  const g = new AppMap();
  const st = (id: string, template: string) => g.addState({ id, template, pageId: id, url: `http://t/${id}`, title: id, dialog: '', tab: '', visibleActions: [] });
  st('a', 'A'); st('b', 'B'); st('c', 'C');
  const ab = g.addEdge('a', 'b', 'x', 'click', 'safe');
  g.addEdge('a', 'c', 'y', 'click', 'safe');
  g.addEdge('c', 'b', 'z', 'click', 'safe');
  g.record(ab.id, true);
  assert.equal(ab.reliability, 2 / 3);
  assert.ok(Math.abs(ab.cost - (1 + 2 * -Math.log(2 / 3))) < 1e-9);
  assert.deepEqual(g.route('a', 'b')!.map(s => s.kind === 'edge' ? s.edge.actionId : 'goto'), ['x']);
  for (let i = 0; i < BREAK_AFTER; i++) g.record(ab.id, false);
  assert.equal(ab.status, 'broken');
  const r = g.route('a', 'b')!;
  assert.ok(!r.some(s => s.kind === 'edge' && s.edge.id === ab.id), 'broken edge is skipped');
});

const fakeTake = (): Take => ({
  shotId: 's', attempt: 1, video: 'v.webm', ok: true, score: 0, window: { start: 1, end: 12 },
  steps: [{ stepId: 'a', status: 'pass', start: 1.2, end: 4 }, { stepId: 'b', status: 'pass', start: 4, end: 11 }],
  events: [
    { t: 1, type: 'shot_start' }, { t: 1.0, type: 'located', stepId: 'a', box: { x: 100, y: 100, width: 120, height: 36 } },
    { t: 1.8, type: 'act', stepId: 'a' }, { t: 1.9, type: 'nav_start', stepId: 'a' }, { t: 3.4, type: 'ready', stepId: 'a' },
    { t: 3.6, type: 'step_end', stepId: 'a' },
    { t: 4.0, type: 'located', stepId: 'b', box: { x: 600, y: 300, width: 200, height: 30 } },
    { t: 4.3, type: 'typing_start', stepId: 'b' }, { t: 6.3, type: 'typing_end', stepId: 'b' }, { t: 6.4, type: 'act', stepId: 'b' },
    { t: 10.9, type: 'step_end', stepId: 'b' }, { t: 12, type: 'shot_end' }
  ]
});

test('cuts drop page loads and idle gaps and speed up typing', () => {
  const segs = cutSegments(fakeTake(), PRESETS.calm);
  const covered = (t: number) => segs.find(s => t > s.in && t < s.out);
  assert.equal(covered(2.6), undefined, 'page load is cut');
  assert.equal(covered(8.5), undefined, 'idle gap is cut');
  assert.equal(covered(5)?.speed, 3, 'typing is 3x');
  assert.equal(covered(1.3)?.speed, 1);
});

test('zoom keys respect depth, frequency and size limits', () => {
  const take = fakeTake();
  const keys = zoomKeys(take, PRESETS.calm, cutSegments(take, PRESETS.calm));
  assert.equal(keys.length, 2);
  assert.ok(keys.every(k => k.depth <= PRESETS.calm.zoomDepth));
  assert.ok(keys[1].t - keys[0].t >= 3);
  const close = fakeTake();
  close.events.find(e => e.stepId === 'b' && e.type === 'located')!.t = 2.0; // under 3 s from the first
  assert.equal(zoomKeys(close, PRESETS.calm, cutSegments(close, PRESETS.calm)).length, 1);
  const big = fakeTake();
  big.events[1].box = { x: 0, y: 0, width: 1200, height: 600 };
  assert.ok(!zoomKeys(big, PRESETS.calm, cutSegments(big, PRESETS.calm)).some(k => k.t === 1.0), 'no zoom on a huge target');
});

function tlWithVoices(lines: [string, number, number][]): Timeline {
  return layout({
    version: 1, style: 'calm', createdAt: '', duration: 0,
    shots: lines.map(([line, shotSec, voiceSec], i) => ({
      shotId: `shot${i + 1}`, title: '', chapter: '', stepIds: [], take: 'v', takeAttempt: 1, zooms: [], hold: 0, outStart: 0, outDuration: 0,
      segments: [{ in: 0, out: shotSec, speed: 1 }],
      voice: { line, file: 'x', duration: voiceSec, offset: 0.25, words: line.split(' ').map((w, j) => ({ text: w, start: j * 0.3, end: j * 0.3 + 0.25 })) }
    }))
  });
}

test('captions: ≤ 42 chars, ≥ 1 s per cue', () => {
  const cues = buildCues(tlWithVoices([['Click “Invite member”, enter an email address, choose a role, then click “Send invite”.', 8, 6]]));
  assert.ok(cues.length >= 2);
  assert.ok(cues.every(c => c.text.length <= 42 && c.end - c.start >= 0.99));
});

test('checks report silence, overlong voice, unknown labels and missing takes', () => {
  const model = new AppMap({ controls: { a: { id: 'a', pageId: 'p', label: 'Invite member', type: 'button', selector: '#a', visible: true } } });
  const tl = tlWithVoices([['Click “Invite member”.', 5, 1.5], ['Click “Frobnicate”.', 3, 4]]);
  const ok = { ok: true, steps: [] } as unknown as Take;
  const f = checkTimeline(tl, { shot1: ok }, model);
  assert.ok(f.some(x => x.rule === 'silence' && x.shotId === 'shot1'), 'planted gap after shot1');
  assert.ok(f.some(x => x.rule === 'voice_fits' && x.shotId === 'shot2'));
  assert.ok(f.some(x => x.rule === 'label_match' && x.message.includes('Frobnicate')));
  assert.ok(!f.some(x => x.rule === 'label_match' && x.message.includes('Invite member')));
  assert.ok(f.some(x => x.rule === 'passing_take' && x.shotId === 'shot2'));
});

test('narration: repetition is flagged; route clicks are not narrated', () => {
  const tl = tlWithVoices([
    ["Here's the “Courses” section, full of guided learning paths.", 5, 3],
    ["Here's the “Events” section with live webinars.", 5, 3],
    ['Click “A”, click “B”, then click “C” to open the page.', 5, 3],
    ['Full of guided learning paths for every level.', 5, 3]
  ]);
  const f = checkRepetition(tl);
  assert.ok(f.some(x => x.shotId === 'shot2' && /starts with "here's"/.test(x.message)), JSON.stringify(f));
  assert.ok(f.some(x => x.shotId === 'shot3' && /narrates 3 clicks/.test(x.message)));
  assert.ok(f.some(x => x.shotId === 'shot4' && /repeats "full of guided learning"/.test(x.message)));
  const line = fallbackLine({ intent: '', title: 'DSA', before: 'Home', after: 'DSA Tutorial - GeeksforGeeks', audience: '', isIntro: false, isLast: false,
    steps: [{ id: 'a', op: 'click', actionId: 'x', label: 'geeksforgeeks', from: 'p', to: 'q', intent: 'Click “geeksforgeeks”', route: true },
            { id: 'b', op: 'show', actionId: '', label: 'DSA Tutorial', from: 'q', to: 'q', intent: '', sectionId: 's' }] }, 30);
  assert.ok(!/geeksforgeeks”/.test(line) && /DSA Tutorial/.test(line), line);
});

test('script: written once before recording, one beat per step, repetition fixed, result filled in later', async () => {
  const { writeScript, resolveLine } = await import('../src/agent/media/script.js');
  const step = (id: string, op: string, label: string, extra: object = {}) => ({ id, op, actionId: '', label, from: 'a', to: 'b', intent: '', ...extra }) as any;
  const ctx = (steps: any[], extra: object = {}) => ({ intent: '', title: 'Shop', before: 'Home', after: 'Courses page', audience: '', isIntro: false, isLast: false, steps, ...extra });
  const items = [
    { shotId: 'shot1', c: ctx([], { isIntro: true }), seconds: 3 },
    { shotId: 'shot2', c: ctx([step('r1', 'click', 'logo', { route: true }), step('r2', 'click', 'Courses', { route: true }), step('s1', 'show', 'Courses')]), seconds: 8 },
    { shotId: 'shot3', c: ctx([step('q1', 'search', 'Search', { value: 'python' }), step('o1', 'open_result', 'python', { value: 'python' })], { isLast: true }), seconds: 9 }
  ];
  let calls = 0;
  const llm = { async json<T>(): Promise<T> {
    calls++;
    if (calls === 1) return { shots: {
      shot1: { beats: [{ step: '', text: 'Welcome to the shop, home of free courses.' }] },
      shot2: { beats: [{ step: 'r1', text: "Let's head to the courses." }, { step: 's1', text: 'Here you can browse every track.' }] },
      shot3: { beats: [{ step: 'q1', text: "Let's head to the search box and look for python." }, { step: 'o1', text: '{result} looks like a good fit.' }] }
    } } as T;
    // Second call fixes the repeated opener in shot3 only
    return { shots: { shot3: { beats: [{ step: 'q1', text: 'Searching for python narrows it down.' }, { step: 'o1', text: '{result} is a good fit.' }] } } } as T;
  } };
  const script = await writeScript(items as any, { llm, style: 'be brief' });
  assert.equal(calls, 2, 'one call for the script, one to fix repetition');
  assert.deepEqual(script.shots.shot2.beats.map(b => b.stepId), ['r1', 's1'], 'routing clicks share one "arrive" beat');
  assert.ok(script.shots.shot3.dynamic);
  assert.equal(resolveLine(script.shots.shot3, 'Python Crash Course'), 'Searching for python narrows it down. “Python Crash Course” is a good fit.');
  // No model: every shot still gets beats from the rules
  const rules = await writeScript(items as any, {});
  assert.ok(Object.values(rules.shots).every(s => s.by === 'rules' && s.line && s.beats.length));
  assert.ok(!/logo/.test(rules.shots.shot2.line), rules.shots.shot2.line);
});

// ── Against the fixture app (section-graph crawler → adapter → agent) ──────

describe('fixture app', () => {
  let srv: { url: string; close: () => Promise<void> };
  let map: AppMap;
  let browser: Browser;
  let blocked: string[];
  const start = () => urlTemplate(`${srv.url}/index.html`);

  before(async () => {
    srv = await serveDir('test-site');
    map = await crawlSource(`${srv.url}/index.html`, { maxPages: 10 })(quiet);
    ({ blocked } = await exploreInteractions(map));
    browser = await chromium.launch();
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  const newPage = async () => (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const ctrl = (label: string) => Object.values(map.controls).find(a => a.label === label)!;

  test('adapter: pages, controls with sections, and states seeded from probed buttons', async () => {
    const seededOnly = await crawlSource(`${srv.url}/index.html`, { maxPages: 10 })(quiet);
    assert.equal(seededOnly.data.source, 'section-graph');
    assert.equal(Object.keys(seededOnly.pages).length, 4);
    assert.ok(Object.values(seededOnly.controls).every(c => c.section && c.risk));
    assert.ok(Object.values(seededOnly.states).some(s => s.seeded && s.dialog), 'a dialog state seeded from the probe');
    assert.ok(Object.values(seededOnly.edges).length > 0);
  });

  test('explorer finds tab, dialog and page states and never clicks a submit', () => {
    const states = Object.values(map.states).filter(s => !s.seeded);
    const has = (p: (s: typeof states[number]) => boolean) => assert.ok(states.some(p), JSON.stringify(states.map(s => s.id)));
    has(s => s.tab === 'Invoices'); has(s => s.tab === 'Customers'); has(s => s.tab === 'Yearly');
    has(s => s.dialog === 'New Invoice Form'); has(s => s.dialog === 'Invite a teammate');
    const clicked = Object.values(map.edges).map(e => map.controls[e.actionId]).filter(Boolean);
    assert.ok(!clicked.some(a => a.type === 'submit' || a.risk !== 'safe'));
    assert.deepEqual(blocked, []);
    assert.equal(ctrl('Role')?.type, 'select', 'select labelled by its <label>, not its options');
  });

  test('flows: invite dialog, invoice dialog, tab tour, navigation', async () => {
    const flows = candidateFlows(map, start());
    const invite = flows.find(f => f.source === 'dialog' && f.name === 'Invite member')!;
    assert.deepEqual(invite.steps.map(s => `${s.op}:${s.label}`), ['click:Invite member', 'fill:Email address', 'select:Role', 'click:Send invite']);
    assert.ok(flows.some(f => f.source === 'dialog' && f.name === 'Create Invoice'));
    assert.ok(flows.some(f => f.source === 'tabs'));
    assert.ok(flows.some(f => f.source === 'nav'));
    const picked = await findFlows('show a new admin how to invite a member', 'new admin', 40, flows, map.states);
    assert.equal(picked.flows[0].name, 'Invite member');
    const sb = buildStoryboard('invite', '', 40, picked.flows, map, map.baseStateOf(start())!.id);
    assert.ok(Math.abs(sb.shots.reduce((t, s) => t + s.targetSec, 0) - 40) <= 1, 'shot lengths add up to the target');
    assert.ok(sb.approvedActions.includes(ctrl('Send invite').id));
    const vague = await findFlows('make a demo', '', 30, flows, map.states);
    assert.ok(vague.vague && vague.flows.length >= 1);
  });

  test('driveTo crosses pages to reach a dialog and re-plans around a failing edge', async () => {
    const page = await newPage();
    const ctx = { page, map, changes: new ChangeLog(), gate: new Gate() };
    await page.goto(`${srv.url}/members.html`);
    const target = Object.values(map.states).find(s => s.dialog === 'New Invoice Form' && !s.seeded)!;
    await driveTo(ctx, target.id);
    assert.equal((await locateState(page, map)).state?.id, target.id);

    const membersBase = map.baseStateOf(urlTemplate(`${srv.url}/members.html`))!;
    const invBase = map.baseStateOf(start())!;
    const edge = Object.values(map.edges).find(e => e.from === invBase.id && e.to === membersBase.id && e.kind === 'link')!;
    const c = map.controls[edge.actionId];
    const saved = { selector: c.selector, label: c.label };
    c.selector = 'a[href="nowhere.html"]'; c.label = 'Nowhere at all';
    try {
      await page.goto(`${srv.url}/index.html`);
      await driveTo({ ...ctx, changes: new ChangeLog() }, membersBase.id);
      assert.equal((await locateState(page, map)).state?.id, membersBase.id);
    } finally {
      Object.assign(c, saved, { status: 'ok' });
    }
    await page.context().close();
  });

  test('healing: broken selector, renamed button, removed button', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-heal-'));
    fs.cpSync('test-site', dir, { recursive: true });
    const members = fs.readFileSync(path.join(dir, 'members.html'), 'utf8');
    const site = await serveDir(dir);
    const page = await newPage();
    try {
      fs.writeFileSync(path.join(dir, 'members.html'), members.replace(/btn-invite"/, 'btn-invite-v2"').replace("getElementById('btn-invite')", "getElementById('btn-invite-v2')"));
      const a1 = structuredClone(ctrl('Invite member'));
      const log1 = new ChangeLog();
      await page.goto(`${site.url}/members.html`);
      const at = await locateAction(page, a1, log1);
      assert.equal(at.via, 'role');
      assert.equal(log1.of('heal').length, 1);
      assert.equal(a1.selector, '#btn-invite-v2');

      fs.writeFileSync(path.join(dir, 'members.html'), members.replace('>Invite member<', '>Add member<').replace(/btn-invite"/, 'btn-add"').replace("getElementById('btn-invite')", "getElementById('btn-add')"));
      const a2 = structuredClone(ctrl('Invite member'));
      const log2 = new ChangeLog();
      await page.goto(`${site.url}/members.html`);
      await performAction({ page, map, changes: log2, gate: new Gate() }, a2, 'click');
      assert.equal(a2.label, 'Add member');
      assert.ok(a2.aliases?.includes('Invite member'));
      assert.equal(log2.of('rename').length, 1);

      fs.writeFileSync(path.join(dir, 'members.html'), members.replace(/<button id="btn-invite"[^<]*<\/button>/, ''));
      const a3 = structuredClone(ctrl('Invite member'));
      const log3 = new ChangeLog();
      await page.goto(`${site.url}/members.html`);
      await assert.rejects(locateAction(page, a3, log3), ActionMissingError);
      assert.equal(a3.status, 'missing');
      assert.equal(log3.of('removed').length, 1);
    } finally {
      await page.context().close();
      await site.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('records a shot and renders an MP4 with video, audio and the expected length', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-run-'));
    fs.mkdirSync(path.join(runDir, 'takes'));
    const flows = candidateFlows(map, start());
    const invite = flows.find(f => f.name === 'Invite member')!;
    const sb = buildStoryboard('invite', '', 10, [invite], map, map.baseStateOf(start())!.id);
    const env = { runDir, map, changes: new ChangeLog(), gate: new Gate(new Set(sb.approvedActions)), flows, log: quiet };
    try {
      const shot = sb.shots[1];
      const take = await recordShot(env, shot);
      assert.ok(take.ok, take.error);
      assert.deepEqual(take.steps.map(s => s.status), ['pass', 'pass', 'pass', 'pass']);
      assert.ok(take.window.start > 0, 'setup is cut away');
      const segments = cutSegments(take, PRESETS.calm);
      const tl: Timeline = layout({ version: 1, style: 'calm', createdAt: '', duration: 0, shots: [{ shotId: shot.id, title: shot.title, chapter: shot.chapter, stepIds: shot.stepIds, take: take.video, takeAttempt: 1, segments, zooms: zoomKeys(take, PRESETS.calm, segments), hold: 0, outStart: 0, outDuration: 0 }] });
      const ctx = new Map([[shot.id, { intent: shot.intent, title: shot.title, steps: invite.steps, before: '', after: '', audience: '', isIntro: false, isLast: true }]]);
      await voiceTimeline(tl, ctx, PRESETS.calm, runDir, { speech: new SilentSpeech() });
      assert.deepEqual(checkTimeline(tl, { [shot.id]: take }, map), []);
      const r = await renderTimeline(runDir, tl, { extras: true });
      const p = await probeDuration(r.mp4);
      assert.ok(p.streams.includes('video') && p.streams.includes('audio'));
      assert.ok(Math.abs(p.duration - tl.duration) / tl.duration < 0.1, `${p.duration} vs ${tl.duration}`);
      for (const ext of ['srt', 'vtt', 'gif', 'chapters.txt']) assert.ok(fs.existsSync(path.join(runDir, 'out', `demo.${ext}`)), ext);
    } finally {
      await closeRunner(env);
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('public mode: plans and records a search and opens the best result (form posts blocked)', async () => {
    const saved = process.env.DEMO_ALLOW_HOSTS;
    process.env.DEMO_ALLOW_HOSTS = 'nothing.invalid';   // treat the sample app like a live public site
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-public-'));
    fs.mkdirSync(path.join(runDir, 'takes'));
    try {
      const plan = await planDemo(map, 'find help about invoices', '', 20);
      const steps = plan.flows.flatMap(f => f.steps);
      assert.deepEqual(steps.filter(s => ['search', 'open_result'].includes(s.op)).map(s => s.op), ['search', 'open_result'], JSON.stringify(steps.map(s => s.op)));
      assert.ok(!steps.some(s => s.op === 'fill' || s.op === 'select'), 'no form typing on a public site');
      const sb = buildStoryboard('help', '', 20, plan.flows, map, map.baseStateOf(start())!.id);
      const shot = sb.shots.find(s => s.stepIds.some(id => steps.find(x => x.id === id)?.op === 'search'))!;
      const env = { runDir, map, changes: new ChangeLog(), gate: new Gate(new Set(), new Set(), 'public'), flows: plan.flows, log: quiet };
      try {
        const take = await recordShot(env, shot);
        assert.ok(take.ok, take.error);
        assert.ok(take.labels?.some(l => /invoice/i.test(l)), JSON.stringify(take.labels));
        assert.ok(Object.values(map.pages).some(p => p.url.includes('article-invoices')), 'the result page joined the map: ' + JSON.stringify(take.steps.map(s => [s.stepId, s.label, s.url])) + JSON.stringify(Object.keys(map.pages)));
      } finally { await closeRunner(env); }
    } finally {
      if (saved === undefined) delete process.env.DEMO_ALLOW_HOSTS; else process.env.DEMO_ALLOW_HOSTS = saved;
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('graph db store: save, find, and keys match the section graph (skipped without Memgraph/Neo4j)', async t => {
    const store = new GraphDbStore();
    try {
      try { await store.check(); } catch { t.skip('no graph database on NEO4J_URI'); return; }
      await store.forget(map.startUrl);
      assert.equal(await store.find(map.startUrl), null);
      await store.save(map);
      const back = (await store.find(map.startUrl))!;
      assert.ok(back, 'map found after save');
      assert.deepEqual(Object.keys(back.pages).sort(), Object.keys(map.pages).sort());
      assert.equal(Object.keys(back.controls).length, Object.keys(map.controls).length);
      assert.equal(Object.keys(back.edges).length, Object.keys(map.edges).filter(e => map.pages[map.states[map.edges[e].from]?.pageId] && map.pages[map.states[map.edges[e].to]?.pageId]).length);
      assert.deepEqual(back.route(null, Object.values(back.states).find(s => s.dialog === 'Invite a teammate' && !s.seeded)!.id)?.length ? 'routable' : 'no route', 'routable');

      // The graph builder's fields survive the round trip: areas, site profile, page ranks, locators, list samples
      const copy = new AppMap(JSON.parse(JSON.stringify(map.data)));
      const [home, members] = Object.values(copy.pages);
      copy.data.app = { purpose: 'Invoicing for small teams', size: 'small', flows: ['create an invoice'] };
      copy.data.areas = { a1: { id: 'a1', name: 'Billing', pageIds: [home.id], medoid: home.id }, a2: { id: 'a2', name: 'Team', pageIds: [members.id] } };
      home.rank = 0.42;
      const c = Object.values(copy.controls)[0];
      c.locators = ['role=button|name=Save', 'css=#save'];
      c.samples = ['Row 1', 'Row 2'];
      c.count = 12;
      await store.save(copy);
      const back2 = (await store.find(copy.startUrl))!;
      assert.deepEqual(back2.app, copy.data.app);
      assert.deepEqual(Object.values(back2.areas).map(a => a.name).sort(), ['Billing', 'Team']);
      assert.equal(back2.pages[home.id].areaId, 'a1');
      assert.equal(back2.pages[home.id].rank, 0.42);
      assert.deepEqual(back2.controls[c.id].locators, c.locators);
      assert.deepEqual(back2.controls[c.id].samples, c.samples);
      assert.equal(back2.controls[c.id].count, 12);
      // Saving again replaces areas instead of piling them up
      copy.data.areas = { a3: { id: 'a3', name: 'Everything', pageIds: [home.id, members.id] } };
      await store.save(copy);
      assert.deepEqual(Object.values((await store.find(copy.startUrl))!.areas).map(a => a.name), ['Everything']);
      await store.forget(map.startUrl);
    } finally { await store.close(); }
  });

  test('one graph, two agents: the map is built once, then both agents read the saved one', async () => {
    const saved = new Map<string, string>();
    const store = {
      name: 'memory', saves: 0,
      async find(url: string) { const j = saved.get(new URL(url).origin); return j ? new AppMap(JSON.parse(j)) : null; },
      async save(m: AppMap) { this.saves++; saved.set(new URL(m.startUrl).origin, JSON.stringify(m.data)); }
    };
    let builds = 0;
    const source = async () => { builds++; return new AppMap(JSON.parse(JSON.stringify(map.data))); };
    const env = { store, log: quiet };
    const first = await ensureMap({ url: map.startUrl, map: source, deepen: false }, env);
    assert.equal(first.from, 'built');
    const again = await ensureMap({ url: map.startUrl, map: source }, env);
    assert.equal(again.from, 'store');
    const onboarding = createOnboardingAgent({ services: { store, log: quiet } });
    const viaOnboarding = await onboarding.getMap({ url: map.startUrl, map: source, question: '' });
    assert.equal(builds, 1, 'built once');
    assert.equal(store.saves, 1);
    assert.deepEqual(Object.keys(viaOnboarding.pages).sort(), Object.keys(first.map.pages).sort());
  });

  test('plug and play: the agent runs from a plain AppMap with no graph engine involved', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-agent-'));
    const plain = new AppMap(JSON.parse(JSON.stringify(map.data)));   // e.g. loaded from any store
    const agent = createDemoAgent({ runsDir, services: { approver: new AutoApprover('fast', false), speech: new SilentSpeech(), log: quiet } });
    try {
      const r = await agent.make({ map: plain, goal: 'open the reports', seconds: 12, deepen: false, extras: false });
      assert.ok(r.mp4 && fs.existsSync(r.mp4));
      assert.deepEqual(r.findings.filter(f => f.rule === 'passing_take'), []);
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});