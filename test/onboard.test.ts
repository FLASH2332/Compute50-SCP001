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
