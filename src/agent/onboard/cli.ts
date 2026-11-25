/**
 * Onboarding CLI. Same graph sources as the demo agent:
 *   npm run onboard -- <url> "<question>"                 saved map in Memgraph/Neo4j, else crawl
 *   npm run onboard -- <url> "<question>" --graph g.json  a saved section graph file
 *   npm run onboard -- <url> "<question>" --no-db --no-clip
 */
import dotenv from 'dotenv';
import { appMapFromGraphFile, crawlSource, sectionGraphHooks } from '../adapters/sectionGraph.js';
import { GraphDbStore } from '../adapters/graphDbStore.js';
import { servicesFromEnv } from '../index.js';
import { createOnboardingAgent } from './agent.js';

dotenv.config();

const USAGE = `Usage: npm run onboard -- <url> "<question>" [--from <url of the page you are on>] [--graph <graph.json>] [--no-db] [--rebuild] [--no-clip] [--pages 20] [--headed]`;

async function main() {
  const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
  const args = process.argv.slice(2);
  const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const pos = args.filter((a, i) => !a.startsWith('--') && !['--graph', '--pages', '--from'].includes(args[i - 1]));
  const [url, question] = pos;
  if (!url || !question) { console.log(USAGE); process.exitCode = 1; return; }

  const store = flags.has('--no-db') ? undefined : new GraphDbStore();
  const agent = createOnboardingAgent({ services: { ...servicesFromEnv(), store, hooks: sectionGraphHooks }, headless: !flags.has('--headed'), browserChannel: process.env.CRAWLER_BROWSER_CHANNEL });
  try {
    const graph = value('--graph');
    const map = graph ? appMapFromGraphFile(graph) : crawlSource(url, { maxPages: Number(value('--pages') || 20), browserChannel: process.env.CRAWLER_BROWSER_CHANNEL });
    const r = await agent.ask({ url, question, map, from: value('--from'), rebuild: flags.has('--rebuild'), clip: !flags.has('--no-clip') });
    console.log(`\n${r.found ? 'Answer' : 'No answer'} (graph: ${r.source}, decided by ${r.by})`);
    for (const s of r.steps) console.log(`  ${s}`);
    console.log(`Why: ${r.reason}`);
    if (r.clip) console.log(`Clip: ${r.clip.file} (${r.clip.duration.toFixed(1)}s${r.clip.cached ? ', reused' : ''})`);
    if (r.clipError) console.log(`No clip: ${r.clipError}`);
  } finally {
    await store?.close();
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
