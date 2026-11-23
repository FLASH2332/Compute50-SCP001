import type { Page as PlaywrightPage } from 'playwright';
import crypto from 'node:crypto';
import type { Element } from '../types/graph.js';

export interface ExtractedElementRaw {
  selector: string;
  tag: string;
  role: string;
  text: string;
  name?: string;
  elementType: Element['elementType'];
  isInteractive: boolean;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isDangerous?: boolean;
}

/**
 * Extracts visible interactive elements from the current browser DOM
 */
export async function extractInteractiveElements(
  page: PlaywrightPage,
  stateId: string,
  blockedSelectors: string[] = []
): Promise<Element[]> {
  // Heavy pages (ads, late scripts) can report 0 controls if read too early.
  // A page with zero controls is suspicious: wait for it to settle and retry once.
  const first = await extractOnce(page, stateId, blockedSelectors);
  if (first.length > 0) return first;
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return extractOnce(page, stateId, blockedSelectors);
}

async function extractOnce(
  page: PlaywrightPage,
  stateId: string,
  blockedSelectors: string[]
): Promise<Element[]> {
  const elementsData: ExtractedElementRaw[] = await page.evaluate((blockedList) => {
    const results: ExtractedElementRaw[] = [];

    const isVisible = (el: HTMLElement): boolean => {
      if ((el as any).checkVisibility) {
        return (el as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };

    const dangerousPatterns = /(log\s*out|sign\s*out|delete\s*account|purge|destroy)/i;

    const getOptimalSelector = (el: HTMLElement): string => {
      if (el.hasAttribute('data-testid')) {
        return `[data-testid="${el.getAttribute('data-testid')}"]`;
      }
      if (el.hasAttribute('data-test')) {
        return `[data-test="${el.getAttribute('data-test')}"]`;
      }
      if (el.id && !/(\d{5,}|[a-f0-9]{8}-|ember\d+|react-)/.test(el.id)) {
        return `#${CSS.escape(el.id)}`;
      }
      if (el.getAttribute('name')) {
        return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.getAttribute('name')!)}"]`;
      }
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
      }
      const text = el.innerText?.trim();
      if ((el.tagName === 'BUTTON' || role === 'button') && text && text.length < 30) {
        return `${el.tagName.toLowerCase()}:has-text("${text.replace(/"/g, '\\"')}")`;
      }
      if (el.tagName === 'A' && el.getAttribute('href')) {
        const href = el.getAttribute('href')!;
        if (!href.startsWith('javascript:')) {
          return `a[href="${CSS.escape(href)}"]`;
        }
      }
      const pathParts: string[] = [];
      let curr: HTMLElement | null = el;
      while (curr && curr !== document.body && pathParts.length < 4) {
        let part = curr.tagName.toLowerCase();
        if (curr.className && typeof curr.className === 'string') {
          const mainClass = curr.className.split(/\s+/).find(c => c && !c.includes(':') && !/^\d/.test(c) && c.length < 25);
          if (mainClass) part += `.${CSS.escape(mainClass)}`;
        }
        pathParts.unshift(part);
        curr = curr.parentElement;
      }
      return pathParts.join(' > ') || el.tagName.toLowerCase();
    };

    const candidates = document.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], [tabindex="0"]'
    );

    candidates.forEach((el) => {
      if (!isVisible(el)) return;
      if ((el as HTMLButtonElement).disabled) return;

      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || (
        tag === 'a' ? 'link' :
        tag === 'button' ? 'button' :
        tag === 'input' ? 'input' :
        tag === 'select' ? 'select' :
        'interactive'
      );

      const rawText = el.innerText?.trim() ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        (el as HTMLInputElement).value ||
        '';
      const text = rawText.slice(0, 80);

      let elementType: Element['elementType'] = 'custom';
      if (role === 'button' || tag === 'button') elementType = 'button';
      else if (role === 'link' || tag === 'a') elementType = 'link';
      else if (role === 'tab') elementType = 'tab';
      else if (role === 'menuitem') elementType = 'menuitem';
      else if (tag === 'select') elementType = 'select';
      else if (tag === 'input') {
        const typeAttr = (el as HTMLInputElement).type;
        if (['submit', 'button', 'image', 'reset'].includes(typeAttr)) elementType = 'button';
        else if (typeAttr === 'checkbox') elementType = 'checkbox';
        else if (typeAttr === 'radio') elementType = 'radio';
        else elementType = 'input';
      }

      const selector = getOptimalSelector(el);
      const isBlocked = blockedList && blockedList.some(b => selector.includes(b) || (text && text.toLowerCase().includes(b.toLowerCase())));
      if (isBlocked) return;

      const isDangerous = dangerousPatterns.test(text) || dangerousPatterns.test(selector);

      results.push({
        selector,
        tag,
        role,
        text,
        name: el.getAttribute('name') || undefined,
        elementType,
        isInteractive: true,
        boundingBox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        isDangerous
      });
    });

    return results;
  }, blockedSelectors).catch((err) => {
    console.error('extractInteractiveElements evaluate error:', err);
    return [];
  });

  const safeElements = elementsData.filter(e => !e.isDangerous);

  // Group repeated controls (e.g. one "Edit" button per table row, or product
  // links /item/1, /item/2 ...) into ONE representative element with a count.
  // Similar selector templates group only when their visible labels match.
  const norm = (v: string) => v.replace(/\d+/g, '#');
  const groups = new Map<string, { raw: typeof safeElements[number]; count: number }>();
  for (const raw of safeElements) {
    const key = [raw.tag, raw.role, norm(raw.selector), raw.text.toLowerCase()].join('|');
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { raw, count: 1 });
  }

  return Array.from(groups.values()).map(({ raw, count }) => {
    const rawKey = `${stateId}:${raw.tag}:${raw.role}:${raw.selector}:${raw.text}`;
    const elementId = 'elem_' + crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16);

    return {
      id: elementId,
      stateId,
      selector: raw.selector,
      tag: raw.tag,
      role: raw.role,
      text: raw.text,
      name: raw.name,
      elementType: raw.elementType,
      isInteractive: raw.isInteractive,
      boundingBox: raw.boundingBox,
      groupSize: count
    };
  });
}
