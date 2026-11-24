import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import type { Interaction, SectionAction } from './types.js';

/** Installed before site scripts in the read-only explorer and recorder, including in frames. */
export function preventFormSubmission() {
  window.addEventListener('submit', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  // Direct submit() bypasses the submit event, including for GET forms.
  HTMLFormElement.prototype.submit = function () {};
  HTMLFormElement.prototype.requestSubmit = function () {};
}

/**
 * Cookie/consent banners cover the page in screenshots and video. We always
 * pick the most privacy-preserving choice: click "Decline"/"Reject" when it
 * exists; otherwise the banner is only hidden from view (never "Accept").
 */
export async function dismissCookieBanner(page: Page, waitMs = 2500): Promise<'declined' | 'hidden' | null> {
  // Banners often appear a moment after load (after scripts run): keep looking briefly
  let found = await findCookieBanner(page);
  for (let waited = 0; !found && waited < waitMs; waited += 500) {
    await page.waitForTimeout(500);
    found = await findCookieBanner(page);
  }
  return applyCookieChoice(page, found);
}

async function findCookieBanner(page: Page): Promise<'decline' | 'hide' | null> {
  return page.evaluate(() => {
    const isBanner = (el: Element) => /cookie|consent|privacy|gdpr|tracking/i.test((el.textContent || '').slice(0, 600));
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
    for (const b of buttons) {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim();
      if (!/^(decline|reject|reject all|decline all|deny|only necessary|necessary only|use necessary cookies only|refuse)$/i.test(label) || !visible(b)) continue;
      let box: Element | null = b.parentElement;
      for (let i = 0; box && i < 6 && !isBanner(box); i++) box = box.parentElement;
      if (box) { b.setAttribute('data-demo-cookie', 'decline'); return 'decline'; }
    }
    // No decline option: find a small fixed/sticky box that talks about cookies and hide it
    const candidates = Array.from(document.querySelectorAll('div, section, aside, dialog, [role="dialog"]')) as HTMLElement[];
    for (const el of candidates) {
      const cs = getComputedStyle(el);
      if (!['fixed', 'sticky'].includes(cs.position) || !visible(el) || !isBanner(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height > innerHeight * 0.7 && r.width > innerWidth * 0.9 && !/cookie/i.test(el.textContent || '')) continue;
      el.setAttribute('data-demo-cookie', 'hide');
      return 'hide';
    }
    return null;
  }).catch(() => null);
}

async function applyCookieChoice(page: Page, found: 'decline' | 'hide' | null): Promise<'declined' | 'hidden' | null> {
  if (found === 'decline') {
    await page.locator('[data-demo-cookie="decline"]').first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
    // If the click was blocked (e.g. consent POST refused in read-only mode), hide the banner instead
    const still = await page.locator('[data-demo-cookie="decline"]').first().isVisible().catch(() => false);
    if (!still) return 'declined';
  }
  if (found) {
    await page.evaluate(() => {
      const b = document.querySelector('[data-demo-cookie]');
      let box: HTMLElement | null = b as HTMLElement | null;
      if (b?.getAttribute('data-demo-cookie') === 'decline') {
        for (let i = 0; box && i < 6; i++) {
          const cs = getComputedStyle(box);
          if (['fixed', 'sticky'].includes(cs.position)) break;
          box = box.parentElement;
        }
      }
      if (box) box.style.setProperty('display', 'none', 'important');
    }).catch(() => {});
    return 'hidden';
  }
  return null;
}

const DANGEROUS = /\b(delete|remove|log ?out|sign ?out|pay|buy|purchase|order|checkout|subscribe|unsubscribe|send|submit|confirm|accept|decline|reject|report|block|flag|vote|cancel)\b/i;

// Sign-in / OAuth buttons are never probed (they start a login flow)
const AUTH = /\b(continue with|sign (in|up) with|log ?in with|login|log ?in|sign ?in)\b/i;
// Main calls to action are probed first: they are what a demo shows
const CTA = /\b(register|get started|start|sign ?up|join|try|demo|book|create|apply|explore|learn more|open|new)\b/i;

/** Controls worth clicking: buttons and tabs (not form submits, not risky or login actions). */
export function clickCandidates(actions: SectionAction[], max: number): SectionAction[] {
  const seen = new Set<string>();
  return actions
    .filter(a => (a.type === 'button' || a.type === 'tab') && a.visible && !a.groupSize && !DANGEROUS.test(a.label) && !AUTH.test(a.label) && a.label.length <= 60)
    .filter(a => { const k = a.label.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => Number(CTA.test(b.label)) - Number(CTA.test(a.label)))
    .slice(0, max);
}

/** The control to click: the only visible match, or the first of several identical ones (same text). */
export async function findControl(page: Page, selector: string): Promise<Locator | undefined> {
  const matches = page.locator(selector).filter({ visible: true });
  const n = await matches.count().catch(() => 0);
  if (n === 1) return matches.first();
  if (n > 1 && n <= 4) {
    const texts = await matches.evaluateAll(els => els.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()));
    if (texts.every(t => t === texts[0])) return matches.first();
  }
}

interface Snapshot { url: string; dialogs: string[]; text: string }
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
    const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
      .filter(el => visible(el) && !el.closest('[class*="google-anno"], ins, .adsbygoogle') && !/cookie|consent/i.test((el.textContent || '').slice(0, 300)))
      .map(el => (el.getAttribute('aria-label') || el.querySelector('h1, h2, h3, h4, [role="heading"]')?.textContent || (el.textContent || '').slice(0, 60)).replace(/\s+/g, ' ').trim());
    return { url: location.href, dialogs, text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 30000) };
  });
}

/**
 * Clicks each candidate control once and records what happened. The caller
 * must run this in a read-only browser context (every non-GET request and
 * off-site navigation blocked), so a click can never change data on the site.
 * The page is reloaded before every click so each result is independent.
 */
export async function probeClicks(
  page: Page,
  pageId: string,
  pageUrl: string,
  candidates: SectionAction[],
  reload: () => Promise<void>,
  pageIdOf: (url: string) => string
): Promise<Interaction[]> {
  const results: Interaction[] = [];
  for (const action of candidates) {
    try {
      await reload();
      await dismissCookieBanner(page, 1500);
      const control = await findControl(page, action.selector);
      if (!control) continue;
      const before = await snapshot(page);
      const expandedBefore = await control.getAttribute('aria-expanded', { timeout: 500 }).catch(() => null);
      await control.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await control.click({ timeout: 3000 });
      await page.waitForTimeout(900);
      const after = await snapshot(page);
      const expandedAfter = await control.getAttribute('aria-expanded', { timeout: 500 }).catch(() => null);

      let kind: Interaction['kind'] = 'nothing';
      let result = '';
      let resultUrl: string | undefined;
      if (pageIdOf(after.url) !== pageIdOf(before.url)) {
        kind = 'navigate';
        resultUrl = after.url;
        result = `Goes to ${new URL(after.url).pathname}`;
      } else {
        const opened = after.dialogs.filter(d => !before.dialogs.includes(d));
        if (opened.length) {
          kind = 'dialog';
          result = `Opens "${opened[0].slice(0, 60)}"`;
        } else if (expandedBefore !== 'true' && expandedAfter === 'true') {
          kind = 'panel';
          result = 'Expands a panel';
        } else if (after.text !== before.text) {
          kind = 'panel';
          const added = after.text.length - before.text.length;
          result = added > 0 ? 'Shows more content' : 'Changes the content on the page';
        }
      }
      const id = 'int_' + createHash('sha256').update(`${pageId}|${action.id}`).digest('hex').slice(0, 16);
      results.push({ id, pageId, actionId: action.id, sectionId: action.sectionId, label: action.label, selector: action.selector, kind, result, resultUrl });
    } catch {
      // A control that can't be clicked (moved, covered, timed out) is skipped
    }
  }
  await reload().catch(() => {});
  await dismissCookieBanner(page);
  return results;
}
