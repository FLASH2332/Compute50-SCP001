import { pageIdOf } from '../sections/sectionCrawler.js';
import type { Interaction, PageSection, SectionAction, SectionGraphModel, SiteLink, SitePage } from '../sections/types.js';

export type Dwell = 'short' | 'normal' | 'long';
export interface Shot {
  dwell?: Dwell;
  overview?: boolean;
  page: SitePage;
  section?: PageSection;
  arrival?: SiteLink;
  anchor?: SectionAction;
  control?: SectionAction;
  interaction?: Interaction;  // click this control on the page and show the result
  caption?: string;           // caption chosen by the planner (shown in the video)
}

const filler = new Set(['show', 'walk', 'through', 'with', 'demo', 'make', 'about', 'the', 'how', 'and', 'for', 'this', 'that', 'from']);
function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter(term => !filler.has(term));
}

export function planWalkthrough(model: SectionGraphModel, prompt: string): Shot[] {
  const wanted = terms(prompt);
  const score = (value: string) => {
    const words = terms(value);
    return wanted.filter(term => words.some(word => word === term || (term.length >= 4 && word.startsWith(term)))).length;
  };
  const resolve = (id: string) => model.pages[id]?.redirectedTo || id;
  const root = model.pages[resolve(pageIdOf(model.startUrl))];
  if (root?.status !== 'ok') throw new Error(root?.error || 'The starting page could not be inspected.');
  const sections = Object.values(model.sections);
  const actions = Object.values(model.actions);
  const choices = (page: SitePage) => sections.filter(section => section.pageId === page.id && !section.hidden && ['content', 'main', 'form'].includes(section.role))
    .map(section => {
      const controls = actions.filter(action => action.sectionId === section.id && action.visible);
      controls.sort((a, b) => score(b.label) - score(a.label));
      const control = controls.find(action => ['tab', 'button'].includes(action.type) && score(action.label) > 0);
      return { section, anchor: controls[0], control, rank: score(section.name) * 4 + Math.max(0, ...controls.map(action => score(action.label))) * 2 };
    })
    .sort((a, b) => b.rank - a.rank || a.section.order - b.section.order);
  const paths = new Map<string, SiteLink[]>([[root.id, []]]);
  const queue = [root.id];
  for (const id of queue) {
    for (const link of model.links ?? []) {
      const target = resolve(link.target);
      if (link.source !== id || paths.has(target) || model.pages[target]?.status !== 'ok') continue;
      paths.set(target, [...paths.get(id)!, link]);
      queue.push(target);
    }
  }
  const preferPagination = /\b(next|pagination|pages|browse|catalog)\b/i.test(prompt);
  const clicks = Object.values(model.interactions ?? {}).filter(i => i.kind === 'dialog' || i.kind === 'panel');
  const candidates = [...paths].filter(([, path]) => path.length <= 5).map(([id, path]) => {
    const page = model.pages[id];
    const rank = score([page.title, page.url, path.at(-1)?.label].join(' ')) * 5 +
      (choices(page)[0]?.rank || 0) + Math.max(0, ...clicks.filter(i => i.pageId === id).map(i => score(i.label))) +
      (preferPagination ? path.filter(link => link.next).length * 6 : 0);
    return { path, rank, page };
  }).sort((a, b) => b.rank - a.rank || (wanted.length ? a.path.length - b.path.length : b.path.length - a.path.length));
  const destination = candidates[0];
  if (!destination.rank) return [{ page: root, overview: true, caption: 'Overview of ' + root.title }];
  const path = destination.path;
  const shots: Shot[] = [{ page: root }, ...path.map(link => ({ page: model.pages[resolve(link.target)], arrival: link }))];
  const destinationPage = shots[shots.length - 1].page;
  for (const shot of shots.slice(0, -1)) {
    const top = choices(shot.page)[0];
    if (top?.rank) Object.assign(shot, { section: top.section, anchor: top.anchor, control: top.control });
  }
  const details = choices(destinationPage);
  for (const { section, anchor, control } of details.filter((choice, index) => index === 0 || choice.rank > 0).slice(0, 2)) {
    shots.push({ page: destinationPage, section, anchor, control });
  }
  return shots;
}

export interface PlanStepReport {
  dwell?: Dwell;
  kind: string;
  caption: string;
  reason: string;
  ref?: string;
  skipped?: boolean;
}
export interface PlanResult {
  by: string;               // how the route was chosen
  title: string;
  summary: string;
  fallbackReason?: string;
  steps: PlanStepReport[];
  shots: Shot[];
}

/**
 * Keyword route (planWalkthrough) plus recorded button clicks on the pages in
 * that route: clicks whose label matches words in the request, else the first
 * one that opens a dialog.
 */
export function planDemo(model: SectionGraphModel, prompt: string): PlanResult {
  const shots = planWalkthrough(model, prompt);
  if (shots[0].overview) {
    const caption = shots[0].caption!;
    return { by: 'keyword rules', title: caption, summary: 'No matching keyword. Showing the starting page.',
      steps: [{ kind: 'open_page', caption, reason: 'No matching keyword; scroll through the starting page.' }], shots };
  }
  const words = (prompt.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const onRoute = new Set(shots.map(x => x.page.id));
  const clicks = Object.values(model.interactions ?? {}).filter(it => onRoute.has(it.pageId) && (it.kind === 'dialog' || it.kind === 'panel'));
  const matching = clicks.filter(it => words.some(w => it.label.toLowerCase().includes(w)));
  for (const it of (matching.length ? matching : clicks.filter(c => c.kind === 'dialog')).slice(0, 2)) {
    const at = shots.map(x => x.page.id).lastIndexOf(it.pageId);
    shots.splice(at + 1, 0, { page: shots[at].page, interaction: it, caption: `Click ${it.label}` });
  }
  const root = shots[0]?.page;
  return {
    by: 'keyword rules',
    title: root?.title || 'Walkthrough',
    summary: 'Route chosen by matching words in the request to page, section and button names.',
    steps: shots.map(x => ({ kind: x.interaction ? 'click' : x.section ? 'show_section' : 'open_page', caption: x.caption || x.section?.name || x.page.title, reason: 'keyword match' })),
    shots
  };
}
