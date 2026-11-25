/**
 * The live browser behind open_page / perform / fill. It is read-only: every request that is not GET/HEAD/OPTIONS is
 * blocked, and so is any navigation off the site. The agent never sees anything from it except which URL it is on
 * and how many elements a locator matched.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { config } from '../config.js';

export interface LocateResult {
  locator?: Locator;
  used?: string;                         // the locator string that worked
  tried: { locator: string; matches: number }[];
}

function sameSite(url: string, host: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === host || h.endsWith('.' + host) || host.endsWith('.' + h);
  } catch {
    return false;
  }
}

export class LiveBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(private host: string) {}

  async current(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.browser ??= await chromium.launch({ headless: config.browser.headless, channel: config.browser.channel });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await this.context.addInitScript('globalThis.__name = (t) => t;');
    await this.context.route('**/*', route => {
      const req = route.request();
      const okMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method());
      const okNav = !req.isNavigationRequest() || req.frame() !== this.page?.mainFrame() || sameSite(req.url(), this.host);
      return okMethod && okNav ? route.fallback() : route.abort();
    });
    this.page = await this.context.newPage();
    // Links that open a new tab: follow them in the same tab instead.
    this.context.on('page', async p => {
      if (p === this.page) return;
      const url = p.url() !== 'about:blank' ? p.url() : await p.waitForURL(u => u.href !== 'about:blank', { timeout: 5000 }).then(() => p.url()).catch(() => '');
      await p.close().catch(() => undefined);
      if (url && sameSite(url, this.host)) await this.page?.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    });
    return this.page;
  }

  url(): string | undefined {
    return this.page && !this.page.isClosed() ? this.page.url() : undefined;
  }

  async goto(url: string): Promise<string> {
    const page = await this.current();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.settle(page);
    return page.url();
  }

  async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: config.browser.settleMs + 2000 }).catch(() => undefined);
    await page.waitForTimeout(Math.min(800, config.browser.settleMs));
  }

  /** Builds a Playwright locator from one stored locator string. */
  private build(page: Page, spec: string, item?: string): Locator {
    const m = /^(role|testid|css|text|item)=(.*)$/s.exec(spec);
    if (!m) return page.locator(spec);
    const [, kind, rest] = m;
    if (kind === 'role') {
      const [role, ...name] = rest.split('|name=');
      return page.getByRole(role as any, name.length ? { name: name.join('|name='), exact: true } : {});
    }
    if (kind === 'testid') return page.getByTestId(rest);
    if (kind === 'text') return page.getByText(rest, { exact: true });
    if (kind === 'item') return item ? page.locator(rest).filter({ hasText: item }) : page.locator(rest);
    return page.locator(rest);
  }

  /** Tries the locators in order; the first that finds exactly one visible element (or several identical ones) wins. */
  async locate(specs: string[], item?: string): Promise<LocateResult> {
    const page = await this.current();
    const tried: LocateResult['tried'] = [];
    for (const spec of specs) {
      let loc: Locator;
      try {
        loc = this.build(page, spec, item).filter({ visible: true });
      } catch {
        tried.push({ locator: spec, matches: -1 });
        continue;
      }
      const n = await loc.count().catch(() => -1);
      tried.push({ locator: spec, matches: n });
      if (n === 1) return { locator: loc.first(), used: spec, tried };
      if (n > 1 && n <= 8) {
        const texts = await loc.evaluateAll(els => els.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase())).catch(() => []);
        if (texts.length && texts.every(t => t === texts[0])) return { locator: loc.first(), used: spec, tried };
        if (item) return { locator: loc.first(), used: spec, tried };
      }
    }
    return { tried };
  }

  async click(loc: Locator): Promise<void> {
    const page = await this.current();
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
    await loc.click({ timeout: 8000 });
    await this.settle(page);
  }

  async fill(loc: Locator, text: string, submit: boolean): Promise<void> {
    const page = await this.current();
    const tag = await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') await loc.selectOption({ label: text }, { timeout: 8000 }).catch(() => loc.selectOption(text, { timeout: 8000 }));
    else await loc.fill(text, { timeout: 8000 });
    if (submit) {
      await loc.press('Enter', { timeout: 5000 }).catch(() => undefined);
      await this.settle(page);
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
  }
}
