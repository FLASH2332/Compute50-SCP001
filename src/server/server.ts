import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GraphBuilder } from '../graph/graphBuilder.js';
import { PlaywrightExplorer } from '../explorer/playwrightExplorer.js';
import { Neo4jService } from '../neo4j/neo4jClient.js';
import { syncGraphToNeo4j } from '../neo4j/sync.js';
import { generateCypherScript } from '../neo4j/cypherExporter.js';
import type { CrawlerConfig, CrawlerEvent } from '../types/graph.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Global singletons
const graphBuilder = new GraphBuilder();
const neo4jService = new Neo4jService();
let activeExplorer: PlaywrightExplorer | null = null;
let crawlCompletion: Promise<void> | undefined;

// Broadcast to connected WebSocket clients
function broadcast(event: CrawlerEvent) {
  const payload = JSON.stringify(event, (key, value) => key === 'screenshotBase64' ? undefined : value);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// REST Endpoints

// 1. Get current graph data (Cytoscape JSON + domain model)
app.get('/api/graph', (req, res) => {
  const filter = (req.query.filter as 'states' | 'full' | 'workflows' | 'pages') || 'states';
  const cyElements = graphBuilder.toCytoscapeElements(filter);
  const model = graphBuilder.getModel();
  res.json({
    elements: cyElements,
    stats: {
      pagesCount: Object.keys(model.pages).length,
      statesCount: Object.keys(model.states).length,
      elementsCount: Object.keys(model.elements).length,
      transitionsCount: Object.keys(model.transitions).length,
      workflowsCount: Object.keys(model.workflows).length
    },
    model: { ...model, states: Object.fromEntries(Object.entries(model.states).map(([id, { screenshotBase64, ...state }]) => [id, state])) }
  });
});

app.get('/api/graph/states/:id/screenshot', (req, res) => {
  const image = graphBuilder.getModel().states[req.params.id]?.screenshotBase64;
  if (!image) return res.sendStatus(404);
  res.type('jpeg').send(Buffer.from(image, 'base64'));
});

// 2. Start crawler
app.post('/api/crawl/start', async (req, res) => {
  if (activeExplorer) {
    return res.status(400).json({ error: 'A crawler is already running.' });
  }

  const { startUrl, maxDepth = 3, maxStates = 20, headless = true, captureScreenshots = false, clearPrevious = true } = req.body;

  try {
    if (typeof startUrl !== 'string' || !['http:', 'https:'].includes(new URL(startUrl).protocol)) {
      throw new Error('Invalid URL');
    }
  } catch {
    return res.status(400).json({ error: 'startUrl must be an HTTP or HTTPS URL.' });
  }
  const depth = Number(maxDepth);
  const states = Number(maxStates);
  if (!Number.isSafeInteger(depth) || depth < 0 || !Number.isSafeInteger(states) || states < 1) {
    return res.status(400).json({ error: 'maxDepth must be a nonnegative integer and maxStates must be a positive integer.' });
  }

  if (clearPrevious) {
    graphBuilder.clear();
  }

  try {
    const config: CrawlerConfig = {
      startUrl,
      maxDepth: depth,
      maxStates: states,
      headless: Boolean(headless),
      captureScreenshots: captureScreenshots === true,
      browserChannel: process.env.CRAWLER_BROWSER_CHANNEL
    };

    activeExplorer = new PlaywrightExplorer(config, graphBuilder);
    activeExplorer.on('crawler_event', broadcast);
    crawlCompletion = activeExplorer.start().catch(err => {
      console.error('Explorer error:', err);
    }).finally(() => {
      activeExplorer = null;
      crawlCompletion = undefined;
    });

    res.json({ message: 'Exploration started', config });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// 3. Stop crawler
app.post('/api/crawl/stop', async (_req, res) => {
  if (activeExplorer) {
    const completion = crawlCompletion;
    await activeExplorer.stop();
    await completion;
    broadcast({
      type: 'log',
      timestamp: new Date().toISOString(),
      data: { message: 'Crawler manually stopped by user.' }
    });
    return res.json({ message: 'Crawler stopped' });
  }
  res.json({ message: 'No active crawler was running' });
});

// 4. Crawl Status
app.get('/api/crawl/status', (_req, res) => {
  res.json({ isCrawling: Boolean(activeExplorer) });
});

// 5. Neo4j Status Check
app.get('/api/neo4j/status', async (_req, res) => {
  const result = await neo4jService.verifyConnection();
  res.json(result);
});

// 6. Sync in-memory graph to Neo4j
app.post('/api/neo4j/sync', async (_req, res) => {
  const session = neo4jService.getSession();
  if (!session) {
    return res.status(503).json({ error: 'Cannot connect to Neo4j. Check NEO4J_URI in .env' });
  }

  try {
    const model = graphBuilder.getModel();
    const stats = await syncGraphToNeo4j(session, model);
    res.json({ success: true, stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  } finally {
    await session.close();
  }
});

// 7. Export Cypher script (.cypher)
app.get('/api/neo4j/cypher', (_req, res) => {
  const model = graphBuilder.getModel();
  const cypherScript = generateCypherScript(model);
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="website_graph.cypher"');
  res.send(cypherScript);
});

// Static assets
const publicDir = path.join(__dirname, '..', '..', 'src', 'public');
const testSiteDir = path.join(__dirname, '..', '..', 'test-site');

app.use(express.static(publicDir));
app.use('/demo', express.static(testSiteDir));

// Fallback to index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🌐 Web Graph Engine running at: http://localhost:${PORT}`);
  console.log(`🧪 Built-in Test Application at: http://localhost:${PORT}/demo`);
  console.log(`📊 Cytoscape.js Explorer at:     http://localhost:${PORT}`);
  console.log(`====================================================`);
});
