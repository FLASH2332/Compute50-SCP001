import type { Session } from 'neo4j-driver';

/**
 * Initializes schema constraints and performance indexes in Neo4j
 */
export async function initializeNeo4jSchema(session: Session): Promise<void> {
  const schemaQueries = [
    // Unique Constraints
    `CREATE CONSTRAINT page_id_unique IF NOT EXISTS FOR (p:Page) REQUIRE p.id IS UNIQUE`,
    `CREATE CONSTRAINT uistate_id_unique IF NOT EXISTS FOR (s:UIState) REQUIRE s.id IS UNIQUE`,
    `CREATE CONSTRAINT element_id_unique IF NOT EXISTS FOR (e:Element) REQUIRE e.id IS UNIQUE`,
    `CREATE CONSTRAINT workflow_id_unique IF NOT EXISTS FOR (w:Workflow) REQUIRE w.id IS UNIQUE`,

    // Search Indexes
    `CREATE INDEX page_url_idx IF NOT EXISTS FOR (p:Page) ON (p.url)`,
    `CREATE INDEX page_path_idx IF NOT EXISTS FOR (p:Page) ON (p.path)`,
    `CREATE INDEX uistate_url_idx IF NOT EXISTS FOR (s:UIState) ON (s.url)`,
    `CREATE INDEX element_role_idx IF NOT EXISTS FOR (e:Element) ON (e.role)`,
    `CREATE INDEX element_type_idx IF NOT EXISTS FOR (e:Element) ON (e.elementType)`
  ];

  for (const query of schemaQueries) {
    try {
      await session.run(query);
    } catch (err: any) {
      console.warn(`[Neo4j Schema Warning] ${query}:`, err.message);
    }
  }
}
