/** The task checks, on made-up agent results (no model, no browser). npx tsx --test bench/test/check.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentResult } from '../agent/agent.js';
import { checkTask } from '../check.js';
import { CATEGORIES, TASKS, type Task } from '../tasks.js';

const result = (o: Partial<AgentResult>): AgentResult => ({
  task: '', answer: '', stop: 'finish', calls: [], toolCalls: 0, llmTurns: 0, tokens: { prompt: 0, completion: 0 }, ms: 0, model: 'x', ...o,
});
const task = (check: Task['check']): Task => ({ id: 't', site: 's', category: 'nav', task: '', check, why: '' });
const call = (name: string, args: object, res: object) => ({ name, args, result: JSON.stringify(res), ms: 0 } as any);

test('the task list has 2 tasks per category and a quick subset of one per category', () => {
  for (const c of CATEGORIES) assert.equal(TASKS.filter(t => t.category === c).length, 2, c);
  assert.deepEqual(TASKS.filter(t => t.quick).map(t => t.category).sort(), [...CATEGORIES].sort());
  assert.equal(new Set(TASKS.map(t => t.id)).size, TASKS.length, 'ids are unique');
  for (const t of TASKS) for (const r of [t.check.url, t.check.performed, t.check.filled, ...(t.check.answer ?? [])]) if (r) new RegExp(r);
});

test('url, performed, filled and answer checks', () => {
  const t = task({ url: '/page/3/?$' });
  assert.equal(checkTask(t, result({ finalPage: { url: 'https://q.test/page/3/' } }), () => undefined).pass, true);
  const wrong = checkTask(t, result({ finalPage: { url: 'https://q.test/page/2/' } }), () => undefined);
  assert.equal(wrong.failure, 'wrong-page');

  const p = task({ performed: 'add element' });
  const did = result({ calls: [call('perform', { action_id: 'a1' }, { done: true })] });
  assert.equal(checkTask(p, did, id => (id === 'a1' ? 'Add Element' : undefined)).pass, true);
  const failed = result({ calls: [call('perform', { action_id: 'a1' }, { done: false, error: 'not found' })] });
  assert.equal(checkTask(p, failed, () => 'Add Element').failure, 'no-action');

  const f = task({ filled: 'option 2' });
  assert.equal(checkTask(f, result({ calls: [call('fill', { action_id: 'x', text: 'Option 2' }, { done: true })] }), () => '').pass, true);

  const a = task({ answer: ['category', 'max price'] });
  assert.equal(checkTask(a, result({ answer: 'Search books, Category, Max price' }), () => '').pass, true);
  assert.equal(checkTask(a, result({ answer: 'Search books' }), () => '').failure, 'wrong-answer');
});

test('NOT FOUND: required on impossible tasks, a failure on possible ones; budget stops win', () => {
  const imp = task({ notFound: true });
  assert.equal(checkTask(imp, result({ answer: 'NOT FOUND: there is no checkout' }), () => '').pass, true);
  assert.equal(checkTask(imp, result({ answer: 'Opened the checkout' }), () => '').failure, 'invented');
  const possible = task({ url: '/login' });
  assert.equal(checkTask(possible, result({ answer: 'NOT FOUND', finalPage: { url: 'https://q.test/' } }), () => '').failure, 'gave-up');
  const budget = checkTask(possible, result({ stop: 'max_calls', finalPage: { url: 'https://q.test/' } }), () => '');
  assert.equal(budget.failure, 'budget');
  assert.match(budget.reasons[0], /stopped: max_calls/);
});
