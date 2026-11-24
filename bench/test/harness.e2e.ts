/**
 * End-to-end check of the harness without a real model: serves the local test site, crawls it with this branch's
 * crawler, loads the snapshot into Memgraph, then runs the agent against a scripted fake LLM server that calls a few
 * MCP tools and finishes. Needs Memgraph on MEMGRAPH_URI (default bolt://localhost:7687) and Playwright's Chromium.
 *
 *   npx tsx --test bench/test/harness.e2e.ts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { config } from '../config.js';
import { crawlSite } from '../crawl.js';
import { closeDb } from '../graph/db.js';
import { loadSnapshot } from '../graph/load.js';
import { serveFolder } from '../serve.js';

const SITE_PORT = 4191;
const LLM_PORT = 4192;
let site: http.Server;
let llm: http.Server;
const seen: any[] = [];

// The fake model: 1) site_overview  2) search  3) perform the first action found  4) finish.
function fakeReply(body: any) {
  seen.push(body);
  const toolMsgs = body.messages.filter((m: any) => m.role === 'tool');
  const call = (name: string, args: object) => ({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + toolMsgs.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  if (toolMsgs.length === 0) return call('site_overview', {});
  if (toolMsgs.length === 1) return call('search', { text: 'create invoice' });
  if (toolMsgs.length === 2) {
    const hit = JSON.parse(toolMsgs[1].content).results.find((r: any) => r.type === 'Action');
    return call('perform', { action_id: hit.action_id });
  }
  return call('finish', { answer: 'Clicked + Create Invoice', action_ids: ['x'] });
}

before(async () => {
  site = await serveFolder('test-site', SITE_PORT);
  llm = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fakeReply(JSON.parse(data))));
    });
  });
  await new Promise<void>(r => llm.listen(LLM_PORT, '127.0.0.1', () => r()));
  config.llm.baseUrl = `http://127.0.0.1:${LLM_PORT}/v1`;
  config.llm.model = 'fake';
});

after(async () => {
  site.close();
  llm.close();
  await closeDb();
});

test('crawl → load → MCP agent run', { timeout: 240_000 }, async () => {
  const snap = await crawlSite({ site: 'harness-test', url: `http://127.0.0.1:${SITE_PORT}/`, pages: 3, hops: 1, variant: 'test' });
  assert.ok((snap.metrics as any).actions > 5, 'crawler found actions');
  const counts = await loadSnapshot(snap);
  assert.equal(counts.Page, 1);
  assert.ok(counts.Action > 5);
  await closeDb();

  const { runAgent } = await import('../agent/agent.js');
  const r = await runAgent('Open the form to create an invoice');
  assert.equal(r.stop, 'finish', r.error);
  assert.deepEqual(r.calls.map(c => c.name), ['site_overview', 'search', 'perform', 'finish']);
  const perform = JSON.parse(r.calls[2].result);
  assert.equal(perform.done, true, r.calls[2].result);
  assert.equal(r.finalPage?.in_graph, true);
  assert.equal(seen[0].tools.length, 11, 'all MCP tools offered to the model');
  assert.ok(!r.calls.some(c => /<html|<div/i.test(c.result)), 'no HTML reaches the agent');
});
