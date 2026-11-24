import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { Neo4jService } from '../neo4j/neo4jClient.js';
import { SectionGraph, sectionGraphToCypher } from '../sections/sectionGraph.js';
import { SectionCrawler } from '../sections/sectionCrawler.js';
import type { SectionCrawlConfig, SectionCrawlEvent } from '../sections/types.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Global singletons
const graph = new SectionGraph();
const neo4jService = new Neo4jService();
// Result of the most recent crawl, so a failed start is visible via /api/crawl/status
let lastCrawl: { startUrl: string; startedAt: string; status: 'running' | 'completed' | 'failed' | 'stopped'; error?: string } | null = null;
let activeExplorer: SectionCrawler | null = null;
let crawlCompletion: Promise<void> | undefined;

// Broadcast to connected WebSocket clients
function broadcast(event: SectionCrawlEvent) {
  const payload = JSON.stringify(event, (key, value) => key === 'screenshotBase64' ? undefined : value);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// REST Endpoints

// 1. Get current graph data (Cytoscape JSON + section model, screenshots left out)
app.get('/api/graph', (req, res) => {
  const filter = (req.query.filter as 'sections' | 'actions' | 'pages') || 'sections';
  const model = graph.getModel();
  res.json({
    elements: graph.toCytoscape(filter),
    stats: graph.stats(),
    model: { ...model, pages: Object.fromEntries(Object.entries(model.pages).map(([id, { screenshotBase64, ...p }]) => [id, p])) }
  });
});

app.get('/api/graph/pages/screenshot', (req, res) => {
  const image = graph.getModel().pages[String(req.query.id)]?.screenshotBase64;
  if (!image) return res.sendStatus(404);
  res.type('jpeg').send(Buffer.from(image, 'base64'));
});

// 2. Start crawler
app.post('/api/crawl/start', async (req, res) => {
  if (activeExplorer) {
    return res.status(400).json({ error: 'A crawler is already running.' });
  }

  const { startUrl, maxDepth = 2, maxPages = 10, headless = true, captureScreenshots = false } = req.body;

  try {
    if (typeof startUrl !== 'string' || !['http:', 'https:'].includes(new URL(startUrl).protocol)) {
      throw new Error('Invalid URL');
    }
  } catch {
    return res.status(400).json({ error: 'startUrl must be an HTTP or HTTPS URL.' });
  }
  const depth = Number(maxDepth);
  const pages = Number(maxPages);
  if (!Number.isSafeInteger(depth) || depth < 0 || !Number.isSafeInteger(pages) || pages < 1) {
    return res.status(400).json({ error: 'maxDepth must be a nonnegative integer and maxPages must be a positive integer.' });
  }

  try {
    const config: SectionCrawlConfig = {
      startUrl,
      maxDepth: depth,
      maxPages: pages,
      headless: Boolean(headless),
      captureScreenshots: captureScreenshots === true,
      browserChannel: process.env.CRAWLER_BROWSER_CHANNEL
    };
    graph.clear(startUrl);

    activeExplorer = new SectionCrawler(config, graph);
    lastCrawl = { startUrl, startedAt: new Date().toISOString(), status: 'running' };
    activeExplorer.on('crawler_event', broadcast);
    activeExplorer.on('crawler_event', (event: SectionCrawlEvent) => {
      if (!lastCrawl) return;
      if (event.type === 'error') {
        lastCrawl.status = 'failed';
        lastCrawl.error = (event.data as any)?.error;
      } else if (event.type === 'complete' && lastCrawl.status !== 'failed') {
        lastCrawl.status = 'completed';
      }
    });
    crawlCompletion = activeExplorer.start().catch(err => {
      console.error('Explorer error:', err);
    }).finally(() => {
      activeExplorer = null;
      crawlCompletion = undefined;
    });

    res.json({ message: 'Crawl started', config });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// 3. Stop crawler
app.post('/api/crawl/stop', async (_req, res) => {
  if (activeExplorer) {
    const completion = crawlCompletion;
    await activeExplorer.stop();
    if (lastCrawl && lastCrawl.status === 'running') lastCrawl.status = 'stopped';
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
  res.json({ isCrawling: Boolean(activeExplorer), lastCrawl });
});

// 5. Neo4j Status Check
app.get('/api/neo4j/status', async (_req, res) => {
  const result = await neo4jService.verifyConnection();
  res.json(result);
});

// 6. Write the section graph to the graph database (Neo4j or Memgraph, via Bolt)
app.post('/api/neo4j/sync', async (_req, res) => {
  const session = neo4jService.getSession();
  if (!session) {
    return res.status(503).json({ error: 'Cannot connect to the graph database. Check NEO4J_URI in .env' });
  }
  const started = Date.now();
  try {
    const statements = sectionGraphToCypher(graph.getModel()).split('\n').filter(l => l.trim() && !l.startsWith('//'));
    for (const statement of statements) await session.run(statement);
    res.json({ success: true, stats: { ...graph.stats(), statements: statements.length, durationMs: Date.now() - started } });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  } finally {
    await session.close();
  }
});

// 7. Export Cypher script (.cypher)
app.get('/api/neo4j/cypher', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="website_sections.cypher"');
  res.send(sectionGraphToCypher(graph.getModel()));
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
