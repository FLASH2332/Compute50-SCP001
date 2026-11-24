import type { Page as PlaywrightPage } from 'playwright';

/**
 * Waits until a page is "ready to read": HTML parsed, stylesheets applied and
 * the set of visible controls stopped changing. Slow or ad-heavy sites keep
 * the network busy forever, so we do NOT wait for network idle alone; we wait
 * for the visible page to be stable, with a hard cap so a crawl never hangs.
 */
export async function waitForPageReady(page: PlaywrightPage, maxMs = 10000): Promise<void> {
  const deadline = Date.now() + maxMs;
  const left = () => Math.max(0, deadline - Date.now());

  await page.waitForLoadState('domcontentloaded', { timeout: left() }).catch(() => {});
  await page.waitForFunction(
    () => Array.from(document.styleSheets).length >= document.querySelectorAll('link[rel="stylesheet"]').length,
    null,
    { timeout: Math.min(4000, left()) }
  ).catch(() => {});

  // Count visible controls until two readings 500 ms apart agree (and are > 0),
  // or the deadline passes.
  let previous = -1;
  while (left() > 0) {
    const count = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) n++;
      });
      return n;
    }).catch(() => -1);
    if (count > 0 && count === previous) return;
    previous = count;
    await page.waitForTimeout(Math.min(500, left()));
  }
}

/**
 * Opens a URL with retries. Slow sites (or a site briefly refusing us) get
 * up to `attempts` tries with a longer timeout before the crawl gives up.
 */
export async function gotoWithRetry(page: PlaywrightPage, url: string, attempts = 3, timeout = 45000): Promise<void> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await waitForPageReady(page);
      return;
    } catch (err) {
      lastError = err;
      if (i < attempts) await page.waitForTimeout(2000 * i);
    }
  }
  const reason = lastError instanceof Error ? lastError.message.split('\n')[0] : String(lastError);
  throw new Error(`Could not open ${url} after ${attempts} attempts: ${reason}`);
}
