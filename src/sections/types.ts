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
}

export interface PageSection {
  id: string;
  pageId: string;
  name: string;             // aria-label > id > first heading > class > role-N
  role: SectionRole;
  order: number;            // position on the page, top to bottom
  hidden: boolean;          // e.g. a dialog that is in the page but not open
  actionCount: number;      // actions stored (after grouping repeats)
  totalActions: number;     // actions found before grouping
  summary: string;          // plain description built from the section's actions
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
}

export interface SectionGraphModel {
  startUrl: string;
  domain: string;
  pages: Record<string, SitePage>;
  sections: Record<string, PageSection>;
  actions: Record<string, SectionAction>;
}

export interface SectionCrawlConfig {
  startUrl: string;
  maxPages?: number;        // pages to open (default 10)
  maxDepth?: number;        // link hops from the start page (default 2)
  headless?: boolean;
  captureScreenshots?: boolean;
  browserChannel?: string;
  allowedDomains?: string[];
}

export type SectionCrawlEvent =
  | { type: 'log'; timestamp: string; data: { message: string } }
  | { type: 'page_crawled'; timestamp: string; data: { page: SitePage; sections: number; actions: number } }
  | { type: 'complete'; timestamp: string; data: { pages: number; sections: number; actions: number } }
  | { type: 'error'; timestamp: string; data: { error: string } };
