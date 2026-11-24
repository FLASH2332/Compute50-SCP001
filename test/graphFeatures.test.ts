/**
 * new_graph_base graph features: URL templates, risk and cost, frontier groups, graph algorithms, richer capture
 * (locators, inferred clickables, list templates) and the post-crawl enrichment.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { betweenness, harmonic, labelPropagation, pagerank, reachableFrom } from '../src/sections/algorithms.js';
import { parseProfile } from '../src/sections/bootstrap.js';
import { enrichModel } from '../src/sections/enrich.js';
import { groupFrontier, parseChoice, pickIndex } from '../src/sections/frontier.js';
import { buildSections, readPageRegions } from '../src/sections/sectionExtractor.js';
import { pageIdOf } from '../src/sections/sectionCrawler.js';
import { classifyRisk, edgeCost, reliability, templatePattern, urlTemplate } from '../src/sections/templates.js';
import type { SectionGraphModel } from '../src/sections/types.js';

test('URL templates replace ids, slugs and query values', () => {
  assert.equal(urlTemplate('https://x.test/product/123'), '/product/:id');
  assert.equal(urlTemplate('https://x.test/catalogue/a-light-in-the-attic_1000/index.html'), '/catalogue/:id/index.html');
  assert.equal(urlTemplate('https://x.test/search?q=shoes&page=2'), '/search?page&q');
  assert.equal(urlTemplate('https://x.test/about'), '/about');
  assert.equal(urlTemplate('https://x.test/#/item/7'), '/#/item/:id');
  const re = new RegExp(templatePattern('https://x.test', '/product/:id'));
  assert.ok(re.test('https://x.test/product/99'));
  assert.ok(re.test('https://x.test/product/99?ref=a'));
  assert.ok(!re.test('https://x.test/product/99/reviews'));
  assert.ok(!re.test('https://other.test/product/99'));
});

test('risk classes and routing cost', () => {
  const same = (u: string) => u.startsWith('https://x.test');
  assert.equal(classifyRisk('link', 'Log in', 'https://x.test/login', same), 'navigate', 'a login link only opens a page');
  assert.equal(classifyRisk('button', 'Log in', undefined, same), 'submit_mutating');
  assert.equal(classifyRisk('button', 'Delete account', undefined, same), 'destructive');
  assert.equal(classifyRisk('link', 'Partner', 'https://other.test/', same), 'external');
  assert.equal(classifyRisk('textbox', 'Email', undefined, same), 'input');
  assert.equal(reliability(0, 0), 0.5);
  assert.equal(reliability(1, 1), 2 / 3);
  assert.ok(edgeCost(reliability(1, 1)) < edgeCost(reliability(0, 0)), 'a link that worked is cheaper than an untried one');
  assert.ok(edgeCost(0.5, 'destructive') > 10000);
});

test('frontier groups, guided choice parsing and the template cap', () => {
  const t = (path: string, depth = 1) => ({ id: 'https://x.test' + path, url: 'https://x.test' + path, depth });
  const queue = [t('/product/1'), t('/product/2'), t('/product/3'), t('/product/4'), t('/about'), t('/blog/post-one-here', 2)];
  const { groups, members } = groupFrontier(queue);
  const product = groups.find(g => g.template === '/product/:id')!;
  assert.equal(product.count, 4);
  assert.ok(product.lookalike);
  assert.equal(members.get(product.id)!.length, 4);

  const choice = parseChoice({ pick: [product.id, 'g99'], skip: [{ pattern: '/blog/', reason: 'posts' }, { pattern: '(' }], stop: false }, groups);
  assert.deepEqual(choice.pick, [product.id], 'unknown group ids are dropped');
  assert.deepEqual(choice.skip.map(s => s.pattern), ['/blog/'], 'patterns that do not compile are dropped');
  assert.equal(parseChoice('nonsense', groups).ok, false);

  const opened = new Map([['/product/:id', 3]]);
  assert.equal(queue[pickIndex(queue, opened, 3)].url, 'https://x.test/about', 'a 4th look-alike waits behind other pages');
  assert.equal(pickIndex(queue, new Map(), 3), 0);
  assert.equal(queue[pickIndex(queue, new Map(), 3, new Set(['/blog/:id']))].url, 'https://x.test/blog/post-one-here');
});

test('graph algorithms on small graphs', () => {
  const star = { nodes: ['h', 'a', 'b', 'c'], edges: [['h', 'a'], ['h', 'b'], ['h', 'c'], ['a', 'h'], ['b', 'h'], ['c', 'h']] as [string, string][] };
  const pr = pagerank(star);
  assert.ok(Math.abs(pr.reduce((s, v) => s + v, 0) - 1) < 1e-6, 'PageRank sums to 1');
  assert.ok(pr[0] > pr[1], 'the hub ranks highest');
  const path = { nodes: ['a', 'b', 'c'], edges: [['a', 'b'], ['b', 'c']] as [string, string][] };
  assert.deepEqual(betweenness(path), [0, 0.5, 0], 'b is on the only a→c path');
  assert.deepEqual(harmonic(path), [0, 0.5, 0.75]);
  assert.deepEqual(reachableFrom(path, 'b'), [false, true, true]);
  // two triangles joined by one edge → two communities
  const two = { nodes: ['a', 'b', 'c', 'x', 'y', 'z'], edges: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['x', 'y'], ['y', 'z'], ['z', 'x'], ['c', 'x']] as [string, string][] };
  const lp = labelPropagation(two);
  assert.equal(lp[0], lp[1]);
  assert.equal(lp[1], lp[2]);
  assert.equal(lp[3], lp[4]);
  assert.equal(lp[4], lp[5]);
  assert.notEqual(lp[0], lp[3]);
});

test('site profile answers are validated', () => {
  assert.equal(parseProfile({ sections: [] }, 'https://x.test/'), undefined, 'no purpose, no profile');
  const p = parseProfile({ purpose: 'A shop', size: 'huge', skip: [{ pattern: 'x\\.test' }, { pattern: '/legal/' }, { pattern: '(' }], flows: ['buy', 3] }, 'https://x.test/')!;
  assert.equal(p.size, 'medium');
  assert.deepEqual(p.skip.map(s => s.pattern), ['/legal/'], 'a pattern matching the start page is dropped');
  assert.deepEqual(p.flows, ['buy']);
});

const LIST_PAGE = `<!doctype html><html><body>
<nav aria-label="Main"><a href="/">Home</a><a href="/about">About</a><a data-testid="cart-link" href="/cart">Cart</a></nav>
<main><h1>Products</h1>
  <ul class="grid">
    ${[1, 2, 3, 4, 5].map(i => `<li class="card"><a href="/product/${i}"><img alt="Photo ${i}" src="data:,"></a><h3><a href="/product/${i}">Product number ${i}</a></h3><p>Nice thing for $${i}0</p></li>`).join('')}
  </ul>
  <div class="tile" onclick="void 0">Open filters</div>
  <div style="cursor:pointer" id="sorter">Sort by price</div>
  <button aria-haspopup="menu">More</button>
</main></body></html>`;

test('richer capture: roles, locators, inferred clickables and list templates', async () => {
  const browser = await chromium.launch({ channel: process.env.CRAWLER_BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage();
    await page.addInitScript('globalThis.__name = (t) => t;');
    await page.route('https://shop.test/**', r => r.fulfill({ contentType: 'text/html', body: LIST_PAGE }));
    await page.goto('https://shop.test/');
    const raw = await readPageRegions(page);
    const { actions } = buildSections(pageIdOf(page.url()), raw.regions, u => u.startsWith('https://shop.test'), pageIdOf);

    const cart = actions.find(a => a.label === 'Cart')!;
    assert.equal(cart.role, 'link');
    assert.equal(cart.risk, 'navigate');
    assert.deepEqual(cart.locators!.map(l => l.split('=')[0]), ['role', 'testid', 'css', 'text']);
    assert.equal(cart.locators![0], 'role=link|name=Cart');
    assert.ok(cart.fingerprint?.bbox.length === 4);

    const inferred = actions.filter(a => a.inferred).map(a => a.label).sort();
    assert.deepEqual(inferred, ['Open filters', 'Sort by price'], 'clickable divs are recorded as buttons');
    assert.ok(actions.find(a => a.label === 'More')?.hoverable);

    const list = actions.find(a => a.isTemplate)!;
    assert.equal(list.count, 5);
    assert.deepEqual(list.samples, [1, 2, 3, 4, 5].map(i => `Product number ${i}`));
    assert.equal(list.hrefTemplate, '/product/:id');
    // The item= locator finds one item by its text
    const sel = list.locators![0].slice('item='.length);
    assert.equal(await page.locator(sel).filter({ hasText: 'Product number 3' }).count(), 1);
    // Every css= locator is unique on the page
    for (const a of actions.filter(x => !x.isTemplate)) {
      const css = a.locators!.find(l => l.startsWith('css='))!.slice(4);
      assert.equal(await page.locator(css).count(), 1, `${a.label}: ${css}`);
    }
  } finally {
    await browser.close();
  }
});

test('enrichment adds templates, costs, scores, areas and keeps the model loadable', async () => {
  const page = (id: string, depth: number, crawled = true) => ({ id: 'https://x.test' + id, url: 'https://x.test' + id, title: `T ${id} | Shop`, depth, crawled, status: crawled ? 'ok' : 'not-crawled', discoveredAt: '' } as any);
  const pages = Object.fromEntries([page('/', 0), page('/product/1', 1), page('/product/2', 1), page('/product/3', 1, false),
    page('/blog', 1), page('/blog/post-1', 2), page('/blog/post-2', 2)].map(p => [p.id, p]));
  const link = (s: string, t: string) => ({ source: 'https://x.test' + s, target: 'https://x.test' + t, url: 'https://x.test' + t, label: t, next: false });
  const model: SectionGraphModel = {
    startUrl: 'https://x.test/', domain: 'x.test', pages, sections: {}, actions: {},
    links: [link('/', '/product/1'), link('/', '/product/2'), link('/', '/product/3'), link('/', '/blog'),
      link('/product/1', '/product/2'), link('/product/2', '/product/1'), link('/product/2', '/product/3'),
      link('/blog', '/blog/post-1'), link('/blog', '/blog/post-2'), link('/blog/post-1', '/blog/post-2'), link('/blog/post-2', '/blog/post-1')],
  };
  await enrichModel(model, { isSameSite: u => u.startsWith('https://x.test') });
  const tpl = model.extraNodes!.filter(n => n.label === 'Template');
  assert.equal(tpl.length, 2, '/product/:id and /blog/:id');
  assert.equal(model.extraEdges!.filter(e => e.type === 'INSTANCE_OF').length, 5);
  assert.ok(pages['https://x.test/product/1'].urlPattern, 'the first product page stands for unopened products');
  assert.ok(model.links!.every(l => typeof l.cost === 'number'));
  assert.ok(model.links!.find(l => l.target.endsWith('/product/1'))!.cost! < model.links!.find(l => l.target.endsWith('/product/3'))!.cost!,
    'a link to a page that opened fine is cheaper than one to an unopened page');
  assert.ok(Object.values(pages).every((p: any) => typeof p.pagerank === 'number' && p.reachable === true));
  assert.equal(pages['https://x.test/blog/post-1'].deadEnd, false);
  const areas = model.extraNodes!.filter(n => n.label === 'Area');
  assert.ok(areas.length >= 2, 'products and blog are separate areas');
  assert.ok(areas.every(a => a.props.namedBy === 'top page' && typeof a.props.name === 'string'));
  assert.equal(new Set(areas.map(a => a.props.name)).size, areas.length, 'area names are distinct');
  assert.ok(JSON.stringify(model), 'serializable');
});
