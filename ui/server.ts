/**
 * Demo Agent UI — a small web front end for src/agent/: one site graph (Memgraph), two agents
 * (make a demo, ask a question).
 *
 *   npx tsx ui/server.ts            → http://localhost:4300
 *
 * It only imports the agent's public pieces (index.ts + adapters) and plugs a
 * web Approver into the agent's Approver port, so the storyboard and style
 * questions are answered in the page instead of on the terminal.
 * Nothing outside ui/ is changed.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express, { type Response } from 'express';
import { appMapFromGraphFile, crawlSource, sectionGraphHooks } from '../src/agent/adapters/sectionGraph.js';
import { GraphDbStore } from '../src/agent/adapters/graphDbStore.js';
import { AutoApprover, createDemoAgent, createOnboardingAgent, editDemo, listVersions, servicesFromEnv, undoDemo, type Approver, type DemoAgent } from '../src/agent/index.js';
import { ensureMap } from '../src/agent/core/mapProvider.js';
import { PRESETS } from '../src/agent/media/timeline.js';
import { allowedHosts, modeFor } from '../src/agent/nav/risk.js';

// ── Environment ──────────────────────────────────────────────────────────────
// Keys stay on the server. The nearest .env walking up from the working
// directory is loaded (a git worktree finds the main checkout's .env).
function loadEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const f = path.join(dir, '.env');
    if (fs.existsSync(f)) { dotenv.config({ path: f, quiet: true } as dotenv.DotenvConfigOptions); return f; }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
const envFile = loadEnv();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.UI_PORT || 4300);
const RUNS_DIR = path.resolve(process.env.UI_RUNS_DIR || 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

function hasExe(cmd: string): Promise<boolean> {
  return new Promise(resolve => execFile(cmd, ['-version'], { windowsHide: true, timeout: 8000 }, err => resolve(!err)));
}

// ── Jobs (one at a time: the agent drives one browser) ──────────────────────
type Pending =
  | { kind: 'storyboard'; text: string; round: number }
  | { kind: 'style'; samples: { name: 'fast' | 'calm'; url: string }[] };

interface Job {
  id: string;
  kind: 'make' | 'resume' | 'edit' | 'undo' | 'graph' | 'ask';
  label: string;
  runId?: string;
  status: 'running' | 'waiting' | 'done' | 'error';
  phase: string;
  logs: string[];
  pending?: Pending;
  answer?: (a: string) => void;
  cancel?: (e: Error) => void;
  result?: unknown;
  error?: string;
  startedAt: number;
  clients: Set<Response>;
}

const jobs = new Map<string, Job>();
let active: Job | null = null;

function send(job: Job, event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of job.clients) c.write(msg);
}
const snapshot = (j: Job) => ({ id: j.id, kind: j.kind, label: j.label, runId: j.runId, status: j.status, phase: j.phase, pending: j.pending, result: j.result, error: j.error, startedAt: j.startedAt });
function update(job: Job, patch: Partial<Job>) { Object.assign(job, patch); send(job, 'state', snapshot(job)); }
function log(job: Job, line: string) {
  job.logs.push(line);
  if (job.logs.length > 5000) job.logs.splice(0, 1000);
  send(job, 'log', line);
  console.log(`[${job.id}] ${line}`);
}

const mediaUrl = (file: string) => '/media/' + path.relative(RUNS_DIR, path.resolve(file)).split(path.sep).map(encodeURIComponent).join('/');

/** Approver port implemented by the page: each question waits for an answer posted from the UI. */
class WebApprover implements Approver {
  private round = 0;
  constructor(private job: Job, private reviewStoryboard: boolean, private fixedStyle?: 'fast' | 'calm') {}
  private ask(p: Pending): Promise<string> {
    return new Promise((resolve, reject) => {
      update(this.job, { status: 'waiting', pending: p });
      this.job.answer = a => { this.job.answer = undefined; this.job.cancel = undefined; update(this.job, { status: 'running', pending: undefined }); resolve(a); };
      this.job.cancel = e => { this.job.answer = undefined; this.job.cancel = undefined; reject(e); };
    });
  }
  async storyboard(text: string): Promise<string> {
    if (!this.reviewStoryboard) { log(this.job, 'Storyboard auto-approved'); return 'approve'; }
    return this.ask({ kind: 'storyboard', text, round: ++this.round });
  }
  async style(samples: { name: 'fast' | 'calm'; file: string }[]): Promise<'fast' | 'calm'> {
    if (this.fixedStyle) return this.fixedStyle;
    const a = await this.ask({ kind: 'style', samples: samples.map(s => ({ name: s.name, url: mediaUrl(s.file) })) });
    return a === 'fast' ? 'fast' : 'calm';
  }
}

/** Watches runs/ for the run dir this job creates and mirrors state.json's phase. */
function watchPhase(job: Job, before: Set<string>) {
  const t = setInterval(() => {
    try {
      if (!job.runId) {
        const fresh = fs.readdirSync(RUNS_DIR).filter(d => !before.has(d) && fs.statSync(path.join(RUNS_DIR, d)).isDirectory());
        if (fresh.length) update(job, { runId: fresh.sort().pop() });
      }
      if (job.runId) {
        const f = path.join(RUNS_DIR, job.runId, 'state.json');
        if (fs.existsSync(f)) {
          const phase = JSON.parse(fs.readFileSync(f, 'utf8')).phase as string;
          if (phase && phase !== job.phase && job.status !== 'done' && job.status !== 'error') update(job, { phase });
        }
      }
    } catch { /* state.json mid-write; next tick */ }
  }, 800);
  return () => clearInterval(t);
}

function startJob(kind: Job['kind'], label: string, body: (job: Job) => Promise<unknown>, runId?: string): Job {
  const watch = kind !== 'graph' && kind !== 'ask';   // graph builds and answers make no demo run folder
  const job: Job = { id: Math.random().toString(36).slice(2, 10), kind, label, runId, status: 'running', phase: kind === 'make' ? 'map' : kind, logs: [], startedAt: Date.now(), clients: new Set() };
  jobs.set(job.id, job);
  active = job;
  const before = new Set(fs.readdirSync(RUNS_DIR));
  const stop = watch ? watchPhase(job, before) : () => {};
  body(job).then(
    result => { stop(); update(job, { status: 'done', phase: 'done', result, pending: undefined }); },
    err => { stop(); const m = err instanceof Error ? err.message : String(err); log(job, `Error: ${m}`); update(job, { status: 'error', error: m, pending: undefined }); }
  ).finally(() => { if (active === job) active = null; });
  return job;
}

function makeAgent(job: Job, approver: Approver, o: { headed?: boolean; storageState?: string; store?: GraphDbStore }): DemoAgent {
  return createDemoAgent({
    services: { ...servicesFromEnv(), store: o.store, approver, hooks: sectionGraphHooks, log: m => log(job, m) },
    runsDir: RUNS_DIR,
    headless: !o.headed,
    browserChannel: process.env.CRAWLER_BROWSER_CHANNEL,
    storageState: o.storageState || undefined,
    resetUrl: process.env.DEMO_RESET_URL
  });
}

const relRun = (r: { mp4?: string; [k: string]: unknown }) => ({ ...r, mp4Url: r.mp4 ? mediaUrl(r.mp4) : undefined });

/** The narration style guide for the next job (one job runs at a time); empty = the bundled guide. */
const BASE_STYLE = process.env.NARRATION_STYLE_FILE;
function setNarrationStyle(file: unknown): string | undefined {
  const f = String(file || '').trim();
  if (f && !fs.existsSync(f)) return `Narration style file not found: ${f}`;
  if (f) process.env.NARRATION_STYLE_FILE = f;
  else if (BASE_STYLE) process.env.NARRATION_STYLE_FILE = BASE_STYLE;
  else delete process.env.NARRATION_STYLE_FILE;
}

const DEFAULT_DB = process.env.NEO4J_URI || 'bolt://localhost:7687';
async function dbUp(uri = DEFAULT_DB): Promise<boolean> {
  const s = new GraphDbStore({ uri });
  try { await s.check(); return true; } catch { return false; } finally { await s.close(); }
}
/** The store a request asks for: its bolt:// URI, or none for an in-memory map. */
function storeFor(b: { store?: string; storeUri?: string }): { store?: GraphDbStore; error?: string } {
  if (b.store !== 'graph') return {};
  const uri = String(b.storeUri || DEFAULT_DB).trim();
  if (!/^(bolt|neo4j)(\+s|\+ssc)?:\/\//.test(uri)) return { error: 'Give a bolt:// URI for the graph database.' };
  return { store: new GraphDbStore({ uri }) };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(HERE, 'public')));
app.use('/media', express.static(RUNS_DIR, { fallthrough: false }));

const clampInt = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const busy = (res: Response) => res.status(409).json({ error: `Another job is running (${active!.label}). Wait for it to finish.`, jobId: active!.id });
const validRunId = (id: string) => /^[\w.-]+$/.test(id) && fs.existsSync(path.join(RUNS_DIR, id, 'state.json'));

/** What this agent supports, and what this machine has (booleans only, never key values). */
app.get('/api/options', async (_req, res) => {
  const ffmpeg = await hasExe(process.env.FFMPEG_PATH || 'ffmpeg');
  const claudeLlm = (process.env.AGENT_LLM || '').toLowerCase() === 'claude';
  res.json({
    styles: Object.values(PRESETS),
    defaults: { seconds: 60, takes: 1, pages: 20, extras: true, deepen: true, review: true, headed: false, rebuild: false },
    env: {
      envFile: !!envFile,
      llm: claudeLlm || !!process.env.GROQ_API_KEY, llmProvider: claudeLlm ? 'Claude Code' : process.env.GROQ_API_KEY ? 'Groq' : null,
      llmModel: claudeLlm ? `claude ${process.env.CLAUDE_MODEL || 'sonnet'}` : process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || 'openai/gpt-oss-20b') : null,
      vision: !!(process.env.GROQ_API_KEY && process.env.GROQ_VISION_MODEL),
      voice: process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'silent',
      ffmpeg,
      allowHosts: allowedHosts(),
      resetUrl: !!process.env.DEMO_RESET_URL,
      graphDb: { uri: DEFAULT_DB, up: await dbUp() },
      graphLlm: !!process.env.LLM_BASE_URL
    },
    active: active ? snapshot(active) : null
  });
});

app.get('/api/mode', (req, res) => {
  try { res.json({ mode: modeFor(String(req.query.url)) }); } catch { res.json({ mode: null }); }
});

/** Start a new demo: agent.make(). */
app.post('/api/runs', async (req, res) => {
  if (active) return busy(res);
  const b = req.body || {};
  const url = String(b.url || '').trim();
  const goal = String(b.goal || '').trim();
  try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { return res.status(400).json({ error: 'Enter a full http(s) URL.' }); }
  if (!goal) return res.status(400).json({ error: 'Say what the demo should show.' });
  const style = b.style === 'fast' || b.style === 'calm' ? b.style : undefined;   // undefined → render both samples and ask
  const seconds = clampInt(b.seconds, 10, 600, 60);
  const takes = clampInt(b.takes, 1, 5, 1);
  const pages = clampInt(b.pages, 1, 200, 20);
  const graphFile = String(b.graphFile || '').trim();
  const styleErr = setNarrationStyle(b.narrationStyle);
  if (styleErr) return res.status(400).json({ error: styleErr });
  if (graphFile && !fs.existsSync(graphFile)) return res.status(400).json({ error: `Graph file not found: ${graphFile}` });
  const storeUri = b.store === 'graph' ? String(b.storeUri || '').trim() : '';
  if (b.store === 'graph' && !/^(bolt|neo4j)(\+s|\+ssc)?:\/\//.test(storeUri)) return res.status(400).json({ error: 'Give a bolt:// URI for the graph database.' });
  if (!style && !(await hasExe(process.env.FFMPEG_PATH || 'ffmpeg'))) return res.status(400).json({ error: 'Comparing style samples needs FFmpeg to render them. Pick Fast or Calm, or install FFmpeg.' });

  const job = startJob('make', goal, async job => {
    let store: GraphDbStore | undefined;
    if (storeUri) { store = new GraphDbStore({ uri: storeUri }); await store.check(); log(job, `Graph store: ${store.name}`); }
    else log(job, 'Graph store: none (the map is built in memory for this run)');
    log(job, `Site mode: ${modeFor(url)}${modeFor(url) === 'public' ? ' (links, tabs, dialogs, search boxes only)' : ' (forms and approved submits allowed)'}`);
    try {
      const agent = makeAgent(job, new WebApprover(job, b.review !== false, style), { headed: !!b.headed, storageState: b.storageState, store });
      const map = graphFile ? appMapFromGraphFile(graphFile) : crawlSource(url, { maxPages: pages, browserChannel: process.env.CRAWLER_BROWSER_CHANNEL });
      const r = await agent.make({
        url, map, rebuild: !!b.rebuild, goal, audience: String(b.audience || ''), seconds, style, takes,
        extras: b.extras !== false, deepen: b.deepen !== false
      });
      return relRun(r as never);
    } finally { await store?.close(); }
  });
  res.json(snapshot(job));
});

/** Continue a run that stopped (e.g. failed render after FFmpeg was installed): agent.resume(). */
app.post('/api/runs/:runId/resume', (req, res) => {
  if (active) return busy(res);
  const { runId } = req.params;
  if (!validRunId(runId)) return res.status(404).json({ error: 'No such run.' });
  const job = startJob('resume', `resume ${runId}`, async job => {
    const agent = makeAgent(job, new WebApprover(job, true), { headed: !!req.body?.headed });
    return relRun(await agent.resume(runId) as never);
  }, runId);
  res.json(snapshot(job));
});

/** Edit by request ("shorten the intro"): editDemo(). */
app.post('/api/runs/:runId/edit', (req, res) => {
  if (active) return busy(res);
  const { runId } = req.params;
  const request = String(req.body?.request || '').trim();
  if (!validRunId(runId)) return res.status(404).json({ error: 'No such run.' });
  if (!request) return res.status(400).json({ error: 'Say what to change, e.g. "shorten the intro".' });
  const job = startJob('edit', `edit: ${request}`, async job => relRun(await editDemo(makeAgent(job, new AutoApprover('calm', false), {}), runId, request) as never), runId);
  res.json(snapshot(job));
});

/** Undo the last edit: undoDemo(). */
app.post('/api/runs/:runId/undo', (req, res) => {
  if (active) return busy(res);
  const { runId } = req.params;
  if (!validRunId(runId)) return res.status(404).json({ error: 'No such run.' });
  const job = startJob('undo', `undo ${runId}`, async job => relRun(await undoDemo(makeAgent(job, new AutoApprover('calm', false), {}), runId) as never), runId);
  res.json(snapshot(job));
});

/** Answer the pending storyboard / style question. */
app.post('/api/jobs/:id/answer', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.answer) return res.status(409).json({ error: 'Nothing is waiting for an answer.' });
  const answer = String(req.body?.answer || '').trim();
  if (!answer) return res.status(400).json({ error: 'Empty answer.' });
  log(job, `You: ${answer}`);
  job.answer(answer);
  res.json({ ok: true });
});

/** Cancel while the agent is waiting on a question (the agent has no mid-recording cancel). */
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.cancel) return res.status(409).json({ error: 'The job can only be cancelled while it waits for your answer.' });
  job.cancel(new Error('Cancelled from the UI'));
  res.json({ ok: true });
});

/** Live job events (Server-Sent Events): a snapshot, then log lines and state changes. */
app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot(job), logs: job.logs })}\n\n`);
  job.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); job.clients.delete(res); });
});

/** Past runs in runs/. */
app.get('/api/runs', (_req, res) => {
  const list = fs.readdirSync(RUNS_DIR).filter(validRunId).map(id => {
    const s = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'state.json'), 'utf8'));
    const mp4 = path.join(RUNS_DIR, id, 'out', 'demo.mp4');
    let url = '';
    try { url = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'map.json'), 'utf8')).startUrl || ''; } catch {}
    return { runId: id, goal: s.goal, url, phase: s.phase, style: s.style, version: s.version, seconds: s.seconds, video: fs.existsSync(mp4), mtime: fs.statSync(path.join(RUNS_DIR, id, 'state.json')).mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
  res.json(list);
});

/** One run: state, storyboard, takes, outputs, versions. */
app.get('/api/runs/:runId', (req, res) => {
  const { runId } = req.params;
  if (!validRunId(runId)) return res.status(404).json({ error: 'No such run.' });
  const dir = path.join(RUNS_DIR, runId);
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return undefined; } };
  const state = read('state.json');
  const storyboard = read('storyboard.json');
  const outDir = path.join(dir, 'out');
  const outputs: { name: string; url: string }[] = [];
  const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (!/\.(ffmeta|ass|filter\.txt)$/.test(f)) outputs.push({ name: path.relative(outDir, p).replace(/\\/g, '/'), url: mediaUrl(p) }); } };
  walk(outDir);
  const titles = new Map<string, string>((storyboard?.shots || []).map((s: { id: string; title: string }) => [s.id, s.title]));
  const takes = Object.values(state.takes || {}).map((t: any) => ({ shotId: t.shotId, title: titles.get(t.shotId) || '', ok: t.ok, score: t.score, error: t.error, attempt: t.attempt, url: mediaUrl(path.join(dir, t.video)) }));
  let versions: unknown[] = [];
  try { versions = listVersions({ runDir: (id: string) => path.join(RUNS_DIR, id) } as DemoAgent, runId); } catch {}
  let url = '';
  try { url = read('map.json')?.startUrl || ''; } catch {}
  const mp4 = path.join(outDir, 'demo.mp4');
  res.json({ runId, url, state: { goal: state.goal, audience: state.audience, seconds: state.seconds, phase: state.phase, style: state.style, version: state.version, findings: state.findings, notes: state.notes, options: state.options },
    storyboard, takes, outputs, versions, video: fs.existsSync(mp4) ? mediaUrl(mp4) + `?v=${state.version}-${fs.statSync(mp4).mtimeMs}` : null });
});

// ── One site graph ───────────────────────────────────────────────────────────

/** What the database knows about a site: pages, areas, UI states, the profile. */
app.get('/api/graph', async (req, res) => {
  const url = String(req.query.url || '');
  try { new URL(url); } catch { return res.status(400).json({ error: 'Enter a full http(s) URL.' }); }
  const { store, error } = storeFor({ store: 'graph', storeUri: String(req.query.storeUri || '') });
  if (!store) return res.status(400).json({ error });
  try {
    const map = await store.find(url);
    if (!map) return res.json({ exists: false, store: store.name });
    const pages = Object.values(map.pages);
    const top = pages.filter(p => p.rank !== undefined).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 5).map(p => p.title.split(/\s+[|\-–·]\s+/)[0]);
    res.json({ exists: true, store: store.name, purpose: map.app?.purpose, pages: pages.length, controls: Object.keys(map.controls).length,
      states: Object.keys(map.states).length, edges: Object.keys(map.edges).length,
      areas: Object.values(map.areas).map(a => ({ name: a.name, pages: a.pageIds.length })), top });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : String(e) });
  } finally { await store.close(); }
});

/** Build (or rebuild) the site's graph into the database: ensureMap() with the crawler. Both agents then reuse it. */
app.post('/api/graph', (req, res) => {
  if (active) return busy(res);
  const b = req.body || {};
  const url = String(b.url || '').trim();
  try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { return res.status(400).json({ error: 'Enter a full http(s) URL.' }); }
  const { store, error } = storeFor({ store: 'graph', storeUri: b.storeUri });
  if (!store) return res.status(400).json({ error });
  const job = startJob('graph', `graph for ${new URL(url).host}`, async job => {
    try {
      await store.check();
      const { map, from } = await ensureMap({ url, map: crawlSource(url, { maxPages: clampInt(b.pages, 1, 200, 20), browserChannel: process.env.CRAWLER_BROWSER_CHANNEL }), rebuild: b.rebuild !== false, deepen: b.deepen !== false },
        { store, hooks: sectionGraphHooks, log: m => log(job, m), browserChannel: process.env.CRAWLER_BROWSER_CHANNEL }, true);
      return { from, pages: Object.keys(map.pages).length, areas: Object.keys(map.areas).length, states: Object.keys(map.states).length };
    } finally { await store.close(); }
  });
  res.json(snapshot(job));
});

// ── Ask (onboarding agent) ───────────────────────────────────────────────────

/** Answer a question about the site: steps, plus a short clip of the way there. */
app.post('/api/ask', (req, res) => {
  if (active) return busy(res);
  const b = req.body || {};
  const url = String(b.url || '').trim();
  const question = String(b.question || '').trim();
  try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { return res.status(400).json({ error: 'Enter a full http(s) URL.' }); }
  if (!question) return res.status(400).json({ error: 'Type a question.' });
  const { store, error } = storeFor(b);
  if (error) return res.status(400).json({ error });
  const styleErr = setNarrationStyle(b.narrationStyle);
  if (styleErr) return res.status(400).json({ error: styleErr });
  const job = startJob('ask', question, async job => {
    try {
      if (store) await store.check();
      const agent = createOnboardingAgent({ services: { ...servicesFromEnv(), store, hooks: sectionGraphHooks, log: m => log(job, m) }, runsDir: RUNS_DIR, headless: !b.headed, browserChannel: process.env.CRAWLER_BROWSER_CHANNEL });
      const r = await agent.ask({ url, question, from: String(b.from || '').trim() || undefined, clip: b.clip !== false,
        map: crawlSource(url, { maxPages: clampInt(b.pages, 1, 200, 20), browserChannel: process.env.CRAWLER_BROWSER_CHANNEL }) });
      return { ...r, clipUrl: r.clip ? mediaUrl(r.clip.file) : undefined };
    } finally { await store?.close(); }
  });
  res.json(snapshot(job));
});

/** The demand list: questions people asked, newest first, with whether they were answered. */
app.get('/api/questions', (_req, res) => {
  const f = path.join(RUNS_DIR, 'questions.jsonl');
  const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
  res.json(lines.slice(-100).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
});

app.get('/api/active', (_req, res) => res.json(active ? snapshot(active) : null));

app.listen(PORT, () => {
  console.log(`Demo Agent UI: http://localhost:${PORT}`);
  console.log(`Runs folder: ${RUNS_DIR}${envFile ? '' : '  (no .env found; offline fallbacks)'}`);
});
