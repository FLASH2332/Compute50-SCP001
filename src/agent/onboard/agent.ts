/**
 * The onboarding agent: Understand → Show → Answer.
 *
 * Like the demo agent it depends only on the AppMap and the ports in
 * core/ports.ts, so it reads any graph an adapter can produce: a saved map
 * in Memgraph / Neo4j (MapStore), a section graph file, or a fresh crawl
 * (MapSource). It never invents steps: no route in the map means
 * "I can't find that in this app", and the question is logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppMap } from '../core/appMap.js';
import type { MapSource, Services } from '../core/ports.js';
import { ensureMap } from '../core/mapProvider.js';
import { SilentSpeech } from '../providers/speech.js';
import { AutoApprover } from '../providers/approvers.js';
import { answerSteps, flowFromRoute } from './answer.js';
import { showClip, type Clip } from './show.js';
import { bestRoute, NOT_FOUND, startFrom, understand } from './understand.js';
import { overview, overviewKind } from './overview.js';

export interface OnboardingConfig {
  services?: Partial<Services>;
  runsDir?: string;
  headless?: boolean;
  browserChannel?: string;
  storageState?: string;
}

export interface AskInput {
  question: string;
  /** The site. With a store, its saved map is used when there is one. */
  url?: string;
  /** A ready AppMap, or a source that builds one when the store has none. */
  map?: AppMap | MapSource;
  rebuild?: boolean;
  deepen?: boolean;      // run the safe-click explorer on a freshly built map (slower)
  clip?: boolean;        // record a clip (default true)
  from?: string;         // URL of the page the viewer is on: the answer starts there
}

export interface AskResult {
  found: boolean;
  kind?: 'route' | 'what' | 'start';  // a way to do something, or an overview of the app
  steps: string[];       // numbered steps (or overview lines), or [NOT_FOUND]
  clip?: Clip;
  reason: string;
  by: string;            // 'model' or 'keyword rules'
  source: string;        // which graph the answer came from (adapter name)
  clipError?: string;
}

export class OnboardingAgent {
  readonly services: Services;
  readonly runsDir: string;

  constructor(private cfg: OnboardingConfig = {}) {
    const s = cfg.services || {};
    this.services = { speech: s.speech || new SilentSpeech(), approver: s.approver || new AutoApprover(), hooks: s.hooks || {}, log: s.log || console.log, llm: s.llm, vision: s.vision, store: s.store };
    this.runsDir = cfg.runsDir || 'runs';
  }

  /** The map, from the shared map provider (same graph as the demo agent). Not deepened by default: answers are quick. */
  async getMap(input: AskInput): Promise<AppMap> {
    const { map } = await ensureMap(input, { store: this.services.store, hooks: this.services.hooks, log: this.services.log, browserChannel: this.cfg.browserChannel, storageState: this.cfg.storageState }, false);
    return map;
  }

  async ask(input: AskInput): Promise<AskResult> {
    const map = await this.getMap(input);
    const source = map.data.source;
    // Questions about the app itself ("what can I do here?", "where should I start?") come from its areas and PageRank
    const kind = overviewKind(input.question);
    if (kind) {
      const ov = overview(map, kind, input.question, input.from);
      if (ov.lines.length) {
        this.logQuestion(input.question, map.startUrl, true, ov.reason);
        const result: AskResult = { found: true, kind, steps: ov.lines, reason: ov.reason, by: 'graph', source };
        // "Where should I start?" also shows the way to the first page
        const start = startFrom(map, input.from).state;
        const route = kind === 'start' && ov.target && start ? bestRoute(map, start, [{ ref: 'top', kind: 'page', label: '', aliases: [], text: '', state: ov.target }]) : null;
        if (route && route.steps.length && input.clip !== false) {
          try { result.clip = await showClip(map, flowFromRoute(map, route, input.question), this.services, { runsDir: this.runsDir, headless: this.cfg.headless, browserChannel: this.cfg.browserChannel, storageState: this.cfg.storageState, question: input.question }); }
          catch (err) { result.clipError = err instanceof Error ? err.message : String(err); }
        }
        return result;
      }
    }
    const u = await understand(map, input.question, this.services.llm, { from: input.from });
    if (!u.found) {
      this.logQuestion(input.question, map.startUrl, false, u.reason);
      return { found: false, steps: [NOT_FOUND], reason: u.reason, by: u.by, source };
    }
    const flow = flowFromRoute(map, u.route, input.question);
    const steps = await answerSteps(map, flow, input.question, this.services.llm);
    this.logQuestion(input.question, map.startUrl, true, u.reason);
    const result: AskResult = { found: true, kind: 'route', steps, reason: u.reason, by: u.by, source };
    if (input.clip !== false) {
      try {
        result.clip = await showClip(map, flow, this.services, { runsDir: this.runsDir, headless: this.cfg.headless, browserChannel: this.cfg.browserChannel, storageState: this.cfg.storageState, question: input.question });
      } catch (err) {
        // The text answer still stands; say why there is no clip
        result.clipError = err instanceof Error ? err.message : String(err);
      }
    }
    return result;
  }

  /** Demand list: every question with whether it was answered (runs/questions.jsonl). */
  private logQuestion(question: string, site: string, found: boolean, reason: string) {
    try {
      fs.mkdirSync(this.runsDir, { recursive: true });
      fs.appendFileSync(path.join(this.runsDir, 'questions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), site, question, found, reason }) + '\n');
    } catch { /* logging must never break an answer */ }
  }
}

export function createOnboardingAgent(cfg: OnboardingConfig = {}): OnboardingAgent {
  return new OnboardingAgent(cfg);
}
