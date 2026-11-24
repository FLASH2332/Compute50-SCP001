import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planWithGroq } from '../src/demo/groqPlanner.js';
import type { SectionGraphModel, SitePage } from '../src/sections/types.js';

const page = (path: string): SitePage => ({
  id: 'https://demo.test' + path, url: 'https://demo.test' + path, title: path || 'Hackathon',
  crawled: true, status: 'ok', discoveredAt: '', depth: path ? 1 : 0
});
const home = page('/'), prizes = page('/prizes'), orphan = page('/orphan');
const section = { id: 'start', pageId: home.id, name: 'Register', role: 'content' as const, hidden: false, order: 0, totalActions: 1, actionCount: 1, summary: '', positionPct: 45, heightScreens: 1.8 };
const action = { id: 'register', sectionId: section.id, type: 'button' as const, selector: '#register', label: 'Register now', visible: true };
const click = { id: 'registration', pageId: home.id, sectionId: section.id, actionId: action.id, label: action.label, selector: action.selector, kind: 'dialog' as const, result: 'Opens sign-in dialog' };
const navAction = { ...action, id: 'browse', label: 'See prizes', selector: '#browse' };
const navigate = { ...click, id: 'to-prizes', actionId: navAction.id, label: navAction.label, selector: navAction.selector, kind: 'navigate' as const, resultUrl: prizes.url, result: 'Goes to prizes' };
const graph: SectionGraphModel = {
  startUrl: home.url, domain: 'demo.test', pages: Object.fromEntries([home, prizes, orphan].map(p => [p.id, p])),
  sections: { start: section, awards: { ...section, id: 'awards', pageId: prizes.id, name: 'Prize tracks' } },
  actions: { register: action, browse: navAction }, interactions: { registration: click, navigate },
  links: [{ source: home.id, target: prizes.id, url: prizes.url, label: navAction.label, next: false, interactionId: navigate.id }]
};

const step = (kind: string, ref: string) => ({ kind, ref, caption: 'Watch ' + ref, reason: 'Requested by viewer' });
function fake(steps: ReturnType<typeof step>[]) {
  let request: { model: string; messages: { content: string }[]; response_format: { type: string } };
  const transport: typeof fetch = async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return Response.json({ model: 'fixture-model', choices: [{ message: { content: JSON.stringify({ title: 'Register', summary: 'Explore prizes', steps }) } }] });
  };
  return { options: { apiKey: 'test-only', fetch: transport }, request: () => request };
}

test('Groq fake response becomes graph-backed shots and reports an unknown reference', async () => {
  const stub = fake([step('click', 'I1'), step('show_section', 'S1'), step('click', 'I99')]);
  const plan = await planWithGroq(graph, 'Show registration', stub.options);
  assert.equal(plan.by, 'fixture-model');
  assert.equal(plan.shots.length, 2);
  assert.equal(plan.shots[0].interaction, click);
  assert.equal(plan.shots[1].section, section);
  assert.equal(plan.shots[1].caption, 'Watch S1');
  assert.equal(plan.steps[0].reason, 'Requested by viewer');
  assert.deepEqual(plan.steps[2], { ...step('click', 'I99'), skipped: true, reason: 'unknown reference' });
  const req = stub.request();
  assert.equal(req.response_format.type, 'json_object');
  assert.equal(req.model, 'openai/gpt-oss-20b');
  const input = JSON.parse(req.messages[1].content);
  assert.equal(input.prompt, 'Show registration');
  for (const text of ['P1 -> P2', 'S2 P2', 'I1 P1 S1', 'Opens sign-in dialog', 'I2 P1 S1 "See prizes" navigate "Goes to prizes" -> P2']) assert.ok(input.siteMap.includes(text));
  assert.ok(!input.siteMap.includes('#register'));
});

test('Groq route validation tracks the current page after a recorded navigation', async () => {
  for (const move of [step('open_page', 'P2'), step('click', 'I2')]) {
    const stub = fake([step('show_section', 'S2'), step('open_page', 'P3'), step('click', 'S1'), move, step('show_section', 'S2'), step('click', 'I1')]);
    const plan = await planWithGroq(graph, '', stub.options);
    assert.deepEqual(plan.steps.filter(s => s.skipped).map(s => s.reason), [
      'reference is on another page', 'no recorded route from the current page', 'reference does not match step kind', 'reference is on another page'
    ]);
    assert.deepEqual(plan.shots.map(s => s.page.id), [home.id, prizes.id, prizes.id]);
    assert.equal(plan.shots[1].arrival?.interactionId, navigate.id);
  }
});

test('Groq receives measured geometry and section dwell is validated before recording', async () => {
  const stub = fake(['long', 'xyz', 'short'].map(dwell => ({ ...step('show_section', 'S1'), dwell })));
  const plan = await planWithGroq(graph, 'register', stub.options);
  assert.match(JSON.parse(stub.request().messages[1].content).siteMap, /"Register" at 45%, 1\.80 screens/);
  assert.deepEqual(plan.shots.map(s => s.dwell), ['long', 'normal', 'short']);
  assert.deepEqual(plan.steps.map(s => s.dwell), ['long', 'normal', 'short']);
});

test('missing key or unusable plan with no keyword match yields one captioned start-page overview', async () => {
  for (const options of [{ apiKey: '' }, fake([step('click', 'I99')]).options]) {
    const plan = await planWithGroq(graph, 'telescope', options);
    assert.deepEqual(plan.shots, [{ page: home, overview: true, caption: 'Overview of ' + home.title }]);
  }
});

test('fallback without GROQ_API_KEY uses keyword rules and gives the reason', async () => {
  const plan = await planWithGroq(graph, 'register', { apiKey: '', fetch: () => assert.fail('unexpected network call') });
  assert.equal(plan.by, 'keyword rules');
  assert.match(plan.fallbackReason!, /GROQ_API_KEY is missing/);
  assert.ok(plan.shots.some(s => s.interaction === click));
});

test('fallback reports HTTP failure, malformed JSON and a fully rejected plan', async () => {
  for (const [response, reason] of [[Response.json({}, { status: 429 }), /HTTP 429/], [Response.json({ choices: [] }), /invalid plan/]] as const) {
    const plan = await planWithGroq(graph, '', { apiKey: 'test-only', fetch: async () => response });
    assert.equal(plan.by, 'keyword rules');
    assert.match(plan.fallbackReason!, reason);
  }
  const plan = await planWithGroq(graph, '', fake([step('click', 'I99')]).options);
  assert.equal(plan.by, 'keyword rules');
  assert.equal(plan.steps[0].reason, 'unknown reference');
  assert.equal(plan.steps[0].skipped, true);
});
