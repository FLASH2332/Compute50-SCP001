/**
 * Runs a benchmark session: every task once per variant, with the same agent, tools and model.
 *
 *   npm run bench:run                          # all 18 tasks x 2 variants (about 25-30 min on a local 9B model)
 *   npm run bench:run -- --quick               # the 9-task subset
 *   npm run bench:run -- --resume <session>    # finish an interrupted session
 *   npm run bench:run -- --tasks books-checkout,quotes-login --variants graph_base,new_graph_base
 *
 * - Variants alternate which goes first, task by task, so neither always runs on a warm model or site.
 * - Each run loads that variant's snapshot into Memgraph and starts a fresh MCP server (fresh browser).
 * - Results go to bench/results/sessions/<session>.jsonl, one line per run; `npm run bench:report` pools them.
 * - Both variants' snapshots of a site must come from the same harness code (benchHash), or the session stops.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, type AgentResult } from './agent/agent.js';
import { checkTask } from './check.js';
import { config } from './config.js';
import { snapshotPath } from './crawl.js';
import { closeDb } from './graph/db.js';
import { loadSnapshot, type Snapshot } from './graph/load.js';
import { benchHash } from './hash.js';
import { ensureServed, siteByName, stopServers } from './sites.js';
import { TASKS, type Task } from './tasks.js';

export const SESSIONS_DIR = path.resolve('bench', 'results', 'sessions');

export interface RunRecord {
  session: string; taskId: string; site: string; category: string; variant: string; order: number;
  pass: boolean; failure?: string; reasons: string[];
  stop: AgentResult['stop']; toolCalls: number; llmTurns: number; tokens: AgentResult['tokens']; ms: number;
  answer: string; finalUrl: string; tools: string[];
  model: string; commit?: string; snapshotHash?: string; benchHash: string; at: string;
}

const arg = (n: string) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (n: string) => process.argv.includes('--' + n);

function selectTasks(): Task[] {
  const ids = arg('tasks')?.split(',').map(s => s.trim());
  let list = has('quick') ? TASKS.filter(t => t.quick) : TASKS;
  if (ids) list = TASKS.filter(t => ids.includes(t.id));
  const sites = arg('sites')?.split(',');
  if (sites) list = list.filter(t => sites.includes(t.site));
  return list;
}

function readSnapshot(site: string, variant: string): Snapshot {
  const file = snapshotPath(site, variant);
  if (!fs.existsSync(file)) throw new Error(`no snapshot for ${site}/${variant}: run npm run bench:crawl-all in the ${variant} checkout`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const variants = (arg('variants') ?? 'graph_base,new_graph_base').split(',');
  const tasks = selectTasks();
  const resume = arg('resume');
  const session = resume ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (has('quick') ? '-quick' : '');
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = path.join(SESSIONS_DIR, session + '.jsonl');
  const done = new Set<string>();
  if (resume) {
    if (!fs.existsSync(file)) throw new Error(`no session ${resume} in ${SESSIONS_DIR}`);
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as RunRecord;
      done.add(`${r.taskId}|${r.variant}`);
    }
  }

  // Same harness for both variants: snapshot hashes must agree per site; the current code may differ (warn only)
  const hash = benchHash();
  const snaps = new Map<string, Snapshot>();
  for (const site of new Set(tasks.map(t => t.site))) {
    const hashes = new Set<string>();
    for (const v of variants) {
      const s = readSnapshot(site, v);
      snaps.set(`${site}|${v}`, s);
      hashes.add(s.benchHash ?? 'none');
    }
    if (hashes.size > 1) throw new Error(`${site}: the variants' snapshots were made by different harness code (${[...hashes].join(' vs ')}); re-crawl one of them`);
    if (!hashes.has(hash)) console.warn(`note: ${site} snapshots were crawled with harness ${[...hashes][0]}, the code is now ${hash} (fine if only tasks/report changed)`);
  }

  const total = tasks.length * variants.length;
  console.log(`Session ${session}: ${tasks.length} tasks x ${variants.length} variants = ${total} runs, model ${config.llm.model}${done.size ? `, ${done.size} already done` : ''}`);
  const started = Date.now();
  let n = done.size, ran = 0;
  for (const [i, task] of tasks.entries()) {
    const order = i % 2 === 0 ? variants : [...variants].reverse();
    for (const [pos, variant] of order.entries()) {
      if (done.has(`${task.id}|${variant}`)) continue;
      const snap = snaps.get(`${task.site}|${variant}`)!;
      await ensureServed(siteByName(task.site));
      await loadSnapshot(snap);
      await closeDb();
      const labels = new Map<string, string>(Object.values<any>(snap.model.actions ?? {}).map(a => [a.id, a.label]));
      const r = await runAgent(task.task);
      const v = checkTask(task, r, id => labels.get(id));
      const rec: RunRecord = {
        session, taskId: task.id, site: task.site, category: task.category, variant, order: pos,
        pass: v.pass, failure: v.failure, reasons: v.reasons,
        stop: r.stop, toolCalls: r.toolCalls, llmTurns: r.llmTurns, tokens: r.tokens, ms: r.ms,
        answer: r.answer.slice(0, 500), finalUrl: String((r.finalPage as any)?.url ?? ''), tools: r.calls.map(c => c.name),
        model: r.model, commit: snap.commit, snapshotHash: snap.benchHash, benchHash: hash, at: new Date().toISOString(),
      };
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
      // The full run (every tool call and result) for debugging a failure
      const detail = path.join(SESSIONS_DIR, session, `${task.id}.${variant}.json`);
      fs.mkdirSync(path.dirname(detail), { recursive: true });
      fs.writeFileSync(detail, JSON.stringify({ task, verdict: v, result: r }, null, 2));
      n++; ran++;
      const eta = Math.round(((Date.now() - started) / ran) * (total - n) / 60000);
      console.log(`[${n}/${total}] ${v.pass ? 'PASS' : 'FAIL'} ${task.id} @ ${variant} (${r.toolCalls} calls, ${Math.round(r.ms / 1000)} s)${v.pass ? '' : ' — ' + v.reasons.join('; ').slice(0, 160)}${total > n ? `  ~${eta} min left` : ''}`);
    }
  }
  await stopServers();
  console.log(`\nDone in ${Math.round((Date.now() - started) / 60000)} min. Results: ${path.relative(process.cwd(), file)}\nReport: npm run bench:report`);
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
