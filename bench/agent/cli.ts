/**
 * Ad-hoc agent run: load a site's graph snapshot into Memgraph, then let the agent do one task.
 *
 *   npm run agent -- --site books "Find the page for the book Sharp Objects"
 *   npm run agent -- --site books --variant new_graph_base "..."
 *   npm run agent -- --no-load "..."          # use whatever graph is already in Memgraph
 *
 * Writes the full run (every tool call and result) to bench/results/adhoc/<time>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { currentVariant, snapshotPath } from '../crawl.js';
import { closeDb } from '../graph/db.js';
import { loadSnapshot } from '../graph/load.js';
import { config } from '../config.js';
import { runAgent } from './agent.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : 'true';
};
const site = flag('site');
const variant = flag('variant') ?? currentVariant();
const noLoad = flag('no-load');
const task = argv.join(' ').trim();
if (!task || (!site && !noLoad)) {
  console.error('usage: npm run agent -- --site <name> [--variant <branch>] "<task>"   (or --no-load "<task>")');
  process.exit(2);
}

if (!noLoad) {
  const file = snapshotPath(site!, variant);
  if (!fs.existsSync(file)) {
    console.error(`No snapshot at ${file}. Crawl it first: npx tsx bench/crawl.ts --site ${site} --url <url>`);
    process.exit(2);
  }
  const counts = await loadSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(`Loaded ${site} / ${variant}:`, counts);
}
await closeDb();

console.log(`Model ${config.llm.model} at ${config.llm.baseUrl}\nTask: ${task}\n`);
const result = await runAgent(task, { onEvent: e => console.log('  ' + e) });
console.log(`\nStop: ${result.stop}${result.error ? ` (${result.error})` : ''}`);
console.log(`Answer: ${result.answer}`);
if (result.finish?.page_id) console.log(`Page: ${result.finish.page_id}`);
if (result.finish?.action_ids?.length) console.log(`Actions: ${result.finish.action_ids.join(', ')}`);
console.log(`Browser on: ${JSON.stringify(result.finalPage)}`);
console.log(`${result.toolCalls} tool calls, ${result.llmTurns} model turns, ${result.tokens.prompt + result.tokens.completion} tokens, ${(result.ms / 1000).toFixed(1)} s`);

const out = path.resolve('bench/results/adhoc', new Date().toISOString().replace(/[:.]/g, '-') + '.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ site, variant, ...result }, null, 2));
console.log(`Saved ${out}`);
