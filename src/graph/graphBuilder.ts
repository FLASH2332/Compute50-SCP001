import { createHash } from 'node:crypto';
import type { PageLink, StateCoverage, Page, UIState, Element, Transition, Workflow, GraphModel } from '../types/graph.js';

export class GraphBuilder {
  private domain: string = '';
  private pages: Map<string, Page> = new Map();
  private states: Map<string, UIState> = new Map();
  private elements: Map<string, Element> = new Map();
  private transitions: Map<string, Transition> = new Map();
  private links = new Map<string, PageLink>();
  private coverage = new Map<string, StateCoverage>();
  private workflows: Map<string, Workflow> = new Map();

  constructor(domain: string = '') {
    this.domain = domain;
  }

  public setDomain(domain: string) {
    this.domain = domain;
  }

  public addPage(page: Page): void {
    if (!this.domain && page.domain) {
      this.domain = page.domain;
    }
    this.pages.set(page.id, page);
  }

  public addUIState(state: UIState): void {
    this.states.set(state.id, state);
    this.setCoverage(state.id, 'discovered', true);
    // Register the state's page too (previously only the start page was added)
    if (!this.pages.has(state.pageId)) {
      let path = state.url;
      let domain = this.domain;
      try { const u = new URL(state.url); path = u.pathname + u.search; domain = u.hostname; } catch { /* keep raw */ }
      this.pages.set(state.pageId, {
        id: state.pageId,
        url: state.url,
        path,
        title: path,
        domain,
        discoveredAt: state.discoveredAt
      });
    }
  }

  public addElement(element: Element): void {
    this.elements.set(element.id, element);
  }

  public addTransition(transition: Transition): void {
    this.transitions.set(transition.id, transition);
  }

  public addWorkflow(workflow: Workflow): void {
    this.workflows.set(workflow.id, workflow);
  }

  public addLink(sourcePageId: string, destinationUrl: string, label: string): void {
    const url = new URL(destinationUrl);
    url.hash = '';
    this.links.set(JSON.stringify([sourcePageId, url.href]), { sourcePageId, destinationUrl: url.href, label });
  }

  public setCoverage(stateId: string, coverage: StateCoverage, preserveFailure = false): void {
    const existing = this.coverage.get(stateId);
    if (preserveFailure && existing && (coverage === 'discovered' || existing === 'restore failed')) return;
    this.coverage.set(stateId, coverage);
  }

  public getModel(): GraphModel {
    return {
      domain: this.domain,
      links: [...this.links.values()],
      coverage: Object.fromEntries(this.coverage),
      pages: Object.fromEntries(this.pages),
      states: Object.fromEntries(this.states),
      elements: Object.fromEntries(this.elements),
      transitions: Object.fromEntries(this.transitions),
      workflows: Object.fromEntries(this.workflows)
    };
  }

  /**
   * Discovers multi-step workflows (paths through the state transition graph)
   */
  /**
   * Workflows = shortest path from the entry state to a goal.
   *  - COMPLETED: a goal action (Save / Submit / Create / Login ...) was
   *    followed by a positive confirmation message.
   *  - PARTIAL: a dialog / wizard step / goal action was reached, but no result
   *    was observed (e.g. "New Invoice" dialog opened, nothing submitted).
   */
  public detectWorkflows(): Workflow[] {
    this.workflows.clear();
    const discovered: Workflow[] = [];
    const stateList = Array.from(this.states.values());
    if (!stateList.length) return discovered;
    const entry = stateList[0];
    const transitions = Array.from(this.transitions.values());

    // Shortest paths from entry (BFS)
    const prev = new Map<string, { from: string; via: string }>();
    const seen = new Set([entry.id]);
    const queue = [entry.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const t of transitions) {
        if (t.fromStateId !== cur || seen.has(t.toStateId)) continue;
        seen.add(t.toStateId);
        prev.set(t.toStateId, { from: cur, via: t.id });
        queue.push(t.toStateId);
      }
    }
    const pathTo = (stateId: string): { states: string[]; transitions: string[] } | null => {
      if (stateId !== entry.id && !prev.has(stateId)) return null;
      const states = [stateId];
      const trans: string[] = [];
      let cur = stateId;
      while (prev.has(cur)) {
        const p = prev.get(cur)!;
        trans.unshift(p.via);
        states.unshift(p.from);
        cur = p.from;
      }
      return { states, transitions: trans };
    };

    const goalWord = /\b(submit|save|create|add|send|search|log ?in|sign ?(in|up)|register|confirm|checkout|buy|book|apply|upload|finish|done|ok)\b/i;
    const label = (t: Transition) => (t.description.match(/"([^"]+)"/) || [, t.action.type])[1] as string;
    const seenGoal = new Map<string, Workflow>();
    const push = (wf: Omit<Workflow, 'id'>) => {
      // "Add to basket" tried on 7 category pages is ONE workflow, not 7.
      // Key = status + action/goal label + kind of evidence (URLs stripped).
      const goal = (wf.name.split(' -> ').pop() || wf.name);
      const evidenceKind = wf.evidence.replace(/https?:\/\/\S+/g, '<url>');
      const dedupeKey = `${wf.status}|${goal}|${evidenceKind}`;
      const existing = seenGoal.get(dedupeKey);
      if (existing) {
        if (wf.stepCount >= existing.stepCount) return;
        this.workflows.delete(existing.id);
        discovered.splice(discovered.indexOf(existing), 1);
      }
      const id = createHash('sha256').update(JSON.stringify([wf.startStateId, wf.transitions])).digest('hex');
      const full: Workflow = { id: `wf_${id}`, ...wf };
      this.workflows.set(full.id, full);
      discovered.push(full);
      seenGoal.set(dedupeKey, full);
    };
    const completedEnds = new Set<string>();

    // 1. Completed: goal action + observed result
    for (const t of transitions) {
      const element = t.triggerElementId ? this.elements.get(t.triggerElementId) : undefined;
      const isLink = element ? element.elementType === 'link' || element.role === 'link' : t.description.startsWith('CLICK link ');
      if (t.action.type !== 'CLICK' || isLink || !goalWord.test(label(t))) continue;
      const errorMsg = /\b(invalid|error|failed|required|wrong|incorrect|denied|unsuccessful|unable|could not|not (?:found|saved|submitted|created|confirmed|completed)|try again)\b/i;
      const all = t.resultEvidence || [];
      const messages = all.filter(e => e.startsWith('message:'));
      const errors = messages.filter(e => errorMsg.test(e));
      const positive = /\b(successfully|success|saved|submitted|created|confirmed|completed|thank you)\b/i;
      const ev = errors.length ? [] : messages.filter(e => positive.test(e));
      const recordedPath = t.pathFromEntry?.map(id => this.transitions.get(id));
      const head = recordedPath?.every(step => step !== undefined)
        ? { states: [recordedPath[0]?.fromStateId || t.fromStateId, ...recordedPath.map(step => step.toStateId)], transitions: t.pathFromEntry! }
        : pathTo(t.fromStateId);
      if (!head) continue;
      if (ev.length === 0) {
        if (all.length) {
          completedEnds.add(t.fromStateId);
          push({
            name: `${entry.name} -> "${label(t)}"`,
            description: `Partial: tried "${label(t)}" without a confirmed result: ${all.join('; ')} (${head.transitions.length + 1} steps)`,
            startStateId: head.states[0],
            endStateId: t.toStateId,
            stepCount: head.transitions.length + 1,
            states: [...head.states, t.toStateId],
            transitions: [...head.transitions, t.id],
            status: 'partial',
            evidence: all.join('; ')
          });
        }
        continue;
      }
      const end = this.states.get(t.toStateId)!;
      completedEnds.add(t.fromStateId);
      push({
        name: `${entry.name} -> "${label(t)}"`,
        description: `Completed: "${label(t)}" then observed ${ev.join('; ')} (${head.transitions.length + 1} steps)`,
        startStateId: head.states[0],
        endStateId: end.id,
        stepCount: head.transitions.length + 1,
        states: [...head.states, end.id],
        transitions: [...head.transitions, t.id],
        status: 'completed',
        evidence: ev.join('; ')
      });
    }

    // 2. Partial: dialog / wizard step reached without an observed result
    for (const st of stateList) {
      const isGoalScreen = st.isModal || st.activeLandmarks.some(l => l.startsWith('step:'));
      if (!isGoalScreen || st.id === entry.id || completedEnds.has(st.id)) continue;
      const p = pathTo(st.id);
      if (!p) continue;
      push({
        name: `${entry.name} -> ${st.name}`,
        description: `Partial: reached ${st.isModal ? `dialog "${st.modalTitle || 'Dialog'}"` : 'wizard step'}; no result observed (${p.transitions.length} steps)`,
        startStateId: entry.id,
        endStateId: st.id,
        stepCount: p.transitions.length,
        states: p.states,
        transitions: p.transitions,
        status: 'partial',
        evidence: 'none'
      });
    }
    return discovered;
  }

  /**
   * Formats graph entities into Cytoscape.js elements JSON
   */
  public toCytoscapeElements(filterMode: 'states' | 'full' | 'workflows' | 'pages' = 'states') {
    if (filterMode === 'pages') {
      const pages = new Map<string, { id: string; label: string; visited: boolean }>();
      const aliases = new Map<string, string>();
      for (const page of this.pages.values()) {
        const url = new URL(page.url);
        url.hash = '';
        aliases.set(url.href, page.id);
        pages.set(page.id, { id: page.id, label: page.title || page.path, visited: true });
      }
      for (const state of this.states.values()) {
        const url = new URL(state.url);
        url.hash = '';
        aliases.set(url.href, state.pageId);
      }
      const edges = [...this.links.values()].map((link, index) => {
        const target = aliases.get(link.destinationUrl) || link.destinationUrl;
        if (!pages.has(target)) pages.set(target, { id: target, label: new URL(target).pathname, visited: false });
        return { group: 'edges', data: { id: `link-${index}`, source: link.sourcePageId, target, type: 'LINKS_TO', label: link.label }, classes: 'edge-transition-nav' };
      });
      return [
        ...[...pages.values()].map(page => ({
          group: 'nodes',
          classes: 'node-page',
          data: { ...page, label: `${page.label} (${page.visited ? 'visited' : 'discovered'})`, type: 'Page', url: page.id, path: new URL(page.id).pathname }
        })),
        ...edges
      ];
    }

    const cyNodes: any[] = [];
    const cyEdges: any[] = [];

    // 1. Pages. High-level view draws only the entry page so the flow reads
    // top-down from one start; every page stays in the model / Neo4j.
    const entryState = this.states.values().next().value as UIState | undefined;
    const drawnPages = new Set<string>();
    for (const page of this.pages.values()) {
      if (filterMode !== 'full' && entryState && page.id !== entryState.pageId) continue;
      drawnPages.add(page.id);
      cyNodes.push({
        group: 'nodes',
        data: {
          id: page.id,
          label: page.title || page.path,
          type: 'Page',
          url: page.url,
          path: page.path,
          domain: page.domain
        },
        classes: 'node-page'
      });
    }

    // 2. UIStates
    const workflows = [...this.workflows.values()];
    const workflowStates = new Set(workflows.flatMap(workflow => workflow.states));
    const workflowTransitions = new Set(workflows.flatMap(workflow => workflow.transitions));
    for (const state of this.states.values()) {
      if (filterMode === 'workflows' && !workflowStates.has(state.id)) continue;
      cyNodes.push({
        group: 'nodes',
        data: {
          id: state.id,
          label: state.name,
          type: 'UIState',
          isModal: state.isModal,
          modalTitle: state.modalTitle,
          pageId: state.pageId,
          elementCount: state.elementCount,
          activeLandmarks: state.activeLandmarks,
          coverage: this.coverage.get(state.id),
          hasScreenshot: Boolean(state.screenshotBase64)
        },
        classes: state.isModal ? 'node-state-modal' : 'node-state'
      });

      // Link Page -> UIState
      if (drawnPages.has(state.pageId) && (filterMode === 'full' || state.id === entryState?.id)) cyEdges.push({
        group: 'edges',
        data: {
          id: `page-state-${state.pageId}-${state.id}`,
          source: state.pageId,
          target: state.id,
          label: 'HAS_STATE',
          type: 'HAS_STATE'
        },
        classes: 'edge-containment'
      });
    }

    // 3. Transitions. In-place actions (A -> A) are collapsed into a count on
    // the state node instead of drawing a tangle of self-loops; parallel
    // edges between the same two states are merged into one labelled arrow.
    const inPlace = new Map<string, string[]>();
    const merged = new Map<string, Transition[]>();
    for (const trans of this.transitions.values()) {
      if (filterMode === 'workflows' && !workflowTransitions.has(trans.id)) continue;
      if (trans.fromStateId === trans.toStateId) {
        const list = inPlace.get(trans.fromStateId) || [];
        list.push([trans.description, ...(trans.resultEvidence || [])].join(' · '));
        inPlace.set(trans.fromStateId, list);
        continue;
      }
      const key = `${trans.fromStateId}->${trans.toStateId}`;
      merged.set(key, [...(merged.get(key) || []), trans]);
    }
    for (const node of cyNodes) {
      const loops = inPlace.get(node.data.id);
      if (loops) {
        node.data.inPlaceCount = loops.length;
        node.data.inPlaceActions = loops;
        node.data.label = `${node.data.label}
(${loops.length} in-place action${loops.length > 1 ? 's' : ''})`;
      }
    }
    const shortLabel = (t: Transition) => {
      const q = t.description.match(/"([^"]{1,28})/);
      const verb = t.action.type.charAt(0) + t.action.type.slice(1).toLowerCase();
      return q ? `${verb} "${q[1]}"` : verb;
    };
    for (const group of merged.values()) {
      const trans = group[0];
      const extra = group.length > 1 ? ` +${group.length - 1}` : '';
      cyEdges.push({
        group: 'edges',
        data: {
          id: trans.id,
          source: trans.fromStateId,
          target: trans.toStateId,
          label: shortLabel(trans) + extra,
          type: 'TRANSITION',
          actionType: trans.action.type,
          description: group.map(g => [g.description, ...(g.resultEvidence || [])].join(' · ')).join(' | '),
          urlChanged: trans.urlChanged
        },
        classes: trans.urlChanged ? 'edge-transition-nav' : 'edge-transition-action'
      });
    }
    // 4. Elements (if 'full' mode selected)
    if (filterMode === 'full') {
      for (const elem of this.elements.values()) {
        cyNodes.push({
          group: 'nodes',
          data: {
            id: elem.id,
            label: elem.text || elem.selector,
            type: 'Element',
            elementType: elem.elementType,
            selector: elem.selector,
            tag: elem.tag,
            role: elem.role
          },
          classes: 'node-element'
        });

        // Link State -> Element
        cyEdges.push({
          group: 'edges',
          data: {
            id: `state-elem-${elem.stateId}-${elem.id}`,
            source: elem.stateId,
            target: elem.id,
            label: 'CONTAINS_ELEMENT',
            type: 'CONTAINS_ELEMENT'
          },
          classes: 'edge-element-containment'
        });
      }
    }

    return [...cyNodes, ...cyEdges];
  }

  public clear(): void {
    this.pages.clear();
    this.states.clear();
    this.elements.clear();
    this.transitions.clear();
    this.workflows.clear();
    this.links.clear();
    this.coverage.clear();
  }
}
