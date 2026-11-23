import type { Page as PlaywrightPage } from 'playwright';
import crypto from 'node:crypto';
import type { UIState, Page } from '../types/graph.js';

export interface StateDetectionResult {
  page: Page;
  state: UIState;
}

/**
 * Normalizes URL by stripping ephemeral tracking/cache-busting parameters
 */
export function normalizeUrl(rawUrl: string): { canonicalUrl: string; path: string; domain: string } {
  try {
    const urlObj = new URL(rawUrl);
    const volatileParams = ['_t', 't', 'timestamp', 'nocache', 'utm_source', 'utm_medium', 'utm_campaign', 'session', 'sid'];
    for (const p of volatileParams) {
      urlObj.searchParams.delete(p);
    }
    if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    const origin = urlObj.origin === 'null' ? '' : urlObj.origin;
    const canonical = origin ? (origin + urlObj.pathname + (urlObj.search || '')) : urlObj.href;
    return {
      canonicalUrl: canonical,
      path: urlObj.pathname + (urlObj.search || ''),
      domain: urlObj.hostname || (origin ? '' : 'local')
    };
  } catch {
    return {
      canonicalUrl: rawUrl,
      path: rawUrl,
      domain: 'unknown'
    };
  }
}

/**
 * URL template for state identity: numeric / uuid / long-hex path segments
 * become ":id" and query values are dropped (keys kept), so /item/1 and /item/2
 * are the same screen template. The Page node still keeps the real URL.
 */
export function urlTemplate(canonicalUrl: string): string {
  try {
    const u = new URL(canonicalUrl);
    const segs = u.pathname.split('/').map(seg =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) ? ':id' : seg
    );
    const keys = [...new Set([...u.searchParams.keys()])].sort();
    return u.origin + segs.join('/') + (keys.length ? '?' + keys.join('&') : '');
  } catch {
    return canonicalUrl;
  }
}

/**
 * Evaluates in-browser DOM landmarks to identify the distinct UI State
 */
export async function detectCurrentUIState(
  page: PlaywrightPage,
  captureScreenshot: boolean = false
): Promise<StateDetectionResult> {
  const currentUrl = page.url();
  const pageTitle = await page.title().catch(() => '');
  const normalized = normalizeUrl(currentUrl);
  // Page identity: the concrete URL (after redirects, since page.url() is the
  // final URL). A same-origin <link rel="canonical"> declared by the site is
  // stronger evidence and wins, so tracking-param variants merge correctly.
  const declaredCanonical = await page
    .evaluate(() => (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || '')
    .catch(() => '');
  let canonicalUrl = normalized.canonicalUrl;
  let canonicalSource: 'url' | 'link-rel-canonical' = 'url';
  if (declaredCanonical) {
    try {
      if (new URL(declaredCanonical).origin === new URL(currentUrl).origin) {
        canonicalUrl = normalizeUrl(declaredCanonical).canonicalUrl;
        canonicalSource = 'link-rel-canonical';
      }
    } catch { /* ignore malformed canonical */ }
  }
  const { path, domain } = normalized;

  const pageEntity: Page = {
    id: canonicalUrl,
    url: currentUrl,
    path,
    title: pageTitle || path,
    domain,
    discoveredAt: new Date().toISOString()
  };

  // Run in-page evaluation to detect structural state condition
  // The page may still be navigating; a failed/empty inspection would create a
  // bogus "empty structure" state, so wait for load and retry once.
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  const inspect = () => page.evaluate(() => {
    const isVisible = (el: HTMLElement | Element): boolean => {
      if ((el as any).checkVisibility) {
        return (el as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };

    // 1. Check for open modals
    const modalSelectors = [
      'dialog[open]',
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.modal.show',
      '.modal.open',
      '.modal.is-active',
      '[data-state="open"][role="dialog"]'
    ];

    let openModalTitle: string | null = null;
    let modalSource: string | null = null;
    let isModalOpen = false;

    for (const sel of modalSelectors) {
      const el = document.querySelector(sel);
      const isAd = el && (el.closest('ins, .adsbygoogle, [data-ad-slot], [data-ad-client], [id^="google_ads"], [id^="aswift"], [id^="div-gpt-ad"]')
        || Array.from(el.querySelectorAll('iframe')).some(f => /doubleclick|googlesyndication|adservice|googleads/i.test((f as HTMLIFrameElement).src)));
      if (el && isVisible(el) && !isAd) {
        isModalOpen = true;
        { const chain: string[] = []; let n: Element | null = el; while (n && n !== document.body && chain.length < 4) { chain.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`); n = n.parentElement; } modalSource = chain.join(' < '); }
        const heading = el.querySelector('h1, h2, h3, h4, [role="heading"], .modal-title, [data-modal-title]');
        if (heading && heading.textContent) {
          openModalTitle = heading.textContent.trim().slice(0, 50);
        } else {
          openModalTitle = (el.getAttribute('aria-label') || el.getAttribute('id') || 'Dialog').trim();
        }
        break;
      }
    }

    // 2. Active tabs
    const activeTabs: string[] = [];
    const tabElements = document.querySelectorAll('[role="tab"][aria-selected="true"], .tab.active, .nav-link.active');
    tabElements.forEach(tab => {
      if (isVisible(tab)) {
        const text = tab.textContent?.trim();
        if (text) activeTabs.push(text.slice(0, 30));
      }
    });

    // 3. Open drawers / expandables
    const expandedSections: string[] = [];
    const expandedEls = document.querySelectorAll('[aria-expanded="true"]:not([role="tab"])');
    expandedEls.forEach(el => {
      if (isVisible(el)) {
        const text = el.textContent?.trim() || el.getAttribute('aria-label') || el.id;
        if (text) expandedSections.push(text.slice(0, 30));
      }
    });

    // 4. Visible alerts / toasts
    const alerts = new Set<string>();
    const alertEls = document.querySelectorAll('[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], .alert, .toast, .flash, #flash, .notification');
    alertEls.forEach(el => {
      if (isVisible(el)) {
        const message = el.cloneNode(true) as Element;
        message.querySelectorAll('button, [role="button"], .close, [data-dismiss], [data-bs-dismiss]')
          .forEach(control => control.remove());
        const text = message.textContent?.replace(/\s+/g, ' ').replace(/\s*\u00d7\s*$/, '').trim();
        if (text) alerts.add(text.slice(0, 160));
      }
    });

    // 5. Form states (step indicators or active form IDs)
    const activeSteps: string[] = [];
    const stepEls = document.querySelectorAll('.step.active, [data-active-step]');
    stepEls.forEach(s => {
      if (isVisible(s)) {
        const text = s.textContent?.trim() || s.getAttribute('data-active-step');
        if (text) activeSteps.push(text.slice(0, 20));
      }
    });

    // Count interactive elements
    const interactiveCandidates = document.querySelectorAll(
      'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"]'
    );
    let interactiveCount = 0;
    interactiveCandidates.forEach(el => {
      if (isVisible(el)) interactiveCount++;
    });

    // Structural skeleton of the main content: tag/role tree (depth <= 4), no text,
    // repeated siblings collapsed, hidden nodes included so expanding/collapsing
    // a panel does not change it. Data rows (10 vs 11 items) collapse to one.
    const root = document.querySelector('main, [role="main"]') || document.body;
    // Leaf controls are skipped too: adding a "Delete" button or a list row is
    // new data on the same screen, not a new screen layout.
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'IFRAME', 'INS',
      'BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'OPTION', 'IMG', 'BR', 'SPAN', 'I', 'B', 'STRONG', 'EM']);
    const skel = (el: Element, depth: number): string => {
      const tag = el.tagName.toLowerCase() + (el.getAttribute('role') ? '#' + el.getAttribute('role') : '');
      if (depth >= 4) return tag;
      const parts: string[] = [];
      let last = '';
      for (const child of Array.from(el.children)) {
        if (skip.has(child.tagName.toUpperCase())) continue;
        if (child.closest('dialog, [role="dialog"], [role="alert"], [role="status"], [aria-live], .toast, .alert, .flash, #flash, .notification, ins, .adsbygoogle, [data-ad-slot], [data-ad-client], [id^="google_ads"], [id^="aswift"], [id^="div-gpt-ad"], .google-auto-placed, [class*="google-auto-placed"], [id^="google_vignette"], .adsbygoogle-noablate, [data-google-query-id], [data-anchor-status]')) continue;
        // Top-level floating/empty containers are injected by ads, chat widgets
        // and cookie bars after load; they are not part of the screen layout.
        if (depth === 0) {
          const cs = getComputedStyle(child);
          const r = child.getBoundingClientRect();
          if (cs.position === 'fixed' || cs.position === 'absolute' || ((r.width === 0 || r.height === 0) && child.children.length === 0)) continue;
        }
        // Containers with no text that only hold ads / embedded frames
        // (auto-inserted ad slots) are not part of the screen layout.
        if (!(child.textContent || '').trim() && child.querySelector('ins, iframe')) continue;
        const sub = skel(child, depth + 1);
        if (sub !== last) parts.push(sub);
        last = sub;
      }
      return parts.length ? `${tag}(${parts.join(',')})` : tag;
    };
    const structure = skel(root, 0);
    // Error / rate-limit pages (served instead of the real page)
    const heading = (document.querySelector('h1, h2')?.textContent || '').trim();
    const errorText = `${document.title} ${heading}`;
    const errorMatch = errorText.match(/(429|500|502|503|504|too many requests|service unavailable|bad gateway|internal server error|access denied|forbidden)/i);
    const errorPage = errorMatch ? (heading || document.title).slice(0, 60) : null;

    return {
      structure,
      errorPage,
      isModalOpen,
      openModalTitle,
      modalSource,
      activeTabs,
      expandedSections,
      alerts: [...alerts],
      activeSteps,
      interactiveCount
    };
  });
  let domInspection = await inspect().catch(() => null);
  if (domInspection?.errorPage) {
    // The site served an error / rate-limit page: wait and reload once.
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    domInspection = await inspect().catch(() => null);
  }
  if (!domInspection || !domInspection.structure) {
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    domInspection = await inspect().catch((err) => {
    console.error('State detection evaluate error:', err);
    return {
      isModalOpen: false,
      openModalTitle: null,
      modalSource: null as string | null,
      activeTabs: [],
      expandedSections: [],
      alerts: [],
      activeSteps: [],
      interactiveCount: 0,
      structure: '',
      errorPage: null as string | null
    };
    });
  }

  // Build landmarks array
  const activeLandmarks: string[] = [];
  if (domInspection.isModalOpen) {
    activeLandmarks.push(`modal:${domInspection.openModalTitle || 'Modal'}`);
  }
  for (const tab of domInspection.activeTabs) {
    activeLandmarks.push(`tab:${tab}`);
  }
  if (domInspection.errorPage) {
    activeLandmarks.push('error-page');
  }
  for (const step of domInspection.activeSteps) {
    activeLandmarks.push(`step:${step}`);
  }
  // Expanded panels and alerts are changes INSIDE a screen, not new screens:
  // they are recorded on the state for display, but never hashed.
  const detailLandmarks: string[] = [
    ...domInspection.expandedSections.map(e => `expanded:${e}`),
    ...domInspection.alerts.map(a => `alert:${a}`)
  ];

  // Generate deterministic state hash
  const structureHash = crypto.createHash('sha256').update(domInspection.structure).digest('hex').slice(0, 12);
  const fragment = new URL(currentUrl).hash;
  const hashRoute = /^#(?:\/|!)/.test(fragment) ? fragment : '';
  const signatureComponents = [
    normalized.canonicalUrl + hashRoute, // Preserve concrete routes even when SEO canonicals match.
    activeLandmarks.sort().join('|'),
    structureHash
  ];
  const domSignature = signatureComponents.join(':::');
  const stateId = 'state_' + crypto.createHash('sha256').update(domSignature).digest('hex').slice(0, 16);

  // Human friendly state name
  let stateName = path === '/' ? '/ (Home)' : path;
  if (domInspection.errorPage) stateName += ` [Error page: ${domInspection.errorPage}]`;
  if (domInspection.isModalOpen) {
    stateName += ` [Modal: ${domInspection.openModalTitle || 'Active'}]`;
  } else if (domInspection.activeTabs.length > 0) {
    stateName += ` [Tab: ${domInspection.activeTabs.join(', ')}]`;
  } else if (domInspection.activeSteps.length > 0) {
    stateName += ` [Step: ${domInspection.activeSteps.join(', ')}]`;
  }

  let screenshotBase64: string | undefined;
  if (captureScreenshot) {
    try {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 50 });
      screenshotBase64 = buffer.toString('base64');
    } catch {
      // Ignore screenshot error
    }
  }

  const uiState: UIState = {
    id: stateId,
    pageId: pageEntity.id,
    name: stateName,
    url: currentUrl,
    isModal: domInspection.isModalOpen,
    modalTitle: domInspection.openModalTitle || undefined,
    modalSource: domInspection.modalSource || undefined,
    activeLandmarks,
    detailLandmarks,
    routeTemplate: urlTemplate(canonicalUrl),
    domSkeleton: domInspection.structure.slice(0, 4000),
    canonicalSource,
    elementCount: domInspection.interactiveCount,
    screenshotBase64,
    domSignature,
    discoveredAt: new Date().toISOString()
  };

  return {
    page: pageEntity,
    state: uiState
  };
}
