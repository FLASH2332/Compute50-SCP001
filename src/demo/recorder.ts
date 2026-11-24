import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Locator, type Page } from 'playwright';
import { pageIdOf, type SectionCrawler } from '../sections/sectionCrawler.js';
import { readPageRegions } from '../sections/sectionExtractor.js';
import { nextPageButton, paginationSignature, pressNextPage } from '../sections/pagination.js';
import type { Shot } from './planner.js';
import { dismissCookieBanner, findControl, preventFormSubmission } from '../sections/interactions.js';
import type { DemoScene } from './interactive.js';

const run = promisify(execFile);
const viewport = { width: 1280, height: 800 };

async function exactControl(page: Page, selector?: string): Promise<Locator | undefined> {
  if (!selector) return;
  return findControl(page, selector);
}

async function scrollTo(page: Page, target?: Locator, block: ScrollLogicalPosition = 'center',
  timing: { fraction?: number; durationMs?: number; maxMs?: number } = {}) {
  await (target ?? page.locator('html')).evaluate(async (element, { block, timing }) => {
    const root = document.scrollingElement ?? document.documentElement;
    const containers = new Set<Element>([root]);
    for (let el: Element | null = element; el;) {
      if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) containers.add(el);
      const tree = el.getRootNode();
      el = el.parentElement ?? (tree instanceof ShadowRoot ? tree.host : null);
    }
    const moves = Array.from(containers, el => ({ el, x: el.scrollLeft, y: el.scrollTop, dx: 0, dy: 0 }));
    // Measure the browser's alignment (including nested panels and scroll margins)
    // and restore the starting positions within the same frame, before painting.
    if (timing.fraction !== undefined) root.scrollTo({ top: (root.scrollHeight - root.clientHeight) * timing.fraction, behavior: 'instant' });
    else {
      element.scrollIntoView({ behavior: 'instant', block, inline: 'nearest' });
      if (block === 'start') {
        // A laptop viewport can have multiple stacked sticky navigation bars.
        // Probe their actual lower edge after alignment so the heading clears them.
        let top = 0;
        for (const x of [innerWidth * 0.25, innerWidth * 0.75]) {
          let y = 1;
          while (y < innerHeight / 2) {
            let bottom = y;
            for (const hit of document.elementsFromPoint(x, y)) {
              for (let bar: Element | null = hit; bar; bar = bar.parentElement) {
                const pos = getComputedStyle(bar).position;
                if (pos !== 'sticky' && pos !== 'fixed') continue;
                const rect = bar.getBoundingClientRect();
                if (rect.width >= innerWidth / 2 && rect.bottom < innerHeight / 2) bottom = Math.max(bottom, rect.bottom);
              }
            }
            if (bottom <= y) break;
            top = Math.max(top, bottom);
            y = Math.ceil(bottom) + 1;
          }
        }
        const gap = Math.max(0, top + 24 - element.getBoundingClientRect().top);
        if (gap) {
          // Let native alignment apply the inset to the correct scroller,
          // including overflow panels. Restore the site's style immediately.
          const style = (element as HTMLElement).style;
          const margin = style.getPropertyValue('scroll-margin-top');
          const priority = style.getPropertyPriority('scroll-margin-top');
          const inset = parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
          style.setProperty('scroll-margin-top', (inset + gap) + 'px', 'important');
          try { element.scrollIntoView({ behavior: 'instant', block, inline: 'nearest' }); }
          finally { style.setProperty('scroll-margin-top', margin, priority); }
        }
      }
    }
    for (const move of moves) {
      move.dx = move.el.scrollLeft - move.x;
      move.dy = move.el.scrollTop - move.y;
    }
    const moving = moves.filter(m => m.dx || m.dy);
    if (!moving.length) return;
    for (const m of moving) m.el.scrollTo({ left: m.x, top: m.y, behavior: 'instant' });

    // About 1.5 seconds per viewport, with a gentle start and stop.
    const distance = moving.reduce((sum, m) => sum + Math.hypot(m.dx, m.dy), 0);
    const naturalMs = distance / (innerHeight * 0.7) * 1000;
    const duration = Math.min(timing.durationMs ?? (naturalMs + Math.min(200, naturalMs)), timing.maxMs ?? Infinity);
    const ramp = Math.min(200, duration / 2);
    const cruiseMs = duration - ramp;
    await new Promise<void>(resolve => {
      const start = performance.now();
      const frame = (now: number) => {
        const t = Math.min(duration, Math.max(0, now - start));
        const remaining = duration - t;
        const progress = t < ramp ? t * t / (2 * ramp * cruiseMs)
          : remaining < ramp ? 1 - remaining * remaining / (2 * ramp * cruiseMs)
          : (t - ramp / 2) / cruiseMs;
        for (const m of moving) m.el.scrollTo({ left: m.x + m.dx * progress, top: m.y + m.dy * progress, behavior: 'instant' });
        if (t < duration) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }, { block, timing }, { timeout: 2500 });
}

async function firstStopBelowFold(page: Page, shots: Shot[]) {
  const stop = shots.find(s => s.section || s.interaction || s.arrival);
  if (!stop || stop.overview) return false;
  let target: Locator | undefined;
  // An arrival belongs to the page being left. Its destination's section is
  // measured only after the link or button has been followed.
  if (stop.arrival) {
    target = stop.arrival.via === 'button' ? await nextPageButton(page) ?? undefined
      : page.getByRole('link', { name: stop.arrival.label, exact: true }).first();
  } else if (stop.interaction) target = await exactControl(page, stop.interaction.selector);
  else if (stop.section) {
    target = stop.section.regionSelector ? page.locator(stop.section.regionSelector)
      : page.getByRole('heading', { name: stop.section.name, exact: true });
  }
  if (!target || await target.count() !== 1) return false;
  return target.evaluate(el => el.getBoundingClientRect().top >= innerHeight);
}

// A visible cursor so viewers can follow each click
const CURSOR_SCRIPT = `globalThis.__name = (value) => value;
window.__demoCursor = (x, y) => {
  let c = document.getElementById('__demo_cursor');
  if (!c) {
    c = document.createElement('div');
    c.id = '__demo_cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;width:22px;height:22px;border-radius:50%;background:rgba(23,103,225,.85);border:3px solid #fff;box-shadow:0 0 0 6px rgba(23,103,225,.35);pointer-events:none;transition:left .6s ease,top .6s ease;left:640px;top:400px;transform:translate(-50%,-50%)';
    document.documentElement.appendChild(c);
  }
  c.style.left = x + 'px';
  c.style.top = y + 'px';
};`;

async function pointAt(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) return undefined;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(([cx, cy]) => (window as any).__demoCursor?.(cx, cy), [x, y]).catch(() => {});
  await page.mouse.move(x, y, { steps: 12 }).catch(() => {});
  await page.waitForTimeout(700);
  return { x: x / viewport.width * 100, y: y / viewport.height * 100 };
}

/** Real length of a video file in seconds (ffprobe next to ffmpeg), or undefined. */
async function videoSeconds(file: string): Promise<number | undefined> {
  const ffmpeg = process.env.FFMPEG_PATH;
  const ffprobe = process.env.FFPROBE_PATH || (ffmpeg ? path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe')) : 'ffprobe');
  try {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30000, windowsHide: true });
    const seconds = parseFloat(stdout);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

const timecode = (seconds: number) => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23).replace('.', ',');

export async function recordWalkthrough(shots: Shot[], crawler: SectionCrawler, directory: string, channel?: string) {
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ channel, timeout: 15000 });
  const scenes: DemoScene[] = [];
  const cues: { start: number; end?: number; text: string }[] = [];
  let recording: string;
  let firstFrame = 0;
  let end = 0;
  let closedAt = 0;
  try {
    const context = await browser.newContext({ viewport, recordVideo: { dir: directory, size: viewport }, serviceWorkers: 'block', acceptDownloads: false });
    await context.addInitScript(CURSOR_SCRIPT);
    await context.addInitScript(preventFormSubmission);
    await context.route('**/*', route => {
      const request = route.request();
      return ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
        (!request.isNavigationRequest() || crawler.isSameSite(request.url())) ? route.fallback() : route.abort();
    });
    const page = await context.newPage();
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    const video = page.video()!;
    const started = performance.now();
    const elapsed = () => (performance.now() - started) / 1000;
    const endCaption = () => {
      const cue = cues.at(-1);
      if (cue && cue.end === undefined) cue.end = elapsed();
    };
    let previous: Shot | undefined;
    const snapshot = async (title: string, caption: string, hotspot?: DemoScene['hotspot']) => {
      const image = await page.screenshot({ type: 'jpeg', quality: 76, timeout: 5000 });
      scenes.push({ title, caption, screenshot: image.toString('base64'), hotspot });
    };
    for (const shot of shots) {
      endCaption();
      if (previous?.page.id !== shot.page.id) {
        let followed = false;
        if (shot.arrival?.interactionId && previous) {
          const it = Object.values(crawler.interactions()).find(x => x.id === shot.arrival!.interactionId);
          const control = it && await exactControl(page, it.selector).catch(() => undefined);
          if (control) {
            await scrollTo(page, control);
            const hotspot = await pointAt(page, control);
            const text = shot.caption || 'Click ' + shot.arrival.label;
            cues.push({ start: elapsed(), text });
            await snapshot(previous.page.title, text, hotspot);
            try {
              await Promise.all([
                page.waitForURL(url => pageIdOf(url.href) === shot.page.id, { waitUntil: 'domcontentloaded', timeout: 6000 }),
                control.click({ timeout: 3500 })
              ]);
              followed = pageIdOf(page.url()) === shot.page.id;
            } catch { /* replay the verified destination directly */ }
          }
        } else if (shot.arrival?.via === 'button' && previous) {
          const next = await nextPageButton(page);
          if (!next) throw new Error('The Next page control was no longer available during recording.');
          await scrollTo(page, next);
          const hotspot = await pointAt(page, next);
          const text = shot.caption || 'Continue to the next page';
          cues.push({ start: elapsed(), text });
          await snapshot(previous.page.title, text, hotspot);
          await page.waitForTimeout(450);
          followed = await pressNextPage(page, next) === shot.page.pagination?.signature;
          if (!followed) throw new Error('The Next page control produced a different result during recording.');
        } else if (shot.arrival && previous) {
          const arrivalId = pageIdOf(shot.arrival.url);
          const links = page.locator('a[href]');
          const index = await links.evaluateAll((items, url) =>
            items.findIndex(el => (el as HTMLAnchorElement).href === url && (el as HTMLElement).getClientRects().length > 0), shot.arrival.url);
          if (index >= 0) {
            const link = links.nth(index);
            if (await link.evaluate(el => !(el as HTMLAnchorElement).target && !el.hasAttribute('download'))) {
              await scrollTo(page, link);
              const hotspot = await pointAt(page, link);
              const text = shot.caption || (shot.arrival.next ? 'Continue to the next page' : 'Open ' + shot.arrival.label);
              cues.push({ start: elapsed(), text });
              if (hotspot) await snapshot(previous.page.title, text, hotspot);
              await page.waitForTimeout(550);
              try {
                await Promise.all([
                  page.waitForURL(url => [arrivalId, shot.page.id].includes(pageIdOf(url.href)), { waitUntil: 'domcontentloaded', timeout: 5000 }),
                  link.click({ timeout: 3500 })
                ]);
                followed = pageIdOf(page.url()) === shot.page.id;
              } catch { /* replay the verified destination directly */ }
            }
          }
        }
        if (!followed) {
          const response = await page.goto(shot.page.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (response && response.status() >= 400) throw new Error('Recording received HTTP ' + response.status() + ' at ' + shot.page.url);
        }
        const matches = shot.page.pagination ? await paginationSignature(page) === shot.page.pagination.signature : pageIdOf(page.url()) === shot.page.id;
        if (!crawler.isSameSite(page.url()) || !matches || (await readPageRegions(page)).botCheck) {
          throw new Error('The verified page changed during recording: ' + shot.page.url);
        }
        await dismissCookieBanner(page);
        if (!previous) await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.waitForTimeout(350);
        if (!previous) firstFrame = elapsed();
        cues.push({ start: elapsed(), text: shot.caption && !shot.section && !shot.interaction ? shot.caption : shot.page.title });
        await snapshot(shot.page.title, shot.arrival?.next ? 'Next page' : 'Page overview');
        await page.waitForTimeout(1400);
        if (!previous && shot.overview) {
          const budgetMs = Math.max(1, 12000 - (elapsed() - firstFrame) * 1000 - 1600);
          await scrollTo(page, undefined, 'start', { fraction: 1, maxMs: budgetMs });
          await snapshot(shot.page.title, shot.caption || shot.page.title);
        } else if (!previous && await firstStopBelowFold(page, shots)) {
          endCaption();
          await scrollTo(page, undefined, 'start', { fraction: 0.6, durationMs: 3000 });
        }
      }
      if (shot.section || shot.interaction) await dismissCookieBanner(page, 0);
      if (shot.section) {
        const heading = page.getByRole('heading', { name: shot.section.name, exact: true });
        const control = await exactControl(page, shot.control?.selector).catch(() => undefined);
        const anchor = await exactControl(page, shot.anchor?.selector).catch(() => undefined);
        const hasHeading = await heading.count() === 1;
        const recordedRegion = shot.section.regionSelector ? page.locator(shot.section.regionSelector) : undefined;
        const region = recordedRegion && await recordedRegion.count() === 1 && await recordedRegion.isVisible() ? recordedRegion : undefined;
        const tall = region && await region.evaluate(el => el.getBoundingClientRect().height > innerHeight * 1.5);
        let target = (tall ? region : undefined) || (hasHeading ? heading : region) || anchor || control;
        let align: ScrollLogicalPosition = hasHeading || region ? 'start' : 'center';
        if (!target && shot.section.role === 'main') {
          const main = page.getByRole('main', { name: shot.section.name, exact: true });
          if (await main.count() === 1) {
            target = main;
            align = 'start';
          }
        }
        if (target) {
          endCaption();
          await scrollTo(page, target, align);
          cues.push({ start: elapsed(), text: shot.caption || shot.section.name });
          await snapshot(shot.page.title, shot.caption || shot.section.name);
          const dwell = { short: 2000, normal: 3500, long: 5000 }[shot.dwell ?? 'normal'];
          const startedDwell = performance.now();
          if (tall) await scrollTo(page, region, 'end', { durationMs: dwell });
          await page.waitForTimeout(Math.max(0, dwell - (performance.now() - startedDwell)));
        }
        if (control && shot.control) {
          // Only replay UI controls that explicitly disclose a local DOM panel.
          const panelId = await control.evaluate(el => {
            if (el.closest('form') || el.getAttribute('aria-expanded') === 'true' || el.getAttribute('aria-selected') === 'true') return null;
            return el.getAttribute('aria-controls');
          });
          if (panelId) {
            const panel = page.locator('[id]').filter({ visible: true });
            const panelVisible = () => panel.evaluateAll((elements, id) => elements.some(el => el.id === id), panelId);
            if (!await panelVisible()) {
              await scrollTo(page, control);
              const hotspot = await pointAt(page, control);
              await snapshot(shot.page.title, 'Open ' + shot.control.label, hotspot);
              await control.click({ timeout: 2500 });
              await page.waitForTimeout(450);
              if (pageIdOf(page.url()) !== shot.page.id) throw new Error('A local control unexpectedly navigated away from ' + shot.page.url);
              if (await panelVisible()) {
                cues.push({ start: elapsed(), text: 'Open ' + shot.control.label });
                await snapshot(shot.page.title, shot.control.label);
                await page.waitForTimeout(1200);
              }
            }
          }
        }
      }
      if (shot.interaction) {
        const it = shot.interaction;
        const control = await exactControl(page, it.selector).catch(() => undefined);
        if (control) {
          await scrollTo(page, control);
          const hotspot = await pointAt(page, control);
          const text = shot.caption || `Click ${it.label}`;
          cues.push({ start: elapsed(), text });
          await snapshot(shot.page.title, text, hotspot);
          await control.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1600);
          if (pageIdOf(page.url()) !== shot.page.id) {
            // It navigated after all: go back to the page the plan expects
            await page.goto(shot.page.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await dismissCookieBanner(page);
          } else {
            await snapshot(shot.page.title, it.result);
            await page.waitForTimeout(1200);
            if (it.kind === 'dialog' && shot !== shots.at(-1)) {
              await page.keyboard.press('Escape').catch(() => {});
              await page.waitForTimeout(500);
              const open = await page.locator('dialog[open], [role="dialog"], [aria-modal="true"]').filter({ visible: true }).count().catch(() => 0);
              if (open) {
                await page.goto(shot.page.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await dismissCookieBanner(page);
              }
            }
          }
        }
      }
      previous = shot;
    }
    await page.waitForTimeout(1150);
    end = elapsed();
    if (shots[0]?.overview) end = Math.min(end, firstFrame + 12);
    closedAt = elapsed();
    await context.close();
    recording = await video.path();
  } finally {
    await browser.close();
  }
  // The video file starts at the first painted frame, which is later than our
  // clock's zero (set when the tab opened). Measure that shift from the file's
  // real length and move every cut point by it, so the start isn't clipped.
  const length = await videoSeconds(path.join(directory, path.basename(recording)));
  const shift = length !== undefined ? Math.max(0, Math.min(closedAt - length, firstFrame)) : 0;
  firstFrame -= shift;
  end -= shift;
  for (const cue of cues) {
    cue.start -= shift;
    if (cue.end !== undefined) cue.end -= shift;
  }
  const subtitle = cues.map((cue, index) => [
    index + 1, timecode(Math.max(0, cue.start - firstFrame)) + ' --> ' + timecode((cue.end ?? cues[index + 1]?.start ?? end) - firstFrame),
    cue.text.replace(/[\r\n<>]/g, ' ').slice(0, 120), ''
  ].join('\n')).join('\n');
  await writeFile(path.join(directory, 'captions.srt'), subtitle, 'utf8');
  try {
    await run(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', firstFrame.toFixed(3), '-i', path.basename(recording),
      '-t', (end - firstFrame).toFixed(3), '-vf', "scale=1040:650,pad=1280:720:120:0:0x151b26,subtitles=captions.srt:force_style='FontSize=12,MarginV=4'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'walkthrough.mp4'
    ], { cwd: directory, timeout: 120000, windowsHide: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('FFmpeg is required for MP4 export. Set FFMPEG_PATH or add FFmpeg to PATH.');
    throw error;
  }
  return scenes;
}
