/**
 * Builds (or shows) a site's graph in Memgraph/Neo4j, without making a demo or answering a question.
 * Both agents then reuse it.
 *
 *   npm run graph -- <url>                 show the saved graph, or build it if there is none
 *   npm run graph -- <url> --rebuild       crawl again (graph builder + safe-click explorer) and replace it
 *   npm run graph -- <url> --no-deepen     skip the safe-click explorer (faster; no dialog/tab states)
 *   npm run graph -- <url> --graph g.json  load a saved section graph file into the database
 */
import dotenv from 'dotenv';
import { appMapFromGraphFile, crawlSource, sectionGraphHooks } from './adapters/sectionGraph.js';
import { GraphDbStore } from './adapters/graphDbStore.js';
import { ensureMap } from './core/mapProvider.js';

dotenv.config();

const USAGE = 'Usage: npm run graph -- <url> [--rebuild] [--no-deepen] [--pages 20] [--graph <graph.json>]';

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(n);
  const value = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const url = args.find((a, i) => !a.startsWith('--') && !['--pages', '--graph'].includes(args[i - 1]));
  if (!url) { console.log(USAGE); process.exitCode = 1; return; }
  const store = new GraphDbStore();
  try {
    await store.check();
    const file = value('--graph');
    const { map, from } = await ensureMap({
      url,
      map: file ? appMapFromGraphFile(file) : crawlSource(url, { maxPages: Number(value('--pages') || 20), browserChannel: process.env.CRAWLER_BROWSER_CHANNEL }),
      rebuild: flag('--rebuild') || !!file,
      deepen: !flag('--no-deepen')
    }, { store, hooks: sectionGraphHooks, log: console.log, browserChannel: process.env.CRAWLER_BROWSER_CHANNEL }, true);
    if (from === 'given') await store.save(map);   // a graph file is loaded into the database too

    const pages = Object.values(map.pages);
    console.log(`\nGraph for ${new URL(map.startUrl).origin} (${from === 'store' ? 'saved' : 'built now'}, in ${store.name})`);
    if (map.app?.purpose) console.log(`  What it is: ${map.app.purpose}${map.app.size ? ` (${map.app.size})` : ''}`);
    console.log(`  ${pages.length} pages, ${Object.keys(map.controls).length} controls, ${Object.keys(map.states).length} UI states, ${Object.keys(map.edges).length} actions between them`);
    const areas = Object.values(map.areas);
    if (areas.length) {
      console.log(`  ${areas.length} areas:`);
      for (const a of areas) console.log(`    · ${a.name} (${a.pageIds.length} page${a.pageIds.length === 1 ? '' : 's'})`);
    }
    const top = pages.filter(p => p.rank !== undefined).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 5);
    if (top.length) console.log(`  Most central pages: ${top.map(p => p.title.split(/\s+[|\-–·]\s+/)[0]).join(', ')}`);
  } finally {
    await store.close();
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
