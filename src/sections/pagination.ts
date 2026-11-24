import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright';

export async function nextPageButton(page: Page): Promise<Locator | undefined> {
  const buttons = page.locator('button, [role="button"]').filter({ visible: true });
  const matches = await buttons.evaluateAll(elements => elements.flatMap((element, index) => {
    if (element.closest('form, [aria-hidden="true"]') || element.matches(':disabled, [aria-disabled="true"]')) return [];
    const label = (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim();
    const container = element.closest('[aria-label], nav')?.parentElement;
    const nav = element.closest('nav, [role="navigation"], [class*="pagination" i], [data-pagination]');
    const inPager = /paginat|pages/i.test([nav?.getAttribute('aria-label'), nav?.className, container?.getAttribute('aria-label')].join(' '));
    return (/^next page[\s›»→>]*$/i.test(label) || (inPager && /^(next|older|›|»|→)[\s›»→>]*$/i.test(label))) ? [index] : [];
  }));
  // An ambiguous pager requires a more specific graph target.
  if (matches.length === 1) return buttons.nth(matches[0]);
}

export async function paginationSignature(page: Page): Promise<string> {
  const content = await page.evaluate(() => {
    const main = document.querySelector('main, [role="main"]') ?? document.body;
    return (main as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 24000);
  });
  return createHash('sha256').update(page.url() + '\n' + content).digest('hex');
}

export async function pressNextPage(page: Page, button: Locator): Promise<string | undefined> {
  const before = await paginationSignature(page);
  await button.click({ timeout: 3000 });
  for (let check = 0; check < 8; check++) {
    await page.waitForTimeout(350);
    const after = await paginationSignature(page).catch(() => undefined);
    if (after && after !== before) return after;
  }
}
