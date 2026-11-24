import type { GraphModel, UIState } from '../types/graph.js';

export interface DemoScene {
  title: string;
  caption: string;
  screenshot: string;
  hotspot?: { x: number; y: number };
}

const terms = (value: string) => [...new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
const filler = new Set(['show', 'walk', 'through', 'with', 'demo', 'make', 'create', 'about', 'the', 'how', 'and', 'for', 'this', 'that', 'from']);

export function promptTerms(prompt: string): string[] {
  return terms(prompt).filter(word => !filler.has(word));
}

export function planDemo(graph: GraphModel, prompt: string): DemoScene[] {
  const states = Object.values(graph.states);
  const entry = states[0];
  if (!entry?.screenshotBase64) throw new Error('The explorer did not capture a starting screen.');
  const wanted = promptTerms(prompt);
  const paths = Object.values(graph.transitions).filter(step => step.fromStateId !== step.toStateId)
    .map(step => [...(step.pathFromEntry || []), step.id].map(id => graph.transitions[id]))
    .filter(path => path.every(Boolean) && path[0]?.fromStateId === entry.id && path.length <= 6 &&
      path.every((step, index) => graph.states[step.toStateId]?.screenshotBase64 &&
        (index === 0 || path[index - 1].toStateId === step.fromStateId)));
  const score = (path: typeof paths[number]) => {
    const changed = path.filter(step => step.fromStateId !== step.toStateId);
    const relevant = new Set(terms(changed.map(step => [
      graph.elements[step.triggerElementId || '']?.text,
      graph.states[step.toStateId].name
    ].join(' ')).join(' ')));
    return wanted.filter(term => relevant.has(term)).length * 10 + new Set(path.map(step => step.toStateId)).size;
  };
  const path = paths.sort((a, b) => score(b) - score(a) || a.length - b.length)[0] || [];
  const title = (state: UIState) => state.modalTitle || graph.pages[state.pageId]?.title || state.name;
  const scene = (state: UIState, caption: string): DemoScene => ({
    title: title(state),
    caption,
    screenshot: state.screenshotBase64!
  });
  const scenes = [scene(entry, path.length ? 'Start here' : 'Overview')];
  for (const step of path) {
    const element = graph.elements[step.triggerElementId || ''];
    const label = element?.text || '';
    const box = element?.boundingBox;
    const previous = scenes[scenes.length - 1];
    previous.caption = label
      ? `${step.action.type === 'FILL' ? 'Enter text in' : step.action.type === 'SELECT' ? 'Choose an option in' : 'Select'} “${label}”`
      : 'Continue to the next screen';
    if (step.action.type === 'CLICK' && box && box.width > 0 && box.height > 0) {
      const x = (box.x + box.width / 2) / 1280 * 100;
      const y = (box.y + box.height / 2) / 800 * 100;
      if (x >= 0 && x <= 100 && y >= 0 && y <= 100) previous.hotspot = { x, y };
    }
    scenes.push(scene(graph.states[step.toStateId], 'Result'));
  }
  return scenes;
}
