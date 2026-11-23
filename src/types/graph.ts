export interface Page {
  id: string; // canonical URL
  url: string;
  path: string;
  title: string;
  domain: string;
  discoveredAt: string;
}

export interface UIState {
  id: string; // Hash of canonical URL + dynamic landmarks (modal/drawer/tab/form)
  pageId: string;
  name: string; // Human-friendly descriptor (e.g. "/billing [Modal: Create Invoice]")
  url: string;
  isModal: boolean;
  modalTitle?: string;
  activeLandmarks: string[];
  /** In-screen details (expanded panels, alert shown) — informative, not part of state identity */
  detailLandmarks?: string[];
  /** Route grouping, e.g. /item/:id — for grouping only, NOT part of identity */
  routeTemplate?: string;
  /** Which element was detected as the modal (tag#id.class < parents) — to tell real dialogs from injected ads */
  modalSource?: string;
  /** Text-free tag/role skeleton used in the state hash (truncated) — lets a human see why two states differ */
  domSkeleton?: string;
  /** Where the page identity came from */
  canonicalSource?: 'url' | 'link-rel-canonical';
  elementCount: number;
  screenshotBase64?: string;
  domSignature: string;
  discoveredAt: string;
}

export interface Element {
  id: string; // Deterministic ID based on selector, role, text
  stateId: string;
  selector: string;
  tag: string;
  role: string;
  text: string;
  name?: string;
  elementType: 'button' | 'link' | 'input' | 'select' | 'checkbox' | 'radio' | 'tab' | 'menuitem' | 'custom';
  isInteractive: boolean;
  /** How many identical controls this one represents (e.g. 50 row "Edit" buttons -> 50) */
  groupSize?: number;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type ActionType = 'CLICK' | 'FILL' | 'SELECT' | 'HOVER' | 'NAVIGATE';

export interface Action {
  id: string;
  type: ActionType;
  targetElementId?: string;
  targetSelector?: string;
  payload?: string;
  timestamp: string;
}

export interface Transition {
  id: string;
  fromStateId: string;
  toStateId: string;
  action: Action;
  urlChanged: boolean;
  triggerElementId?: string;
  description: string;
  discoveredAt: string;
  /** What was observed right after the action (confirmation message, navigation) */
  resultEvidence?: string[];
  pathFromEntry?: string[];
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  startStateId: string;
  endStateId: string;
  stepCount: number;
  states: string[]; // State IDs in sequence
  transitions: string[]; // Transition IDs in sequence
  /** completed = a positive confirmation was observed after a goal action;
   *  partial = only reached (e.g. dialog opened), no result observed */
  status: 'completed' | 'partial';
  evidence: string;
}

export interface PageLink {
  sourcePageId: string;
  destinationUrl: string;
  label: string;
}

export type StateCoverage = 'discovered' | 'sampled' | 'depth limit' | 'state limit' | 'restore failed';

export interface GraphModel {
  links?: PageLink[];
  coverage?: Record<string, StateCoverage>;
  domain: string;
  pages: Record<string, Page>;
  states: Record<string, UIState>;
  elements: Record<string, Element>;
  transitions: Record<string, Transition>;
  workflows: Record<string, Workflow>;
}

export interface CrawlerConfig {
  startUrl: string;
  maxDepth?: number;
  maxStates?: number;
  headless?: boolean;
  browserChannel?: string;
  captureScreenshots?: boolean;
  allowedDomains?: string[];
  blockedSelectors?: string[]; // E.g., logout buttons, delete actions
}

export interface CrawlerEvent {
  type: 'state_discovered' | 'transition_discovered' | 'element_discovered' | 'workflow_detected' | 'log' | 'complete' | 'error';
  timestamp: string;
  data: any;
}
