import { EventEmitter } from 'node:events';
import { chromium, type Browser, type BrowserContext, type Page as PlaywrightPage } from 'playwright';
import { gotoWithRetry } from './pageReady.js';
import { normalizeUrl } from './url.js';
import { buildSections, readPageRegions } from './sectionExtractor.js';
import type { SectionGraph } from './sectionGraph.js';
import type { SectionCrawlConfig, SectionCrawlEvent, SitePage } from './types.js';

const SKIP_EXT = /\.(pdf|zip|gz|rar|7z|exe|dmg|msi|jpe?g|png|gif|svg|webp|ico|mp4|mp3|mov|avi|csv|xlsx?|docx?|pptx?|json|xml|rss)$/i;

/** Canonical page id: normalized URL without #hash. */
export function pageIdOf(url: string): string {
  return normalizeUrl(url.split('#')[0]).canonicalUrl;
}

/**
 * Opens pages one by one (breadth first) and records each page's sections and
 * actions. It only follows links (href) on the same site; it never clicks
 * buttons, fills fields or submits forms.
 */
export class SectionCrawler extends EventEmitter {
  private config: Required<Omit<SectionCrawlConfig, 'browserChannel' | 'allowedDomains'>> & { browserChannel: string; allowedDomains: string[] };
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private running = false;

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
    this.log(`Crawling ${startUrl} (up to ${maxPages} pages, ${maxDepth} link hops; links only, nothing is clicked or submitted)`);

    try {
      this.browser = await chromium.launch({ headless: this.config.headless, channel: this.config.browserChannel || undefined });
      this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
      // tsx/esbuild helper used inside page.evaluate callbacks
      await this.context.addInitScript('globalThis.__name = (t) => t;');
      const page = await this.context.newPage();

      const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
      const queued = new Set([pageIdOf(startUrl)]);
      let crawled = 0;

      while (queue.length && crawled < maxPages && this.running) {
        const { url, depth } = queue.shift()!;
        const result = await this.crawlPage(page, url, depth);
        crawled++;
        if (result === 'bot-check') {
          this.emitEvent({ type: 'error', timestamp: new Date().toISOString(), data: { error: `This site showed a bot-protection check on ${url}. The crawler does not bypass these, so crawling stopped. The graph has the ${crawled - 1} page(s) read before the block.` } });
          break;
        }
        if (!result || depth >= maxDepth) continue;
        for (const target of result) {
          if (queued.has(target.id)) continue;
          queued.add(target.id);
          queue.push({ url: target.url, depth: depth + 1 });
        }
        if (queue.length) await page.waitForTimeout(400); // be polite between pages
      }

      if (this.running) {
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
  private async crawlPage(page: PlaywrightPage, url: string, depth: number): Promise<{ id: string; url: string }[] | 'bot-check' | null> {
    const id = pageIdOf(url);
    this.log(`Opening ${url} (hop ${depth})`);
    const base: SitePage = { id, url, title: url, depth, crawled: true, status: 'ok', discoveredAt: new Date().toISOString() };
    try {
      await gotoWithRetry(page, url, 2, 45000);
    } catch (err: any) {
      this.graph.setPage({ ...base, status: 'error', error: String(err?.message || err).split(/\r?\n/)[0] }, [], []);
      this.log(`Could not open ${url}: ${String(err?.message || err).split(/\r?\n/)[0]}`);
      return null;
    }

    const finalUrl = page.url();
    if (!this.isSameSite(finalUrl)) {
      this.log(`${url} redirected off-site to ${finalUrl}; skipped`);
      return null;
    }
    const finalId = pageIdOf(finalUrl);
    const raw = await readPageRegions(page);
    if (raw.botCheck) {
      this.graph.setPage({ ...base, id: finalId, url: finalUrl, title: raw.title, status: 'bot-check' }, [], []);
      return 'bot-check';
    }

    const { sections, actions } = buildSections(finalId, raw.regions, this.isSameSite, pageIdOf);
    let screenshotBase64: string | undefined;
    if (this.config.captureScreenshots) {
      screenshotBase64 = (await page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null))?.toString('base64');
    }
    const sitePage: SitePage = { ...base, id: finalId, url: finalUrl, title: raw.title || finalUrl, screenshotBase64 };
    this.graph.setPage(sitePage, sections, actions);

    const next = new Map<string, string>();
    for (const a of actions) {
      if (!a.navigatesTo || !a.href || a.navigatesTo === finalId) continue;
      if (SKIP_EXT.test(new URL(a.href).pathname)) continue;
      this.graph.addLinkedPage(a.navigatesTo, a.href, depth + 1);
      if (!next.has(a.navigatesTo)) next.set(a.navigatesTo, a.href);
    }
    this.emitEvent({ type: 'page_crawled', timestamp: new Date().toISOString(), data: { page: sitePage, sections: sections.length, actions: actions.length } });
    this.log(`Read ${finalUrl}: ${sections.length} sections, ${actions.length} actions, ${next.size} same-site links`);
    return [...next].map(([nid, nurl]) => ({ id: nid, url: nurl }));
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
  }
}
