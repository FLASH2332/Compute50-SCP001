# Benchmark harness

Compares graph variants (`graph_base` vs `new_graph_base`) by letting the **same agent** do the **same tasks** on the
**same sites**, using **only the graph** through an MCP server. Nothing in this folder may differ between the two
branches: fix the harness on `graph_base`, then merge it into `new_graph_base`.

## Pieces

| File | What it does |
| --- | --- |
| `config.ts` | All settings, from env / `.env` (LLM server, Memgraph, limits) |
| `crawl.ts` | Crawls a site with this branch's crawler (Demo Studio settings) → `snapshots/<site>/<variant>/graph.json` |
| `graph/load.ts` | Loads a snapshot into Memgraph (clears it first) |
| `graph/url.ts` | URL → page id, the same rule as the graph_base crawler |
| `mcp/server.ts` | MCP server (stdio) with the agent's tools |
| `mcp/tools.ts` | Tool logic: Cypher over Memgraph, plus the read-only live browser |
| `mcp/browser.ts` | Read-only Playwright browser: non-GET requests and off-site navigation are blocked |
| `agent/agent.ts` | The agent: an MCP client + an OpenAI-compatible LLM, with a tool-call and time limit |
| `agent/cli.ts` | Ad-hoc runs: `npm run agent -- --site books "task"` |
| `serve.ts` | Serves a local fixture folder |
| `test/harness.e2e.ts` | End-to-end check with a scripted fake model |

## Setup

```bash
npm ci
npx playwright install chromium
docker run -d --name compute50-memgraph -p 7687:7687 memgraph/memgraph-mage
```

`.env` (all optional; defaults shown):

```bash
LLM_BASE_URL=http://localhost:11434/v1   # Ollama; LM Studio: http://localhost:1234/v1
LLM_MODEL=qwen2.5:7b-instruct            # must support tool calling
LLM_API_KEY=local
LLM_REASONING_EFFORT=none                # thinking models: none = thinking off (fast); empty = model default
MEMGRAPH_URI=bolt://localhost:7687
AGENT_MAX_TOOL_CALLS=15
AGENT_MAX_MS=120000
```

## Use

```bash
npm run bench:crawl -- --site books --url https://books.toscrape.com/ --pages 25 --hops 3
npm run agent -- --site books "Find the page for the Travel category and open it"
npx tsx --test bench/test/harness.e2e.ts
```

Every agent run is saved with every tool call and result under `results/`.

## The agent's tools

| Tool | Reads / does |
| --- | --- |
| `site_overview` | Start page, counts, section roles, other node types the graph has |
| `list_pages(filter?, include_unopened?)` | Pages with every stored property |
| `get_page(page_id, section_id?)` | Sections in order, their actions, recorded click results, links to other pages |
| `search(text)` | Plain word match over every text property of pages, sections, actions, click results and extra nodes |
| `find_path(to_page, from_page?)` | Cheapest route; edge cost = the edge's `cost` property if present, else 1 |
| `list_areas` | `Area` nodes and their pages, if the graph has them |
| `open_page(page_id)` | Opens the page in the live browser |
| `perform(action_id, item?)` | Clicks the action with its stored locators (in order), reports the graph page it lands on |
| `fill(action_id, text, submit?)` | Types into a field; only GET forms can submit |
| `where_am_i` | Which graph page the browser is on |
| `finish(answer, page_id?, action_ids?)` | Ends the task |

The agent never sees HTML or page text: act tools return only locator match counts and graph page ids.

## Contract for graph variants

The loader and tools read the crawler's `SectionGraphModel` (`src/sections/types.ts`). A variant may **add**, never
rename or remove:

- **Properties** on pages, sections, actions, interactions or links. They are copied to Memgraph as they are
  (objects become JSON strings) and shown by the tools. `selector`, `locators` and `fingerprint` are used by `perform`
  but hidden from the agent.
- **`Action.locators: string[]`**, tried in order before `selector`. Formats: `role=<role>|name=<name>`,
  `testid=<id>`, `css=<selector>`, `text=<exact text>`, `item=<selector>` (with `perform`'s `item` text), or any
  Playwright selector.
- **`Page.urlPattern`**: a regex; a browser URL that matches it maps to that page (for URL templates).
- **`cost`** on a link (or an action, or an interaction): used by `find_path`.
- **`model.extraNodes: {label, id, props}[]`** and **`model.extraEdges: {type, from: {label, id}, to: {label, id}, props}[]`**
  for new node and edge types. `Area` nodes with `name` / `summary` and `(:Area)-[:CONTAINS]->(:Page)` edges are shown by
  `list_areas`.
- **`model.buildStats.llmCalls`**: LLM calls spent building the graph (reported by `crawl.ts`).

The crawler is called as `new SectionCrawler(config, graph).start()`, with the config `crawl.ts` passes; a variant must
keep that entry point.
