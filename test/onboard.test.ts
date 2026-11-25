import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AppMap, stateIdOf, urlTemplate } from '../src/agent/core/appMap.js';
import type { TextModel } from '../src/agent/core/ports.js';
import { appMapFromSectionGraph } from '../src/agent/adapters/sectionGraph.js';
import { answerSteps, baseSteps, flowFromRoute } from '../src/agent/onboard/answer.js';
import { createOnboardingAgent } from '../src/agent/onboard/agent.js';
import { buildRefs, keywordTargets, NOT_FOUND, siteMapText, understand } from '../src/agent/onboard/understand.js';
import type { SectionGraphModel } from '../src/sections/types.js';

// An AppMap built directly (as a Memgraph store or any other adapter would),
// not from our crawler: onboarding must work from the AppMap alone.
function expenseApp(): AppMap {
  const map = new AppMap({ source: 'any-graph', startUrl: 'https://app.test/' });
  const page = (p: string, title: string) => {
    const url = 'https://app.test' + p;
    map.pages[url] = { id: url, url, title, template: urlTemplate(url) };
    map.addState({ id: stateIdOf(urlTemplate(url), '', ''), template: urlTemplate(url), pageId: url, url, title, dialog: '', tab: '', visibleActions: [], base: true });
    return url;
  };
  const home = page('/', 'Home'), exp = page('/expenses', 'Expenses'), set = page('/settings', 'Settings');
  const sec = (id: string, pageId: string, name: string, role = 'content') => { map.sections[id] = { id, pageId, name, role, hidden: false, order: Object.keys(map.sections).length }; };
  sec('s-nav', home, 'nav: Expenses, Settings', 'nav');
  sec('s-acct', home, 'Account');
  sec('s-exp', exp, 'Your expenses');
  sec('s-team', set, 'Team');
  const ctl = (id: string, pageId: string, label: string, type: 'link' | 'button', sectionId: string, extra: object = {}) => {
    const s = map.sections[sectionId];
    map.controls[id] = { id, pageId, label, type, selector: '#' + id, visible: true, risk: 'safe', section: { id: s.id, name: s.name, role: s.role, hidden: false }, ...extra };
  };
  ctl('c-exp', home, 'Expenses', 'link', 's-nav', { navigatesTo: exp });
  ctl('c-set', home, 'Settings', 'link', 's-nav', { navigatesTo: set });
  ctl('c-sign', home, 'Sign In', 'button', 's-acct');
  ctl('c-add', exp, 'Add expense', 'button', 's-exp');
  ctl('c-invite', set, 'Invite people', 'button', 's-team', { aliases: ['Invite members'] });
  const base = (u: string) => map.baseStateOf(urlTemplate(u))!.id;
  const dlg = (pageUrl: string, name: string) => map.addState({ id: stateIdOf(urlTemplate(pageUrl), name, ''), template: urlTemplate(pageUrl), pageId: pageUrl, url: pageUrl, title: map.pages[pageUrl].title, dialog: name, tab: '', visibleActions: [] }).id;
  map.addEdge(base(home), base(exp), 'c-exp', 'link', 'safe');
  map.addEdge(base(home), base(set), 'c-set', 'link', 'safe');
  map.addEdge(base(exp), dlg(exp, 'New expense'), 'c-add', 'click', 'safe');
  map.addEdge(base(set), dlg(set, 'Invite your team'), 'c-invite', 'click', 'safe');
  return map;
}

const model = (reply: unknown | Error): TextModel => ({
  async json<T>() { if (reply instanceof Error) throw reply; return reply as T; }
});
const refOf = (map: AppMap, label: string) => buildRefs(map).find(r => r.kind === 'control' && r.label === label)!.ref;

test('keyword rules: question -> route through a link to a dialog', async () => {
  const map = expenseApp();
  const u = await understand(map, 'How do I add an expense?');
  assert.equal(u.found, true);
  if (!u.found) return;
  const flow = flowFromRoute(map, u.route, 'add an expense');
  assert.deepEqual(flow.steps.map(s => s.label), ['Expenses', 'Add expense']);
  assert.match(map.states[u.route.target].dialog, /New expense/);
});

test('answers start from the page the viewer is on', async () => {
  const map = expenseApp();
  // Already on Expenses: adding an expense is one click, no detour through Home
  const here = await understand(map, 'How do I add an expense?', undefined, { from: 'https://app.test/expenses?tab=mine' });
  assert.equal(here.found, true);
  if (!here.found) return;
  assert.equal(here.route.start, map.baseStateOf(urlTemplate('https://app.test/expenses'))!.id);
  assert.deepEqual(flowFromRoute(map, here.route, 'add').steps.map(s => s.label), ['Add expense']);
  assert.match(here.reason, /from "Expenses"/);
  // A page the map doesn't know: start from the start page, and say so
  const lost = await understand(map, 'How do I add an expense?', undefined, { from: 'https://app.test/unknown' });
  assert.equal(lost.found, true);
  if (!lost.found) return;
  assert.equal(lost.route.start, map.baseStateOf(urlTemplate('https://app.test/'))!.id);
  assert.match(lost.reason, /not in the map/);
});

test('"what can I do?", "what can I do here?" and "where should I start?" come from areas and PageRank', async () => {
  const map = expenseApp();
  const [home, exp, set] = ['/', '/expenses', '/settings'].map(p => 'https://app.test' + p);
  map.pages[home].rank = 0.2; map.pages[exp].rank = 0.5; map.pages[set].rank = 0.3;
  map.data.areas = { money: { id: 'money', name: 'Spending', pageIds: [exp], medoid: exp }, people: { id: 'people', name: 'Team admin', pageIds: [set] } };
  map.pages[exp].areaId = 'money'; map.pages[set].areaId = 'people';
  map.data.app = { purpose: 'Track team expenses' };
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-ov-'));
  const agent = createOnboardingAgent({ runsDir, services: { log: () => {} } });
  try {
    const what = await agent.ask({ map, question: 'What can I do in this app?', clip: false });
    assert.equal(what.kind, 'what');
    assert.deepEqual(what.steps.map(s => s.replace(/ —.*/, '')), ['• Spending', '• Team admin']);
    assert.match(what.reason, /Track team expenses/);

    const here = await agent.ask({ map, question: 'what can I do here?', from: exp, clip: false });
    assert.ok(here.steps.some(s => s.includes('Your expenses')), here.steps.join(' | '));
    assert.ok(here.steps.some(s => s.includes('“Add expense”')), here.steps.join(' | '));

    const start = await agent.ask({ map, question: 'Where should I start?', clip: false });
    assert.equal(start.kind, 'start');
    assert.match(start.steps[0], /^1\. Expenses \(in Spending\) — start here/);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('an area can be the answer: "where is team admin?" leads to that area\'s main page', async () => {
  const map = expenseApp();
  const set = 'https://app.test/settings';
  map.data.areas = { people: { id: 'people', name: 'Team admin', pageIds: [set], medoid: set } };
  assert.ok(buildRefs(map).some(r => r.kind === 'area' && r.label === 'Team admin'));
  const u = await understand(map, 'Where is team admin?');
  assert.equal(u.found, true);
  if (!u.found) return;
  assert.equal(map.states[u.route.target].pageId, set);
});

test('no route in the map: the site\'s search box is used (real control), never invented steps', async () => {
  const map = expenseApp();
  const home = 'https://app.test/';
  map.controls['c-search'] = { id: 'c-search', pageId: home, label: 'Search expenses', type: 'input', inputType: 'search', selector: 'input[name="q"]', visible: true, risk: 'safe',
    section: { id: 's-acct', name: 'Account', role: 'content', hidden: false } };
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-search-'));
  const agent = createOnboardingAgent({ runsDir, services: { log: () => {} } });
  try {
    const r = await agent.ask({ map, question: 'How do I find mileage reimbursement rules?', clip: false });
    assert.equal(r.kind, 'search');
    assert.deepEqual(r.steps, ['1. Type “mileage reimbursement rules” into the search box and press Enter.', '2. Open the result that best matches “mileage reimbursement rules”.']);
    assert.match(r.reason, /searching the site instead/);
    // Nothing to search for: still "can't find"
    const none = await agent.ask({ map, question: 'How do I do that?', clip: false });
    assert.deepEqual(none.steps, [NOT_FOUND]);
    // Destructive questions are never turned into a search
    const del = await agent.ask({ map, question: 'How do I delete my account?', clip: false });
    assert.deepEqual(del.steps, [NOT_FOUND]);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
  // After recording, the last step names the result that was actually opened
  const { searchFlow } = await import('../src/agent/onboard/search.js');
  const flow = searchFlow(map, 'mileage rules', map.baseStateOf(urlTemplate(home))!.id)!;
  flow.steps[flow.steps.length - 1].label = 'Mileage policy 2026';
  assert.match(baseSteps(map, flow).at(-1)!, /Open “Mileage policy 2026”/);
});

test('model picks a ref; a made-up ref is rejected, never invented', async () => {
  const map = expenseApp();
  const ok = await understand(map, 'add an expense', model({ targets: [refOf(map, 'Add expense')], reason: 'Add expense opens the form' }));
  assert.equal(ok.found, true);
  assert.equal(ok.found && ok.by, 'model');
  const bad = await understand(map, 'add an expense', model({ targets: ['A999'], reason: 'made up' }));
  assert.equal(bad.found, false);
  assert.equal(!bad.found && bad.message, NOT_FOUND);
  const none = await understand(map, 'export to excel', model({ targets: [], reason: 'not found' }));
  assert.equal(none.found, false);
});

test('a model failure is reported in the reason, and keyword rules answer', async () => {
  const map = expenseApp();
  const u = await understand(map, 'How do I add an expense?', model(new Error('HTTP 413 Request too large')));
  assert.equal(u.found, true);
  assert.match(u.reason, /model unavailable \(HTTP 413/);
});

test('a control with no recorded effect is pointed at as the last step (not clicked)', async () => {
  const map = expenseApp();
  const u = await understand(map, 'How do I sign in?');
  assert.equal(u.found, true);
  if (!u.found) return;
  const flow = flowFromRoute(map, u.route, 'sign in');
  assert.deepEqual(flow.steps.map(s => [s.op, s.label]), [['show', 'Sign In']]);
  assert.deepEqual(baseSteps(map, flow), ['1. Click “Sign In”.']);
});

test('a renamed control is found by its old name (alias)', async () => {
  const map = expenseApp();
  const u = await understand(map, 'How do I invite members?');
  assert.equal(u.found, true);
  if (!u.found) return;
  assert.deepEqual(flowFromRoute(map, u.route, 'invite').steps.map(s => s.label), ['Settings', 'Invite people']);
});

test('broken edges are not used; with no other way the answer is "can\'t find"', async () => {
  const map = expenseApp();
  for (const e of Object.values(map.edges)) if (e.actionId === 'c-add') e.status = 'broken';
  const u = await understand(map, 'How do I add an expense?');
  assert.equal(u.found, false);
});

test('destructive questions are never answered with invented steps', async () => {
  const u = await understand(expenseApp(), 'How do I delete my account?');
  assert.equal(u.found, false);
});

test('keyword ranking: exact label beats a partial match; a partial match alone is no answer', () => {
  const refs = buildRefs(expenseApp());
  assert.deepEqual(keywordTargets('sign in', refs).map(r => refs.find(x => x.ref === r)!.label), ['Sign In']);
  assert.deepEqual(keywordTargets('arrange by price', refs), []);
});

test('site map for the model stays under its budget and keeps the relevant line', () => {
  const map = expenseApp();
  for (let i = 0; i < 600; i++) map.controls['x' + i] = { id: 'x' + i, pageId: 'https://app.test/expenses', label: 'Topic ' + i, type: 'link', selector: '#x' + i, visible: true, section: { id: 's-exp', name: 'Your expenses', role: 'content', hidden: false } };
  const text = siteMapText('How do I sign in?', buildRefs(map), 4000);
  assert.ok(text.length <= 4000);
  assert.match(text, /"Sign In"/);
});

test('rephrased steps keep their on-screen names, else the plain step is used', async () => {
  const map = expenseApp();
  const u = await understand(map, 'add an expense');
  assert.ok(u.found);
  if (!u.found) return;
  const flow = flowFromRoute(map, u.route, 'add');
  const steps = await answerSteps(map, flow, 'add', model({ steps: ['1. Open Expenses from the menu.', '2. Press the big blue button.'] }));
  assert.equal(steps[0], '1. Open Expenses from the menu.');
  assert.equal(steps[1], '2. In “Your expenses”, click “Add expense”.');
});

test('works from the section graph adapter too (our crawler format)', async () => {
  const home = 'https://site.test/', reg = 'https://site.test/register';
  const page = (url: string, title: string) => ({ id: url, url, title, depth: 0, crawled: true, status: 'ok' as const, discoveredAt: '' });
  const g: SectionGraphModel = {
    startUrl: home, domain: 'site.test',
    pages: { [home]: page(home, 'Home'), [reg]: page(reg, 'Register') },
    sections: { s1: { id: 's1', pageId: home, name: 'Menu', role: 'nav', order: 0, hidden: false, actionCount: 1, totalActions: 1, summary: '' } },
    actions: { a1: { id: 'a1', sectionId: 's1', label: 'Register', type: 'link', selector: 'a[href="/register"]', href: reg, navigatesTo: reg, visible: true } },
    links: [{ source: home, target: reg, url: reg, label: 'Register', next: false }]
  };
  const agent = createOnboardingAgent({ runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'onb-')), services: { log: () => {} } });
  const r = await agent.ask({ question: 'How do I register?', map: appMapFromSectionGraph(g), clip: false });
  assert.equal(r.found, true);
  assert.equal(r.source, 'section-graph');
  assert.deepEqual(r.steps, ['1. In “Menu”, click “Register”.']);
});

test('every question goes to runs/questions.jsonl with whether it was answered', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onb-'));
  const agent = createOnboardingAgent({ runsDir, services: { log: () => {} } });
  await agent.ask({ question: 'How do I add an expense?', map: expenseApp(), clip: false });
  await agent.ask({ question: 'How do I export to excel?', map: expenseApp(), clip: false });
  const lines = fs.readFileSync(path.join(runsDir, 'questions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.question, l.found]), [['How do I add an expense?', true], ['How do I export to excel?', false]]);
});
