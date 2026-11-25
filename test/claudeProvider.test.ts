import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeCodeText, claudeFromEnv, parseJsonReply } from '../src/agent/providers/claude.js';
import { GroqText } from '../src/agent/providers/groq.js';
import { servicesFromEnv } from '../src/agent/index.js';

/** A stand-in `claude` executable: echoes what it received, the way `claude -p --output-format json` replies. */
function fakeClaude(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const ECHO = `
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const a = process.argv.slice(2);
  const reply = { user: input, model: a[a.indexOf('--model') + 1], system: a[a.indexOf('--system-prompt') + 1],
    tools: a[a.indexOf('--tools') + 1], hasApiKey: !!process.env.ANTHROPIC_API_KEY, cwd: process.cwd() };
  console.log(JSON.stringify({ type: 'result', is_error: false, result: '\`\`\`json\\n' + JSON.stringify(reply) + '\\n\`\`\`' }));
});`;

test('ClaudeCodeText sends the prompt on stdin, without tools or an API key, and parses the JSON reply', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
  try {
    const llm = new ClaudeCodeText({ bin: fakeClaude(ECHO), model: 'opus' });
    const r = await llm.json<{ user: string; model: string; system: string; tools: string; hasApiKey: boolean; cwd: string }>('Plan a tour.', '{"pages":3}');
    assert.equal(r.user, '{"pages":3}');
    assert.equal(r.model, 'opus');
    assert.match(r.system, /^Plan a tour\.\n.*one JSON object only/s);
    assert.equal(r.tools, '');
    assert.equal(r.hasApiKey, false);
    assert.equal(fs.realpathSync(r.cwd), fs.realpathSync(os.tmpdir()));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('ClaudeCodeText reports a failed run instead of returning bad data', async () => {
  const llm = new ClaudeCodeText({ bin: fakeClaude(`console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })); process.exit(1);`) });
  await assert.rejects(llm.json('x', 'y'), /Not logged in/);
  await assert.rejects(new ClaudeCodeText({ bin: '/nonexistent/claude' }).json('x', 'y'), /could not start/);
});

test('ClaudeCodeText runs at most `concurrency` processes at once', async () => {
  const marker = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-conc-'));
  const bin = fakeClaude(`
const fs = require('fs'), p = require('path'), dir = ${JSON.stringify(marker)};
const mine = p.join(dir, String(process.pid)); fs.writeFileSync(mine, '');
const peak = fs.readdirSync(dir).length;
setTimeout(() => { fs.unlinkSync(mine); console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ peak }) })); }, 150);
process.stdin.resume();`);
  const llm = new ClaudeCodeText({ bin, concurrency: 2 });
  const peaks = await Promise.all([1, 2, 3, 4, 5].map(() => llm.json<{ peak: number }>('s', 'u')));
  assert.ok(Math.max(...peaks.map(p => p.peak)) <= 2);
});

test('parseJsonReply accepts fenced or wrapped JSON and refuses prose', () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Here it is: {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.throws(() => parseJsonReply('no json here'), /no JSON object/);
});

test('AGENT_LLM=claude picks Claude Code for text, over a Groq key', () => {
  assert.equal(claudeFromEnv({}).llm, undefined);
  assert.ok(claudeFromEnv({ AGENT_LLM: 'Claude' }).llm instanceof ClaudeCodeText);
  assert.ok(servicesFromEnv({ GROQ_API_KEY: 'k' }).llm instanceof GroqText);
  const both = servicesFromEnv({ GROQ_API_KEY: 'k', GROQ_VISION_MODEL: 'v', AGENT_LLM: 'claude' });
  assert.ok(both.llm instanceof ClaudeCodeText);
  assert.ok(both.vision, 'Groq still provides vision');
});
