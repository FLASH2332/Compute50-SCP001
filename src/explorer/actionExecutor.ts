import type { Page as PlaywrightPage } from 'playwright';
import crypto from 'node:crypto';
import type { Element, Action, Transition, UIState, Page } from '../types/graph.js';
import { detectCurrentUIState } from './stateDetector.js';

export interface ExecutionResult {
  success: boolean;
  action: Action;
  previousState: UIState;
  newState?: UIState;
  page?: Page;
  transition?: Transition;
  error?: string;
}

/**
 * Safely executes an action on an element and computes the resulting transition
 */
export async function executeElementAction(
  page: PlaywrightPage,
  element: Element,
  currentState: UIState,
  captureScreenshots: boolean = false
): Promise<ExecutionResult> {
  const timestamp = new Date().toISOString();
  const actionId = 'act_' + crypto.randomUUID().slice(0, 12);

  // Auto-dismiss or accept browser dialogs (alerts, confirms) to prevent hanging
  const dialogHandler = async (dialog: any) => {
    try {
      await dialog.dismiss();
    } catch {
      // Ignore
    }
  };
  page.once('dialog', dialogHandler);

  let actionType: Action['type'] = 'CLICK';
  let payload: string | undefined;

  try {
    const locator = page.locator(element.selector).first();

    // Ensure locator is visible with short timeout
    const isVisible = await locator.isVisible().catch(() => false);
    if (!isVisible) {
      return {
        success: false,
        action: { id: actionId, type: 'CLICK', targetElementId: element.id, targetSelector: element.selector, timestamp },
        previousState: currentState,
        error: 'Element no longer visible on screen'
      };
    }

    // Determine action strategy
    if (element.elementType === 'input') {
      actionType = 'FILL';
      payload = element.selector.toLowerCase().includes('email') ? 'user@example.com' : 'Test Value';
      await locator.fill(payload, { timeout: 3000 });
    } else if (element.elementType === 'select') {
      actionType = 'SELECT';
      // Pick first non-empty option
      const options = await locator.locator('option').allInnerTexts().catch(() => []);
      const optionToSelect = options.find(o => o.trim().length > 0) || '';
      if (optionToSelect) {
        await locator.selectOption({ label: optionToSelect });
        payload = optionToSelect;
      }
    } else {
      // Default: Click
      actionType = 'CLICK';
      await locator.click({ timeout: 4000, force: false });
    }

    // Wait for DOM / network stabilization
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {}),
      page.waitForTimeout(600)
    ]);
    // Small buffer for CSS animations / transitions
    await page.waitForTimeout(250);

    // Detect new UI state
    const { state: newState, page: destinationPage } = await detectCurrentUIState(page, captureScreenshots);

    const action: Action = {
      id: actionId,
      type: actionType,
      targetElementId: element.id,
      targetSelector: element.selector,
      payload,
      timestamp
    };

    const urlChanged = currentState.url !== newState.url;
    const stateChanged = currentState.id !== newState.id;

    const transitionDescription = `${actionType} ${element.elementType} "${element.text || element.selector}" ${
      urlChanged ? `(Navigates to ${newState.url})` : stateChanged ? `(Opens ${newState.name})` : `(In-place action)`
    }`;

    // Evidence of a result: a confirmation/alert that was NOT on the previous
    // screen, or a navigation caused by the action.
    const before = new Set(currentState.detailLandmarks || []);
    const resultEvidence = (newState.detailLandmarks || [])
      .filter(d => d.startsWith('alert:') && !before.has(d))
      .map(d => `message: ${d.slice(6)}`);
    if (urlChanged) resultEvidence.push(`navigated to ${newState.url}`);

    const transitionId = 'trans_' + crypto.createHash('sha256').update(`${currentState.id}->${actionId}->${newState.id}`).digest('hex').slice(0, 16);

    const transition: Transition = {
      id: transitionId,
      fromStateId: currentState.id,
      toStateId: newState.id,
      action,
      urlChanged,
      triggerElementId: element.id,
      description: transitionDescription,
      discoveredAt: timestamp,
      resultEvidence
    };

    return {
      success: true,
      action,
      previousState: currentState,
      newState,
      page: destinationPage,
      transition
    };
  } catch (err: any) {
    return {
      success: false,
      action: { id: actionId, type: actionType, targetElementId: element.id, targetSelector: element.selector, payload, timestamp },
      previousState: currentState,
      error: err.message || String(err)
    };
  } finally {
    page.off('dialog', dialogHandler);
  }
}
