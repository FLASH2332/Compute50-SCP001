import type { Page } from 'playwright';
import { stateIdOf, urlTemplate, type AppMap, type UiState } from '../core/appMap.js';
import { similarity } from './locate.js';

export interface UiReading {
  url: string;
  title: string;
  template: string;
  dialog: string;
  tab: string;
}

/** Reads what the page looks like right now: URL template, open dialog, selected tab(s). */
export async function readUi(page: Page): Promise<UiReading> {
  // A string, not a function: tsx would inject its __name helper into a function body
  const r: { url: string; title: string; dialog: string; tab: string } = await page.evaluate(`(() => {
    const clean = s => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    const shown = el => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return false;
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      }
      return true;
    };
    const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')).filter(shown);
    const nameOf = d => {
      const by = d.getAttribute('aria-labelledby');
      const labelled = by ? by.split(/\\s+/).map(id => (document.getElementById(id) || {}).textContent || '').join(' ') : '';
      const h = d.querySelector('h1, h2, h3, legend');
      return clean(d.getAttribute('aria-label')) || clean(labelled) || clean(h && h.textContent) || 'dialog';
    };
    const tabs = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).filter(shown).map(t => clean(t.textContent));
    return { url: location.href, title: document.title, dialog: [...new Set(dialogs.map(nameOf))].sort().join(' + '), tab: tabs.join(', ') };
  })()`);
  return { ...r, template: urlTemplate(r.url) };
}

export function stateIdFor(r: UiReading): string {
  return stateIdOf(r.template, r.dialog, r.tab);
}

/**
 * Maps the live page to a known state. Exact match first; then the same page
 * and dialog with any tab; then the page's base state when no dialog is open.
 * Unknown (another page, or a dialog we never saw) → null.
 */
export async function locateState(page: Page, graph: AppMap): Promise<{ state: UiState | null; reading: UiReading }> {
  const reading = await readUi(page);
  const exact = graph.states[stateIdFor(reading)];
  if (exact) return { state: exact, reading };
  const same = Object.values(graph.states).filter(s => s.template === reading.template);
  const byDialog = same.find(s => s.dialog === reading.dialog)
    // Graph sources name dialogs slightly differently (aria-label vs heading vs text)
    || (reading.dialog ? same.find(s => s.dialog && similarity(s.dialog, reading.dialog) >= 0.8) : undefined);
  if (byDialog) return { state: byDialog, reading };
  return { state: null, reading };
}
