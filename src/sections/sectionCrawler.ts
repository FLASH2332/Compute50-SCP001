import { EventEmitter } from 'node:events';
import { chromium, type Browser, type BrowserContext, type Page as PlaywrightPage } from 'playwright';
import { gotoWithRetry } from './pageReady.js';
import { normalizeUrl } from './url.js';
import { buildSections, readPageRegions } from './sectionExtractor.js';
import type { SectionGraph } from './sectionGraph.js';
import type { SectionCrawlConfig, SectionCrawlEvent, SitePage } from './types.js';
import { nextPageButton, pressNextPage } from './pagination.js';
import { clickCandidates, preventFormSubmission, probeClicks } from './interactions.js';
import { connectGraphLlm } from '../llm.js';
import { bootstrapSite, type Bootstrap } from './bootstrap.js';
import { FRONTIER_SYSTEM, frontierPrompt, groupFrontier, parseChoice, pickIndex, templateOf } from './frontier.js';
import { enrichModel } from './enrich.js';
import { isVariable } from './templates.js';

const GUIDED_ROUND_PAGES = 10;  // pages opened per guided round (old SiteGraph: 10 new states)
const GUIDED_MAX_ROUNDS = 12;
const AUTO_PROBE_PAGES = 8;     // auto mode: pages opened breadth first before deciding
const AUTO_MAX_GROUPS = 15;     // ... then guided if more frontier groups than this are still open
const AUTO_LARGE_SITEMAP = 300;

const SKIP_EXT = /\.(pdf|zip|gz|rar|7z|exe|dmg|msi|jpe?g|png|gif|svg|webp|ico|mp4|mp3|mov|avi|csv|xlsx?|docx?|pptx?|json|xml|rss)$/i;

/** Canonical page id: normalized URL without #hash. */
export function pageIdOf(url: string): string {
  const fragment = new URL(url).hash;
  return normalizeUrl(url).canonicalUrl + (/^#(?:\/|!)/.test(fragment) ? fragment : '');
}

type Target = { id: string; url: string; depth: number; next?: boolean; label?: string; pagination?: SitePage['pagination'] };

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
      explore: config.explore ?? 'auto',
      templateCap: config.templateCap ?? 3,
      useLlm: config.useLlm ?? true,
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

      // Exploration mode (old SiteGraph brute / guided / auto). Look-alike pages (one URL template) are opened
      // `templateCap` at a time; the rest wait until nothing else is left.
      const llm = this.config.useLlm ? await connectGraphLlm() : undefined;
      if (llm) this.log('A model is available: the site profile, guided picks and area names use it');
      let mode: 'brute' | 'guided' = this.config.explore === 'guided' && llm ? 'guided' : 'brute';
      let decided = this.config.explore !== 'auto' || !llm;
      const opened = new Map<string, number>();
      const skip: RegExp[] = [];
      let preferred: Set<string> | undefined;
      let roundLeft = 0;
      const stats = { rounds: 0, skipped: 0, deferred: 0 };
      let boot: Bootstrap | undefined;
      let stopAsked = false;

      // Drops queued targets that match a skip pattern. A pattern that would drop more than half the queue
      // (or the start page) is ignored: a model's skip list must not end the crawl.
      const applySkip = (patterns: { pattern: string; reason: string }[]) => {
        for (const { pattern, reason } of patterns) {
          const re = new RegExp(pattern, 'i');
          if (re.test(startUrl)) continue;
          const hits = queue.filter(t => re.test(t.url));
          if (queue.length >= 4 && hits.length > queue.length / 2) continue;
          skip.push(re);
          for (const t of hits) queue.splice(queue.indexOf(t), 1);
          stats.skipped += hits.length;
          if (hits.length) this.log(`Skipping ${hits.length} page(s) matching /${pattern}/ (${reason || 'no reason given'})`);
        }
      };
      const guidedRound = async () => {
        stats.rounds++;
        roundLeft = GUIDED_ROUND_PAGES;
        const { groups, members } = groupFrontier(queue);
        const mapped = [...opened.entries()].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ');
        const answer = await llm!.json(FRONTIER_SYSTEM, frontierPrompt(groups, boot?.profile?.purpose, mapped, maxPages - crawled), 600);
        const choice = parseChoice(answer, groups);
        if (!choice.ok) { preferred = undefined; this.log('Guided round: no usable answer, breadth first'); return; }
        preferred = new Set(choice.pick.flatMap(id => (members.get(id) ?? []).map(templateOf)));
        applySkip(choice.skip);
        // A stop is honoured only after half the page budget, so one early answer can't end the map
        if (choice.stop && crawled >= maxPages / 2) stopAsked = true;
        this.log(`Guided round ${stats.rounds}: open ${choice.pick.join(', ') || 'nothing in particular'}${choice.skip.length ? `; skip ${choice.skip.length} pattern(s)` : ''}${choice.stop ? '; the model says the map is good enough' : ''}`);
      };
      const decide = (why: string, guided: boolean) => {
        decided = true;
        if (guided) { mode = 'guided'; roundLeft = 0; }
        this.log(`Exploration mode: ${mode} (${why})`);
      };

      while ((queue.length || paginationQueue.length) && crawled < maxPages && this.running && !stopAsked) {
        // Alternate pagination with normal navigation so catalog links do not
        // bury the Next chain and a long Next chain does not bury the site.
        let target: Target;
        if ((!followedNext || !queue.length) && paginationQueue.length) target = paginationQueue.shift()!;
        else {
          if (mode === 'guided' && roundLeft <= 0 && stats.rounds < GUIDED_MAX_ROUNDS && queue.length > 1) await guidedRound();
          const i = pickIndex(queue, opened, this.config.templateCap, mode === 'guided' ? preferred : undefined);
          const k = templateOf(queue[i]);
          if (isVariable(k) && (opened.get(k) ?? 0) >= this.config.templateCap) stats.deferred++;
          target = queue.splice(i, 1)[0];
          roundLeft--;
        }
        followedNext = target.next === true;
        const { url, depth } = target;
        const result = await this.crawlPage(page, target);
        crawled++;
        opened.set(templateOf(target), (opened.get(templateOf(target)) ?? 0) + 1);
        if (crawled === 1 && result !== 'bot-check' && this.running) {
          const model = this.graph.getModel();
          const first = Object.values(model.pages).find(p => p.crawled);
          boot = await bootstrapSite(startUrl, first?.title ?? '', Object.values(model.actions), llm);
          if (boot.profile) {
            this.log(`Site profile: ${boot.profile.purpose} (size ${boot.profile.size})`);
            if (Array.isArray(result)) {
              const pats = boot.profile.skip.map(s => new RegExp(s.pattern, 'i'));
              const keep = result.filter(t => !pats.some(re => re.test(t.url)));
              if (keep.length >= result.length / 2) {
                stats.skipped += result.length - keep.length;
                result.splice(0, result.length, ...keep);
                skip.push(...pats);
              }
            }
          }
          if (!decided && (boot.profile?.size === 'large' || (boot.sitemapUrls ?? 0) > AUTO_LARGE_SITEMAP))
            decide(boot.profile?.size === 'large' ? 'the site profile says large' : `the sitemap lists ${boot.sitemapUrls} URLs`, true);
        }
        if (result === 'bot-check') {
          blocked = true;
          this.emitEvent({ type: 'error', timestamp: new Date().toISOString(), data: { error: `This site showed a bot-protection check on ${url}. The crawler does not bypass these, so crawling stopped. The graph has the ${crawled - 1} page(s) read before the block.` } });
          break;
        }
        if (!result || depth >= maxDepth) continue;
        for (const target of result) {
          if (queued.has(target.id)) continue;
          queued.add(target.id);
          if (skip.some(re => re.test(target.url))) { stats.skipped++; continue; }
          (this.config.readOnly && target.next ? paginationQueue : queue).push(target);
        }
        if (!decided && crawled >= AUTO_PROBE_PAGES) {
          const groups = groupFrontier(queue).groups.length;
          decide(`${groups} frontier groups open after ${crawled} pages`, groups > AUTO_MAX_GROUPS);
        }
        if (queue.length || paginationQueue.length) await page.waitForTimeout(400); // be polite between pages
      }

      const model = this.graph.getModel();
      const pending = Object.values(model.pages).filter(p => p.status === 'not-crawled' && !p.redirectedTo).length;
      model.coverage = {
        remaining: pending,
        reason: blocked ? 'blocked' : !this.running ? 'stopped' : queue.length || paginationQueue.length ? 'page limit' : pending ? 'depth limit' : 'frontier exhausted'
      };
      if (!decided) decide('the crawl ended before the probe', false);
      if (this.running) {
        await enrichModel(model, { llm, isSameSite: this.isSameSite, bootstrap: boot, log: m => this.log(m) });
        model.buildStats = { llmCalls: llm?.calls ?? 0, mode, rounds: stats.rounds, skipped: stats.skipped, deferred: stats.deferred, profile: !!boot?.profile };
      }
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
        next.set(targetId, { id: targetId, url: target.href, depth: depth + 1, next: link.next, label: link.label });
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
