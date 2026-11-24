import dotenv from 'dotenv';
import fs from 'node:fs';
import { Neo4jService } from './neo4j/neo4jClient.js';
import { SectionCrawler } from './sections/sectionCrawler.js';
import { SectionGraph, sectionGraphToCypher } from './sections/sectionGraph.js';

dotenv.config();

// Usage: npm run crawl <url> [maxPages=10] [linkHops=2] [--screenshots] [--sync]
async function runCli() {
  const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const startUrl = args[0] || 'http://localhost:3000/demo';
  const maxPages = Number(args[1] ?? 10);
  const maxDepth = Number(args[2] ?? 2);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error('maxPages must be a positive integer and linkHops a nonnegative integer.');
  }

  const graph = new SectionGraph();
  const crawler = new SectionCrawler({
    startUrl, maxPages, maxDepth, headless: true,
    captureScreenshots: flags.has('--screenshots'),
    browserChannel: process.env.CRAWLER_BROWSER_CHANNEL
  }, graph);

  let failed: string | undefined;
  crawler.on('crawler_event', e => {
    if (e.type === 'log') console.log(e.data.message);
    if (e.type === 'error') { failed = e.data.error; console.error(`Error: ${e.data.error}`); }
  });
  await crawler.start();

  const model = graph.getModel();
  console.log('\nPage | Section | Role | Actions');
  for (const p of Object.values(model.pages).filter(p => p.crawled)) {
    for (const s of Object.values(model.sections).filter(s => s.pageId === p.id).sort((a, b) => a.order - b.order)) {
      console.log(`${p.url} | ${s.name} | ${s.role} | ${s.actionCount}${s.totalActions > s.actionCount ? ` (of ${s.totalActions})` : ''}`);
    }
  }
  console.log('\n', graph.stats());

  fs.writeFileSync('website_sections.cypher', sectionGraphToCypher(model));
  console.log('Wrote website_sections.cypher');

  if (flags.has('--sync')) {
    const db = new Neo4jService();
    const session = db.getSession();
    try {
      if (!session) throw new Error('No database session');
      const statements = sectionGraphToCypher(model).split('\n').filter(l => l.trim() && !l.startsWith('//'));
      for (const st of statements) await session.run(st);
      console.log(`Synced ${statements.length} statements to ${process.env.NEO4J_URI || 'bolt://localhost:7687'}`);
    } finally {
      await session?.close();
      await db.close();
    }
  }
  if (failed) process.exitCode = 1;
}

runCli().catch(err => {
  console.error(err);
  process.exit(1);
});
