let cy = null;
let inspectorRequest = 0;
let graphRequest = 0;
let renderedView = '';
let graphRevision;
let forceWorker;
let studioGraphTimer;
const studioRun = new URLSearchParams(location.search).get('run');
const studioEndpoint = studioRun ? '/api/studio/runs/' + encodeURIComponent(studioRun) : null;
const graphEndpoint = studioEndpoint ? studioEndpoint + '/graph' : '/api/graph';
let ws = null;
let eventCount = 0;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('input-url');
  if (urlInput && !urlInput.value) urlInput.value = `${location.origin}/demo`;
  initCytoscape();
  setupEventListeners();
  if (studioRun) {
    document.getElementById('studio-source').hidden = false;
    for (const id of ['crawl-controls', 'neo4j-status-pill', 'btn-sync-neo4j', 'btn-export-cypher']) {
      document.getElementById(id).hidden = true;
    }
    const studioLink = document.getElementById('studio-link');
    studioLink.href = '/studio.html?run=' + encodeURIComponent(studioRun);
    studioLink.textContent = 'Back to walkthrough';
    document.getElementById('log-container').textContent = '';
    document.getElementById('log-header').firstElementChild.textContent = 'Walkthrough activity';
  } else {
    setupWebSocket();
    checkNeo4jStatus();
  }
  fetchGraphData();
});

// 1. Initialize Cytoscape Instance
function initCytoscape() {
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: [],
    style: [
      // General node style
      {
        selector: 'node',
        style: {
          'label': ele => ele.data('displayLabel') || ele.data('label'),
          'color': '#f8fafc',
          'font-size': '13px',
          'min-zoomed-font-size': 8,
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-overflow-wrap': 'anywhere',
          'text-max-width': '170px',
          'border-width': 2,
          'transition-property': 'background-color, border-color, width, height',
          'transition-duration': '0.2s'
        }
      },
      // Page Node
      {
        selector: '.node-page',
        style: {
          'shape': 'round-rectangle',
          'background-color': '#0369a1',
          'border-color': '#38bdf8',
          'width': '180px',
          'height': '68px',
          'font-weight': 'bold'
        }
      },
      // Page known only through a link (not opened)
      {
        selector: '.node-page-linked',
        style: { 'background-color': '#0b1220', 'border-style': 'dashed', 'font-weight': 'normal', 'color': '#93c5fd', 'height': '40px' }
      },
      // Page that could not be read (bot check / error)
      {
        selector: '.node-page-blocked',
        style: { 'background-color': '#7f1d1d', 'border-color': '#f87171' }
      },
      // Section
      {
        selector: '.node-section',
        style: { 'shape': 'round-rectangle', 'background-color': '#064e3b', 'border-color': '#10b981', 'width': '190px', 'height': '64px', 'font-size': '12px' }
      },
      {
        selector: '.node-section-form, .node-section-dialog',
        style: { 'background-color': '#581c87', 'border-color': '#c084fc' }
      },
      {
        selector: '.node-section-shared',
        style: { 'border-style': 'double', 'border-width': 4, 'background-color': '#1e293b', 'border-color': '#64748b' }
      },
      {
        selector: '.node-section-hidden',
        style: { 'border-style': 'dashed', 'opacity': 0.75 }
      },
      // Action
      {
        selector: '.node-action',
        style: { 'shape': 'round-rectangle', 'background-color': '#78350f', 'border-color': '#fbbf24', 'border-width': 1, 'width': '192px', 'height': '62px', 'font-size': '13px', 'text-max-width': '174px' }
      },
      // Edges
      {
        selector: '.edge-has-section, .edge-has-action',
        style: { 'line-style': 'dashed', 'line-color': '#334155', 'target-arrow-shape': 'none', 'width': 1, 'curve-style': 'bezier' }
      },
      {
        selector: '.edge-nav',
        style: {
          'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#38bdf8', 'target-arrow-color': '#38bdf8', 'width': 2,
          'label': ele => ele.data('label') === 'link' ? '' : ele.data('label'),
          'font-size': '10px', 'min-zoomed-font-size': 9, 'color': '#7dd3fc',
          'text-background-color': '#0f172a', 'text-background-opacity': 0.9, 'text-background-padding': '2px'
        }
      },
      // Selected Highlighting
      {
        selector: 'node:selected',
        style: {
          'border-color': '#ffffff',
          'border-width': 4
        }
      },
      {
        selector: 'edge:selected',
        style: {
          'line-color': '#ffffff',
          'target-arrow-color': '#ffffff',
          'width': 4
        }
      },
      {
        selector: '.route-muted',
        style: { 'opacity': 0.17 }
      }
    ]
  });

  // Node & Edge selection listener
  cy.on('tap', 'node, edge', (evt) => {
    const item = evt.target;
    inspectItem(item);
  });
  cy.on('select unselect', '.node-page', () => {
    if (renderedView !== 'pages') return;
    const selected = cy.nodes('.node-page:selected');
    const routes = selected.connectedEdges();
    cy.edges().toggleClass('route-muted', selected.length > 0);
    routes.removeClass('route-muted');
  });
  new ResizeObserver(() => cy.resize()).observe(cy.container());
}

// 2. WebSocket Connection for Real-Time Streaming
function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    appendLog('info', 'Connected to real-time engine event stream');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerEvent(msg);
    } catch (err) {
      console.error('WS parse error:', err);
    }
  };

  ws.onclose = () => {
    setTimeout(setupWebSocket, 3000); // Auto reconnect
  };
}

// 3. Handle Streaming Explorer Events
function handleServerEvent(evt) {
  eventCount++;
  document.getElementById('log-count').innerText = eventCount;

  switch (evt.type) {
    case 'log':
      appendLog('info', evt.data.message);
      break;

    case 'page_crawled':
      appendLog('state', `Page: ${evt.data.page.url} - ${evt.data.sections} sections, ${evt.data.actions} actions`);
      fetchGraphData();
      break;

    case 'complete':
      appendLog('workflow', `Crawl complete: ${evt.data.pages} pages, ${evt.data.sections} sections, ${evt.data.actions} actions`);
      setCrawlerRunning(false);
      fetchGraphData();
      break;

    case 'error':
      appendLog('error', `Error: ${evt.data.error}`);
      setCrawlerRunning(false);
      fetchGraphData();
      break;
  }
}

// 4. Fetch Graph Data and Render into Cytoscape
async function fetchGraphData() {
  clearTimeout(studioGraphTimer);
  const filter = document.getElementById('select-filter-mode').value;
  const request = ++graphRequest;
  try {
    const query = new URLSearchParams({ filter, view: 'canvas' });
    if (studioRun && filter === renderedView && graphRevision !== undefined) query.set('since', graphRevision);
    const res = await fetch(graphEndpoint + '?' + query);
    if (!res.ok) throw new Error(res.status === 404 ? 'This walkthrough graph could not be found.' : 'Could not load the graph.');
    const data = await res.json();
    if (request !== graphRequest) return;
    if (studioRun) updateStudioStatus(data);
    if (data.unchanged) return;
    if (studioRun) document.getElementById('studio-source-url').textContent = decodedUrl(data.startUrl);
    const previous = cy.$(':selected').first().id();
    const viewport = cy.nodes().length && renderedView === filter ? { zoom: cy.zoom(), pan: { ...cy.pan() } } : null;
    renderedView = filter;
    graphRevision = data.revision;

    // Update Metrics
    document.getElementById('metric-pages').innerText = data.stats.pagesCount;
    document.getElementById('metric-states').innerText = data.stats.sectionsCount;
    document.getElementById('metric-transitions').innerText = data.stats.linksCount;
    document.getElementById('metric-elements').innerText = data.stats.actionsCount;
    document.getElementById('metric-workflows').innerText = data.stats.linkedPagesCount;

    replaceElements(data.elements);
    applyLayout(Boolean(viewport));
    if (viewport) cy.viewport(viewport);
    const selected = cy.getElementById(previous || '');
    if (selected.length) inspectItem(selected.select());
    else resetInspector();
    if (filter === 'pages') {
      const pending = data.stats.linkedPagesCount;
      setViewStatus(`${data.stats.pagesCount} attempted pages · ${cy.edges().length} routes. Select a page to highlight its routes.${pending ? ' Unopened links are in the inspector.' : ''}`);
    } else {
      setViewStatus('Scroll to zoom, drag the canvas to pan, and select a section to inspect its actions.');
    }
  } catch (err) {
    if (request === graphRequest && studioRun) document.getElementById('studio-source-status').textContent = err.message;
    console.error('Fetch graph error:', err);
  }
}

function updateStudioStatus({ stage, message = 'Saved walkthrough graph' }) {
  const status = document.getElementById('studio-source-status');
  if (status.textContent !== message) appendLog(stage === 'failed' ? 'error' : 'info', message);
  status.textContent = message;
  if (stage === 'exploring') studioGraphTimer = setTimeout(fetchGraphData, 1200);
  if (stage === 'planning' || stage === 'recording') studioGraphTimer = setTimeout(pollStudioStatus, 1200);
}

async function pollStudioStatus() {
  const request = graphRequest;
  try {
    const response = await fetch(studioEndpoint);
    if (!response.ok) throw new Error('Could not load walkthrough status.');
    const status = await response.json();
    if (request === graphRequest) updateStudioStatus(status);
  } catch (error) {
    if (request === graphRequest) document.getElementById('studio-source-status').textContent = error.message;
  }
}

function decodedUrl(value) {
  try { return decodeURIComponent(value); } catch {
    return value.replace(/(?:%[\da-f]{2})+/gi, encoded => new URLSearchParams('url=' + encoded).get('url'));
  }
}

function replaceElements(elements) {
  cy.batch(() => {
    cy.elements().remove();
    cy.add(elements);
  });
}

function setViewStatus(message) {
  document.getElementById('graph-view-status').textContent = message;
}

// 5. Apply Selected Layout
function applyLayout(preserveViewport = false) {
  forceWorker?.terminate();
  forceWorker = undefined;
  const layoutName = document.getElementById('select-layout').value;
  if (layoutName === 'cose' && cy.nodes().length) {
    const worker = new Worker('/force-layout.js');
    forceWorker = worker;
    const viewport = { pan: { ...cy.pan() }, zoom: cy.zoom() };
    worker.onmessage = ({ data }) => {
      if (forceWorker !== worker) return;
      worker.terminate();
      forceWorker = undefined;
      cy.batch(() => {
        for (const { id, position } of data) cy.getElementById(id).position(position);
      });
      if (!preserveViewport && cy.zoom() === viewport.zoom && cy.pan().x === viewport.pan.x && cy.pan().y === viewport.pan.y) centerGraph();
    };
    worker.onerror = () => {
      if (forceWorker !== worker) return;
      worker.terminate();
      forceWorker = undefined;
      setViewStatus('Force layout could not finish. Choose another graph layout.');
    };
    worker.postMessage([
      ...cy.nodes().map(n => ({ data: { id: n.id(), width: n.width(), height: n.height() }, position: n.position() })),
      ...cy.edges().map(e => ({ data: { id: e.id(), source: e.source().id(), target: e.target().id() } }))
    ]);
    return;
  }
  if (layoutName === 'breadthfirst') {
    if (renderedView === 'pages') {
      layoutPageMap();
      centerGraph();
      return;
    }
    // Top-down flow: Page -> entry state -> next screens, like a user journey
    const roots = cy.nodes('.node-page').filter(n => n.data('depth') === 0);
    cy.layout({
      name: 'breadthfirst',
      directed: true,
      roots: roots.length ? roots : undefined,
      spacingFactor: 1,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      animate: false,
      fit: false
    }).run();
    centerGraph();
    return;
  }
  const layout = cy.layout({
    name: layoutName,
    animate: false,
    fit: false,
    idealEdgeLength: 100,
    nodeOverlap: 20
  });
  layout.run();
  centerGraph();
}

function layoutPageMap() {
  const columns = Math.max(1, Math.floor((cy.width() - 64) / 198));
  const visited = cy.nodes().sort((a, b) => a.data('depth') - b.data('depth'));
  const ranks = new Map();
  visited.forEach(page => {
    const depth = page.data('depth');
    if (!ranks.has(depth)) ranks.set(depth, []);
    ranks.get(depth).push(page);
  });
  let row = 0;
  cy.batch(() => {
    for (const pages of ranks.values()) {
      for (let offset = 0; offset < pages.length; offset += columns) {
        const group = pages.slice(offset, offset + columns);
        group.forEach((page, index) => page.position({
          x: (index - (group.length - 1) / 2) * 198,
          y: row * 117
        }));
        row++;
      }
    }
  });
}

function centerGraph() {
  if (!cy.nodes().length) return;
  cy.fit(cy.elements(), 32);
  if (cy.zoom() > 1) {
    cy.zoom(1);
    cy.center();
  } else if (cy.zoom() < 0.75) {
    const root = cy.nodes('.node-page').filter(node => node.data('depth') === 0).first();
    cy.zoom(0.75);
    cy.center(root.length ? root : cy.nodes().first());
  }
}

function resetInspector() {
  inspectorRequest++;
  document.getElementById('inspector-title').textContent = 'Entity Inspector';
  document.getElementById('inspector-badge').textContent = 'Select Node';
  document.getElementById('inspector-content').innerHTML =
    '<p class="placeholder-text">Select a node or link to see its details.</p>';
}

// 6. Inspect Node or Edge
async function inspectItem(item) {
  const request = ++inspectorRequest;
  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const data = item.data();
  const isNode = item.isNode();

  const titleEl = document.getElementById('inspector-title');
  const badgeEl = document.getElementById('inspector-badge');
  const contentEl = document.getElementById('inspector-content');

  if (isNode) {
    titleEl.innerText = data.type || 'Node';
    badgeEl.innerText = data.type === 'Page' ? decodedUrl(data.id) : data.id;

    let html = `
      <div class="detail-row">
        <div class="detail-label">Name / Label</div>
        <div class="detail-val">${escapeHtml(data.label || 'N/A')}</div>
      </div>
    `;

    const row = (label, value) => `<div class="detail-row"><div class="detail-label">${label}</div><div class="detail-val">${value}</div></div>`;
    if (data.type === 'Page') {
      html += row('URL', escapeHtml(decodedUrl(data.url)));
      html += row('Status', data.crawled ? escapeHtml(data.status === 'ok' ? 'Opened and read' : data.status === 'bot-check' ? 'Blocked by a bot-protection check (not bypassed)' : `Could not open: ${data.error || ''}`) : 'Linked from a crawled page, not opened (limit reached)');
      html += row('Link hops from start', escapeHtml(data.depth));
      if (data.hasScreenshot) html += row('Screenshot', `<img class="screenshot-preview" src="/api/graph/pages/screenshot?id=${encodeURIComponent(data.id)}" alt="Page screenshot" />`);
    } else if (data.type === 'Section') {
      html += row('Role', escapeHtml(data.role) + (data.hidden ? ' (in the page but not visible, e.g. a closed dialog)' : ''));
      html += row('Summary', escapeHtml(data.summary));
      html += row('Actions', `${data.actionCount}${data.totalActions > data.actionCount ? ` shown (${data.totalActions} found; repeated links grouped)` : ''}`);
    } else if (data.type === 'Action') {
      html += row('Type', escapeHtml(data.actionType) + (data.inputType ? ` (${escapeHtml(data.inputType)})` : ''));
      html += row('Selector', escapeHtml(data.selector));
      if (data.href) html += row('Goes to', escapeHtml(decodedUrl(data.href)) + (data.external ? ' (other site)' : ''));
      if (data.groupSize) html += row('Repeated', `Stands for ${data.groupSize} similar links`);
      html += row('Visible on load', data.visible ? 'Yes' : 'No (e.g. inside a closed menu)');
    }

    contentEl.innerHTML = html;
    if (!['Page', 'Section'].includes(data.type)) return;
    const details = document.createElement('div');
    details.textContent = 'Loading details…';
    contentEl.append(details);
    try {
      const pageId = data.type === 'Page' ? data.id : data.pageId;
      const response = await fetch(graphEndpoint + '/page?id=' + encodeURIComponent(pageId));
      if (!response.ok) throw new Error('Could not load page details.');
      const page = await response.json();
      if (request !== inspectorRequest) return;
      if (data.type === 'Section') {
        const actions = page.actions.filter(a => a.sectionId === data.id);
        details.textContent = actions.length ? 'What a visitor can do here' : 'No actions';
        if (actions.length) details.append(graphList(actions, a =>
          a.type + (a.inputType ? ' (' + a.inputType + ')' : '') + ': ' + a.label + (a.groupSize ? ' ×' + a.groupSize : '') +
          (a.href ? ' → ' + decodedUrl(a.href) : '') + (a.external ? ' (other site)' : '')));
      } else {
        details.textContent = 'Sections (' + page.sections.length + ')';
        details.append(graphList(page.sections, s => s.role + ': ' + s.name + ' (' + s.actionCount + ' actions)'));
        const links = renderedView === 'pages' ? page.links.filter(link => !link.opened) : [];
        if (links.length) {
          const outgoing = document.createElement('details');
          outgoing.className = 'inspector-links';
          const summary = document.createElement('summary');
          summary.textContent = links.length + ' discovered links to unopened pages';
          outgoing.append(summary);
          outgoing.addEventListener('toggle', () => {
            if (outgoing.open && !summary.nextElementSibling) outgoing.append(graphList(links, l => l.label + ' → ' + decodedUrl(l.url)));
          });
          details.append(outgoing);
        }
      }
    } catch (error) {
      if (request === inspectorRequest) details.textContent = error.message;
    }

  } else {
    titleEl.innerText = data.type === 'NAVIGATES_TO' ? 'Link to page' : 'Contains';
    badgeEl.innerText = data.type;
    const list = Array.isArray(data.actions) ? data.actions.map(a => `- ${escapeHtml(a)}`).join('<br>') : escapeHtml(data.label || '');
    contentEl.innerHTML = `
      <div class="detail-row"><div class="detail-label">From</div><div class="detail-val">${escapeHtml(cy.getElementById(data.source).data('label') || data.source)}</div></div>
      <div class="detail-row"><div class="detail-label">To</div><div class="detail-val">${escapeHtml(cy.getElementById(data.target).data('label') || data.target)}</div></div>
      ${data.type === 'NAVIGATES_TO' ? `<div class="detail-row"><div class="detail-label">Links</div><div class="detail-val">${list}</div></div>` : ''}
    `;
  }
}

// 7. Verify Neo4j Status
async function checkNeo4jStatus() {
  const pill = document.getElementById('neo4j-status-pill');
  const text = document.getElementById('neo4j-status-text');
  try {
    const res = await fetch('/api/neo4j/status');
    const data = await res.json();
    if (data.connected) {
      pill.className = 'status-pill status-connected';
      text.innerText = `Neo4j Connected (${data.version})`;
    } else {
      pill.className = 'status-pill status-disconnected';
      text.innerText = 'Neo4j Offline (Bolt:7687)';
    }
  } catch {
    pill.className = 'status-pill status-disconnected';
    text.innerText = 'Neo4j Offline';
  }
}

// 8. Event Listeners
function setupEventListeners() {
  // Start Crawl
  document.getElementById('btn-start-crawl').addEventListener('click', async () => {
    const startUrl = document.getElementById('input-url').value;
    const maxStates = document.getElementById('input-max-states').value;
    const maxDepth = document.getElementById('input-max-depth').value;
    const captureScreenshots = document.getElementById('check-screenshots').checked;
    const headless = document.getElementById('check-headless').checked;

    setCrawlerRunning(true);
    appendLog('info', `Starting crawl of ${startUrl} (links only; nothing is clicked or submitted)...`);

    try {
      const res = await fetch('/api/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startUrl, maxPages: maxStates, maxDepth, headless, captureScreenshots })
      });
      const data = await res.json();
      if (data.error) {
        appendLog('error', data.error);
        setCrawlerRunning(false);
      }
    } catch (err) {
      appendLog('error', String(err));
      setCrawlerRunning(false);
    }
  });

  // Stop Crawl
  document.getElementById('btn-stop-crawl').addEventListener('click', async () => {
    await fetch('/api/crawl/stop', { method: 'POST' });
    setCrawlerRunning(false);
  });

  // Sync to Neo4j
  document.getElementById('btn-sync-neo4j').addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-neo4j');
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Syncing...';
    try {
      const res = await fetch('/api/neo4j/sync', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`Graph database sync done in ${data.stats.durationMs}ms\n\n` +
          `- Pages: ${data.stats.pagesCount} (+${data.stats.linkedPagesCount} linked)\n` +
          `- Sections: ${data.stats.sectionsCount}\n` +
          `- Actions: ${data.stats.actionsCount}\n` +
          `- Page links: ${data.stats.linksCount}`);
      } else {
        alert(`Neo4j Sync Notice: ${data.error}\n\nTip: You can download the .cypher file via "Export Cypher" anytime.`);
      }
    } catch (err) {
      alert(`Sync Error: ${err}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>🔄</span> Sync to Neo4j';
      checkNeo4jStatus();
    }
  });

  // Export Cypher
  document.getElementById('btn-export-cypher').addEventListener('click', () => {
    window.location.href = '/api/neo4j/cypher';
  });

  // Filter mode change
  document.getElementById('select-filter-mode').addEventListener('change', fetchGraphData);

  // Layout change
  document.getElementById('select-layout').addEventListener('change', () => applyLayout());

  // Fit Viewport
  document.getElementById('btn-fit-graph').addEventListener('click', centerGraph);

  // Log drawer toggle
  const logDrawer = document.getElementById('log-drawer');
  const logHeader = document.getElementById('log-header');
  const logToggleIcon = document.getElementById('log-toggle-icon');
  logHeader.addEventListener('click', () => {
    logDrawer.classList.toggle('collapsed');
    logToggleIcon.innerText = logDrawer.classList.contains('collapsed') ? '▼' : '▲';
  });
}

function setCrawlerRunning(running) {
  document.getElementById('btn-start-crawl').style.display = running ? 'none' : 'flex';
  document.getElementById('btn-stop-crawl').style.display = running ? 'flex' : 'none';
}

function appendLog(type, message) {
  const container = document.getElementById('log-container');
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString();
  line.innerText = `[${time}] ${message}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}
