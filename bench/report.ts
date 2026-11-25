/**
 * Pools every benchmark session (or the ones named) into bench/report/report.md: pass rates per variant and per
 * category, a per-task win/loss table, failure reasons, cost per run, and how each graph was built.
 *
 *   npm run bench:report
 *   npm run bench:report -- --sessions 2026-11-25T01-40-00,2026-11-25T03-10-00
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotPath } from './crawl.js';
import type { RunRecord } from './run.js';
import { SITES } from './sites.js';
import { CATEGORIES, TASKS } from './tasks.js';

const SESSIONS_DIR = path.resolve('bench', 'results', 'sessions');
const OUT = path.resolve('bench', 'report', 'report.md');
const arg = (n: string) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };

const wanted = arg('sessions')?.split(',');
const files = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl')) : [];
const allRuns: RunRecord[] = files
  .filter(f => !wanted || wanted.includes(f.replace(/\.jsonl$/, '')))
  .flatMap(f => fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as RunRecord));
if (!allRuns.length) { console.error('No benchmark runs yet: npm run bench:run'); process.exit(1); }
// Only runs made by the same harness code are comparable: by default, the harness of the latest run (--all-harness: every run)
const latestHash = [...allRuns].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!.benchHash;
const runs = process.argv.includes('--all-harness') ? allRuns : allRuns.filter(r => r.benchHash === latestHash);
const leftOut = allRuns.length - runs.length;

const variants = [...new Set(runs.map(r => r.variant))].sort();
const [A, B] = variants;
const of = (v: string, f: (r: RunRecord) => boolean = () => true) => runs.filter(r => r.variant === v && f(r));
const rate = (list: RunRecord[]) => (list.length ? `${list.filter(r => r.pass).length}/${list.length} (${Math.round((100 * list.filter(r => r.pass).length) / list.length)}%)` : '—');
const pct = (list: RunRecord[]) => (list.length ? list.filter(r => r.pass).length / list.length : NaN);
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const better = (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) ? '' : a > b ? `**${A}**` : b > a ? `**${B}**` : 'tie');
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');

const sessions = [...new Set(runs.map(r => r.session))];
const lines: string[] = [];
lines.push('# Graph variant benchmark', '');
lines.push(`${runs.length} runs from ${sessions.length} session(s) (${sessions.join(', ')}); model ${[...new Set(runs.map(r => r.model))].join(', ')}.`);
lines.push(`Same agent, tools and model for every run; only the graph differs. Variant order alternates task by task.`, '');
if (leftOut) lines.push(`${leftOut} older run(s) made with different harness code were left out (harness ${latestHash} only; --all-harness to include them).`, '');
if (variants.length !== 2) lines.push(`> Expected two variants, found: ${variants.join(', ')}`, '');

// 1. Overall
lines.push('## Overall', '');
lines.push(table(['Variant', 'Passed', 'Median time', 'Median tool calls', 'Mean tokens / run', 'Hit the budget'],
  variants.map(v => {
    const l = of(v);
    return [v, rate(l), `${Math.round(median(l.map(r => r.ms)) / 1000)} s`, median(l.map(r => r.toolCalls)),
      Math.round(l.reduce((s, r) => s + r.tokens.prompt + r.tokens.completion, 0) / l.length), l.filter(r => r.failure === 'budget').length];
  })), '');

// 2. Categories
lines.push('## By category', '', 'Where each graph is good and bad: the pass rate per kind of task.', '');
lines.push(table(['Category', A, B, 'Better'], CATEGORIES.map(c => {
  const a = of(A, r => r.category === c), b = of(B, r => r.category === c);
  return [c, rate(a), rate(b), better(pct(a), pct(b))];
})), '');

// 3. Tasks
lines.push('## By task', '');
const taskIds = [...new Set(runs.map(r => r.taskId))];
const topFailure = (l: RunRecord[]) => {
  const c = new Map<string, number>();
  for (const r of l) if (!r.pass && r.failure) c.set(r.failure, (c.get(r.failure) ?? 0) + 1);
  return [...c.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}×${n}`).join(', ');
};
lines.push(table(['Task', 'Site', 'Category', A, B, 'Better', `${A} failures`, `${B} failures`], taskIds.map(id => {
  const t = TASKS.find(x => x.id === id);
  const a = of(A, r => r.taskId === id), b = of(B, r => r.taskId === id);
  return [id, t?.site ?? '', t?.category ?? '', rate(a), rate(b), better(pct(a), pct(b)), topFailure(a), topFailure(b)];
})), '');
const wins = (x: string, y: string) => taskIds.filter(id => pct(of(x, r => r.taskId === id)) > pct(of(y, r => r.taskId === id))).length;
lines.push(`Tasks won: ${A} ${wins(A, B)}, ${B} ${wins(B, A)}, tied ${taskIds.length - wins(A, B) - wins(B, A)}.`, '');

// 4. Failure reasons
lines.push('## Why runs failed', '');
const kinds = [...new Set(runs.filter(r => !r.pass).map(r => r.failure ?? 'unknown'))].sort();
lines.push(kinds.length ? table(['Failure', ...variants], kinds.map(k => [k, ...variants.map(v => of(v, r => !r.pass && (r.failure ?? 'unknown') === k).length)])) : 'No failures.', '');
lines.push('Failure kinds: budget = out of tool calls or time; wrong-page = ended elsewhere; no-action = the click or fill did not happen;',
  'wrong-answer = answer missing something; gave-up = said NOT FOUND on a possible task; invented = did not say NOT FOUND on an impossible one.', '');
lines.push('<details><summary>Every failed run</summary>', '');
for (const r of runs.filter(x => !x.pass)) lines.push(`- \`${r.taskId}\` @ ${r.variant} (${r.session}): ${r.reasons.join('; ')}`);
lines.push('', '</details>', '');

// 5. Graph build
lines.push('## How each graph was built', '', 'Same page and hop budget for both. "Slow" = the crawl took more than 3x as long as the other variant.', '');
const rows: (string | number)[][] = [];
for (const site of SITES) {
  const snaps = variants.map(v => { const f = snapshotPath(site.name, v); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined; });
  if (snaps.every(s => !s)) continue;
  const ms = snaps.map(s => s?.metrics?.crawlMs ?? NaN);
  snaps.forEach((s, i) => {
    if (!s) return;
    const m = s.metrics ?? {};
    const acts = Object.values<any>(s.model.actions ?? {});
    const extra = (label: string) => (s.model.extraNodes ?? []).filter((n: any) => n.label === label).length;
    const other = ms[1 - i];
    rows.push([site.name, variants[i], `${m.pagesOpened}/${m.pagesKnown}`, m.actions, m.interactions, acts.filter(a => a.isTemplate).length,
      extra('Template'), extra('Area'), m.llmCalls, `${Math.round(m.crawlMs / 1000)} s${!Number.isNaN(other) && m.crawlMs > 3 * other ? ' (slow)' : ''}`, s.commit ?? '']);
  });
}
lines.push(table(['Site', 'Variant', 'Pages opened/known', 'Actions', 'Recorded clicks', 'List templates', 'URL templates', 'Areas', 'Model calls', 'Crawl time', 'Commit'], rows), '');

lines.push('## Notes', '',
  '- Small numbers: one run per task per variant per session. Pool several sessions (re-run `npm run bench:run`) before trusting a difference of one or two tasks.',
  '- Gaps both variants share (crawler code they have in common, not a graph feature): demoblaze product cards load after the',
  '  crawler decides the page is ready, and practicesoftwaretesting loads products with HTTP `QUERY` requests, which the read-only',
  '  browser blocks. Tasks on those sites mostly show that gap.',
  '- Task definitions and checks: `bench/tasks.ts`, `bench/check.ts`. Full runs (every tool call): `bench/results/sessions/<session>/`.', '');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${runs.length} runs, ${sessions.length} session(s))`);
