import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { PlaywrightExplorer } from '../src/explorer/playwrightExplorer.js';
import { GraphBuilder } from '../src/graph/graphBuilder.js';
import { generateCypherScript } from '../src/neo4j/cypherExporter.js';

test('restores same-URL dialogs and records outcomes and sitemap links', async () => {
  const html = `<!doctype html><title>Fixture</title><main>
    <button onclick="document.querySelector('dialog').showModal()">Open dialog</button>
    <dialog aria-label="Details">
      <button onclick="document.querySelector('dialog').close()">Close dialog</button>
      <button onclick="document.querySelector('[role=status]').textContent='Successfully saved'">Save</button>
      <button onclick="document.querySelector('[role=status]').innerHTML='<span class=&quot;alert&quot;>Your username is invalid!</span> <button type=&quot;button&quot; aria-label=&quot;Close&quot;>&times;</button>'">Submit</button>
      <div role="status"></div>
    </dialog>
    <a href="/extra">Add/Remove Elements</a>
  </main>`;
  const launch = chromium.launch;
  chromium.launch = async options => {
    const browser = await launch.call(chromium, options);
    const createContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await createContext(options);
      await context.route('https://fixture.test/**', route => route.fulfill({
        contentType: 'text/html',
        body: route.request().url().endsWith('/extra') ? '<title>Extra</title>' : html
      }));
      return context;
    };
    return browser;
  };

  const graph = new GraphBuilder();
  const explorer = new PlaywrightExplorer({
    startUrl: 'https://fixture.test/',
    browserChannel: process.env.CRAWLER_BROWSER_CHANNEL,
    maxDepth: 2
  }, graph);
  const errors: string[] = [];
  explorer.on('crawler_event', event => {
    if (event.type === 'error') errors.push(event.data.error);
  });

  try {
    await explorer.start();
    assert.deepEqual(errors, []);
    const model = graph.getModel();
    const close = Object.values(model.transitions).find(edge => edge.description.includes('Close dialog'));
    assert.ok(close);
    assert.equal(model.states[close.fromStateId].isModal, true);
    assert.equal(model.states[close.toStateId].isModal, false);
    assert.equal(model.states[close.fromStateId].url, model.states[close.toStateId].url);
    assert.ok(model.links?.some(link => link.destinationUrl.endsWith('/extra')));
    assert.ok(Object.values(model.states).every(state => !state.screenshotBase64));

    const workflows = Object.values(model.workflows);
    assert.ok(workflows.some(workflow => workflow.status === 'completed' && workflow.evidence.includes('Successfully saved')));
    assert.ok(workflows.some(workflow => workflow.status === 'partial' && workflow.evidence === 'message: Your username is invalid!'));
    assert.ok(!workflows.some(workflow => workflow.name.includes('Add/Remove Elements')));
    const navigation = Object.values(model.transitions).find(edge => edge.description.includes('Add/Remove Elements'));
    assert.ok(navigation?.urlChanged);
    assert.ok(generateCypherScript(model).includes('w.transitionIds = ["trans_'));
  } finally {
    chromium.launch = launch;
  }
});
