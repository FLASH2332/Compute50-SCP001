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
      // UIState Node
      {
        selector: '.node-state',
        style: {
          'shape': 'round-rectangle',
          'background-color': '#064e3b',
          'border-color': '#10b981',
          'width': '140px',
          'height': '42px'
        }
      },
      // Modal UIState Node
      {
        selector: '.node-state-modal',
        style: {
          'shape': 'round-diamond',
          'background-color': '#581c87',
          'border-color': '#c084fc',
          'border-width': 3,
          'width': '180px',
          'height': '56px',
          'font-weight': 'bold'
        }
      },
      // Element Node
      {
        selector: '.node-element',
        style: {
          'shape': 'ellipse',
          'background-color': '#78350f',
          'border-color': '#fbbf24',
          'width': '40px',
          'height': '40px',
          'font-size': '9px'
        }
      },
      // Edges: Transitions
      {
        selector: '.edge-transition-action',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'line-color': '#64748b',
          'target-arrow-color': '#64748b',
          'width': 2,
          'label': 'data(label)',
          'font-size': '10px',
          'color': '#cbd5e1',
          'text-background-color': '#0f172a',
          'text-background-opacity': 0.9,
          'text-background-padding': '2px'
        }
      },
      {
        selector: '.edge-transition-nav',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'line-color': '#38bdf8',
          'target-arrow-color': '#38bdf8',
          'width': 3,
          'label': 'data(label)',
          'font-size': '10px',
          'color': '#7dd3fc',
          'text-background-color': '#0f172a',
          'text-background-opacity': 0.9,
          'text-background-padding': '2px'
        }
      },
      // Edge: Page -> State Containment
      {
        selector: '.edge-containment',
        style: {
          'line-style': 'dashed',
          'line-color': '#334155',
          'target-arrow-shape': 'none',
          'width': 1
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

    case 'state_discovered':
      appendLog('state', `State: ${evt.data.state.name} (${evt.data.state.id})`);
      fetchGraphData(); // Refresh Cytoscape with incremental node
      break;

    case 'transition_discovered':
      appendLog('transition', `Transition: ${evt.data.transition.description}`);
      fetchGraphData();
      break;

    case 'workflow_detected':
      appendLog('workflow', `Workflow: ${evt.data.name} (${evt.data.stepCount} steps)`);
      fetchGraphData();
      break;

    case 'complete':
      appendLog('workflow', `✓ Exploration complete! Total: ${evt.data.totalStates} states, ${evt.data.totalTransitions} transitions`);
      setCrawlerRunning(false);
      fetchGraphData();
      break;

    case 'error':
      appendLog('error', `Error: ${evt.data.error}`);
      setCrawlerRunning(false);
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
    document.getElementById('metric-states').innerText = data.stats.statesCount;
    document.getElementById('metric-transitions').innerText = data.stats.transitionsCount;
    document.getElementById('metric-elements').innerText = data.stats.elementsCount;
    document.getElementById('metric-workflows').innerText = data.stats.workflowsCount;

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
    const roots = cy.nodes('.node-page').filter(n => n.indegree(false) === 0);
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

    if (data.type === 'Page') {
      html += `
        <div class="detail-row">
          <div class="detail-label">Path</div>
          <div class="detail-val">${escapeHtml(data.path)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">URL</div>
          <div class="detail-val">${escapeHtml(data.url)}</div>
        </div>
      `;
    } else if (data.type === 'UIState') {
      html += `
        <div class="detail-row">
          <div class="detail-label">Is Modal / Dialog</div>
          <div class="detail-val">${data.isModal ? 'Yes (' + (escapeHtml(data.modalTitle || 'Active')) + ')' : 'No'}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Interactive Elements</div>
          <div class="detail-val">${data.elementCount || 0} discovered</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Exploration coverage</div>
          <div class="detail-val">${data.coverage || 'discovered'}</div>
        </div>
        ${data.inPlaceActions ? `<div class="detail-row">
          <div class="detail-label">In-place actions (stay on this screen)</div>
          <div class="detail-val">${data.inPlaceActions.map(a => `• ${String(a).replace(/</g, '&lt;')}`).join('<br>')}</div>
        </div>` : ''}
        <div class="detail-row">
          <div class="detail-label">Active Landmarks</div>
          <div class="detail-val">${data.activeLandmarks?.length ? escapeHtml(data.activeLandmarks.join(', ')) : 'None'}</div>
        </div>
      `;

      if (data.hasScreenshot) {
        html += `
          <div class="detail-row">
            <div class="detail-label">State Screenshot Preview</div>
            <img class="screenshot-preview" src="/api/graph/states/${encodeURIComponent(data.id)}/screenshot" alt="State Preview" />
          </div>
        `;
      }
    } else if (data.type === 'Element') {
      html += `
        <div class="detail-row">
          <div class="detail-label">Type & Tag</div>
          <div class="detail-val">&lt;${escapeHtml(data.tag)}&gt; (${escapeHtml(data.elementType)})</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Playwright Selector</div>
          <div class="detail-val">${escapeHtml(data.selector)}</div>
        </div>
      `;
    }

    contentEl.innerHTML = html;
  } else {
    // Edge / Transition
    titleEl.innerText = data.type === 'LINKS_TO' ? 'Page link' : 'Transition';
    badgeEl.innerText = data.actionType || (data.type === 'LINKS_TO' ? 'Link' : 'Action');

    contentEl.innerHTML = `
      <div class="detail-row">
        <div class="detail-label">Description</div>
        <div class="detail-val">${escapeHtml(data.description || data.label || 'Transition')}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Action Type</div>
        <div class="detail-val">${escapeHtml(data.actionType || (data.type === 'LINKS_TO' ? 'Link' : 'CLICK'))}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">From State</div>
        <div class="detail-val">${escapeHtml(data.source)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">To State</div>
        <div class="detail-val">${escapeHtml(data.target)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">URL Changed</div>
        <div class="detail-val">${data.urlChanged ? 'Yes' : 'No (Dynamic In-Page State)'}</div>
      </div>
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
    appendLog('info', `Starting exploration of ${startUrl}...`);

    try {
      const res = await fetch('/api/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startUrl, maxStates, maxDepth, headless, captureScreenshots })
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
        alert(`Neo4j Sync Succeeded in ${data.stats.durationMs}ms!\n\n` +
          `- Pages: ${data.stats.pagesSynced}\n` +
          `- UIStates: ${data.stats.statesSynced}\n` +
          `- Elements: ${data.stats.elementsSynced}\n` +
          `- Transitions: ${data.stats.transitionsSynced}\n` +
          `- Workflows: ${data.stats.workflowsSynced}`);
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
