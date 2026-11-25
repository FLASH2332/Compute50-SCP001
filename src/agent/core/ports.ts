import type { Page } from 'playwright';
import type { AppMap } from './appMap.js';

/**
 * Ports: everything the agent needs from the outside world. Each has a
 * default implementation in ../providers/, and each can be swapped (another
 * LLM, another TTS, a web UI or MCP approver) without touching the agent.
 */

/** A chat model that answers with one JSON object. */
export interface TextModel {
  json<T>(system: string, user: string): Promise<T>;
}

/** A vision model that answers questions about screenshots (PNG base64). */
export interface VisionModel {
  json<T>(system: string, question: string, imagesBase64: string[]): Promise<T>;
}

export interface Word { text: string; start: number; end: number }
export interface SpeechClip { file: string; duration: number; words: Word[] }

/** The text spoken just before / after a clip, so separately made clips sound like one take (request stitching). */
export interface SpeechContext { previousText?: string; nextText?: string }

/** Text → audio file (written into `dir`) with word timings. */
export interface Speech {
  synthesize(text: string, dir: string, speed: number, context?: SpeechContext): Promise<SpeechClip>;
}

/** Human gates. A CLI, a web page or an MCP elicitation can implement this. */
export interface Approver {
  /** Shown the storyboard; returns "approve" (or an approval word) or a change request. */
  storyboard(text: string): Promise<string>;
  /** Pick a style after seeing the samples. */
  style(samples: { name: 'fast' | 'calm'; file: string }[]): Promise<'fast' | 'calm'>;
}

export type Logger = (message: string) => void;

/** Page-level hooks from the app's environment (cookie banners, read-only guards...). */
export interface BrowserHooks {
  /** Scripts added to every page while exploring (read-only). */
  exploreInitScripts?: (string | (() => void))[];
  /** Run after every page load (explore and record), e.g. dismiss a cookie banner. */
  afterLoad?: (page: Page) => Promise<unknown>;
}

/** Where the app map comes from: a crawler, a saved graph... */
export type MapSource = (log: Logger) => Promise<AppMap>;

/**
 * Where maps live between runs (Memgraph, Neo4j, ...). The agent asks the
 * store first; only when it has no map for the site does it build one, save
 * it, and read it back. After each run, learned stats and heals are saved.
 */
export interface MapStore {
  readonly name: string;
  find(url: string): Promise<AppMap | null>;
  save(map: AppMap): Promise<void>;
  close?(): Promise<void>;
}

export interface Services {
  store?: MapStore;
  llm?: TextModel;
  vision?: VisionModel;
  speech: Speech;
  approver: Approver;
  hooks: BrowserHooks;
  log: Logger;
}
