import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
let writes = 0;
const html = (body) => '<!doctype html><title>Catalog</title><style>body{font:24px system-ui;padding:36px}main{min-height:1000px}section{margin:750px 0 120px}</style><main>' + body + '</main>';
const browserChannel = process.env.CRAWLER_BROWSER_CHANNEL;
const studioPort = process.env.STUDIO_TEST_PORT || '3975';
let releaseCatalog;
const catalogReady = new Promise(resolve => { releaseCatalog = resolve; });
const fixture = createServer(async (req, res) => {
  if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return; }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/') return res.end(html('<h1>Store</h1><a href="/catalog">Browse catalog</a>'));
  if (req.url === '/catalog') {
    await catalogReady;
    return res.end(html('<h1>Catalog</h1><section><h2>First page of products</h2><nav aria-label="Pagination"><a href="/catalog?page=2" rel="next">Next page</a></nav></section>'));
  }
  if (req.url === '/catalog?page=2') return res.end(html('<h1>Catalog page two</h1><section><h2>More products</h2><nav aria-label="Pagination"><button id="next" type="button">Next page</button></nav><script>document.querySelector("#next").onclick=()=>{document.querySelector("h2").textContent="Third page of products";document.querySelector("#next").disabled=true}</script></section>'));
  if (req.url === '/favicon.ico') return res.writeHead(404).end();
  return res.writeHead(404).end();
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const target = 'http://127.0.0.1:' + fixture.address().port + '/';
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/server.ts'], {
  env: { ...process.env, PORT: studioPort, GROQ_API_KEY: '' },
  stdio: 'inherit'
});
const base = 'http://127.0.0.1:' + studioPort;
let browser;
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await fetch(base + '/studio.html').then(r => r.ok).catch(() => false)) break;
    await delay(250);
  }
  browser = await chromium.launch({ channel: browserChannel });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/studio.html');
  await page.getByLabel('Website URL').fill(target);
  await page.getByLabel('What should the demo show?').fill('Browse catalog pagination and products');
  let id;
  page.on('response', async response => {
    if (response.url().endsWith('/api/studio/runs') && response.request().method() === 'POST' && response.ok()) id = (await response.json()).id;
  });
  await page.getByRole('button', {name: 'Generate walkthrough'}).click();
  await page.waitForFunction(() => document.querySelector('.studio-graph-link').search.startsWith('?run='));
  const [explorer] = await Promise.all([
    page.waitForEvent('popup'), page.getByRole('link', { name: 'Graph Explorer', exact: true }).click()
  ]);
  explorer.on('pageerror', error => errors.push(error.message));
  assert.equal(new URL(explorer.url()).searchParams.get('run'), id);
  await explorer.waitForFunction(() => document.querySelector('#metric-pages')?.textContent === '1');
  assert.equal(await explorer.locator('#studio-source-url').textContent(), target);
  assert.equal(await explorer.locator('#crawl-controls').isVisible(), false);
  const graphUrl = base + '/api/studio/runs/' + id + '/graph';
  const live = await fetch(graphUrl + '?filter=sections&view=canvas').then(r => r.json());
  assert.equal(live.model, undefined);
  const poll = await fetch(graphUrl + '?filter=sections&view=canvas&since=' + live.revision).then(r => r.json());
  assert.equal(poll.unchanged, true);
  assert.equal(poll.elements, undefined);
  releaseCatalog();
  await explorer.waitForFunction(() => document.querySelector('#metric-pages')?.textContent === '4');
  await explorer.getByLabel('Graph Detail Level').selectOption('pages');
  await explorer.waitForFunction(() => renderedView === 'pages' && cy.nodes('.node-page').length === 4);
  assert.equal(await explorer.evaluate(() => cy.edges().filter(edge => edge.data('label') === 'Next page').length), 2);
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('error') || !document.querySelector('#results').hidden, undefined, { timeout: 150000 });
  assert.ok(id);
  const endpoint = base + '/api/studio/runs/' + id;
  const status = await fetch(endpoint).then(r => r.json());
  assert.equal(status.stage,'complete',JSON.stringify(status));
  assert.equal(await page.getByRole('link', { name: 'Open graph in Graph Explorer' }).getAttribute('href'), '/?run=' + id);
  const plan = await fetch(endpoint + '/files/plan.json').then(r => r.json());
  assert.deepEqual(plan, status.plan);
  assert.equal(plan.by, 'keyword rules');
  assert.ok((await page.locator('#plan-head').textContent()).includes('Planned by ' + plan.by));
  assert.ok((await page.locator('#plan-head').textContent()).includes(plan.fallbackReason));
  assert.equal(await page.locator('#plan').getAttribute('href'), '/api/studio/runs/' + id + '/files/plan.json');
  assert.deepEqual(await page.locator('#shots li').allTextContents(), plan.steps.map(s => s.caption + ' — ' + s.reason));
  const graph = await fetch(endpoint + '/graph').then(r => r.json());
  assert.equal(Object.values(graph.pages).filter(p => p.status === 'ok').length,4);
  assert.equal(graph.coverage.reason,'frontier exhausted');
  assert.equal(graph.links.filter(l=>l.next).length,2);
  assert.ok(graph.links.some(link => link.via === 'button'));
  assert.ok(Object.values(graph.sections).some(section => section.name === 'Third page of products'));
  assert.ok(status.shots.filter(s=>s.nextPage).length===2,JSON.stringify(status.shots));
  const tree = page.locator('#graph-tree');
  assert.equal(await tree.locator('li').count(), 0);
  const firstPage = tree.locator(':scope > details').first();
  await firstPage.locator(':scope > summary').click();
  const outgoing = firstPage.locator('details').filter({ hasText: 'outgoing links' });
  await outgoing.locator('summary').click();
  await outgoing.getByText(/Browse catalog/).waitFor();
  assert.equal(writes,0);
  assert.deepEqual(errors,[]);
  await page.locator('#preview').evaluate(video => new Promise((resolve, reject) => {
    if (video.readyState >= 1) return resolve();
    const timeout = setTimeout(() => reject(new Error('Video metadata timed out')), 10000);
    video.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once:true });
  }));
  const interactive = await browser.newPage();
  await interactive.goto(endpoint + '/files/interactive.html');
  await interactive.getByRole('button',{name:'Next',exact:true}).click();
  assert.equal(await interactive.locator('section:not([hidden]) small').textContent().then(t=>t.startsWith('2 /')),true);
  const metadata = execFileSync(process.env.FFPROBE_PATH || 'ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,duration','-of','json','.demo-runs/'+id+'/walkthrough.mp4'],{encoding:'utf8'});
  console.log(JSON.stringify({job:id,shots:status.shots,video:JSON.parse(metadata),writes,graph:status.stats},null,2));
  const limited = await fetch(base + '/api/studio/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: target, prompt: 'Show the catalog', maxPages: 1, requireFullCoverage: true })
  }).then(r => r.json());
  const limitedUrl = base + '/api/studio/runs/' + limited.id;
  let stopped;
  for (let i = 0; i < 120; i++) {
    stopped = await fetch(limitedUrl).then(r => r.json());
    assert.equal(stopped.plan, undefined);
    if (stopped.stage === 'failed') break;
    await delay(250);
  }
  assert.equal(stopped.stage, 'failed');
  assert.match(stopped.message, /Incomplete graph \(page limit\)/);
  const partialGraph = JSON.parse(await readFile('.demo-runs/' + limited.id + '/graph.json', 'utf8'));
  assert.equal(partialGraph.coverage.remaining, 1);
  await assert.rejects(readFile('.demo-runs/' + limited.id + '/walkthrough.mp4'), { code: 'ENOENT' });
  const partialView = await fetch(limitedUrl + '/graph?filter=sections').then(r => r.json());
  assert.equal(partialView.stage, 'failed');
  assert.equal(partialView.stats.pagesCount, 1);
  await explorer.reload();
  await explorer.waitForFunction(() => document.querySelector('#metric-pages')?.textContent === '4');
  assert.equal(await explorer.locator('#studio-source-status').textContent(), 'Your walkthrough is ready');
  await explorer.getByRole('link', { name: 'Back to walkthrough' }).click();
  await explorer.locator('#preview').waitFor({ state: 'visible' });
  assert.equal(await explorer.locator('#mp4').getAttribute('href'), '/api/studio/runs/' + id + '/files/walkthrough.mp4');
  const standalone = await fetch(base + '/api/graph').then(r => r.json());
  assert.equal(standalone.stats.pagesCount, 0);
  assert.deepEqual(errors, []);
  console.log('Studio graph updated live from 1 to 4 pages and reopened its run after a second crawl.');
} finally {
  releaseCatalog();
  await browser?.close();
  server.kill();
  fixture.close();
}
