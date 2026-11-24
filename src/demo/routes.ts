import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { SectionCrawler } from '../sections/sectionCrawler.js';
import { SectionGraph } from '../sections/sectionGraph.js';
import { demoHtml } from './interactive.js';
import type { PlanResult } from './planner.js';
import { planWithGroq } from './groqPlanner.js';
import { recordWalkthrough } from './recorder.js';

const router = Router();
const output = path.resolve('.demo-runs');
const runId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
interface Run {
  id: string;
  stage: 'exploring' | 'planning' | 'recording' | 'complete' | 'failed';
  message: string;
  stats?: ReturnType<SectionGraph['stats']>;
  coverage?: ReturnType<SectionGraph['getModel']>['coverage'];
  shots?: { title: string; section?: string; nextPage: boolean; click?: string; caption?: string }[];
  plan?: Omit<PlanResult, 'shots'>;
  graph: SectionGraph;
  revision: number;
}
let latest: Run | undefined;

function runStatus({ graph, ...status }: Run) {
  return status;
}

async function savedFile<T>(id: string, file: string): Promise<T | undefined> {
  if (!runId.test(id)) return undefined;
  try {
    return JSON.parse(await readFile(path.join(output, id, file), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function createDemo(run: Run, url: string, prompt: string, maxPages: number, maxDepth: number, requireFullCoverage: boolean) {
  const directory = path.join(output, run.id);
  const graph = run.graph;
  const channel = process.env.CRAWLER_BROWSER_CHANNEL;
  const crawler = new SectionCrawler({
    startUrl: url, maxPages, maxDepth, browserChannel: channel, navigationAttempts: 1, readOnly: true, buttonPagination: true, probeClicks: true
  }, graph);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    run.message = 'Exploration time limit reached. Using the pages collected so far.';
    void crawler.stop();
  }, 240000);
  let error: string | undefined;
  crawler.on('crawler_event', event => {
    if (event.type === 'log') run.message = event.data.message;
    if (event.type === 'error') error = event.data.error;
    if (event.type === 'page_crawled') {
      run.revision++;
      run.stats = graph.stats();
    }
  });
  try {
    await crawler.start();
  } finally {
    clearTimeout(timer);
    run.revision++;
  }
  const model = graph.getModel();
  run.stats = graph.stats();
  run.coverage = model.coverage;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'graph.json'), JSON.stringify(model, null, 2), 'utf8');
  if (error) throw new Error(error);
  const failed = Object.values(model.pages).filter(page => page.status === 'error' || page.status === 'bot-check');
  if (requireFullCoverage && (timedOut || run.coverage?.reason !== 'frontier exhausted' || run.coverage.remaining || failed.length)) {
    const reason = timedOut ? 'time limit' : failed[0]?.error || run.coverage?.reason || 'crawl interrupted';
    throw new Error(`Incomplete graph (${reason}). ${run.stats.linkedPagesCount} discovered pages pending, ${failed.length} failed. Recording requires full coverage.`);
  }
  run.stage = 'planning';
  run.message = 'Choosing the story of the video from the explored graph';
  const { shots, ...plan } = await planWithGroq(model, prompt);
  run.plan = plan;
  run.shots = shots.map(shot => ({ title: shot.page.title, section: shot.section?.name, nextPage: shot.arrival?.next ?? false, click: shot.interaction?.label, caption: shot.caption }));
  await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  run.stage = 'recording';
  run.message = `Recording ${shots.length} steps (plan by ${plan.by})`;
  const scenes = await recordWalkthrough(shots, crawler, directory, channel);
  await writeFile(path.join(directory, 'interactive.html'), demoHtml(scenes), 'utf8');
}

async function finishRun(run: Run, work: Promise<void>) {
  let outcome: Pick<Run, 'stage' | 'message'>;
  try {
    await work;
    outcome = { stage: 'complete', message: 'Your walkthrough is ready' };
  } catch (error) {
    outcome = { stage: 'failed', message: error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error) };
  }
  try {
    const directory = path.join(output, run.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'status.json'), JSON.stringify({ ...runStatus(run), ...outcome }), 'utf8');
  } catch (error) {
    console.error('Could not save Studio run status:', error);
  }
  Object.assign(run, outcome);
}

router.post('/runs', (req, res) => {
  if (latest && !['complete', 'failed'].includes(latest.stage)) return res.status(409).json({ error: 'A walkthrough is already running.' });
  const { url, prompt = '', maxPages = 40, maxDepth = 12, requireFullCoverage = false } = req.body ?? {};
  if (typeof requireFullCoverage !== 'boolean') return res.status(400).json({ error: 'Full coverage must be true or false.' });
  try {
    if (typeof url !== 'string' || url.length > 2048) throw new Error();
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Enter a valid HTTP or HTTPS URL without credentials.' });
  }
  if (typeof prompt !== 'string' || prompt.length > 600 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 200 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 30) {
    return res.status(400).json({ error: 'Use a prompt up to 600 characters, 1–200 pages and 0–30 link hops.' });
  }
  const run: Run = { id: randomUUID(), stage: 'exploring', message: 'Starting the browser', graph: new SectionGraph(), revision: 0 };
  latest = run;
  void finishRun(run, createDemo(run, url, prompt, maxPages, maxDepth, requireFullCoverage));
  return res.status(202).json({ id: run.id });
});

router.get('/runs/:id', async (req, res, next) => {
  try {
    const status = latest?.id === req.params.id ? runStatus(latest)
      : await savedFile<ReturnType<typeof runStatus>>(req.params.id, 'status.json');
    return status ? res.json(status) : res.sendStatus(404);
  } catch (error) { return next(error); }
});

let savedGraph: { id: string; graph: SectionGraph } | undefined;

async function loadGraph(id: string) {
  if (latest?.id === id) return latest.graph;
  if (savedGraph?.id === id) return savedGraph.graph;
  const model = await savedFile<ReturnType<SectionGraph['getModel']>>(id, 'graph.json');
  if (!model) return undefined;
  const graph = new SectionGraph();
  Object.assign(graph.getModel(), model);
  savedGraph = { id, graph };
  return graph;
}

router.get('/runs/:id/graph/page', async (req, res, next) => {
  try {
    const graph = await loadGraph(req.params.id);
    const details = graph?.pageDetails(String(req.query.id));
    return details ? res.json(details) : res.sendStatus(404);
  } catch (error) { return next(error); }
});

router.get('/runs/:id/graph', async (req, res, next) => {
  try {
    const current = latest?.id === req.params.id ? latest : undefined;
    const graph = await loadGraph(req.params.id);
    if (!graph) return res.sendStatus(404);
    const model = graph.getModel();
    const { filter } = req.query;
    if (req.query.view === 'tree') return res.json({ startUrl: model.startUrl, pages: graph.pageList() });
    if (filter === undefined) return res.json(model);
    if (filter !== 'pages' && filter !== 'sections') return res.status(400).json({ error: 'Unknown graph view.' });
    const status = current ? runStatus(current) : await savedFile<ReturnType<typeof runStatus>>(req.params.id, 'status.json');
    if (req.query.view === 'canvas') {
      const revision = String(status?.revision ?? 'saved');
      const progress = { stage: status?.stage, message: status?.message, revision };
      if (req.query.since === revision) return res.json({ ...progress, unchanged: true });
      return res.json({ ...progress, startUrl: model.startUrl, elements: graph.toCytoscape(filter), stats: graph.stats() });
    }
    return res.json({ model, elements: graph.toCytoscape(filter), stats: graph.stats(), stage: status?.stage, message: status?.message });
  } catch (error) { return next(error); }
});

router.get('/runs/:id/files/:name', (req, res) => {
  const { id, name } = req.params;
  if (!runId.test(id) || !['walkthrough.mp4', 'interactive.html', 'graph.json', 'plan.json'].includes(name)) return res.sendStatus(404);
  if (latest?.id === id && latest.stage !== 'complete') return res.sendStatus(404);
  return res.sendFile(path.join(output, id, name));
});

export default router;
