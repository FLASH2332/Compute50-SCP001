/**
 * Crawls every benchmark site (or the ones named) with this checkout's crawler and saves the snapshots.
 * Run it once per variant, in that variant's checkout:
 *
 *   npm run bench:crawl-all                                   # all sites, variant = current branch
 *   npm run bench:crawl-all -- --sites books,quotes
 *   BENCH_SNAPSHOTS=<main checkout>/bench/snapshots npm run bench:crawl-all    # from a graph_base worktree
 *
 * Crawls are not part of a benchmark session (they run once); `--skip-existing` keeps snapshots already made.
 */
import fs from 'node:fs';
import path from 'node:path';
import { crawlSite, currentVariant, snapshotPath } from './crawl.js';
import { ensureServed, SITES, stopServers } from './sites.js';

const arg = (n: string) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const names = arg('sites')?.split(',').map(s => s.trim()).filter(Boolean);
const variant = arg('variant') ?? currentVariant();
const skipExisting = process.argv.includes('--skip-existing');

const rows: string[] = [];
for (const site of SITES.filter(s => !names || names.includes(s.name))) {
  const file = snapshotPath(site.name, variant);
  if (skipExisting && fs.existsSync(file)) { rows.push(`${site.name}: kept ${path.relative(process.cwd(), file)}`); continue; }
  await ensureServed(site);
  const started = Date.now();
  try {
    const snap = await crawlSite({ site: site.name, url: site.url, pages: site.pages, hops: site.hops, variant, log: m => console.log(`[${site.name}] ${m}`) });
    const m = snap.metrics as any;
    rows.push(`${site.name}: ${m.pagesOpened} opened / ${m.pagesKnown} known, ${m.actions} actions, ${m.interactions} clicks, ${m.llmCalls} model calls, ${Math.round(m.crawlMs / 1000)} s${m.error ? ' — ' + m.error : ''}`);
  } catch (e: any) {
    rows.push(`${site.name}: FAILED after ${Math.round((Date.now() - started) / 1000)} s — ${String(e?.message || e).split('\n')[0]}`);
  }
}
await stopServers();
console.log(`\nVariant ${variant}:\n  ` + rows.join('\n  '));
process.exit(0);
