import fs from 'node:fs';
import path from 'node:path';
import { AppMap, urlTemplate } from '../core/appMap.js';
import type { MapSource, Services } from '../core/ports.js';
import { exploreInteractions, classifyRisk, linkEdges } from '../explore/interact.js';
import { checkTimeline, type Finding } from '../media/check.js';
import { renderTimeline } from '../media/render.js';
import { cutSegments, layout, PRESETS, saveTimeline, zoomKeys, type Preset, type Timeline, type TimelineShot } from '../media/timeline.js';
import { voiceShot, voiceTimeline, type LineContext } from '../media/voice.js';
import { ChangeLog } from '../nav/changes.js';
import { Gate } from '../nav/gate.js';
import { modeFor } from '../nav/risk.js';
import type { Flow } from '../plan/flows.js';
import { planDemo } from '../plan/planner.js';
import { approveStoryboard, buildStoryboard, type Storyboard } from '../plan/storyboard.js';
import { AutoApprover } from '../providers/approvers.js';
import { SilentSpeech } from '../providers/speech.js';
import { closeRunner, recordBest, type RunnerEnv, type Take } from '../record/runner.js';

export type Phase = 'plan' | 'sample' | 'style' | 'record' | 'assemble' | 'review' | 'done';

export interface RunOptions {
  takes: number;
  headless: boolean;
  extras: boolean;
  browserChannel?: string;
  storageState?: string;
  resetUrl?: string;
}

export interface RunState {
  runId: string;
  goal: string;
  audience: string;
  seconds: number;
  phase: Phase;
  style?: Preset['name'];
  version: number;
  takes: Record<string, Take>;
  findings: Finding[];
  notes: string[];
  options: RunOptions;
}

/** One demo run, saved under runs/<runId>/ (state, map, flows, storyboard, takes, timelines, out/). */
export class Run {
  state!: RunState;
  map!: AppMap;
  flows: Flow[] = [];
  storyboard?: Storyboard;
  changes: ChangeLog;

  constructor(public dir: string) {
    fs.mkdirSync(path.join(dir, 'takes'), { recursive: true });
    this.changes = new ChangeLog(path.join(dir, 'changes.jsonl'));
  }
  p(file: string) { return path.join(this.dir, file); }
  read<T>(file: string): T { return JSON.parse(fs.readFileSync(this.p(file), 'utf8')); }
  write(file: string, data: unknown) { fs.writeFileSync(this.p(file), JSON.stringify(data, null, 2)); }

  static open(dir: string): Run {
    if (!fs.existsSync(path.join(dir, 'state.json'))) throw new Error(`No demo run at ${dir}`);
    const r = new Run(dir);
    r.state = r.read('state.json');
    r.map = AppMap.load(r.p('map.json'));
    if (fs.existsSync(r.p('flows.json'))) r.flows = r.read('flows.json');
    if (fs.existsSync(r.p('storyboard.json'))) r.storyboard = r.read('storyboard.json');
    return r;
  }

  save() {
    this.write('state.json', this.state);
    this.map.save(this.p('map.json'));
    this.write('flows.json', this.flows);
    if (this.storyboard) this.write('storyboard.json', this.storyboard);
  }

  lineContexts(): Map<string, LineContext> {
    const steps = new Map(this.flows.flatMap(f => f.steps).map(s => [s.id, s]));
    const title = (id: string) => { const s = this.map.states[id]; return s ? (s.dialog ? `${s.title} with "${s.dialog}" open` : s.title) : ''; };
    const out = new Map<string, LineContext>();
    const shots = this.storyboard?.shots || [];
    shots.forEach((s, i) => {
      const st = s.stepIds.map(id => steps.get(id)!).filter(Boolean);
      out.set(s.id, { intent: s.intent, title: s.title === 'Intro' ? s.chapter : s.title, steps: st, before: title(s.startState), after: title(st[st.length - 1]?.to || s.startState), audience: this.state.audience, isIntro: !s.flowId, isLast: i === shots.length - 1, targetSec: s.targetSec });
    });
    return out;
  }

  /** Timeline shots from takes; shots without a passing take are left out (and reported by review). */
  buildTimeline(preset: Preset, shotIds?: string[]): { tl: Timeline; skipped: string[] } {
    const shots: TimelineShot[] = [];
    const skipped: string[] = [];
    for (const s of this.storyboard!.shots) {
      if (shotIds && !shotIds.includes(s.id)) continue;
      const take = this.state.takes[s.id];
      if (!take?.ok) { skipped.push(s.id); continue; }
      const segments = cutSegments(take, preset);
      shots.push({ shotId: s.id, title: s.title, chapter: s.chapter, stepIds: s.stepIds, take: take.video, takeAttempt: take.attempt, segments, zooms: zoomKeys(take, preset, segments), hold: 0, outStart: 0, outDuration: 0 });
    }
    return { tl: layout({ version: 0, style: preset.name, createdAt: new Date().toISOString(), shots, duration: 0 }), skipped };
  }

  review(tl: Timeline, skipped: string[]): Finding[] {
    const f = checkTimeline(tl, this.state.takes, this.map);
    for (const id of skipped) {
      const t = this.state.takes[id];
      const missing = t?.missing?.map(a => this.map.controls[a]?.label).filter(Boolean);
      f.push({ rule: 'passing_take', shotId: id, message: missing?.length ? `left out: ${missing.map(m => `"${m}"`).join(', ')} is missing from the app; the flow is marked broken` : `left out: no passing take (${t?.error || 'not recorded'})` });
    }
    return f;
  }
}

export interface AgentConfig {
  services?: Partial<Services>;
  runsDir?: string;
  headless?: boolean;
  browserChannel?: string;
  storageState?: string;   // Playwright storage state of the seeded demo account
  resetUrl?: string;       // GET before each take to reset demo data
}

export interface MakeInput {
  /** The site. With a store, the saved map for this URL's origin is used when there is one. */
  url?: string;
  /** A ready AppMap, or a source that builds one when the store has none. */
  map?: AppMap | MapSource;
  /** Ignore the saved map and build a new one. */
  rebuild?: boolean;
  goal: string;
  audience?: string;
  seconds?: number;
  style?: Preset['name'];   // skip the style question
  takes?: number;           // takes per shot; the cleanest is kept
  extras?: boolean;         // srt/vtt, gif, chapters, stills (default true)
  deepen?: boolean;         // run the safe-click explorer on top of the map (default true)
}

export interface MakeResult { runId: string; dir: string; mp4?: string; findings: Finding[]; notes: string[] }

const newRunId = (goal: string) => {
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'demo';
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${slug}`;
};

/**
 * The demo agent: Plan → Sample → Pick style → Record → Assemble → Review.
 * It depends only on an AppMap and the ports in core/ports.ts; graph
 * sources plug in through adapters, people through an Approver.
 */
export class DemoAgent {
  readonly services: Services;
  readonly runsDir: string;

  constructor(private cfg: AgentConfig = {}) {
    const s = cfg.services || {};
    this.services = { speech: s.speech || new SilentSpeech(), approver: s.approver || new AutoApprover(), hooks: s.hooks || {}, log: s.log || console.log, llm: s.llm, vision: s.vision, store: s.store };
    this.runsDir = cfg.runsDir || 'runs';
  }

  private get log() { return this.services.log; }

  runDir(runId: string) { return path.join(this.runsDir, runId); }

  env(run: Run): RunnerEnv {
    const o = run.state.options;
    const mode = modeFor(run.map.startUrl);
    return {
      runDir: run.dir, map: run.map, changes: run.changes, flows: run.flows,
      gate: new Gate(new Set(run.storyboard?.approved ? run.storyboard.approvedActions : []), new Set(), mode),
      headless: o.headless, browserChannel: o.browserChannel, storageState: o.storageState, resetUrl: o.resetUrl,
      log: this.log, hooks: this.services.hooks, llm: this.services.llm, vision: this.services.vision
    };
  }

  /** Builds (or takes) the map, then runs every phase. */
  async make(input: MakeInput): Promise<MakeResult> {
    const runId = newRunId(input.goal);
    const run = new Run(this.runDir(runId));
    run.state = {
      runId, goal: input.goal, audience: input.audience || '', seconds: input.seconds || 60, phase: 'plan', style: input.style, version: 0, takes: {}, findings: [], notes: [],
      options: { takes: input.takes || 1, headless: this.cfg.headless ?? true, extras: input.extras ?? true, browserChannel: this.cfg.browserChannel, storageState: this.cfg.storageState, resetUrl: this.cfg.resetUrl }
    };
    run.map = await this.getMap(input);
    run.save();
    return this.continue(run);
  }

  /**
   * The map for this run: a given AppMap; else the store's saved map for the
   * site; else build one from the source, deepen it, save it to the store and
   * read it back (the store is the source of truth).
   */
  private async getMap(input: MakeInput): Promise<AppMap> {
    if (input.map instanceof AppMap) return this.prepare(input.map, input.deepen);
    const store = this.services.store;
    const url = input.url || '';
    if (store && url && !input.rebuild) {
      const saved = await store.find(url);
      if (saved) {
        this.log(`Using the saved map of ${new URL(url).origin} from ${store.name}: ${Object.keys(saved.pages).length} pages, ${Object.keys(saved.states).length} UI states`);
        return saved;
      }
      this.log(`No saved map for ${new URL(url).origin} in ${store.name}; building one`);
    }
    if (!input.map) throw new Error('No map: give a map source, or a store that has this site.');
    const built = await this.prepare(await input.map(this.log), input.deepen);
    if (!store) return built;
    await store.save(built);
    this.log(`Saved the map to ${store.name}`);
    return (await store.find(built.startUrl)) || built;
  }

  private async prepare(map: AppMap, deepen = true): Promise<AppMap> {
    if (!Object.keys(map.pages).length) throw new Error('The map has no pages (the site could not be crawled).');
    classifyRisk(map);
    if (deepen) {
      const r = await exploreInteractions(map, { browserChannel: this.cfg.browserChannel, storageState: this.cfg.storageState, hooks: this.services.hooks, log: this.log });
      this.log(`Map: ${Object.keys(map.pages).length} pages, ${r.states} UI states, ${r.edges} actions between them (source: ${map.data.source})`);
    } else linkEdges(map);
    return map;
  }

  /** Continues a saved run from the phase it stopped in. */
  async resume(runId: string): Promise<MakeResult> {
    const run = Run.open(this.runDir(runId));
    this.log(`Resuming ${runId} at phase "${run.state.phase}"`);
    return this.continue(run);
  }

  private async continue(run: Run): Promise<MakeResult> {
    const s = run.state;
    const { llm, approver } = this.services;
    const env = this.env(run);
    let mp4: string | undefined;
    try {
      if (s.phase === 'plan') {
        const startTpl = urlTemplate(run.map.startUrl);
        const plan = await planDemo(run.map, s.goal, s.audience, s.seconds, llm);
        if (!plan.flows.length) throw new Error('Could not plan a demo for this request from the map (no matching pages, sections, searches or flows).');
        run.flows = plan.flows;
        const start = run.map.baseStateOf(startTpl) || run.map.states[plan.flows[0].startState];
        run.storyboard = buildStoryboard(s.goal, s.audience, s.seconds, plan.flows, run.map, start.id);
        run.storyboard.why = `${plan.why} (${plan.by === 'llm' ? 'planned by the LLM' : 'keyword rules'})`;
        await approveStoryboard(run.storyboard, run.flows, approver, llm, this.log);
        s.phase = 'sample';
        run.save();
      }
      const sb = run.storyboard!;
      const freshEnv = () => Object.assign(env, { gate: this.env(run).gate, flows: run.flows });
      const deps = { speech: this.services.speech, llm };

      if (s.phase === 'sample') {
        const opening = sb.shots.slice(0, 2);
        for (const shot of opening) {
          this.log(`Recording ${shot.id} (${shot.title})`);
          s.takes[shot.id] = await recordBest(freshEnv(), shot, s.options.takes);
        }
        const ids = opening.filter(x => s.takes[x.id]?.ok).map(x => x.id);
        if (!s.style && ids.length) {
          const samples: { name: Preset['name']; file: string }[] = [];
          for (const p of Object.values(PRESETS)) {
            const { tl } = run.buildTimeline(p, ids);
            await voiceTimeline(tl, run.lineContexts(), p, run.dir, deps);
            const r = await renderTimeline(run.dir, tl, { name: `sample-${p.name}` });
            samples.push({ name: p.name, file: r.mp4 });
            this.log(`Style sample "${p.name}": ${r.mp4} (${r.duration.toFixed(1)}s)`);
          }
          s.style = await approver.style(samples);
        }
        s.phase = 'style';
        run.save();
      }
      if (s.phase === 'style') {
        s.style ??= 'calm';
        this.log(`Style: ${s.style}`);
        s.phase = 'record';
        run.save();
      }
      if (s.phase === 'record') {
        for (const shot of sb.shots) {
          if (s.takes[shot.id]?.ok) continue;
          this.log(`Recording ${shot.id} (${shot.title})`);
          s.takes[shot.id] = await recordBest(freshEnv(), shot, s.options.takes);
          run.save();
        }
        s.phase = 'assemble';
        run.save();
      }
      if (s.phase === 'assemble' || s.phase === 'review') {
        const preset = PRESETS[s.style || 'calm'];
        const { tl, skipped } = run.buildTimeline(preset);
        if (!tl.shots.length) throw new Error('No shot has a passing take; nothing to assemble.');
        s.notes = await voiceTimeline(tl, run.lineContexts(), preset, run.dir, deps);
        tl.version = 1;
        let findings = run.review(tl, skipped);
        // One automatic fix round: re-voice shots with timing or label problems
        const fixable = new Set(findings.filter(f => f.shotId && f.rule !== 'passing_take').map(f => f.shotId!));
        if (fixable.size) {
          this.log(`Review found ${findings.length} issue(s); re-voicing ${[...fixable].join(', ')}`);
          const ctx = run.lineContexts();
          for (const sh of tl.shots) if (fixable.has(sh.shotId)) {
            const labelIssue = findings.some(f => f.shotId === sh.shotId && f.rule === 'label_match');
            const tooLong = findings.some(f => f.shotId === sh.shotId && f.rule === 'voice_fits');
            // A label problem gets the deterministic line, which uses the exact on-screen labels
            s.notes.push(...await voiceShot(sh, ctx.get(sh.shotId)!, preset, path.join(run.dir, 'voice'), run.dir, { speech: deps.speech, llm: labelIssue ? undefined : llm }, { direction: tooLong ? 'shorter' : undefined }));
          }
          layout(tl);
          findings = run.review(tl, skipped);
        }
        saveTimeline(run.dir, tl);
        s.version = 1;
        s.phase = 'review';
        run.save();
        this.log('Rendering the final video');
        const r = await renderTimeline(run.dir, tl, { extras: s.options.extras });
        mp4 = r.mp4;
        s.findings = findings;
        s.phase = 'done';
        this.log(`Done: ${r.mp4} (${r.duration.toFixed(1)}s, ${tl.shots.length} shots)`);
      }
      return { runId: s.runId, dir: run.dir, mp4, findings: s.findings, notes: s.notes };
    } finally {
      await closeRunner(env);
      run.save();
      // Learned edge stats, heals and pages found while recording go back to the store
      if (this.services.store) await this.services.store.save(run.map).catch(e => this.log(`Could not save the map to ${this.services.store!.name}: ${(e as Error).message}`));
    }
  }
}

export function createDemoAgent(cfg: AgentConfig = {}): DemoAgent {
  return new DemoAgent(cfg);
}
