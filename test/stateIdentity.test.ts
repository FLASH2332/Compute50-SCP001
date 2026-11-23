// Run: npm test. Set CRAWLER_BROWSER_CHANNEL=chrome to use installed Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { detectCurrentUIState, urlTemplate } from '../src/explorer/stateDetector.js';

const BASE = 'https://fixture.test';

test('urlTemplate groups numeric ids but is not identity', () => {
  assert.equal(urlTemplate(`${BASE}/status_codes/200`), `${BASE}/status_codes/:id`);
  assert.equal(urlTemplate(`${BASE}/status_codes/404`), `${BASE}/status_codes/:id`);
});

test('/status_codes/200 and /404 are different states with the same route template', async () => {
  const browser = await chromium.launch({ channel: process.env.CRAWLER_BROWSER_CHANNEL });
  try {
    const page = await browser.newPage();
    await page.addInitScript('globalThis.__name = (value) => value');
    await page.route(`${BASE}/**`, route => route.fulfill({
      contentType: 'text/html',
      body: '<main><h1>Status page</h1></main>'
    }));
    await page.goto(`${BASE}/status_codes/200`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const a = await detectCurrentUIState(page);
    await page.goto(`${BASE}/status_codes/404`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const b = await detectCurrentUIState(page);
    await page.goto(`${BASE}/status_codes/200?utm_source=x`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const c = await detectCurrentUIState(page);

    assert.notEqual(a.state.id, b.state.id, 'different pages must not collapse');
    assert.notEqual(a.page.id, b.page.id);
    assert.equal(a.state.routeTemplate, b.state.routeTemplate, 'same route group');
    assert.equal(a.state.id, c.state.id, 'tracking params must not create a new state');
  } finally {
    await browser.close();
  }
});
