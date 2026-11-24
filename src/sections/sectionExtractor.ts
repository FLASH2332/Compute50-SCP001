import crypto from 'node:crypto';
import type { Page as PlaywrightPage } from 'playwright';
import type { ActionType, PageSection, SectionAction, SectionRole } from './types.js';

/** Raw data read from the page (in the browser). */
interface RawAction {
  label: string;
  type: ActionType;
  inputType?: string;
  selector: string;
  href?: string;
  visible: boolean;
  path: string;             // tag.class chain of the 3 nearest ancestors (structure)
  itemKey?: string;         // set when inside a repeated card/row: item signature + position in item
  itemId?: number;          // which copy of the repeated item (to drop image+title duplicates)
}
interface RawRegion {
  positionPct: number;
  heightScreens: number;
  regionSelector: string;
  role: SectionRole;
  ariaLabel: string;
  id: string;
  heading: string;
  className: string;
  hidden: boolean;
  actions: RawAction[];
}

export interface ExtractedPage {
  title: string;
  botCheck: boolean;
  regions: RawRegion[];
  links: Array<{ url: string; label: string; next: boolean }>;
}

/**
 * Reads the page's regions and the actions inside each one. Runs entirely in
 * the browser; nothing is clicked, typed or submitted.
 */
export async function readPageRegions(page: PlaywrightPage): Promise<ExtractedPage> {
  return page.evaluate(() => {
    const REGION = 'header, nav, main, aside, footer, form, dialog, section, [role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"], [role="search"], [role="form"], [role="dialog"]';
    const ACTION = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';
    const TEXT_FIELDS = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range', 'file']);

    const roleOf = (el: Element): string | null => {
      const r = el.getAttribute('role');
      const t = el.tagName;
      if (t === 'NAV' || r === 'navigation') return 'nav';
      if (t === 'MAIN' || r === 'main') return 'main';
      if (t === 'ASIDE' || r === 'complementary') return 'sidebar';
      if (t === 'DIALOG' || r === 'dialog') return 'dialog';
      if (t === 'HEADER' || r === 'banner') {
        // <header> inside an article/section/card is a card header, not the page header
        if (t === 'HEADER' && !r && el.parentElement?.closest('article, section, aside, nav, li')) return null;
        return 'header';
      }
      if (t === 'FOOTER' || r === 'contentinfo') {
        if (t === 'FOOTER' && !r && el.parentElement?.closest('article, section, aside, nav, li')) return null;
        return 'footer';
      }
      if (t === 'SECTION') {
        // A titled block of the page ("Prizes", "Judging", "FAQ") is a section
        // of its own; untitled <section> wrappers are ignored.
        return el.querySelector('h1, h2, h3') || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'content' : null;
      }
      if (t === 'FORM' || r === 'search' || r === 'form') {
        // Only forms with something to fill in are their own section; a form
        // that is just one "Add to cart" button stays part of its parent.
        return el.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), select, textarea') ? 'form' : null;
      }
      return null;
    };

    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };

    const clean = (s: string | null | undefined, n = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

    const labelOf = (el: Element): string => {
      const id = el.id;
      const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : '';
      const img = el.querySelector('img[alt]')?.getAttribute('alt');
      // innerText keeps the spaces between lines; textContent keeps the real
      // casing (CSS text-transform makes innerText ALL CAPS). Use the best of both.
      const it = clean((el as HTMLElement).innerText);
      const tc = clean(el.textContent);
      const text = it && it === it.toUpperCase() && tc && tc !== tc.toUpperCase()
        && it.replace(/\s/g, '').toLowerCase() === tc.replace(/\s/g, '').toLowerCase() ? tc : (it || tc);
      let target = '';
      if (el.tagName === 'A') {
        try { const u = new URL((el as HTMLAnchorElement).href); target = u.pathname === '/' ? `link to ${u.host} home` : `link to ${u.pathname}`; } catch { /* none */ }
      }
      return clean(el.getAttribute('aria-label'))
        || text
        || clean(forLabel)
        || clean((el as HTMLInputElement).value && ['submit', 'button', 'reset'].includes((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : '')
        || clean(el.getAttribute('placeholder'))
        || clean(el.getAttribute('title'))
        || clean(img)
        || clean(el.getAttribute('name'))
        || target
        || el.tagName.toLowerCase();
    };

    const selectorOf = (el: Element, label: string): string => {
      const tag = el.tagName.toLowerCase();
      for (const attr of ['data-testid', 'data-test', 'id', 'name', 'aria-label']) {
        const v = el.getAttribute(attr);
        if (v && v.length < 60) return attr === 'id' ? `#${CSS.escape(v)}` : `${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`;
      }
      if (tag === 'a') {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('javascript:')) return `a[href="${href.replace(/"/g, '\\"')}"]`;
      }
      if (label && label.length < 40) return `${tag}:has-text("${label.replace(/"/g, '\\"')}")`;
      return tag;
    };

    const pathOf = (el: Element): string => {
      const parts: string[] = [];
      let n: Element | null = el;
      for (let i = 0; n && i < 3; i++, n = n.parentElement) {
        const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(c => c && !/\d/.test(c)).slice(0, 2).join('.') : '';
        parts.unshift(n.tagName.toLowerCase() + (cls ? '.' + cls : ''));
      }
      return parts.join('>');
    };

    const typeOf = (el: Element): { type: string; inputType?: string } | null => {
      const tag = el.tagName;
      const role = el.getAttribute('role');
      if (role === 'tab') return { type: 'tab' };
      if (tag === 'A') return { type: 'link' };
      if (tag === 'SELECT') return { type: 'select' };
      if (tag === 'TEXTAREA') return { type: 'input', inputType: 'textarea' };
      if (tag === 'INPUT') {
        const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
        if (['submit', 'image'].includes(t)) return { type: 'submit' };
        if (['button', 'reset'].includes(t)) return { type: 'button' };
        if (t === 'checkbox' || t === 'radio') return { type: 'choice', inputType: t };
        return TEXT_FIELDS.has(t) ? { type: 'input', inputType: t } : { type: 'input', inputType: t };
      }
      if (tag === 'BUTTON') {
        const button = el as HTMLButtonElement;
        return { type: button.type === 'submit' && button.form ? 'submit' : 'button' };
      }
      if (role === 'link' || role === 'menuitem') return { type: el.getAttribute('href') ? 'link' : 'button' };
      return { type: 'button' };
    };

    // 1. Regions
    const regionEls: Element[] = [];
    document.querySelectorAll(REGION).forEach(el => { if (roleOf(el)) regionEls.push(el); });
    const regionSet = new Set(regionEls);
    const byRegion = new Map<Element, RawAction[]>();

    // Actions outside every region are grouped by their top-level block.
    // Many sites wrap the whole page in single-child wrappers (#root, #app,
    // <center><table><tbody>), so first step down to where the layout splits.
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);
    const kids = (n: Element) => Array.from(n.children).filter(c => !SKIP_TAGS.has(c.tagName));
    let layoutRoot: Element = document.body;
    for (let i = 0; i < 12; i++) {
      const k = kids(layoutRoot);
      if (k.length !== 1) break;
      layoutRoot = k[0];
    }
    const topBlock = (el: Element): Element => {
      let n: Element = el;
      while (n.parentElement && n.parentElement !== layoutRoot && n.parentElement !== document.body) n = n.parentElement;
      return n;
    };

    // Repeated items: an ancestor that has >= 4 sibling copies (same tag and
    // class) and holds more than this one control (an image, other controls or
    // extra text). Product cards and story rows qualify; plain menus don't.
    const itemIds = new Map<Element, number>();
    const repeatedItem = (el: Element, stop: Element | null): { key: string; id: number } | null => {
      let a: Element | null = el.parentElement;
      for (let depth = 0; a && a !== stop && a !== document.body && depth < 6; depth++, a = a.parentElement) {
        const parent = a.parentElement;
        if (!parent) break;
        const cls = typeof a.className === 'string' ? a.className : '';
        const twins = Array.from(parent.children).filter(c => c.tagName === a!.tagName && (typeof c.className === 'string' ? c.className : '') === cls).length;
        if (twins < 4) continue;
        const ownText = (el.textContent || '').trim().length;
        const rich = !!a.querySelector('img') || a.querySelectorAll(ACTION).length >= 2 || ((a.textContent || '').trim().length - ownText) > 20;
        if (!rich) continue;
        let pos = '';
        for (let n: Element | null = el; n && n !== a; n = n.parentElement) {
          const same = n.parentElement ? Array.from(n.parentElement.children).filter(c => c.tagName === n!.tagName) : [n];
          pos = `${n.tagName.toLowerCase()}:${same.indexOf(n) + 1}` + (pos ? '>' + pos : '');
        }
        if (!itemIds.has(a)) itemIds.set(a, itemIds.size + 1);
        return { key: `${a.tagName.toLowerCase()}.${cls.trim().split(/\s+/).slice(0, 2).join('.')}|${pos}`, id: itemIds.get(a)! };
      }
      return null;
    };
    const fallbackRole = new Map<Element, string>();

    // 2. Actions, each assigned to its nearest region
    document.querySelectorAll(ACTION).forEach(el => {
      if (el.closest('[aria-hidden="true"]') && !el.closest('dialog, [role="dialog"]')) return;
      if ((el as HTMLButtonElement).disabled) return;
      const kind = typeOf(el);
      if (!kind) return;
      let owner: Element | null = el.parentElement;
      while (owner && !regionSet.has(owner)) owner = owner.parentElement;
      if (!owner) {
        owner = topBlock(el);
        if (owner === document.body || owner === document.documentElement) return;
        fallbackRole.set(owner, 'content');
      }
      const label = labelOf(el);
      let href: string | undefined;
      if (kind.type === 'link') {
        const raw = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
        if (raw && !/^(javascript|mailto|tel):/i.test(raw)) href = raw.replace(/#(?![\/!]).*$/, '') || undefined;
        if (!href && /^(mailto|tel):/i.test(raw)) href = raw;
      }
      const list = byRegion.get(owner) || [];
      const item = repeatedItem(el, owner);
      list.push({ label, type: kind.type as any, inputType: kind.inputType, selector: selectorOf(el, label), href, visible: visible(el), path: pathOf(el), itemKey: item?.key, itemId: item?.id });
      byRegion.set(owner, list);
    });

    // 3. Build regions in page order
    const all = [...regionEls, ...fallbackRole.keys()];
    all.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    // A region's own heading: the first heading whose nearest region is this
    // one (a heading inside a nested section belongs to that section).
    const ownHeading = (el: Element): string => {
      for (const h of Array.from(el.querySelectorAll('h1, h2, h3, h4, legend'))) {
        let inItem = false;
        for (const it of itemIds.keys()) if (it.contains(h) && el.contains(it) && it !== el) { inItem = true; break; }
        if (inItem) continue;
        let o = h.parentElement;
        while (o && o !== el && !regionSet.has(o)) o = o.parentElement;
        if (o === el) return clean(h.textContent, 50);
      }
      return '';
    };
    const geometry = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const parts: string[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) {
          parts.unshift('#' + CSS.escape(n.id));
          break;
        }
        let index = 1;
        for (let prev = n.previousElementSibling; prev; prev = prev.previousElementSibling) {
          if (prev.localName === n.localName) index++;
        }
        parts.unshift(CSS.escape(n.localName) + ':nth-of-type(' + index + ')');
      }
      return {
        positionPct: Math.min(100, Math.max(0, 100 * (rect.top + scrollY) / Math.max(innerHeight, (document.scrollingElement ?? document.documentElement).scrollHeight))),
        heightScreens: rect.height / Math.max(1, innerHeight),
        regionSelector: parts.join(' > ')
      };
    };
    const candidates: RawRegion[] = all.map(el => ({
      ...geometry(el),
      role: (roleOf(el) || fallbackRole.get(el) || 'content') as any,
      ariaLabel: clean(el.getAttribute('aria-label'), 50),
      id: clean(el.id, 50),
      // A form with no title of its own takes the title of the block it sits in
      heading: ownHeading(el)
        || (el.tagName === 'FORM' ? clean(el.closest('section, article, aside, dialog')?.querySelector('h1, h2, h3, h4')?.textContent, 50) : ''),
      className: clean(typeof el.className === 'string' ? el.className.split(/\s+/)[0] : '', 50),
      hidden: !visible(el),
      actions: byRegion.get(el) || []
    }));
    const namedControls = new Set(candidates.filter(region => region.actions.length > 0)
      .map(region => region.ariaLabel || region.heading || region.id));
    const regions = candidates.filter(region => region.actions.length > 0 || region.role === 'dialog' ||
      region.role === 'form' || (!region.hidden && region.heading && !namedControls.has(region.heading)));

    // Bot-protection pages are recognised and reported, never bypassed.
    const head = `${document.title} ${(document.body?.innerText || '').slice(0, 400)}`;
    const botCheck = /just a moment|performing security verification|verify you are (a )?human|checking your browser|attention required|are you a robot/i.test(head)
      || !!document.querySelector('#challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha');

    // Retain every link for discovery, independently of action display grouping.
    const links = [...document.querySelectorAll<HTMLAnchorElement | HTMLLinkElement>('a[href], link[rel~="next"][href]')]
      .filter(el => el.tagName === 'LINK' || (!el.closest('[aria-hidden="true"]') && !el.hasAttribute('download')))
      .map(el => {
        const label = el.tagName === 'LINK' ? 'Next page' : labelOf(el);
        const next = el.relList.contains('next') || /^(next(?: page)?|older(?: posts)?)[\s›»→>]*$/i.test(label);
        return { url: el.href, label, next };
      });
    return { title: document.title, botCheck, regions, links };
  });
}

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Groups repeated links (cards in a list, one link per product/event) so a
 * section of 40 hackathon cards becomes a few examples + a count.
 *
 * Grouped: links at the same spot in a repeated card/row (product cards,
 * story rows), the same label repeated, or paths differing only by a number
 * segment (/item/1, /item/2). Menus (one link per list item) are never
 * grouped, so navigation is not lost.
 */
const GROUP_MIN = 6;
const GROUP_KEEP = 3;
function hrefTemplate(href: string): string | null {
  try {
    const u = new URL(href);
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.some(seg => /^\d+$/.test(seg))) return null;
    return u.host + '/' + segs.map(seg => (/^\d+$/.test(seg) ? '#' : seg)).join('/');
  } catch {
    return null;
  }
}

export function buildSections(pageId: string, regions: RawRegion[], isSameSite: (url: string) => boolean, canonical: (url: string) => string): { sections: PageSection[]; actions: SectionAction[] } {
  const sections: PageSection[] = [];
  const actions: SectionAction[] = [];
  const usedNames = new Set<string>();
  const roleCount: Record<string, number> = {};

  regions.forEach((region, order) => {
    roleCount[region.role] = (roleCount[region.role] || 0) + 1;
    // Prefer names a person would use; a CSS class ("sticky", "flex") is only a
    // last resort, replaced by the section's first action labels.
    const firstLabels = region.actions.filter(a => a.label).slice(0, 2).map(a => a.label.slice(0, 20)).join(', ');
    const generic = /^(root|app|__next|__nuxt|wrapper|container|content|main|page|layout|site|body|inner|outer)([-_].*)?$/i;
    const usableId = region.id && !/^[a-z]+[-_]?\d+$|^:r/i.test(region.id) && !generic.test(region.id) ? region.id : '';
    const usableClass = region.className && !generic.test(region.className) && !/^(flex|grid|sticky|relative|absolute|fixed|block|hidden|w-|h-|p[xytblr]?-|m[xytblr]?-)/.test(region.className) ? region.className : '';
    // A block made mostly of repeated cards/rows is named for what it is
    const items = new Set(region.actions.filter(a => a.itemId).map(a => a.itemId));
    const mostlyItems = items.size > GROUP_MIN && region.actions.filter(a => a.itemId).length >= region.actions.length * 0.6;
    let name = region.ariaLabel || region.heading || usableId
      || (mostlyItems ? `list of ${items.size} items` : '')
      || (firstLabels ? `${region.role}: ${firstLabels}` : '') || usableClass || `${region.role}-${roleCount[region.role]}`;
    const base = name;
    for (let n = 2; usedNames.has(name); n++) name = `${base} (${n})`;
    usedNames.add(name);
    const sectionId = 'sec_' + hash(`${pageId}|${name}`);

    // 1. Drop exact duplicates (same type + label + target), preferring visible
    //    ones, and a second link to the same place inside one card (image + title).
    const unique = new Map<string, RawAction>();
    const seenInItem = new Set<string>();
    for (const a of region.actions) {
      if (a.itemId && a.href) {
        const k = `${a.itemId}|${a.href}`;
        if (seenInItem.has(k)) continue;
        seenInItem.add(k);
      }
      const key = `${a.type}|${a.label.toLowerCase()}|${a.href || a.selector}`;
      const prev = unique.get(key);
      if (!prev || (!prev.visible && a.visible)) unique.set(key, a);
    }
    const list = [...unique.values()];

    // 2. Group repeats (more than GROUP_MIN copies): same spot in a repeated
    //    card/row, the same label over and over ("hide", "Add to basket"), or
    //    addresses that differ only by numbers (/item/1, /item/2).
    const groups = new Map<string, RawAction[]>();
    const add = (key: string, a: RawAction) => groups.set(key, [...(groups.get(key) || []), a]);
    for (const a of list) {
      // Links in repeated cards/rows are a catalog (books, stories): group them.
      // Buttons with different labels (FAQ questions, tabs) each mean something
      // different, so they are only grouped when the label repeats too.
      if (a.itemKey && a.type === 'link') add(`item|${a.type}|${a.itemKey}`, a);
      else if (a.type === 'link' && a.href && hrefTemplate(a.href)) add(`tpl|${a.path}|${hrefTemplate(a.href)}`, a);
      else add(`label|${a.type}|${a.path}|${a.label.toLowerCase()}`, a);
    }
    const dropped = new Set<RawAction>();
    const groupSizeOf = new Map<RawAction, number>();
    for (const g of groups.values()) {
      if (g.length <= GROUP_MIN) continue;
      g.slice(GROUP_KEEP).forEach(a => dropped.add(a));
      g.slice(0, GROUP_KEEP).forEach(a => groupSizeOf.set(a, g.length));
    }
    const kept = list.filter(a => !dropped.has(a));

    const idCount: Record<string, number> = {};
    for (const a of kept) {
      const baseId = 'act_' + hash(`${sectionId}|${a.type}|${a.label}|${a.href || a.selector}`);
      idCount[baseId] = (idCount[baseId] || 0) + 1;
      const id = idCount[baseId] > 1 ? `${baseId}_${idCount[baseId]}` : baseId;
      const internal = a.href && /^https?:/i.test(a.href) ? isSameSite(a.href) : undefined;
      actions.push({
        id,
        sectionId,
        label: a.label,
        type: a.type,
        inputType: a.inputType,
        selector: a.selector,
        href: a.href,
        navigatesTo: internal ? canonical(a.href!) : undefined,
        external: a.href && /^https?:/i.test(a.href) ? !internal : undefined,
        visible: a.visible,
        groupSize: groupSizeOf.get(a)
      });
    }

    sections.push({
      id: sectionId,
      pageId,
      name,
      role: region.role,
      positionPct: region.positionPct,
      heightScreens: region.heightScreens,
      regionSelector: region.regionSelector,
      order,
      hidden: region.hidden,
      actionCount: kept.length,
      totalActions: list.length,
      summary: summarize(region.role, kept, list.length)
    });
  });

  return { sections, actions };
}

/** Plain, factual description of a section (no AI): what a visitor can do there. */
function summarize(role: SectionRole, kept: RawAction[], total: number): string {
  const count = (t: ActionType) => kept.filter(a => a.type === t).length;
  const parts: string[] = [];
  const links = count('link');
  if (links) parts.push(`${total > kept.length ? total : links} link${links === 1 ? '' : 's'}`);
  const fields = kept.filter(a => a.type === 'input' || a.type === 'select' || a.type === 'choice');
  if (fields.length) parts.push(`fields: ${fields.slice(0, 4).map(f => f.label).join(', ')}${fields.length > 4 ? '…' : ''}`);
  const buttons = kept.filter(a => a.type === 'button' || a.type === 'submit' || a.type === 'tab');
  if (buttons.length) parts.push(`buttons: ${buttons.slice(0, 4).map(b => b.label).join(', ')}${buttons.length > 4 ? '…' : ''}`);
  return `${role}: ${parts.join('; ') || 'no actions'}`;
}
