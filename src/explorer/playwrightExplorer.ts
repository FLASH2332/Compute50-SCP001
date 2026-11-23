import { chromium, type Browser, type BrowserContext, type Page as PlaywrightPage } from 'playwright';
import { EventEmitter } from 'node:events';
import type { CrawlerConfig, CrawlerEvent, Element, UIState } from '../types/graph.js';
import { detectCurrentUIState } from './stateDetector.js';
import { extractInteractiveElements } from './elementExtractor.js';
import { executeElementAction } from './actionExecutor.js';
import { GraphBuilder } from '../graph/graphBuilder.js';

export class PlaywrightExplorer extends EventEmitter {
  private config: Required<CrawlerConfig>;
  private graphBuilder: GraphBuilder;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: PlaywrightPage | null = null;
  private isRunning: boolean = false;
  private visitedStateIds: Set<string> = new Set();
  private testedTransitions: Set<string> = new Set(); // stateId + "->" + elementId

  constructor(config: CrawlerConfig, graphBuilder: GraphBuilder) {
    super();
    this.config = {
      startUrl: config.startUrl,
      maxDepth: config.maxDepth ?? 3,
      maxStates: config.maxStates ?? 25,
      headless: config.headless ?? true,
      captureScreenshots: config.captureScreenshots ?? false,
      browserChannel: config.browserChannel ?? '',
      // Default: stay on the start site (and its subdomains); never wander off
      // to GitHub, ad networks or social links unless explicitly allowed.
      allowedDomains: config.allowedDomains?.length
        ? config.allowedDomains
        : [new URL(config.startUrl).hostname.replace(/^www\./, '')],
      blockedSelectors: config.blockedSelectors ?? [
        'logout', 'signout', 'sign-out', 'delete-account', 'delete', 'destroy'
      ]
    };
    this.graphBuilder = graphBuilder;
  }

  private emitEvent(event: CrawlerEvent) {
    this.emit('crawler_event', event);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.visitedStateIds.clear();
    this.testedTransitions.clear();

    this.emitEvent({
      type: 'log',
      timestamp: new Date().toISOString(),
      data: { message: `Initializing Playwright Explorer for ${this.config.startUrl}` }
    });

    try {
      this.browser = await chromium.launch({
        headless: this.config.headless,
        channel: this.config.browserChannel || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });

      if (!this.isRunning) return;

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      });

      // Inject __name polyfill for tsx/esbuild evaluate execution
      await this.context.addInitScript(`
        window.__name = (t, v) => t;
        globalThis.__name = (t, v) => t;
      `);

      this.page = await this.context.newPage();

      // Navigate to root
      this.emitEvent({
        type: 'log',
        timestamp: new Date().toISOString(),
        data: { message: `Navigating to initial URL: ${this.config.startUrl}` }
      });

      await this.page.goto(this.config.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(600);

      // Detect root state
      const initialInspection = await detectCurrentUIState(this.page, this.config.captureScreenshots);
      this.graphBuilder.addPage(initialInspection.page);
      this.graphBuilder.addUIState(initialInspection.state);

      this.emitEvent({
        type: 'state_discovered',
        timestamp: new Date().toISOString(),
        data: { page: initialInspection.page, state: initialInspection.state }
      });

      // State Exploration Queue
      type ReplayStep = { element: Element; expectedId: string; transitionId: string };
      interface QueueItem {
        path: ReplayStep[];
        state: UIState;
        depth: number;
      }

      const queue: QueueItem[] = [{ state: initialInspection.state, depth: 0, path: [] }];
      this.visitedStateIds.add(initialInspection.state.id);

      const restore = async (item: QueueItem): Promise<UIState | undefined> => {
        if (!this.page || !this.isRunning) return;
        try {
          await this.page.goto(initialInspection.state.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          let { state } = await detectCurrentUIState(this.page);
          if (state.id !== initialInspection.state.id) return;
          for (const step of item.path) {
            const result = await executeElementAction(this.page, step.element, state);
            if (!result.newState || result.newState.id !== step.expectedId) return;
            state = result.newState;
          }
          if (state.id === item.state.id) return state;
        } catch {
          // A failed replay leaves the state only partially explored.
        }
      };

      while (queue.length > 0 && this.visitedStateIds.size <= this.config.maxStates && this.isRunning) {
        const currentItem = queue.shift()!;
        const { state: currentState, depth } = currentItem;

        if (depth >= this.config.maxDepth) {
          this.graphBuilder.setCoverage(currentState.id, 'depth limit');
          continue;
        }

        this.emitEvent({
          type: 'log',
          timestamp: new Date().toISOString(),
          data: {
            message: `Exploring state [${currentState.name}] at depth ${depth} (${this.visitedStateIds.size}/${this.config.maxStates} discovered)`
          }
        });

        const restored = await restore(currentItem);
        if (!restored) {
          this.graphBuilder.setCoverage(currentState.id, 'restore failed');
          continue;
        }
        let path = currentItem.path;
        await this.collectLinks(restored);

        // Extract interactive elements from current state
        const elements = await extractInteractiveElements(this.page, currentState.id, this.config.blockedSelectors);

        for (const element of elements) {
          this.graphBuilder.addElement(element);
          this.emitEvent({
            type: 'element_discovered',
            timestamp: new Date().toISOString(),
            data: element
          });
        }

        // Limit actions per state to avoid exhaustive combinatorial explosion (explore key actions per state)
        const candidateElements = this.prioritizeCandidateElements(elements).slice(0, 8);
        const seenElementIds = new Set(elements.map(e => e.id));
        let revealedBudget = 6;

        for (const elem of candidateElements) {
          if (!this.isRunning || this.visitedStateIds.size >= this.config.maxStates) break;

          const actionKey = `${currentState.id}->${elem.id}`;
          if (this.testedTransitions.has(actionKey)) continue;
          this.testedTransitions.add(actionKey);

          this.emitEvent({
            type: 'log',
            timestamp: new Date().toISOString(),
            data: { message: `Testing action: ${elem.elementType} "${elem.text || elem.selector}" on ${currentState.name}` }
          });

          // Check the actual browser state immediately before recording an edge.
          const observed = (await detectCurrentUIState(this.page)).state;
          if (observed.id !== currentState.id) {
            this.graphBuilder.setCoverage(currentState.id, 'restore failed');
            break;
          }
          const result = await executeElementAction(this.page, elem, observed, this.config.captureScreenshots);

          if (result.success && result.newState && result.transition) {
            const newState = result.newState;

            // Check if outside allowed domains
            if (this.config.allowedDomains.length > 0) {
              const newDomain = new URL(newState.url).hostname;
              const isAllowed = this.config.allowedDomains.some(d => newDomain === d || newDomain.endsWith(`.${d}`));
              if (!isAllowed) {
                path = currentItem.path;
                if (!(await restore(currentItem))) {
                  this.graphBuilder.setCoverage(currentState.id, 'restore failed');
                  break;
                }
                continue;
              }
            }

            // Register discovered state & transition
            if (result.page) this.graphBuilder.addPage(result.page);
            this.graphBuilder.addUIState(newState);
            await this.collectLinks(newState);
            result.transition.pathFromEntry = path.map(step => step.transitionId);
            this.graphBuilder.addTransition(result.transition);

            this.emitEvent({
              type: 'transition_discovered',
              timestamp: new Date().toISOString(),
              data: {
                transition: result.transition,
                fromState: currentState,
                toState: newState
              }
            });

            // If new state discovered, enqueue for exploration
            if (!this.visitedStateIds.has(newState.id)) {
              this.visitedStateIds.add(newState.id);

              this.emitEvent({
                type: 'state_discovered',
                timestamp: new Date().toISOString(),
                data: { state: newState }
              });

              queue.push({ state: newState, depth: depth + 1, path: [...path, { element: elem, expectedId: newState.id, transitionId: result.transition.id }] });
            }

            if (newState.id !== currentState.id) {
              path = currentItem.path;
              if (!(await restore(currentItem))) {
                this.graphBuilder.setCoverage(currentState.id, 'restore failed');
                break;
              }
            } else {
              path = [...path, { element: elem, expectedId: newState.id, transitionId: result.transition.id }];
              if (revealedBudget <= 0) continue;
              // Same screen, but the action may have revealed new controls
              // (expanded panel, dropdown). Explore them under this state
              // instead of creating a new state for the expansion.
              const after = await extractInteractiveElements(this.page, currentState.id, this.config.blockedSelectors);
              const known = new Set(candidateElements.map(e => e.id));
              for (const el of after) {
                if (revealedBudget <= 0) break;
                if (known.has(el.id) || seenElementIds.has(el.id)) continue;
                seenElementIds.add(el.id);
                this.graphBuilder.addElement(el);
                candidateElements.push(el);
                revealedBudget--;
              }
            }
          } else {
            path = currentItem.path;
            if (!(await restore(currentItem))) {
              this.graphBuilder.setCoverage(currentState.id, 'restore failed');
              break;
            }
          }
        }
        const hitLimit = this.visitedStateIds.size >= this.config.maxStates;
        if (this.isRunning) this.graphBuilder.setCoverage(currentState.id, hitLimit ? 'state limit' : 'sampled', true);
      }

      if (!this.isRunning) return;

      // Discover multi-step workflows across the graph
      const workflows = this.graphBuilder.detectWorkflows();
      for (const wf of workflows) {
        this.emitEvent({
          type: 'workflow_detected',
          timestamp: new Date().toISOString(),
          data: wf
        });
      }

      this.emitEvent({
        type: 'complete',
        timestamp: new Date().toISOString(),
        data: {
          totalPages: Object.keys(this.graphBuilder.getModel().pages).length,
          totalStates: Object.keys(this.graphBuilder.getModel().states).length,
          totalElements: Object.keys(this.graphBuilder.getModel().elements).length,
          totalTransitions: Object.keys(this.graphBuilder.getModel().transitions).length,
          totalWorkflows: workflows.length
        }
      });
    } catch (err: any) {
      if (!this.isRunning) return;
      this.emitEvent({
        type: 'error',
        timestamp: new Date().toISOString(),
        data: { error: err.message || String(err) }
      });
    } finally {
      await this.stop();
    }
  }

  private prioritizeCandidateElements(elements: Element[]): Element[] {
    const priorityMap: Record<string, number> = {
      // Fill form fields before clicking buttons, so a Submit/Login click
      // sends a filled form (realistic) instead of an empty one.
      input: 1,
      select: 2,
      button: 3,
      tab: 4,
      menuitem: 5,
      link: 6,
      custom: 7,
      checkbox: 8,
      radio: 9
    };

    return [...elements].sort((a, b) => {
      const pa = priorityMap[a.elementType] ?? 10;
      const pb = priorityMap[b.elementType] ?? 10;
      return pa - pb;
    });
  }

  private async collectLinks(state: UIState): Promise<void> {
    if (!this.page) return;
    const links = await this.page.locator('a[href]').evaluateAll(anchors => anchors
      .filter(anchor => anchor.getClientRects().length > 0 && getComputedStyle(anchor).visibility === 'visible')
      .map(anchor => ({ url: (anchor as HTMLAnchorElement).href, label: anchor.textContent?.trim() || '' })));
    for (const { url, label } of links) {
      const destination = new URL(url);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.origin !== new URL(state.url).origin) continue;
      this.graphBuilder.addLink(state.pageId, url, label);
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }
}
