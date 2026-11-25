/**
 * Crawls one site with this branch's graph builder and saves a snapshot the harness can load.
 *
 *   npx tsx bench/crawl.ts --site books --url https://books.toscrape.com/ [--pages 25] [--hops 3] [--variant name]
 *
 * The crawler is called with Demo Studio's settings (read-only browser, button pagination, click probing).
 * Writes bench/snapshots/<site>/<variant>/graph.json. The variant defaults to the current git branch.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SectionCrawler } from '../src/sections/sectionCrawler.js';
import { SectionGraph } from '../src/sections/sectionGraph.js';
import { config } from './config.js';
import type { Snapshot } from './graph/load.js';
import { benchHash } from './hash.js';

export function currentVariant(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** BENCH_SNAPSHOTS points another checkout (e.g. a graph_base worktree) at the main checkout's snapshot folder. */
export function snapshotPath(site: string, variant: string): string {
  return path.resolve(process.env.BENCH_SNAPSHOTS || path.join('bench', 'snapshots'), site, variant, 'graph.json');
}

export async function crawlSite(opts: { site: string; url: string; pages: number; hops: number; variant: string; log?: (m: string) => void }): Promise<Snapshot> {
  const graph = new SectionGraph();
  const crawler = new SectionCrawler({
    startUrl: opts.url, maxPages: opts.pages, maxDepth: opts.hops, headless: config.browser.headless,
    browserChannel: config.browser.channel, navigationAttempts: 1, readOnly: true, buttonPagination: true, probeClicks: true,
  } as any, graph);
  let error: string | undefined;
  crawler.on('crawler_event', (e: any) => {
    if (e.type === 'log') opts.log?.(e.data.message);
    if (e.type === 'error') error = e.data.error;
  });
  // A safety stop only: crawls are not time-boxed for the comparison, but a hung site must not block a run.
  const hardStop = setTimeout(() => { error = 'stopped after 15 minutes'; void crawler.stop(); }, 15 * 60_000);
  const started = Date.now();
  await crawler.start();
  clearTimeout(hardStop);
  const crawlMs = Date.now() - started;

  const model: any = graph.getModel();
  const pages = Object.values<any>(model.pages);
  const snap: Snapshot = {
    site: opts.site, variant: opts.variant, createdAt: new Date().toISOString(), model,
    commit: gitCommit(), benchHash: benchHash(),
    metrics: {
      crawlMs, error, maxPages: opts.pages, maxHops: opts.hops,
      pagesOpened: pages.filter(p => p.crawled).length,
      pagesKnown: pages.length,
      sections: Object.keys(model.sections ?? {}).length,
      actions: Object.keys(model.actions ?? {}).length,
      interactions: Object.keys(model.interactions ?? {}).length,
      links: (model.links ?? []).length,
      extraNodes: (model.extraNodes ?? []).length,
      extraEdges: (model.extraEdges ?? []).length,
      llmCalls: model.buildStats?.llmCalls ?? 0,
    },
  };
  if (!snap.metrics!.pagesOpened) throw new Error(`crawl of ${opts.url} opened no pages${error ? ': ' + error.split('\n')[0] : ''}`);
  const file = snapshotPath(opts.site, opts.variant);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap, (k, v) => (k === 'screenshotBase64' ? undefined : v)));
  return snap;
}

function arg(name: string, d?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : d;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')) {
  const site = arg('site');
  const url = arg('url');
  if (!site || !url) {
    console.error('usage: npx tsx bench/crawl.ts --site <name> --url <start url> [--pages 25] [--hops 3] [--variant <name>]');
    process.exit(2);
  }
  const variant = arg('variant', currentVariant())!;
  crawlSite({ site, url, pages: Number(arg('pages', '25')), hops: Number(arg('hops', '3')), variant, log: m => console.log(m) })
    .then(s => console.log(`\nSaved ${snapshotPath(site, variant)}\n`, s.metrics))
    .catch(e => { console.error(e); process.exit(1); });
}
