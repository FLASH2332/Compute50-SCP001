/**
 * MCP server (stdio) exposing the app graph in Memgraph to an agent. Load a snapshot first (bench/graph/load.ts);
 * the agent runner does that for you.
 *
 *   npx tsx bench/mcp/server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { closeDb } from '../graph/db.js';
import { GraphTools } from './tools.js';

export const TOOL_NAMES = ['site_overview', 'list_pages', 'get_page', 'search', 'find_path', 'list_areas',
  'open_page', 'perform', 'fill', 'where_am_i', 'finish'] as const;

export function buildServer(tools = new GraphTools()): McpServer {
  const server = new McpServer({ name: 'app-graph', version: '0.1.0' }, {
    instructions: 'Tools over a graph of a website: pages, their sections, the actions in each section, recorded click ' +
      'results and links between pages. Read tools only read the graph. open_page, perform and fill act in a read-only ' +
      'browser and report which graph page it is on. Ids come from tool results; never make one up.',
  });
  const reply = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await fn()) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(e?.message || e).split('\n')[0] }) }], isError: true };
    }
  };

  server.registerTool('site_overview', {
    description: 'Summary of the whole graph: start page, how many pages, section roles, and any other node types it has (for example areas or an app profile). Call this first.',
    inputSchema: {},
  }, () => reply(() => tools.siteOverview()));

  server.registerTool('list_pages', {
    description: 'Pages in the graph with their titles. Optional filter text matches the title or URL.',
    inputSchema: { filter: z.string().optional(), include_unopened: z.boolean().optional().describe('also list pages only known through a link') },
  }, a => reply(() => tools.listPages(a.filter, a.include_unopened ?? false)));

  server.registerTool('get_page', {
    description: 'One page: its sections in order, the actions in each section (links, buttons, fields), what recorded clicks did, and the pages it links to. Accepts a page id, URL or path. Give section_id to see every action of one section.',
    inputSchema: { page_id: z.string(), section_id: z.string().optional() },
  }, a => reply(() => tools.getPage(a.page_id, a.section_id)));

  server.registerTool('search', {
    description: 'Text search over page titles, section names and summaries, action labels and recorded click results. Returns ids with scores.',
    inputSchema: { text: z.string() },
  }, a => reply(() => tools.search(a.text)));

  server.registerTool('find_path', {
    description: 'Cheapest route between two pages as a list of steps (perform this action_id, or open_page). from_page defaults to the start page.',
    inputSchema: { to_page: z.string(), from_page: z.string().optional() },
  }, a => reply(() => tools.findPath(a.from_page, a.to_page)));

  server.registerTool('list_areas', {
    description: 'Named areas of the app and the pages in each, if the graph has them.',
    inputSchema: {},
  }, () => reply(() => tools.listAreas()));

  server.registerTool('open_page', {
    description: 'Open a graph page in the live browser.',
    inputSchema: { page_id: z.string() },
  }, a => reply(() => tools.openPage(a.page_id)));

  server.registerTool('perform', {
    description: "Click an action (link, button, tab) in the live browser. Opens the action's page first if needed. For an action that stands for a list of similar items, give item = the visible text of the one to click. Returns the graph page the browser is on afterwards.",
    inputSchema: { action_id: z.string(), item: z.string().optional() },
  }, a => reply(() => tools.perform(a.action_id, a.item)));

  server.registerTool('fill', {
    description: 'Type text into a field (or choose an option of a select) in the live browser. submit=true presses Enter afterwards. Only searches and other GET forms can submit; nothing that changes data is sent.',
    inputSchema: { action_id: z.string(), text: z.string(), submit: z.boolean().optional() },
  }, a => reply(() => tools.fill(a.action_id, a.text, a.submit ?? false)));

  server.registerTool('where_am_i', {
    description: 'Which graph page the live browser is on.',
    inputSchema: {},
  }, () => reply(() => tools.whereAmI()));

  server.registerTool('finish', {
    description: 'End the task. answer = your final answer in plain words (say NOT FOUND if the graph has no way to do it). Give page_id and action_ids when the task asks for a page or a control.',
    inputSchema: { answer: z.string(), page_id: z.string().optional(), action_ids: z.array(z.string()).optional() },
  }, () => reply(async () => ({ recorded: true })));

  return server;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('bench/mcp/server.ts')) {
  const tools = new GraphTools();
  const server = buildServer(tools);
  const shutdown = async () => { await tools.close(); await closeDb(); process.exit(0); };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
}
