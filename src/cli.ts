import dotenv from 'dotenv';
import { GraphBuilder } from './graph/graphBuilder.js';
import { PlaywrightExplorer } from './explorer/playwrightExplorer.js';
import { Neo4jService } from './neo4j/neo4jClient.js';
import { syncGraphToNeo4j } from './neo4j/sync.js';
import { generateCypherScript } from './neo4j/cypherExporter.js';
import fs from 'node:fs';

dotenv.config();

async function runCli() {
  const args = process.argv.slice(2).filter(arg => arg !== '--screenshots');
  const targetUrl = args[0] || 'http://localhost:3000/demo';
  const maxStates = Number(args[1] ?? 15);
  const maxDepth = Number(args[2] ?? 3);
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error('maxStates must be a positive integer and maxDepth must be a nonnegative integer.');
  }

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Web Graph Engine CLI`);
  console.log(`Target URL:  ${targetUrl}`);
  console.log(`Max States:  ${maxStates}`);
  console.log(`Max Depth:   ${maxDepth}`);
  console.log(`======================================================\n`);

  const graphBuilder = new GraphBuilder();
  const explorer = new PlaywrightExplorer(
    {
      startUrl: targetUrl,
      maxStates,
      maxDepth,
      headless: true,
      captureScreenshots: process.argv.slice(2).includes('--screenshots'),
      browserChannel: process.env.CRAWLER_BROWSER_CHANNEL
    },
    graphBuilder
  );

  let crawlError: string | undefined;
  explorer.on('crawler_event', (evt) => {
    if (evt.type === 'error') {
      crawlError = evt.data.error;
    } else if (evt.type === 'state_discovered') {
      console.log(`[STATE] Discovered: ${evt.data.state.name} (${evt.data.state.id})`);
    } else if (evt.type === 'transition_discovered') {
      console.log(`[TRANSITION] ${evt.data.transition.description}`);
    } else if (evt.type === 'workflow_detected') {
      console.log(`[WORKFLOW] Found: ${evt.data.name} (${evt.data.stepCount} steps)`);
    } else if (evt.type === 'log') {
      console.log(`[INFO] ${evt.data.message}`);
    }
  });

  await explorer.start();
  if (crawlError) throw new Error(crawlError);

  const model = graphBuilder.getModel();
  console.log(`\n======================================================`);
  console.log(`✅ Exploration Finished! Summary:`);
  console.log(`- Pages:       ${Object.keys(model.pages).length}`);
  console.log(`- UI States:   ${Object.keys(model.states).length}`);
  console.log(`- Elements:    ${Object.keys(model.elements).length}`);
  console.log(`- Transitions: ${Object.keys(model.transitions).length}`);
  console.log(`- Workflows:   ${Object.keys(model.workflows).length}`);
  console.log(`======================================================\n`);

  // Export Cypher file
  const cypherScript = generateCypherScript(model);
  const cypherPath = 'website_graph.cypher';
  fs.writeFileSync(cypherPath, cypherScript);
  console.log(`📄 Cypher export saved to: ${cypherPath}`);

  // Test Neo4j Sync
  console.log(`\nConnecting to Neo4j...`);
  const neo4jService = new Neo4jService();
  const check = await neo4jService.verifyConnection();
  if (check.connected) {
    console.log(`Neo4j Connected (${check.version}). Syncing graph...`);
    const session = neo4jService.getSession()!;
    const stats = await syncGraphToNeo4j(session, model);
    console.log(`🎉 Neo4j Sync Succeeded in ${stats.durationMs}ms:`, stats);
    await session.close();
  } else {
    console.log(`Neo4j not reachable (${check.error}). Exported .cypher file can be imported anytime.`);
  }
  await neo4jService.close();
}

runCli().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
