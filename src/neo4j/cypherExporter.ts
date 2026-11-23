import type { GraphModel } from '../types/graph.js';

/**
 * Generates an idempotent Cypher script from the in-memory GraphModel
 * Suitable for running directly in Neo4j Browser or cypher-shell
 */
export function generateCypherScript(graph: GraphModel): string {
  const lines: string[] = [];
  const list = (items: string[]) => `[${items.map(item => `"${escapeCypher(item)}"`).join(', ')}]`;

  lines.push('// ==========================================');
  lines.push('// Web Graph Engine Export: ' + (graph.domain || 'Website Graph'));
  lines.push('// Generated at: ' + new Date().toISOString());
  lines.push('// ==========================================\n');

  lines.push('// --- Schema Constraints & Indexes ---');
  lines.push('CREATE CONSTRAINT page_id_unique IF NOT EXISTS FOR (p:Page) REQUIRE p.id IS UNIQUE;');
  lines.push('CREATE CONSTRAINT uistate_id_unique IF NOT EXISTS FOR (s:UIState) REQUIRE s.id IS UNIQUE;');
  lines.push('CREATE CONSTRAINT element_id_unique IF NOT EXISTS FOR (e:Element) REQUIRE e.id IS UNIQUE;');
  lines.push('CREATE CONSTRAINT workflow_id_unique IF NOT EXISTS FOR (w:Workflow) REQUIRE w.id IS UNIQUE;\n');

  if (graph.domain) {
    lines.push('// --- Website Root Node ---');
    lines.push(`MERGE (w:Website {domain: "${escapeCypher(graph.domain)}"})`);
    lines.push('SET w.lastSyncedAt = datetime();\n');
  }

  lines.push('// --- Pages ---');
  for (const page of Object.values(graph.pages)) {
    lines.push(
      `MERGE (p:Page {id: "${escapeCypher(page.id)}"}) ` +
      `SET p.url = "${escapeCypher(page.url)}", p.path = "${escapeCypher(page.path)}", p.title = "${escapeCypher(page.title)}", p.domain = "${escapeCypher(page.domain)}"` +
      (page.domain ? ` WITH p MATCH (w:Website {domain: "${escapeCypher(page.domain)}"}) MERGE (w)-[:HAS_PAGE]->(p);` : ';')
    );
  }
  lines.push('');

  lines.push('// --- UI States ---');
  for (const state of Object.values(graph.states)) {
    lines.push(
      `MERGE (s:UIState {id: "${escapeCypher(state.id)}"}) ` +
      `SET s.name = "${escapeCypher(state.name)}", s.url = "${escapeCypher(state.url)}", s.isModal = ${state.isModal}, s.elementCount = ${state.elementCount} ` +
      `WITH s MATCH (p:Page {id: "${escapeCypher(state.pageId)}"}) MERGE (p)-[:HAS_STATE]->(s);`
    );
  }
  lines.push('');

  lines.push('// --- Interactive Elements ---');
  for (const elem of Object.values(graph.elements)) {
    lines.push(
      `MERGE (e:Element {id: "${escapeCypher(elem.id)}"}) ` +
      `SET e.selector = "${escapeCypher(elem.selector)}", e.tag = "${escapeCypher(elem.tag)}", e.role = "${escapeCypher(elem.role)}", e.text = "${escapeCypher(elem.text)}", e.elementType = "${escapeCypher(elem.elementType)}" ` +
      `WITH e MATCH (s:UIState {id: "${escapeCypher(elem.stateId)}"}) MERGE (s)-[:CONTAINS_ELEMENT]->(e);`
    );
  }
  lines.push('');

  lines.push('// --- State Transitions ---');
  for (const trans of Object.values(graph.transitions)) {
    lines.push(
      `MATCH (from:UIState {id: "${escapeCypher(trans.fromStateId)}"}), (to:UIState {id: "${escapeCypher(trans.toStateId)}"}) ` +
      `MERGE (from)-[r:TRANSITION {id: "${escapeCypher(trans.id)}"}]->(to) ` +
      `SET r.actionType = "${escapeCypher(trans.action.type)}", r.description = "${escapeCypher(trans.description)}", r.urlChanged = ${trans.urlChanged}, r.resultEvidence = ${list(trans.resultEvidence || [])};`
    );
  }
  lines.push('');

  lines.push('// --- Workflows ---');
  for (const wf of Object.values(graph.workflows)) {
    lines.push(
      `MERGE (w:Workflow {id: "${escapeCypher(wf.id)}"}) ` +
      `SET w.name = "${escapeCypher(wf.name)}", w.description = "${escapeCypher(wf.description)}", w.stepCount = ${wf.stepCount}, w.status = "${wf.status}", w.evidence = "${escapeCypher(wf.evidence)}", w.stateIds = ${list(wf.states)}, w.transitionIds = ${list(wf.transitions)} ` +
      `WITH w MATCH (start:UIState {id: "${escapeCypher(wf.startStateId)}"}), (finish:UIState {id: "${escapeCypher(wf.endStateId)}"}) ` +
      `MERGE (w)-[:STARTS_AT]->(start) MERGE (w)-[:ENDS_AT]->(finish);`
    );
  }

  return lines.join('\n');
}

function escapeCypher(str: string): string {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}
