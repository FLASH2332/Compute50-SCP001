import type { Session } from 'neo4j-driver';
import type { GraphModel } from '../types/graph.js';
import { initializeNeo4jSchema } from './schema.js';

export interface SyncStats {
  pagesSynced: number;
  statesSynced: number;
  elementsSynced: number;
  transitionsSynced: number;
  workflowsSynced: number;
  durationMs: number;
}

/**
 * Idempotently syncs the entire GraphModel into Neo4j using Cypher MERGE
 */
export async function syncGraphToNeo4j(session: Session, graph: GraphModel): Promise<SyncStats> {
  const startTime = Date.now();

  // Ensure schema constraints exist
  await initializeNeo4jSchema(session);

  const tx = session.beginTransaction();

  try {
    // 1. Sync Website Root Node
    if (graph.domain) {
      await tx.run(
        `MERGE (w:Website {domain: $domain})
         ON CREATE SET w.createdAt = datetime()
         SET w.lastSyncedAt = datetime()`,
        { domain: graph.domain }
      );
    }

    // 2. Sync Pages
    let pagesSynced = 0;
    for (const page of Object.values(graph.pages)) {
      await tx.run(
        `MERGE (p:Page {id: $id})
         SET p.url = $url,
             p.path = $path,
             p.title = $title,
             p.domain = $domain,
             p.discoveredAt = $discoveredAt
         WITH p
         MATCH (w:Website {domain: $domain})
         MERGE (w)-[:HAS_PAGE]->(p)`,
        {
          id: page.id,
          url: page.url,
          path: page.path,
          title: page.title,
          domain: page.domain,
          discoveredAt: page.discoveredAt
        }
      );
      pagesSynced++;
    }

    // 3. Sync UIStates
    let statesSynced = 0;
    for (const state of Object.values(graph.states)) {
      await tx.run(
        `MERGE (s:UIState {id: $id})
         SET s.name = $name,
             s.url = $url,
             s.isModal = $isModal,
             s.modalTitle = $modalTitle,
             s.elementCount = $elementCount,
             s.activeLandmarks = $activeLandmarks,
             s.discoveredAt = $discoveredAt
         WITH s
         MATCH (p:Page {id: $pageId})
         MERGE (p)-[:HAS_STATE]->(s)`,
        {
          id: state.id,
          name: state.name,
          url: state.url,
          isModal: state.isModal,
          modalTitle: state.modalTitle || '',
          elementCount: state.elementCount,
          activeLandmarks: state.activeLandmarks,
          discoveredAt: state.discoveredAt,
          pageId: state.pageId
        }
      );
      statesSynced++;
    }

    // 4. Sync Elements
    let elementsSynced = 0;
    for (const elem of Object.values(graph.elements)) {
      await tx.run(
        `MERGE (e:Element {id: $id})
         SET e.selector = $selector,
             e.tag = $tag,
             e.role = $role,
             e.text = $text,
             e.elementType = $elementType,
             e.isInteractive = $isInteractive
         WITH e
         MATCH (s:UIState {id: $stateId})
         MERGE (s)-[:CONTAINS_ELEMENT]->(e)`,
        {
          id: elem.id,
          selector: elem.selector,
          tag: elem.tag,
          role: elem.role,
          text: elem.text,
          elementType: elem.elementType,
          isInteractive: elem.isInteractive,
          stateId: elem.stateId
        }
      );
      elementsSynced++;
    }

    // 5. Sync Transitions
    let transitionsSynced = 0;
    for (const trans of Object.values(graph.transitions)) {
      await tx.run(
        `MATCH (from:UIState {id: $fromStateId})
         MATCH (to:UIState {id: $toStateId})
         MERGE (from)-[r:TRANSITION {id: $id}]->(to)
         SET r.actionType = $actionType,
             r.description = $description,
             r.urlChanged = $urlChanged,
             r.resultEvidence = $resultEvidence,
             r.discoveredAt = $discoveredAt`,
        {
          id: trans.id,
          fromStateId: trans.fromStateId,
          toStateId: trans.toStateId,
          actionType: trans.action.type,
          description: trans.description,
          urlChanged: trans.urlChanged,
          resultEvidence: trans.resultEvidence || [],
          discoveredAt: trans.discoveredAt
        }
      );

      // If transition was triggered by a specific Element, link element to target state
      if (trans.triggerElementId) {
        await tx.run(
          `MATCH (e:Element {id: $elemId})
           MATCH (to:UIState {id: $toStateId})
           MERGE (e)-[r:TRIGGERS]->(to)
           SET r.actionType = $actionType`,
          {
            elemId: trans.triggerElementId,
            toStateId: trans.toStateId,
            actionType: trans.action.type
          }
        );
      }
      transitionsSynced++;
    }

    // 6. Sync Workflows
    let workflowsSynced = 0;
    for (const wf of Object.values(graph.workflows)) {
      await tx.run(
        `MERGE (w:Workflow {id: $id})
         SET w.name = $name,
             w.description = $description,
             w.stepCount = $stepCount,
             w.status = $status,
             w.evidence = $evidence,
             w.stateIds = $stateIds,
             w.transitionIds = $transitionIds
         WITH w
         MATCH (start:UIState {id: $startStateId})
         MATCH (finish:UIState {id: $endStateId})
         MERGE (w)-[:STARTS_AT]->(start)
         MERGE (w)-[:ENDS_AT]->(finish)`,
        {
          id: wf.id,
          name: wf.name,
          description: wf.description,
          stepCount: wf.stepCount,
          status: wf.status,
          evidence: wf.evidence,
          stateIds: wf.states,
          transitionIds: wf.transitions,
          startStateId: wf.startStateId,
          endStateId: wf.endStateId
        }
      );
      workflowsSynced++;
    }

    await tx.commit();

    return {
      pagesSynced,
      statesSynced,
      elementsSynced,
      transitionsSynced,
      workflowsSynced,
      durationMs: Date.now() - startTime
    };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
