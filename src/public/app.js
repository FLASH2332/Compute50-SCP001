let cy = null;
let currentGraphModel = null;
let ws = null;
let eventCount = 0;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('input-url');
  if (urlInput && !urlInput.value) urlInput.value = `${location.origin}/demo`;
  initCytoscape();
  setupWebSocket();
  setupEventListeners();
  checkNeo4jStatus();
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
          'label': 'data(label)',
          'color': '#f8fafc',
          'font-size': '11px',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
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
          'height': '56px',
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
        style: { 'shape': 'round-rectangle', 'background-color': '#064e3b', 'border-color': '#10b981', 'width': '190px', 'height': '50px', 'font-size': '10px' }
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
        style: { 'shape': 'round-rectangle', 'background-color': '#78350f', 'border-color': '#fbbf24', 'border-width': 1, 'width': '130px', 'height': '28px', 'font-size': '9px', 'text-max-width': '120px' }
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
          'label': 'data(label)', 'font-size': '9px', 'color': '#7dd3fc',
          'text-background-color': '#0f172a', 'text-background-opacity': 0.9, 'text-background-padding': '2px'
        }
      },
      // Selected Highlighting
      {
        selector: 'node:selected',
        style: {
          'border-color': '#ffffff',
          'border-width': 4,
          'shadow-blur': 12,
          'shadow-color': '#38bdf8',
          'shadow-opacity': 0.8
        }
      },
      {
        selector: 'edge:selected',
        style: {
          'line-color': '#ffffff',
          'target-arrow-color': '#ffffff',
          'width': 4
        }
      }
    ]
  });

  // Node & Edge selection listener
  cy.on('tap', 'node, edge', (evt) => {
    const item = evt.target;
    inspectItem(item);
  });
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
  const filter = document.getElementById('select-filter-mode').value;
  try {
    const res = await fetch(`/api/graph?filter=${filter}`);
    const data = await res.json();
    currentGraphModel = data.model;

    // Update Metrics
    document.getElementById('metric-pages').innerText = data.stats.pagesCount;
    document.getElementById('metric-states').innerText = data.stats.sectionsCount;
    document.getElementById('metric-transitions').innerText = data.stats.linksCount;
    document.getElementById('metric-elements').innerText = data.stats.actionsCount;
    document.getElementById('metric-workflows').innerText = data.stats.linkedPagesCount;

    // Update Cytoscape Graph
    cy.elements().remove();
    cy.add(data.elements);

    // Apply layout
    applyLayout();
  } catch (err) {
    console.error('Fetch graph error:', err);
  }
}

// 5. Apply Selected Layout
function applyLayout() {
  const layoutName = document.getElementById('select-layout').value;
  if (layoutName === 'breadthfirst') {
    // Top-down flow: Page -> entry state -> next screens, like a user journey
    const start = currentGraphModel && currentGraphModel.pages ? Object.values(currentGraphModel.pages).find(p => p.depth === 0 && p.crawled) : null;
    const roots = start ? cy.getElementById(start.id) : cy.nodes('.node-page').filter(n => n.indegree(false) === 0);
    cy.layout({
      name: 'breadthfirst',
      directed: true,
      roots: roots.length ? roots : undefined,
      spacingFactor: 1.4,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      animate: true,
      animationDuration: 400,
      padding: 30,
      fit: true
    }).run();
    return;
  }
  const layout = cy.layout({
    name: layoutName,
    animate: true,
    animationDuration: 400,
    padding: 30,
    fit: true,
    idealEdgeLength: 100,
    nodeOverlap: 20
  });
  layout.run();
}

// 6. Inspect Node or Edge
function inspectItem(item) {
  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const data = item.data();
  const isNode = item.isNode();

  const titleEl = document.getElementById('inspector-title');
  const badgeEl = document.getElementById('inspector-badge');
  const contentEl = document.getElementById('inspector-content');

  if (isNode) {
    titleEl.innerText = data.type || 'Node';
    badgeEl.innerText = data.id;

    let html = `
      <div class="detail-row">
        <div class="detail-label">Name / Label</div>
        <div class="detail-val">${escapeHtml(data.label || 'N/A')}</div>
      </div>
    `;

    const row = (label, value) => `<div class="detail-row"><div class="detail-label">${label}</div><div class="detail-val">${value}</div></div>`;
    if (data.type === 'Page') {
      html += row('URL', escapeHtml(data.url));
      html += row('Status', data.crawled ? escapeHtml(data.status === 'ok' ? 'Opened and read' : data.status === 'bot-check' ? 'Blocked by a bot-protection check (not bypassed)' : `Could not open: ${data.error || ''}`) : 'Linked from a crawled page, not opened (limit reached)');
      html += row('Link hops from start', escapeHtml(data.depth));
      if (currentGraphModel && data.crawled) {
        const secs = Object.values(currentGraphModel.sections).filter(s => s.pageId === data.id).sort((a, b) => a.order - b.order);
        html += row(`Sections (${secs.length})`, secs.map(s => `- ${escapeHtml(s.role)}: ${escapeHtml(s.name)} (${s.actionCount} actions)`).join('<br>') || 'None');
      }
      if (data.hasScreenshot) html += row('Screenshot', `<img class="screenshot-preview" src="/api/graph/pages/screenshot?id=${encodeURIComponent(data.id)}" alt="Page screenshot" />`);
    } else if (data.type === 'Section') {
      html += row('Role', escapeHtml(data.role) + (data.hidden ? ' (in the page but not visible, e.g. a closed dialog)' : ''));
      html += row('Summary', escapeHtml(data.summary));
      html += row('Actions', `${data.actionCount}${data.totalActions > data.actionCount ? ` shown (${data.totalActions} found; repeated links grouped)` : ''}`);
      if (currentGraphModel) {
        const acts = Object.values(currentGraphModel.actions).filter(a => a.sectionId === data.id);
        html += row('What a visitor can do here', acts.map(a => `- ${escapeHtml(a.type)}${a.inputType ? ' (' + escapeHtml(a.inputType) + ')' : ''}: ${escapeHtml(a.label)}${a.groupSize ? ` <i>x${a.groupSize}</i>` : ''}${a.href ? ` &rarr; <span style="opacity:.7">${escapeHtml(a.href)}</span>` : ''}${a.external ? ' (other site)' : ''}`).join('<br>') || 'None');
      }
    } else if (data.type === 'Action') {
      html += row('Type', escapeHtml(data.actionType) + (data.inputType ? ` (${escapeHtml(data.inputType)})` : ''));
      html += row('Selector', escapeHtml(data.selector));
      if (data.href) html += row('Goes to', escapeHtml(data.href) + (data.external ? ' (other site)' : ''));
      if (data.groupSize) html += row('Repeated', `Stands for ${data.groupSize} similar links`);
      html += row('Visible on load', data.visible ? 'Yes' : 'No (e.g. inside a closed menu)');
    }

    contentEl.innerHTML = html;
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
  document.getElementById('select-layout').addEventListener('change', applyLayout);

  // Fit Viewport
  document.getElementById('btn-fit-graph').addEventListener('click', () => {
    cy.fit(undefined, 30);
  });

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
