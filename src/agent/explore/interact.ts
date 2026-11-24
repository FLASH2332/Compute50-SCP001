import { chromium } from 'playwright';
import type { AppMap, Control, UiState } from '../core/appMap.js';
import type { BrowserHooks, Logger } from '../core/ports.js';
import { describeLocator, norm } from '../nav/locate.js';
import { readUi, stateIdFor, type UiReading } from '../nav/locateState.js';
import { modeFor, riskOf } from '../nav/risk.js';
import { gotoWithRetry, settle } from '../util/pageReady.js';

export interface ExploreOptions {
  maxDepth?: number;          // clicks from a page's base state (default 2)
  maxClicksPerPage?: number;  // default 60 (8 on public sites)
  maxPages?: number;          // pages to explore (default 50, 8 on public sites)
  headless?: boolean;
  browserChannel?: string;
  storageState?: string;
  hooks?: BrowserHooks;
  log?: Logger;
}

/** Gives every control its risk class. */
export function classifyRisk(map: AppMap): void {
  for (const c of Object.values(map.controls)) c.risk = riskOf(c, c.section?.role);
}

/**
 * Deepens an AppMap: clicks every safe button and tab (allow-listed hosts
 * only), records which UI state it leads to, and links states with edges.
 * Every non-GET request is aborted, so nothing can be saved or sent even if
 * a "safe" guess was wrong. Fields are never filled.
 *
 * Also corrects field labels from the live page (a <select> is named by its
 * <label>, not its options), keeping the graph source's label as an alias.
 */
export async function exploreInteractions(map: AppMap, opts: ExploreOptions = {}) {
  const log = opts.log || (() => {});
  // Public sites: a lighter pass (fewer clicks per page, one level deep, fewer pages)
  const pub = modeFor(map.startUrl) === 'public';
  const maxDepth = opts.maxDepth ?? (pub ? 1 : 2);
  const maxClicks = opts.maxClicksPerPage ?? (pub ? 8 : 60);
  classifyRisk(map);
  const pages = Object.values(map.pages).slice(0, opts.maxPages ?? (pub ? 8 : 50));

  const blocked: string[] = [];
  const browser = await chromium.launch({ headless: opts.headless ?? true, channel: opts.browserChannel || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState: opts.storageState, serviceWorkers: 'block' });
    await context.addInitScript('globalThis.__name = (t) => t;');
    for (const s of opts.hooks?.exploreInitScripts || []) await context.addInitScript(s);
    await context.route('**/*', route => {
      const m = route.request().method();
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
      blocked.push(`${m} ${route.request().url()}`);
      return route.abort();
    });
    const page = await context.newPage();
    const visibleIds = async (own: Control[]) => {
      const out: string[] = [];
      for (const c of own) {
        const loc = page.locator(c.selector).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        out.push(c.id);
        if (c.type === 'input' || c.type === 'select') {
          const d = await describeLocator(loc);
          if (d?.label && norm(d.label) !== norm(c.label)) { c.aliases = [...new Set([...(c.aliases || []), c.label])]; c.label = d.label; }
        }
      }
      return out;
    };
    const register = async (r: UiReading): Promise<UiState> => {
      const owner = map.pageByTemplate(r.template);
      return map.addState({
        id: stateIdFor(r), template: r.template, pageId: owner?.id || '', url: owner?.url || r.url, title: r.title,
        dialog: r.dialog, tab: r.tab, visibleActions: owner ? await visibleIds(map.controlsOfPage(owner.id)) : []
      });
    };

    for (const p of pages) {
      const own = map.controlsOfPage(p.id);
      const byId = new Map(own.map(a => [a.id, a]));
      const load = async (path: string[]) => {
        await gotoWithRetry(page, p.url, 2, 30000);
        await opts.hooks?.afterLoad?.(page);
        for (const id of path) {
          await page.locator(byId.get(id)!.selector).first().click({ timeout: 3000 });
          await settle(page);
        }
      };
      try { await load([]); } catch (e) { log(`  could not open ${p.url}: ${(e as Error).message.split('\n')[0]}`); continue; }
      const base = await register(await readUi(page));
      base.base = true;
      delete base.seeded;
      // A seeded base state with another id (e.g. no tab info) points at the real one
      for (const s of Object.values(map.states)) if (s.seeded && s.template === base.template && !s.dialog && s.id !== base.id) s.base = false;
      log(`Exploring ${p.url}: base state ${base.id}`);

      const queue: { path: string[]; state: UiState; depth: number }[] = [{ path: [], state: base, depth: 0 }];
      const seen = new Set([base.id]);
      let clicks = 0;
      let here = base.id;
      while (queue.length && clicks < maxClicks) {
        const { path, state, depth } = queue.shift()!;
        if (depth >= maxDepth) continue;
        const inBase = new Set(base.visibleActions);
        const clickable = state.visibleActions.map(id => byId.get(id)!).filter(a => a && (a.type === 'button' || a.type === 'tab') && a.risk === 'safe'
          && (!state.dialog || !inBase.has(a.id)));
        for (const a of clickable) {
          if (clicks >= maxClicks) break;
          if (here !== state.id) {
            try { await load(path); } catch { break; }
            here = stateIdFor(await readUi(page));
            if (here !== state.id) break;
          }
          const loc = page.locator(a.selector).first();
          if (!(await loc.isVisible().catch(() => false))) continue;
          const box = await loc.boundingBox().catch(() => null);
          if (box) a.box = box;
          clicks++;
          try { await loc.click({ timeout: 3000 }); } catch { continue; }
          await settle(page);
          const r = await readUi(page);
          const id = stateIdFor(r);
          // A click that changes nothing we track may still alter the page: reload next time
          here = id === state.id ? '' : id;
          if (id === state.id) continue;
          if (r.template !== state.template && !map.pageByTemplate(r.template)) { log(`  "${a.label}" leads to an unknown page ${r.url}; not followed`); continue; }
          const next = await register(r);
          delete next.seeded;
          map.addEdge(state.id, next.id, a.id, 'click', a.risk!);
          log(`  ${state.dialog || state.tab || 'base'} --"${a.label}"--> ${next.dialog || next.tab || next.template}`);
          if (r.template === state.template && !seen.has(next.id)) { seen.add(next.id); queue.push({ path: [...path, a.id], state: next, depth: depth + 1 }); }
        }
        if (state.dialog) {
          if (here !== state.id) { try { await load(path); } catch { continue; } here = stateIdFor(await readUi(page)); }
          if (here === state.id) {
            await page.keyboard.press('Escape');
            await settle(page, 1500);
            const r = await readUi(page);
            here = stateIdFor(r);
            if (here !== state.id && !r.dialog && r.template === state.template) map.addEdge(state.id, (await register(r)).id, '', 'escape', 'safe');
          }
        }
      }
    }
    linkEdges(map);
    await context.close();
  } finally {
    await browser.close();
  }
  if (blocked.length) log(`Blocked ${blocked.length} non-GET request(s) while exploring (to ${[...new Set(blocked.map(b => { try { return new URL(b.split(' ')[1]).host; } catch { return '?'; } }))].slice(0, 5).join(', ')})`);
  return { states: Object.keys(map.states).length, edges: Object.keys(map.edges).length, blocked };
}

/** Link edges: from every non-dialog state where a same-site link is visible, to the target page's base state. */
export function linkEdges(map: AppMap): void {
  for (const s of Object.values(map.states)) {
    if (s.dialog) continue;
    for (const id of s.visibleActions) {
      const a = map.controls[id];
      if (!a?.navigatesTo || a.type !== 'link' || (a.risk ?? 'safe') !== 'safe') continue;
      const target = map.pages[a.navigatesTo];
      if (!target) continue;
      const t = map.baseStateOf(target.template);
      if (t && t.id !== s.id) map.addEdge(s.id, t.id, a.id, 'link', 'safe');
    }
  }
}

