const form = document.querySelector('#run-form');
const status = document.querySelector('#status');
const coverage = document.querySelector('#coverage');
const route = document.querySelector('#route');
const results = document.querySelector('#results');
const panel = document.querySelector('#graph-panel');
const generate = document.querySelector('#generate');
const phases = ['exploring', 'planning', 'recording'];
const node = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not load the walkthrough.');
  return data;
}

function update(run) {
  status.textContent = run.message;
  status.classList.toggle('error', run.stage === 'failed');
  document.querySelectorAll('[data-stage]').forEach(item => {
    item.classList.toggle('active', item.dataset.stage === run.stage);
    item.classList.toggle('done', run.stage === 'complete' || phases.indexOf(item.dataset.stage) < phases.indexOf(run.stage));
  });
  if (run.stats) {
    const { pagesCount, sectionsCount, linkedPagesCount } = run.stats;
    coverage.hidden = false;
    coverage.textContent = pagesCount + ' pages attempted · ' + sectionsCount + ' sections · ' + linkedPagesCount + ' discovered views pending' +
      (run.coverage ? ' · ' + run.coverage.reason : '');
  }
  if (run.plan) {
    route.hidden = false;
    // Who planned the video, and the reason for every step (skipped steps say why)
    let head = document.querySelector('#plan-head');
    if (!head) {
      head = node('p', '');
      head.id = 'plan-head';
      head.className = 'secondary';
      document.querySelector('#shots').before(head);
    }
    head.textContent = ['Planned by ' + run.plan.by, run.plan.summary, run.plan.fallbackReason].filter(Boolean).join(' · ');
    const items = run.plan.steps.map(step => node('li',
      (step.skipped ? 'Skipped ' + (step.ref || 'step') + ' · ' : '') + step.caption + ' — ' + step.reason));
    document.querySelector('#shots').replaceChildren(...items);
  } else if (run.shots) {
    route.hidden = false;
    document.querySelector('#shots').replaceChildren(...run.shots.map(shot =>
      node('li', (shot.nextPage ? 'Next page · ' : '') + shot.title + (shot.section ? ' · ' + shot.section : '') + (shot.click ? ' · click ' + shot.click : ''))));
  }
}

function expandable(label, load) {
  const details = document.createElement('details');
  const summary = node('summary', label);
  details.append(summary);
  let loaded = false;
  let message;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    message?.remove();
    message = node('p', 'Loading…');
    details.append(message);
    try {
      const children = await load();
      message.replaceWith(children);
    } catch (error) {
      message.textContent = error.message + ' Close and reopen to retry.';
      loaded = false;
    }
  });
  return details;
}

function showGraph(graph, endpoint) {
  if (!form.elements.url.value) form.elements.url.value = graph.startUrl;
  const tree = document.querySelector('#graph-tree');
  tree.replaceChildren(...graph.pages.map(page => expandable((page.title || page.url) + ' · ' + page.status, async () => {
    const { sections, actions, links } = await json(endpoint + '/page?id=' + encodeURIComponent(page.id));
    const fragment = document.createDocumentFragment();
    const bySection = new Map();
    for (const action of actions) {
      if (!bySection.has(action.sectionId)) bySection.set(action.sectionId, []);
      bySection.get(action.sectionId).push(action);
    }
    for (const section of sections) {
      fragment.append(expandable(section.name + ' · ' + section.role, () => graphList(bySection.get(section.id) || [],
        a => a.label + ' · ' + a.type + (a.groupSize ? ' ×' + a.groupSize : ''))));
    }
    if (links.length) fragment.append(expandable(links.length + ' outgoing links', () => graphList(links,
      link => (link.next ? 'Next page · ' : '') + link.label + ' → ' + (link.title || link.url) + ' · ' + link.status)));
    return fragment;
  })));
  panel.hidden = false;
}

async function watchRun(id) {
  const query = '?run=' + encodeURIComponent(id);
  history.replaceState(null, '', '/studio.html' + query);
  document.querySelectorAll('.studio-graph-link').forEach(link => {
    link.href = '/' + query;
    link.target = '_blank';
    link.rel = 'noopener';
  });
  const base = '/api/studio/runs/' + encodeURIComponent(id);
  let run = await json(base);
  while (true) {
    update(run);
    if (run.stage !== 'exploring' && panel.hidden) {
      const graph = await json(base + '/graph?view=tree').catch(() => null);
      if (graph) showGraph(graph, base + '/graph');
    }
    if (run.stage === 'failed') return;
    if (run.stage === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 1200));
    run = await json(base);
  }
  document.querySelector('#preview').src = base + '/files/walkthrough.mp4';
  document.querySelector('#mp4').href = base + '/files/walkthrough.mp4';
  document.querySelector('#interactive').href = base + '/files/interactive.html';
  document.querySelector('#graph').href = base + '/files/graph.json';
  document.querySelector('#plan').href = base + '/files/plan.json';
  results.hidden = false;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const inputs = new FormData(form);
  generate.disabled = true;
  [coverage, route, results, panel].forEach(element => { element.hidden = true; });
  document.querySelector('#preview').removeAttribute('src');
  update({ stage: 'exploring', message: 'Starting the browser' });
  try {
    const { id } = await json('/api/studio/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: inputs.get('url'), prompt: inputs.get('prompt'), maxPages: Number(inputs.get('maxPages')), maxDepth: Number(inputs.get('maxDepth')), requireFullCoverage: inputs.has('requireFullCoverage') })
    });
    await watchRun(id);
  } catch (error) {
    update({ stage: 'failed', message: error.message });
  } finally {
    generate.disabled = false;
  }
});

const selectedRun = new URLSearchParams(location.search).get('run');
if (selectedRun) {
  generate.disabled = true;
  watchRun(selectedRun)
    .catch(error => update({ stage: 'failed', message: error.message }))
    .finally(() => { generate.disabled = false; });
}
