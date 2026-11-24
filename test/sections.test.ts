import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { SectionCrawler } from '../src/sections/sectionCrawler.js';
import { SectionGraph, sectionGraphToCypher } from '../src/sections/sectionGraph.js';
import { readPageRegions, buildSections } from '../src/sections/sectionExtractor.js';

test('extractor measures a halfway section against document height and viewport height', async () => {
  const browser = await chromium.launch({ channel: process.env.CRAWLER_BROWSER_CHANNEL });
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await tab.evaluate('globalThis.__name = t => t');
    await tab.setContent('<style>body{height:4000px;margin:0}section{position:absolute;top:2000px;height:1280px}</style><section><h2>Halfway</h2></section>');
    await tab.evaluate(() => window.scrollTo(0, 600));
    const { regions } = await readPageRegions(tab);
    const [section] = buildSections('home', regions, () => false, url => url).sections;
    assert.ok(section.positionPct! >= 40 && section.positionPct! <= 60);
    assert.equal(section.heightScreens, 1.6);
    assert.equal(await tab.locator(section.regionSelector!).innerText(), 'Halfway');
  } finally { await browser.close(); }
});

// Real-looking cards: image link + title link to the same event, plus a description
const cards = Array.from({ length: 12 }, (_, i) => {
  const href = `/events/event-${String.fromCharCode(97 + i)}`;
  return `<li class="card"><a href="${href}"><img alt="" src="data:,"></a><a class="card-link" href="${href}">Event ${i}</a><p>A description of this event and who it is for.</p></li>`;
}).join('');
// A plain list of different pages (one link per item): must NOT be grouped
const docs = ['intro', 'install', 'config', 'deploy', 'testing', 'faq', 'api', 'cli'].map(d => `<li><a href="/docs/${d}">${d}</a></li>`).join('');
const HOME = `<!doctype html><title>Home</title><body>
  <header><nav aria-label="Main menu">
    <a href="/about">About</a><a href="/blog">Blog</a><a href="/docs">Docs</a><a href="/pricing">Pricing</a>
    <a href="/careers">Careers</a><a href="/contact">Contact</a><a href="/press">Press</a><a href="https://other.example/x">Partner</a>
  </nav></header>
  <main>
    <section><h2>Upcoming events</h2><ul>${cards}</ul></section>
    <section><h2>Documentation</h2><ul>${docs}</ul></section>
    <section><h2>Sign in</h2>
      <form action="/login" method="post" onsubmit="document.title='SUBMITTED'">
        <input type="email" name="email" placeholder="Email"><input type="password" name="password" placeholder="Password">
        <button type="submit">Log in</button>
      </form>
    </section>
    <form><button type="submit">Add to cart</button></form>
  </main>
  <div class="cookie-bar"><button>Accept</button></div>
  <dialog aria-label="Newsletter"><input type="email" name="nl"><button>Subscribe</button></dialog>
  <footer><a href="/terms">Terms</a></footer>
</body>`;
const page = (title: string) => `<!doctype html><title>${title}</title><body><main><h1>${title}</h1><a href="/">Home</a></main></body>`;

test('splits a page into sections, groups repeated cards, keeps menus, records fields, never submits', async () => {
  const launch = chromium.launch;
  const requests: string[] = [];
  chromium.launch = async options => {
    const browser = await launch.call(chromium, options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async opts => {
      const ctx = await newContext(opts);
      await ctx.route('https://site.test/**', route => {
        requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        const path = new URL(route.request().url()).pathname;
        route.fulfill({ contentType: 'text/html', body: path === '/' ? HOME : page(path.slice(1)) });
      });
      return ctx;
    };
    return browser;
  };

  try {
    const graph = new SectionGraph();
    const crawler = new SectionCrawler({ startUrl: 'https://site.test/', maxPages: 3, maxDepth: 1, browserChannel: process.env.CRAWLER_BROWSER_CHANNEL }, graph);
    const errors: string[] = [];
    crawler.on('crawler_event', e => { if (e.type === 'error') errors.push(e.data.error); });
    await crawler.start();
    assert.deepEqual(errors, []);

    const m = graph.getModel();
    const home = Object.values(m.pages).find(p => p.depth === 0)!;
    const secs = Object.values(m.sections).filter(s => s.pageId === home.id);
    const byName = (n: string) => secs.find(s => s.name === n)!;
    const actionsOf = (n: string) => Object.values(m.actions).filter(a => a.sectionId === byName(n).id);

    // Sections a visitor would name
    for (const n of ['Main menu', 'Upcoming events', 'Sign in', 'Newsletter']) assert.ok(byName(n), `missing section ${n}`);
    assert.equal(byName('Main menu').role, 'nav');
    assert.equal(byName('Newsletter').hidden, true, 'closed dialog is recorded as hidden');

    // Menu: 7 different pages are NOT collapsed; the outside link is marked external
    const menu = actionsOf('Main menu');
    assert.equal(menu.length, 8);
    assert.ok(menu.find(a => a.label === 'Partner')?.external);

    // Repeated cards /events/* are grouped: 3 kept, each standing for 12
    const events = actionsOf('Upcoming events');
    assert.equal(events.length, 3);
    assert.ok(events.every(a => a.groupSize === 12));
    assert.equal(byName('Upcoming events').totalActions, 12);
    assert.equal(m.links?.filter(link => new URL(link.url).pathname.startsWith('/events/')).length, 12);

    // A list of different pages (no images/text per item) is kept in full
    assert.equal(actionsOf('Documentation').length, 8);
    assert.ok(actionsOf('Documentation').every(a => !a.groupSize));

    // Every field type is recorded, including email and password
    const fields = actionsOf('Sign in').map(a => `${a.type}:${a.inputType ?? ''}`).sort();
    assert.deepEqual(fields, ['input:email', 'input:password', 'submit:'].sort());

    // A one-button form is not a section of its own; the cookie bar becomes a content section
    assert.ok(!secs.some(s => s.role === 'form' && s.name.includes('Add to cart')));
    assert.ok(secs.some(s => s.role === 'content' && Object.values(m.actions).some(a => a.sectionId === s.id && a.label === 'Accept')));

    // Nothing was submitted: no POST, and only GETs for pages we navigated to
    assert.ok(!requests.some(r => r.startsWith('POST')), requests.join(', '));
    assert.equal(Object.values(m.pages).filter(p => p.crawled).length, 3);

    // Cypher export uses the friend-compatible schema
    const cypher = sectionGraphToCypher(m);
    assert.ok(cypher.includes('MERGE (p)-[:HAS_SECTION]->(s)'));
    assert.ok(cypher.includes('MERGE (a)-[:NAVIGATES_TO]->(t)'));
  } finally {
    chromium.launch = launch;
  }
});

test('page ids drop tracking params, #hash and trailing slash', async () => {
  const { pageIdOf } = await import('../src/sections/sectionCrawler.js');
  assert.equal(pageIdOf('https://site.test/about/?utm_source=x#team'), 'https://site.test/about');
  assert.notEqual(pageIdOf('https://site.test/item/1'), pageIdOf('https://site.test/item/2'));
});

test('Cytoscape labels shorten page and section URLs without changing their data', () => {
  const graph = new SectionGraph();
  const signin = 'https://site.test/sign-in?next=%2Fhackathons%2Fflagsmith%3Fresume%3Dregister';
  const home = 'https://site.test/';
  const addPage = (url: string, title: string) => graph.setPage({
    id: url, url, title, depth: 0, crawled: true, status: 'ok', discoveredAt: ''
  }, [], []);
  addPage(signin, 'Sign in | Site');
  addPage(home, 'Home | Site');
  graph.getModel().sections.account = {
    id: 'account', pageId: signin, name: signin + ' | Site', role: 'form',
    hidden: false, order: 0, actionCount: 0, totalActions: 0, summary: ''
  };
  const node = (id: string) => graph.toCytoscape().find(element => element.data.id === id).data;
  assert.equal(node(signin).label, 'Sign in\n/sign-in');
  assert.equal(node(home).label, 'Home\nHome');
  assert.equal(node('account').label, 'form: /sign-in\n0 actions');
  assert.equal(node('account').name, signin + ' | Site');
  assert.equal(node(signin).id, signin);
  assert.equal(node(signin).url, signin);
  assert.equal(node(signin).path, new URL(signin).pathname + new URL(signin).search);

  const other = 'https://site.test/sign-in?redirect=%2Fworkspace%2Fteam%3Fmode%3Djoin#form';
  const third = 'https://site.test/sign-in?tab=account';
  const decoded = 'https://site.test/guides/caf%C3%A9%20menu?sort=recent#intro';
  const long = 'https://site.test/guides/' + 'long-path-'.repeat(5);
  addPage(other, 'Sign in - Site');
  addPage(third, 'Sign in · Site');
  addPage(decoded, '');
  addPage(long, long);
  graph.addLinkedPage('unopened', 'https://site.test/guides/unopened?lang=en', 1);
  const map = graph.toCytoscape('pages');
  const label = (id: string) => map.find(element => element.data.id === id).data.label;
  assert.equal(label(signin), 'Sign in\n/sign-in (from: flagsmith)');
  assert.equal(label(other), 'Sign in\n/sign-in (from: team)');
  assert.equal(label(third), 'Sign in\n/sign-in (2)');
  assert.equal(label(decoded), '/guides/café menu');
  assert.equal(label(long).length, 32);
  assert.ok(label(long).endsWith('…'));
  // Site map shows opened pages only; the unopened link stays in the data
  assert.ok(!map.some(element => element.data.id === 'unopened'));
  assert.equal(graph.getModel().pages.unopened?.crawled, false);
  assert.ok(map.every(element => !/[?%]/.test(element.data.label)));
});
