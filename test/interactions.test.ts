import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { SectionCrawler } from '../src/sections/sectionCrawler.js';
import { SectionGraph } from '../src/sections/sectionGraph.js';
import { planDemo } from '../src/demo/planner.js';

const HOME = `<!doctype html><title>Product</title><body>
  <header><nav aria-label="Main"><a href="/">Home</a><a href="/docs">Docs</a></nav></header>
  <main>
    <section><h2>Get started</h2>
      <button id="register" onclick="document.querySelector('#signup').showModal()">Register now</button>
      <button id="save" onclick="fetch('/api/save', {method: 'POST', body: 'x'}).catch(() => {}); this.textContent = 'Saving'">Save draft</button>
      <button id="pricing" onclick="location.href='/pricing'">See pricing</button>
    </section>
    <section><h2>Questions</h2>
      <button id="faq" aria-expanded="false" aria-controls="ans" onclick="this.setAttribute('aria-expanded','true'); document.querySelector('#ans').hidden = false">How does it work?</button>
      <p id="ans" hidden>It crawls your site and records a video of the best flow for your request.</p>
    </section>
  </main>
  <form id="account" method="get" action="/account-submit"><input name="username"><input type="password"></form>
  <button form="account">Finish registration</button>
  <button type="button" onclick="document.querySelector('#account').submit()">Continue setup</button>
  <dialog id="signup" aria-label="Create your account"><h2>Create your account</h2><button onclick="this.closest('dialog').close()">Close</button></dialog>
  <div id="cookies" style="position:fixed;bottom:0;left:0;right:0">We use cookies for analytics. <button onclick="this.parentElement.remove()">Accept</button><button onclick="this.parentElement.remove()">Decline</button></div>
</body>`;
const page = (title: string) => `<!doctype html><title>${title}</title><body><main><h1>${title}</h1><a href="/">Home</a></main></body>`;

async function crawlFixture() {
  const launch = chromium.launch;
  const writes: string[] = [];
  chromium.launch = async options => {
    const browser = await launch.call(chromium, options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async opts => {
      const ctx = await newContext(opts);
      await ctx.route('https://app.test/**', route => {
        const req = route.request();
        if (req.method() !== 'GET') { writes.push(`${req.method()} ${new URL(req.url()).pathname}`); return route.fulfill({ status: 200, body: 'ok' }); }
        const path = new URL(req.url()).pathname;
        if (path === '/account-submit') writes.push('GET form submission');
        return route.fulfill({ contentType: 'text/html', body: path === '/' ? HOME : page(path.slice(1)) });
      });
      return ctx;
    };
    return browser;
  };
  try {
    const graph = new SectionGraph();
    const crawler = new SectionCrawler({ startUrl: 'https://app.test/', maxPages: 4, maxDepth: 1, readOnly: true, probeClicks: true, browserChannel: process.env.CRAWLER_BROWSER_CHANNEL }, graph);
    await crawler.start();
    return { model: graph.getModel(), writes };
  } finally {
    chromium.launch = launch;
  }
}

test('clicks buttons read-only and records what each one does', async () => {
  const { model, writes } = await crawlFixture();
  const byLabel = (label: string) => Object.values(model.interactions ?? {}).find(i => i.label === label);

  assert.equal(byLabel('Register now')?.kind, 'dialog');
  assert.match(byLabel('Register now')!.result, /Create your account/);
  assert.equal(byLabel('See pricing')?.kind, 'navigate');
  assert.equal(byLabel('How does it work?')?.kind, 'panel');

  // The button-reached page became part of the site map and was crawled
  assert.ok((model.links ?? []).some(l => l.interactionId === byLabel('See pricing')!.id));
  assert.equal(model.pages['https://app.test/pricing']?.status, 'ok');

  // The POST from "Save draft" never left the browser
  assert.deepEqual(writes, []);
  assert.equal(Object.values(model.actions).find(a => a.label === 'Finish registration')?.type, 'submit');
  assert.ok(!byLabel('Finish registration'));
  assert.equal(byLabel('Continue setup')?.kind, 'nothing');
  // Cookie buttons are never probed
  assert.ok(!byLabel('Accept') && !byLabel('Decline'));
});

test('the demo plan adds the recorded click that matches the request', async () => {
  const { model } = await crawlFixture();
  const result = planDemo(model, 'how do I register');
  assert.equal(result.by, 'keyword rules');
  const click = result.shots.find(s => s.interaction);
  assert.equal(click?.interaction?.label, 'Register now');
  assert.equal(click?.caption, 'Click Register now');
});
