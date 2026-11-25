/**
 * Section graph model.
 *
 *   (:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(:Action)-[:NAVIGATES_TO]->(:Page)
 *
 * A page is split into the regions a visitor sees (header, navigation, main
 * content, sidebar, forms, dialogs, footer). Each section lists what a visitor
 * can do there. Nothing is clicked or submitted: links tell us where they go
 * (their href); buttons and form fields are recorded but never pressed or filled.
 */

export type SectionRole = 'header' | 'nav' | 'main' | 'sidebar' | 'form' | 'dialog' | 'footer' | 'content';

export type ActionType = 'link' | 'button' | 'submit' | 'input' | 'select' | 'choice' | 'tab';

export interface SitePage {
  id: string;               // canonical URL (tracking params, hash, trailing slash removed)
  url: string;              // URL actually loaded (after redirects)
  title: string;
  depth: number;            // link hops from the start page
  crawled: boolean;         // false = only known because something links to it
  status: 'ok' | 'bot-check' | 'error' | 'not-crawled';
  error?: string;
  screenshotBase64?: string;
  discoveredAt: string;
  redirectedTo?: string;
  pagination?: { startUrl: string; clicks: number; signature?: string };
  // Added after the crawl (enrich.ts):
  urlTemplate?: string;     // /product/:id
  urlPattern?: string;      // regex: browser URLs of this page's template map to this page (template representative)
  pagerank?: number;
  betweenness?: number;
  harmonic?: number;
  community?: number;
  reachable?: boolean;      // reachable from the start page by links / clicks
  deadEnd?: boolean;        // opened, but has no way out
}

export interface SiteLink {
  source: string;
  target: string;
  url: string;
  label: string;
  next: boolean;
  via?: 'button';
  interactionId?: string;   // reached by clicking a (non-link) button, see Interaction
  reliability?: number;     // (s+1)/(n+2) from what the crawl saw
  cost?: number;            // routing cost: 1 + 2·(−ln reliability) + risk cost
}

export interface PageSection {
  positionPct?: number;     // top relative to document height; absent on older graphs
  heightScreens?: number;
  regionSelector?: string;  // measured DOM region, including sections without controls/headings
  id: string;
  pageId: string;
  name: string;             // aria-label > id > first heading > class > role-N
  role: SectionRole;
  order: number;            // position on the page, top to bottom
  hidden: boolean;          // e.g. a dialog that is in the page but not open
  actionCount: number;      // actions stored (after grouping repeats)
  totalActions: number;     // actions found before grouping
  summary: string;          // plain description built from the section's actions
  modal?: boolean;          // a dialog that blocks the page behind it
}

export interface SectionAction {
  id: string;
  sectionId: string;
  label: string;
  type: ActionType;
  inputType?: string;       // for fields: text, email, password, search, textarea ...
  selector: string;         // a Playwright selector that finds it again
  href?: string;            // absolute link target, without #hash
  navigatesTo?: string;     // page id, when the link stays on this site
  external?: boolean;       // link leaves the site
  visible: boolean;
  groupSize?: number;       // >1 when this stands for a group of repeated links
  // Richer capture (ported from the old SiteGraph extractor):
  role?: string;            // ARIA role (explicit or implicit)
  name?: string;            // accessible name
  locators?: string[];      // tried in order: role=<r>|name=<n>, testid=<id>, css=<unique path>, text=<name>, item=<css>
  fingerprint?: { role: string; name: string; tag: string; attrs: Record<string, string | null>; gcss: string; css: string; bbox: number[] };
  risk?: 'read' | 'navigate' | 'input' | 'submit_safe' | 'submit_mutating' | 'external' | 'destructive';
  inferred?: boolean;       // no ARIA role, but clickable (click handler, pointer cursor, tabindex, btn class)
  hoverable?: boolean;      // opens a popup / submenu
  hrefTemplate?: string;    // URL template of href
  // List templates: one action that stands for every item of a repeated list
  isTemplate?: boolean;
  count?: number;
  samples?: string[];       // item texts; pass one as `item` to pick that item
  reliability?: number;
  cost?: number;
}

/** What happened when a button/tab was clicked (in a read-only browser). */
export interface Interaction {
  id: string;
  pageId: string;
  sectionId: string;
  actionId: string;
  label: string;
  selector: string;
  kind: 'dialog' | 'panel' | 'navigate' | 'nothing';
  result: string;           // e.g. 'Opens "Sign in to register"'
  resultUrl?: string;       // for kind 'navigate'
  reliability?: number;
  cost?: number;
}

export interface SectionGraphModel {
  startUrl: string;
  domain: string;
  pages: Record<string, SitePage>;
  sections: Record<string, PageSection>;
  actions: Record<string, SectionAction>;
  links?: SiteLink[];
  interactions?: Record<string, Interaction>;
  coverage?: {
    remaining: number;
    reason: 'frontier exhausted' | 'page limit' | 'depth limit' | 'blocked' | 'stopped';
  };
  // Node / edge types beyond the core schema: App, Template, Area (see bench/README.md)
  extraNodes?: ExtraNode[];
  extraEdges?: ExtraEdge[];
  buildStats?: {
    llmCalls: number;
    mode: ExploreMode;
    rounds: number;          // guided rounds
    skipped: number;         // targets dropped by skip patterns
    deferred: number;        // look-alike pages opened only after everything else
    profile: boolean;        // a site profile was made
  };
}

export type ExploreMode = 'brute' | 'guided' | 'auto';

export interface ExtraNode { label: string; id: string; props: Record<string, unknown> }
export interface ExtraEdge { type: string; from: { label: string; id: string }; to: { label: string; id: string }; props?: Record<string, unknown> }

export interface SectionCrawlConfig {
  startUrl: string;
  maxPages?: number;        // pages to open (default 10)
  maxDepth?: number;        // link hops from the start page (default 2)
  headless?: boolean;
  captureScreenshots?: boolean;
  browserChannel?: string;
  allowedDomains?: string[];
  navigationAttempts?: number;
  readOnly?: boolean;
  buttonPagination?: boolean;
  probeClicks?: boolean;      // click buttons/tabs to learn what they do (read-only mode only)
  maxProbePages?: number;     // pages whose buttons are probed (default 3)
  maxClicksPerPage?: number;  // buttons probed per page (default 6)
  explore?: ExploreMode;      // brute: breadth first; guided: a model picks frontier groups; auto (default): decides
  templateCap?: number;       // pages opened per URL template before look-alikes are deferred (default 3)
  useLlm?: boolean;           // false: no model calls (bootstrap, guided picks, area names)
}

export type SectionCrawlEvent =
  | { type: 'log'; timestamp: string; data: { message: string } }
  | { type: 'page_crawled'; timestamp: string; data: { page: SitePage; sections: number; actions: number } }
  | { type: 'complete'; timestamp: string; data: { pages: number; sections: number; actions: number } }
  | { type: 'error'; timestamp: string; data: { error: string } };
