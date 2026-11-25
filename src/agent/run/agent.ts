import fs from 'node:fs';
import path from 'node:path';
import { AppMap, urlTemplate } from '../core/appMap.js';
import type { MapSource, Services } from '../core/ports.js';
import { ensureMap } from '../core/mapProvider.js';
import { checkTimeline, type Finding } from '../media/check.js';
import { renderTimeline } from '../media/render.js';
import { cutSegments, layout, PRESETS, saveTimeline, zoomKeys, type Preset, type Timeline, type TimelineShot } from '../media/timeline.js';
import { voiceShot, voiceTimeline, type LineContext } from '../media/voice.js';
import { ChangeLog } from '../nav/changes.js';
import { Gate } from '../nav/gate.js';
import { modeFor } from '../nav/risk.js';
import type { Flow } from '../plan/flows.js';
import { resolveLine, WPS, writeScript, type Script } from '../media/script.js';
import { attachVoices, paceOf, pauseFor, shotSeconds, spokenBeats, synthesizeShots, type ShotVoice } from '../media/narrate.js';
import { tidy } from '../media/voice.js';
import { words } from '../media/voice.js';
import type { Speech, TextModel } from '../core/ports.js';
import { planDemo } from '../plan/planner.js';
import { approveStoryboard, buildStoryboard, type Shot, type Storyboard } from '../plan/storyboard.js';
import { AutoApprover } from '../providers/approvers.js';
import { SilentSpeech } from '../providers/speech.js';
import { closeRunner, recordBest, type RunnerEnv, type ShotPace, type Take } from '../record/runner.js';

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
  sampleTakes?: Record<string, Record<string, Take>>;   // style → opening shot → take (Compare records each style)
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
  script?: Script;            // the voice-over, written once after approval (script.json)
  voices: Record<string, Record<string, ShotVoice>> = {};   // style → shot → synthesized voice (voices.json)
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
    if (fs.existsSync(r.p('script.json'))) r.script = r.read('script.json');
    if (fs.existsSync(r.p('voices.json'))) r.voices = r.read('voices.json');
    return r;
  }

  save() {
    this.write('state.json', this.state);
    this.map.save(this.p('map.json'));
    this.write('flows.json', this.flows);
    if (this.storyboard) this.write('storyboard.json', this.storyboard);
    if (this.script) this.write('script.json', this.script);
    if (Object.keys(this.voices).length) this.write('voices.json', this.voices);
  }

  /** Writes the voice-over script once (after approval), unless the run already has one. */
  async ensureScript(llm?: TextModel, wps: number = WPS.calm): Promise<Script> {
    if (this.script) return this.script;
    const ctx = this.lineContexts();
    this.script = await writeScript((this.storyboard?.shots ?? []).map(s => ({ shotId: s.id, c: ctx.get(s.id)!, seconds: s.targetSec })), { llm, wps });
    this.write('script.json', this.script);
    return this.script;
  }

  /** The title of the result a shot opened (search answers), once it is recorded. */
  resultOf(shotId: string): string | undefined {
    const shot = this.storyboard?.shots.find(s => s.id === shotId);
    const steps = new Map(this.flows.flatMap(f => f.steps).map(st => [st.id, st]));
    return this.state.takes[shotId]?.steps.filter(r => steps.get(r.stepId)?.op === 'open_result' && shot?.stepIds.includes(r.stepId)).map(r => r.label).filter(Boolean).pop();
  }

  /**
   * Voices for these shots in this style, synthesized from the script before recording (voice first).
   * A shot whose voice runs well past its planned length gets one shorter line. A shot whose result title is
   * now known (after recording) is synthesized again with the title.
   */
  async ensureVoices(preset: Preset, ids: string[], speech: Speech, llm?: TextModel): Promise<Record<string, ShotVoice>> {
    const script = this.script!;
    const have = (this.voices[preset.name] ??= {});
    const results = Object.fromEntries(ids.map(id => [id, this.resultOf(id)]));
    const spoken = (id: string) => tidy(spokenBeats(script.shots[id], results[id]).map(b => b.text).join(' '));
    const need = ids.filter(id => script.shots[id] && (!have[id] || have[id].line !== spoken(id)));
    const kept = Object.fromEntries(need.filter(id => have[id]?.pause).map(id => [id, have[id].pause!]));
    Object.assign(have, await synthesizeShots(script, need, preset, { speech, runDir: this.dir }, results, kept));
    const ctx = this.lineContexts();
    for (const id of need) {
      const target = this.storyboard?.shots.find(x => x.id === id)?.targetSec ?? 0;
      if (!llm || !target || !have[id].duration) continue;
      // The video follows the voice, so the voice decides the shot's length. Fit it to the plan once,
      // writing for the speaking rate this voice actually has (TTS is often faster than the assumed pace).
      const measured = Math.max(1.5, words(have[id].line) / have[id].duration);
      const long = shotSeconds(have[id]) > target * 1.15;
      const short = shotSeconds(have[id]) < target * 0.8 && target - shotSeconds(have[id]) > 1.5;
      if (!long && !short) continue;
      const redo = await writeScript([{ shotId: id, c: ctx.get(id)!, seconds: target }], { llm, wps: long ? Math.min(measured, script.wps) * 0.9 : measured });
      const n = redo.shots[id] && words(redo.shots[id].line), was = words(script.shots[id].line);
      if (!n || (long ? n >= was : n <= was + 2)) continue;
      script.shots[id] = redo.shots[id];
      Object.assign(have, await synthesizeShots(script, [id], preset, { speech, runDir: this.dir }, results));
      script.notes.push(`${id}: line ${long ? 'shortened' : 'lengthened'} to fit its ${target}s (voice speaks ${measured.toFixed(1)} words/s)`);
    }
    // Still short: pause between sentences (SSML breaks) rather than pad the line with filler
    for (const id of need) {
      const target = this.storyboard?.shots.find(x => x.id === id)?.targetSec ?? 0;
      const pause = target && have[id] ? pauseFor(have[id], spokenBeats(script.shots[id], results[id]).length, target) : 0;
      if (!pause || pause === have[id].pause) continue;
      Object.assign(have, await synthesizeShots(script, [id], preset, { speech, runDir: this.dir }, results, { [id]: pause }));
    }
    this.save();
    return Object.fromEntries(ids.filter(id => have[id]).map(id => [id, have[id]]));
  }

  lineContexts(): Map<string, LineContext> {
    const steps = new Map(this.flows.flatMap(f => f.steps).map(s => [s.id, s]));
    const title = (id: string) => { const s = this.map.states[id]; return s ? (s.dialog ? `${s.title} with "${s.dialog}" open` : s.title) : ''; };
    const out = new Map<string, LineContext>();
    const shots = this.storyboard?.shots || [];
    shots.forEach((s, i) => {
      const st = s.stepIds.map(id => steps.get(id)!).filter(Boolean);
      // The script's line for this shot; a result title known only after recording replaces {result}
      const sc = this.script?.shots[s.id];
      const result = sc?.dynamic ? this.state.takes[s.id]?.steps.filter(r => st.find(x => x.id === r.stepId)?.op === 'open_result').map(r => r.label).filter(Boolean).pop() : undefined;
      out.set(s.id, { intent: s.intent, title: s.title === 'Intro' ? s.chapter : s.title, steps: st, before: title(s.startState), after: title(st[st.length - 1]?.to || s.startState), audience: this.state.audience, isIntro: !s.flowId, isLast: i === shots.length - 1, targetSec: s.targetSec, goal: this.state.goal, site: this.map.app?.purpose,
        draft: sc ? resolveLine(sc, result) : undefined });
    });
    return out;
  }

  /** Timeline shots from takes; shots without a passing take are left out (and reported by review). */
  buildTimeline(preset: Preset, shotIds?: string[], takes: Record<string, Take> = this.state.takes): { tl: Timeline; skipped: string[] } {
    const shots: TimelineShot[] = [];
    const skipped: string[] = [];
    for (const s of this.storyboard!.shots) {
      if (shotIds && !shotIds.includes(s.id)) continue;
      const take = takes[s.id];
      if (!take?.ok) { skipped.push(s.id); continue; }
      const segments = cutSegments(take, preset);
      shots.push({ shotId: s.id, title: s.title, chapter: s.chapter, stepIds: s.stepIds, take: take.video, takeAttempt: take.attempt, segments, zooms: zoomKeys(take, preset, segments), hold: 0, outStart: 0, outDuration: 0 });
    }
    return { tl: layout({ version: 0, style: preset.name, createdAt: new Date().toISOString(), shots, duration: 0 }), skipped };
  }

  review(tl: Timeline, skipped: string[]): Finding[] {
    // Timing is checked against the voices the shots were fitted to
    const voices = this.voices[tl.style] ?? {};
    const f = checkTimeline(tl, this.state.takes, this.map, { beats: Object.fromEntries(Object.entries(voices).map(([id, v]) => [id, v.beatTimes])), targetSec: this.state.seconds });
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

  /** The map for this run, from the shared map provider (given → saved in the store → built). */
  private async getMap(input: MakeInput): Promise<AppMap> {
    const { map } = await ensureMap(input, { store: this.services.store, hooks: this.services.hooks, log: this.log, browserChannel: this.cfg.browserChannel, storageState: this.cfg.storageState }, true);
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
        // The voice-over is written once, now, and reused by the samples, the final video and edits
        const script = await run.ensureScript(llm, s.style === 'fast' ? WPS.fast : WPS.calm);
        this.log(`Script: ${Object.values(script.shots).map(x => `${x.shotId} (${words(x.line)} words, ${x.by})`).join(', ')}`);
        for (const n of script.notes) this.log(n);
        s.phase = 'sample';
        run.save();
      }
      const sb = run.storyboard!;
      const freshEnv = (paces?: Record<string, ShotPace>) => Object.assign(env, { gate: this.env(run).gate, flows: run.flows, paces });
      /** Voice first: synthesize the shots' voices in this style, then record each shot paced to its voice. */
      const recordPaced = async (p: Preset, list: Shot[], into: Record<string, Take>) => {
        const voices = await run.ensureVoices(p, list.map(x => x.id), deps.speech, llm);
        const paces = Object.fromEntries(Object.entries(voices).map(([id, v]) => [id, paceOf(v, p)]));
        for (const shot of list) {
          this.log(`Recording ${shot.id} (${shot.title})${voices[shot.id] ? `, paced to ${voices[shot.id].duration.toFixed(1)}s of voice` : ''}`);
          into[shot.id] = await recordBest(freshEnv(paces), shot, s.options.takes);
          run.save();
        }
      };
      const deps = { speech: this.services.speech, llm };

      if (s.phase === 'sample') {
        const opening = sb.shots.slice(0, 2);
        if (s.style) await recordPaced(PRESETS[s.style], opening, s.takes);
        else {
          // Compare: each style has its own voice timing, so the opening shots are recorded once per style
          s.sampleTakes = {};
          for (const p of Object.values(PRESETS)) await recordPaced(p, opening, (s.sampleTakes[p.name] = {}));
        }
        const ids = opening.filter(x => (s.sampleTakes?.calm ?? s.takes)[x.id]?.ok).map(x => x.id);
        if (!s.style && ids.length) {
          const samples: { name: Preset['name']; file: string }[] = [];
          for (const p of Object.values(PRESETS)) {
            const { tl } = run.buildTimeline(p, ids, s.sampleTakes![p.name]);
            attachVoices(tl, await run.ensureVoices(p, ids, deps.speech, llm), s.sampleTakes![p.name]);
            layout(tl);
            const r = await renderTimeline(run.dir, tl, { name: `sample-${p.name}` });
            samples.push({ name: p.name, file: r.mp4 });
            this.log(`Style sample "${p.name}": ${r.mp4} (${r.duration.toFixed(1)}s)`);
          }
          s.style = await approver.style(samples);
        }
        // The chosen style's takes of the opening shots are kept
        if (s.sampleTakes) Object.assign(s.takes, s.sampleTakes[s.style ?? 'calm'] ?? {});
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
        await recordPaced(PRESETS[s.style ?? 'calm'], sb.shots.filter(x => !s.takes[x.id]?.ok), s.takes);
        s.phase = 'assemble';
        run.save();
      }
      if (s.phase === 'assemble' || s.phase === 'review') {
        const preset = PRESETS[s.style || 'calm'];
        const { tl, skipped } = run.buildTimeline(preset);
        if (!tl.shots.length) throw new Error('No shot has a passing take; nothing to assemble.');
        s.notes = attachVoices(tl, await run.ensureVoices(preset, tl.shots.map(x => x.shotId), deps.speech, llm), s.takes);
        layout(tl);
        s.notes.push(...(run.script?.notes ?? []));
        tl.version = 1;
        let findings = run.review(tl, skipped);
        // One automatic fix round: re-voice shots with timing or label problems
        const fixable = new Set(findings.filter(f => f.shotId && (f.rule === 'label_match' || f.rule === 'repetition')).map(f => f.shotId!));
        if (fixable.size) {
          this.log(`Review found ${findings.length} issue(s); re-voicing ${[...fixable].join(', ')}`);
          const ctx = run.lineContexts();
          for (const sh of tl.shots) if (fixable.has(sh.shotId)) {
            const labelIssue = findings.some(f => f.shotId === sh.shotId && f.rule === 'label_match');
            const tooLong = findings.some(f => f.shotId === sh.shotId && f.rule === 'voice_fits');
            const repeated = findings.filter(f => f.shotId === sh.shotId && (f.rule === 'repetition' || f.rule === 'label_match')).map(f => f.message);
            // Rewrites see the current neighbouring lines, so they don't repeat them
            const k = tl.shots.indexOf(sh);
            const c = ctx.get(sh.shotId)!;
            c.prevLine = tl.shots[k - 1]?.voice?.line;
            c.nextLine = tl.shots[k + 1]?.voice?.line;
            // A label problem gets the deterministic line, which uses the exact on-screen labels
            s.notes.push(...await voiceShot(sh, c, preset, path.join(run.dir, 'voice'), run.dir, { speech: deps.speech, llm: labelIssue && !llm ? undefined : llm }, { direction: tooLong ? 'shorter' : undefined, request: repeated.length ? `Reword this line. Problems: ${repeated.join('; ')}. Only quote names exactly as on screen.` : undefined }));
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
