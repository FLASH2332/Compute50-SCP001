import { EventEmitter } from 'node:events';
import { chromium, type Browser, type BrowserContext, type Page as PlaywrightPage } from 'playwright';
import { gotoWithRetry } from './pageReady.js';
import { normalizeUrl } from './url.js';
import { buildSections, readPageRegions } from './sectionExtractor.js';
import type { SectionGraph } from './sectionGraph.js';
import type { SectionCrawlConfig, SectionCrawlEvent, SitePage } from './types.js';
import { nextPageButton, pressNextPage } from './pagination.js';
import { clickCandidates, preventFormSubmission, probeClicks } from './interactions.js';

const SKIP_EXT = /\.(pdf|zip|gz|rar|7z|exe|dmg|msi|jpe?g|png|gif|svg|webp|ico|mp4|mp3|mov|avi|csv|xlsx?|docx?|pptx?|json|xml|rss)$/i;

/** Canonical page id: normalized URL without #hash. */
export function pageIdOf(url: string): string {
  const fragment = new URL(url).hash;
  return normalizeUrl(url).canonicalUrl + (/^#(?:\/|!)/.test(fragment) ? fragment : '');
}

type Target = { id: string; url: string; depth: number; next?: boolean; pagination?: SitePage['pagination'] };

/**
 * Opens pages one by one (breadth first) and records each page's sections and
 * actions. It follows same-site links. It never fills fields or submits forms.
 * With probeClicks (read-only mode only) it also clicks a few buttons/tabs per
 * page to record what they do; all non-GET requests are blocked meanwhile.
 */
export class SectionCrawler extends EventEmitter {
  private config: Required<Omit<SectionCrawlConfig, 'browserChannel' | 'allowedDomains'>> & { browserChannel: string; allowedDomains: string[] };
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private running = false;
  private probedPages = 0;

  constructor(config: SectionCrawlConfig, private graph: SectionGraph) {
    super();
    const host = new URL(config.startUrl).hostname.replace(/^www\./, '');
    this.config = {
      startUrl: config.startUrl,
      maxPages: config.maxPages ?? 10,
      maxDepth: config.maxDepth ?? 2,
      headless: config.headless ?? true,
      captureScreenshots: config.captureScreenshots ?? false,
      browserChannel: config.browserChannel ?? '',
      navigationAttempts: config.navigationAttempts ?? 2,
      readOnly: config.readOnly ?? false,
      buttonPagination: config.buttonPagination === true && config.readOnly === true,
      // Clicking is only allowed in read-only mode, where every non-GET request
      // and every off-site navigation is blocked by the browser context.
      probeClicks: config.probeClicks === true && config.readOnly === true,
      maxProbePages: config.maxProbePages ?? 3,
      maxClicksPerPage: config.maxClicksPerPage ?? 6,
      allowedDomains: config.allowedDomains?.length ? config.allowedDomains : [host]
    };
  }

  private emitEvent(e: SectionCrawlEvent) {
    this.emit('crawler_event', e);
  }
  private log(message: string) {
    this.emitEvent({ type: 'log', timestamp: new Date().toISOString(), data: { message } });
  }

  isSameSite = (url: string): boolean => {
    try {
      const h = new URL(url).hostname;
      return this.config.allowedDomains.some(d => h === d || h.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { startUrl, maxPages, maxDepth } = this.config;
    this.graph.clear(startUrl, this.config.allowedDomains[0]);
    this.probedPages = 0;
    this.log(`Crawling ${startUrl} (up to ${maxPages} pages, ${maxDepth} link hops; ${this.config.probeClicks ? 'buttons are clicked read-only, nothing is typed or submitted' : 'links only, nothing is clicked or submitted'})`);

    try {
      this.browser = await chromium.launch({ headless: this.config.headless, channel: this.config.browserChannel || undefined });
      if (!this.running) return;
      this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: this.config.readOnly ? 'block' : undefined });
      if (this.config.readOnly) await this.context.addInitScript(preventFormSubmission);
      if (this.config.readOnly) await this.context.route('**/*', route => {
        const request = route.request();
        return ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
          (!request.isNavigationRequest() || this.isSameSite(request.url())) ? route.fallback() : route.abort();
      });
      // tsx/esbuild helper used inside page.evaluate callbacks
      await this.context.addInitScript('globalThis.__name = (t) => t;');
      const page = await this.context.newPage();

      const entry = pageIdOf(startUrl);
      const queue: Target[] = [{ id: entry, url: startUrl, depth: 0 }];
      const paginationQueue: Target[] = [];
      const queued = new Set([entry]);
      let crawled = 0;
      let blocked = false;
      let followedNext = false;

      while ((queue.length || paginationQueue.length) && crawled < maxPages && this.running) {
        // Alternate pagination with normal navigation so catalog links do not
        // bury the Next chain and a long Next chain does not bury the site.
        const target: Target = ((!followedNext || !queue.length) && paginationQueue.shift()) || queue.shift()!;
        followedNext = target.next === true;
        const { url, depth } = target;
        const result = await this.crawlPage(page, target);
        crawled++;
        if (result === 'bot-check') {
          blocked = true;
          this.emitEvent({ type: 'error', timestamp: new Date().toISOString(), data: { error: `This site showed a bot-protection check on ${url}. The crawler does not bypass these, so crawling stopped. The graph has the ${crawled - 1} page(s) read before the block.` } });
          break;
        }
        if (!result || depth >= maxDepth) continue;
        for (const target of result) {
          if (queued.has(target.id)) continue;
          queued.add(target.id);
          (this.config.readOnly && target.next ? paginationQueue : queue).push(target);
        }
        if (queue.length || paginationQueue.length) await page.waitForTimeout(400); // be polite between pages
      }

      const model = this.graph.getModel();
      const pending = Object.values(model.pages).filter(p => p.status === 'not-crawled' && !p.redirectedTo).length;
      model.coverage = {
        remaining: pending,
        reason: blocked ? 'blocked' : !this.running ? 'stopped' : queue.length || paginationQueue.length ? 'page limit' : pending ? 'depth limit' : 'frontier exhausted'
      };
      if (this.running && !blocked) {
        const s = this.graph.stats();
        this.emitEvent({ type: 'complete', timestamp: new Date().toISOString(), data: { pages: s.pagesCount, sections: s.sectionsCount, actions: s.actionsCount } });
      }
    } catch (err: any) {
      if (this.running) this.emitEvent({ type: 'error', timestamp: new Date().toISOString(), data: { error: err?.message || String(err) } });
    } finally {
      await this.stop();
    }
  }

  /** Returns same-site link targets to visit next, 'bot-check', or null on failure. */
  private async crawlPage(page: PlaywrightPage, target: Target): Promise<Target[] | 'bot-check' | null> {
    const { id, url, depth, pagination } = target;
    this.log(`Opening ${url} (hop ${depth})`);
    const base: SitePage = { id, url, title: url, depth, crawled: true, status: 'ok', discoveredAt: new Date().toISOString() };
    let httpStatus = 0;
    try {
      const response = await gotoWithRetry(page, pagination?.startUrl ?? url, this.config.navigationAttempts, 45000);
      httpStatus = response?.status() || 0;
      if (pagination) {
        for (let click = 0; click < pagination.clicks; click++) {
          if (!this.isSameSite(page.url())) throw new Error('Pagination left the starting site');
          const next = await nextPageButton(page);
          const signature = next && await pressNextPage(page, next);
          if (!signature) throw new Error('The Next page control did not reveal a new page');
          pagination.signature = signature;
        }
      }
    } catch (err: any) {
      this.graph.setPage({ ...base, status: 'error', error: String(err?.message || err).split(/\r?\n/)[0] }, [], []);
      this.log(`Could not open ${url}: ${String(err?.message || err).split(/\r?\n/)[0]}`);
      return null;
    }

    const finalUrl = page.url();
    if (!this.isSameSite(finalUrl)) {
      this.log(`${url} redirected off-site to ${finalUrl}; skipped`);
      this.graph.setPage({ ...base, status: 'error', error: `Redirected off-site to ${finalUrl}` }, [], []);
      return null;
    }
    const finalId = pagination ? id : pageIdOf(finalUrl);
    const raw = await readPageRegions(page);
    if (raw.botCheck) {
      this.graph.setPage({ ...base, id: finalId, url: finalUrl, title: raw.title, status: 'bot-check' }, [], []);
      return 'bot-check';
    }
    if (httpStatus >= 400) {
      const error = `HTTP ${httpStatus} opening ${url}`;
      this.graph.setPage({ ...base, title: raw.title, status: 'error', error }, [], []);
      this.log(error);
      return null;
    }

    const { sections, actions } = buildSections(finalId, raw.regions, this.isSameSite, pageIdOf);
    let screenshotBase64: string | undefined;
    if (this.config.captureScreenshots) {
      screenshotBase64 = (await page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null))?.toString('base64');
    }
    const heading = raw.regions.find(region => !region.hidden && region.role === 'main')?.heading;
    const title = pagination ? (heading || raw.title || finalUrl) + ' · Page ' + (pagination.clicks + 1) : raw.title || heading || finalUrl;
    const sitePage: SitePage = { ...base, id: finalId, url: finalUrl, title, screenshotBase64, pagination };
    this.graph.setPage(sitePage, sections, actions);

    if (id !== finalId) this.graph.addRedirect(id, finalId, url, depth);
    const next = new Map<string, Target & { next: boolean }>();
    for (const link of raw.links) {
      const target = new URL(link.url);
      if (!['http:', 'https:'].includes(target.protocol) || !this.isSameSite(target.href) || SKIP_EXT.test(target.pathname)) continue;
      if (this.config.readOnly && /(?:^|\/)(?:log-?out|sign-?out|sign-?off|delete|unsubscribe|vote|hide)(?:\/|$)/i.test(target.pathname)) continue;
      const targetId = pageIdOf(target.href);
      if (targetId === finalId || (pagination && targetId === pageIdOf(finalUrl))) continue;
      this.graph.addLinkedPage(targetId, target.href, depth + 1);
      if (!next.has(targetId) || link.next) {
        next.set(targetId, { id: targetId, url: target.href, depth: depth + 1, next: link.next });
        this.graph.addLink({ source: finalId, target: targetId, ...link });
      }
    }
    if (this.config.buttonPagination && ![...next.values()].some(link => link.next) && await nextPageButton(page)) {
      const startUrl = pagination?.startUrl ?? finalUrl;
      const clicks = (pagination?.clicks ?? 0) + 1;
      const targetId = pageIdOf(startUrl) + '#page-view=' + (clicks + 1);
      this.graph.addLinkedPage(targetId, finalUrl, depth + 1);
      this.graph.addLink({ source: finalId, target: targetId, url: finalUrl, label: 'Next page', next: true, via: 'button' });
      next.set(targetId, { id: targetId, url: finalUrl, depth: depth + 1, next: true, pagination: { startUrl, clicks } });
    }
    // Learn what buttons/tabs do by clicking them (read-only context; see config)
    if (this.config.probeClicks && !pagination && this.probedPages < this.config.maxProbePages && this.running) {
      const candidates = clickCandidates(actions, this.config.maxClicksPerPage);
      if (candidates.length) {
        this.probedPages++;
        this.log(`Clicking ${candidates.length} button(s) on ${finalUrl} to see what they do (writes are blocked)`);
        const found = await probeClicks(page, finalId, finalUrl, candidates,
          async () => { await gotoWithRetry(page, finalUrl, 1, 30000); }, pageIdOf);
        this.graph.setInteractions(finalId, found);
        for (const it of found) {
          if (it.kind !== 'navigate' || !it.resultUrl || !this.isSameSite(it.resultUrl)) continue;
          const targetId = pageIdOf(it.resultUrl);
          if (targetId === finalId) continue;
          this.graph.addLinkedPage(targetId, it.resultUrl, depth + 1);
          this.graph.addLink({ source: finalId, target: targetId, url: it.resultUrl, label: it.label, next: false, interactionId: it.id });
          if (!next.has(targetId)) next.set(targetId, { id: targetId, url: it.resultUrl, depth: depth + 1, next: false });
        }
        this.log(`Buttons on ${finalUrl}: ${found.filter(f => f.kind !== 'nothing').map(f => `${f.label} → ${f.result}`).join('; ') || 'no visible effect'}`);
      }
    }
    this.emitEvent({ type: 'page_crawled', timestamp: new Date().toISOString(), data: { page: sitePage, sections: sections.length, actions: actions.length } });
    this.log(`Read ${finalUrl}: ${sections.length} sections, ${actions.length} actions, ${next.size} same-site links`);
    return [...next.values()].sort((a, b) => Number(b.next) - Number(a.next));
  }

  /** Recorded button results (for the recorder). */
  interactions() {
    return this.graph.getModel().interactions ?? {};
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
  }
}
