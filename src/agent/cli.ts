/**
 * Composition root: wires the agent to the section-graph adapter and the
 * env providers. The agent itself never imports from here.
 */
import dotenv from 'dotenv';
import { appMapFromGraphFile, crawlSource, sectionGraphHooks } from './adapters/sectionGraph.js';
import { GraphDbStore } from './adapters/graphDbStore.js';
import { AutoApprover, CliApprover, createDemoAgent, editDemo, listVersions, servicesFromEnv, undoDemo } from './index.js';

dotenv.config();

const USAGE = `Usage:
  npm run agent -- <url> "<goal>" [--audience "new admin"] [--seconds 60] [--yes] [--style fast|calm]
                   [--rebuild] [--no-db] [--graph <graph.json>] [--takes 3] [--pages 20] [--no-deepen] [--no-extras] [--headed]
  npm run agent -- resume <runId>
  npm run agent -- edit <runId> "<request>"         e.g. "shorten the intro"
  npm run agent -- undo <runId>
  npm run agent -- versions <runId>

Graph: the site's map lives in Memgraph/Neo4j (NEO4J_URI, default bolt://localhost:7687). The first run for a site
crawls it and saves the graph; later runs reuse it. --rebuild crawls again, --no-db skips the database,
--graph uses a saved section graph file (e.g. .demo-runs/<id>/graph.json from the studio).

Sites: hosts in DEMO_ALLOW_HOSTS (default localhost) run in full mode (forms, approved submits). Any other
site runs in public mode: links, tabs, dialogs and search boxes only; nothing else is typed or submitted.

Optional keys: GROQ_API_KEY (+GROQ_MODEL, GROQ_VISION_MODEL), ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID.`;

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (['yes', 'no-extras', 'no-deepen', 'headed', 'help', 'rebuild', 'no-db'].includes(key) || next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { flags, pos };
}

function report(findings: { rule: string; shotId?: string; message: string }[]) {
  if (!findings.length) { console.log('\nChecks: all passed'); return; }
  console.log(`\nChecks: ${findings.length} issue(s)`);
  for (const f of findings) console.log(`  [${f.rule}] ${f.shotId ? f.shotId + ': ' : ''}${f.message}`);
}

async function main() {
  const { flags, pos } = parse(process.argv.slice(2));
  if (flags.help || !pos.length) { console.log(USAGE); return; }
  const style = flags.style ? String(flags.style) : undefined;
  if (style && style !== 'fast' && style !== 'calm') throw new Error('--style must be fast or calm');
  const store = flags['no-db'] ? undefined : new GraphDbStore();
  const agent = createDemoAgent({
    services: { ...servicesFromEnv(), store, approver: flags.yes ? new AutoApprover((style as 'fast' | 'calm') || 'calm') : new CliApprover(), hooks: sectionGraphHooks },
    runsDir: String(flags['runs-dir'] || 'runs'),
    headless: !flags.headed,
    browserChannel: process.env.CRAWLER_BROWSER_CHANNEL,
    storageState: flags['storage-state'] ? String(flags['storage-state']) : undefined,
    resetUrl: process.env.DEMO_RESET_URL
  });

  try { await run(agent, flags, pos, style); } finally { await store?.close(); }
}

async function run(agent: ReturnType<typeof createDemoAgent>, flags: Record<string, string | boolean>, pos: string[], style?: string) {
  const [cmd, a1, a2] = pos;
  if (cmd === 'resume') return report((await agent.resume(a1)).findings);
  if (cmd === 'edit') { if (!a2) throw new Error('Say what to change, e.g. "shorten the intro"'); return report((await editDemo(agent, a1, a2)).findings); }
  if (cmd === 'undo') { await undoDemo(agent, a1); return; }
  if (cmd === 'versions') { for (const v of listVersions(agent, a1)) console.log(`${v.current ? '*' : ' '} v${v.version}  ${v.duration.toFixed(1)}s  ${v.note}`); return; }

  const [url, goal] = pos;
  if (!goal) { console.log(USAGE); process.exitCode = 1; return; }
  const map = flags.graph ? appMapFromGraphFile(String(flags.graph)) : crawlSource(url, { maxPages: Number(flags.pages || 20), browserChannel: process.env.CRAWLER_BROWSER_CHANNEL });
  const r = await agent.make({
    url, map, rebuild: !!flags.rebuild, goal, audience: flags.audience ? String(flags.audience) : '', seconds: Number(flags.seconds || 60), style: style as any,
    takes: Number(flags.takes || 1), extras: !flags['no-extras'], deepen: !flags['no-deepen']
  });
  report(r.findings);
  for (const n of r.notes) console.log(`note: ${n}`);
  console.log(`\nRun: ${r.runId}${r.mp4 ? `\nVideo: ${r.mp4}` : ''}`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
