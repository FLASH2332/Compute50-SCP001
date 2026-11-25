# Status: graph benchmark work

Updated 2026-11-25. What has been built on `graph_base` / `new_graph_base`, what the first runs showed, and what is
still open. How to run things: [bench/README.md](../bench/README.md).

## Merged with the agents (`agents-on-graph`)

`agents-on-graph` = `new_graph_base` + the demo agent, onboarding agent and UI from `demo-agent` /
`onboarding-any-graph`. The graph builder here (`src/sections/`) is unchanged; the agents read what it builds.

| Piece | Where |
| --- | --- |
| Graph builder (this branch's work) | `src/sections/`, `src/llm.ts` |
| Graph in Memgraph, shared by both agents | `src/agent/adapters/graphDbStore.ts` (`App`, `Area`, page metrics, locators); `src/agent/core/mapProvider.ts` |
| Graph builder → agents | `src/agent/adapters/sectionGraph.ts` (PageRank, areas, profile, locators, risk, reliability) |
| Demo agent | `src/agent/run`, `plan`, `record`, `media` (tours by PageRank, areas as chapters) |
| Onboarding agent | `src/agent/onboard/` (viewer's page, "what can I do / where to start", search fallback) |
| UI | `ui/` (site graph card, demo and ask tabs) |
| Commands | `npm run graph`, `npm run agent`, `npm run onboard`; the benchmark's agent is now `npm run bench:agent` |

The benchmark empties the database when it loads a snapshot. Point it at a separate Memgraph (`MEMGRAPH_URI`,
see `bench/README.md`); the agents use `NEO4J_URI`.

## The two branches

| Branch | What it is |
| --- | --- |
| `graph_base` | The teammate's TypeScript graph engine and Demo Studio (`demo-studio`) unchanged, plus our docs and the benchmark harness in `bench/` |
| `new_graph_base` | `graph_base` plus the graph features ported from the old SiteGraph project (see the end of this file and [FEATURES.md](FEATURES.md)) |

`bench/` must stay identical on both branches. Harness changes are made on `graph_base` and merged into
`new_graph_base`, so both variants are measured with the same agent, tools, tasks and checks.

## Done on `graph_base`

**Docs** (`docs/`): what exists, the target architecture, the agent plan, notes on the old SiteGraph project, what to
port from it, and the full feature list.

**Benchmark harness** (`bench/`):

- **Crawl to snapshot**:
  - `bench:crawl` crawls one site, and `bench:crawl-all` crawls all 7 benchmark sites with the branch's own crawler,
    using Demo Studio's settings (read-only browser, click probing).
  - Each snapshot records the harness hash and the commit that made it.
- **Graph-only MCP server** with 11 tools:
  - read tools over Memgraph: overview, pages, a page's sections and actions, search, cheapest path, areas
  - act tools in a read-only live browser: open, perform, fill, where am I
  - finish
  - The agent never sees HTML or page text.
- **Agent**: an MCP client for any OpenAI-compatible local model server (Ollama, LM Studio), at temperature 0, with
  a limit of 15 tool calls and 120 s per task.
  - `LLM_REASONING_EFFORT=none` turns off "thinking" on models like Qwen 3.5, which keeps runs fast on a laptop GPU.
- **Benchmark suite**:
  - 18 tasks: 9 categories (nav, list-item, deep, pagination, click, form, fact, unseen, impossible) × 2.
  - 7 sites: the teammate's test site, the old SiteGraph fixture shop, books and quotes toscrape, the-internet,
    demoblaze, practicesoftwaretesting.
  - Each task has an automatic check: final URL, completed click or fill, answer content, or NOT FOUND.
  - The runner alternates which variant goes first, starts a fresh browser per run, can resume a session, and has
    a 9-task `--quick` mode.
  - The report pools sessions made with the same harness code into per-category and per-task win/loss tables, with
    failure reasons and how each graph was built.
- **Tests**:
  - `bench/test/harness.e2e.ts`: crawl → load → agent, with a scripted fake model.
  - `bench/test/check.test.ts`: the task checks.

## What the first runs showed

These numbers come from one quick session (9 tasks × 2 variants, 12 minutes, model `qwen3.5:latest` on a laptop
RTX 4060), so they are only a first signal:

| | `graph_base` | `new_graph_base` |
| --- | --- | --- |
| Quick session | 6/9 passed | 7/9 passed |
| Median time per task | 40 s | 34 s |
| Better at | — | fixture search form (base gave up), Book finder form fields (base missed fields) |

- **Three failures were an agent mistake, not a graph problem.** The model read the right page in the graph and then
  said it had opened it. The agent prompt now says that reading a page does not open it. The four re-runs of those
  tasks all passed.
- **The report leaves out older runs.** It pools only runs made with the latest harness code, so the quick session
  from before the prompt fix is no longer counted.
- **Crawl time**:
  - `new_graph_base` crawls take 1.2–2.7× as long as `graph_base`, within the "not too slow" bar (3×).
  - Building a graph makes 1–4 model calls per site.

## Pending / possible next work

- **Run full sessions and pool them.** One full session (36 runs) takes about 24 minutes. A few sessions are needed
  before a difference of one or two tasks means anything.
- **Gaps both variants share.** These come from the teammate's crawler code, which `graph_base` keeps unchanged:
  - demoblaze: product cards load after the crawler decides the page is ready, because the wait stops when the
    visible controls are stable for 500 ms.
  - practicesoftwaretesting: products load through HTTP `QUERY` requests, which the read-only browser blocks.
  - Fixing them means patching the shared crawler the same way on both branches.
- **Some tasks don't separate the variants.** Pages whose URL contains the name can be found by search alone (books
  titles, the-internet examples). More tasks per category, and tasks that need clicks through lists, menus and
  buttons, would give more signal.
- **Planned metric not built: locator replay rate.** The share of stored locators that still find exactly one
  element on the live page.
- **A second model.** Results with another local model would show whether a gain comes from the graph or from how
  one model reads it.
- **`docs/CODEBASE.md` describes the Python `graph` branch**, not this TypeScript engine.
- **Still open:** confirm Compute 50's rules allow reusing our earlier SiteGraph code, and what disclosure they require.
- **Snapshots and results are gitignored.** Each machine has to crawl again (`bench:crawl-all` on both branches).

## `new_graph_base`: graph features built

Ported from the old SiteGraph project, graph side only (details and the differences from the plan:
[FEATURES.md](FEATURES.md), section "Built on `new_graph_base`"):

| Feature | What it adds |
| --- | --- |
| A1.1 richer capture | ARIA role, accessible name, box, popup and modal state, clickable `<div>`s found from hints |
| A1.2 locators | `locators[]` (role+name, test id, unique CSS, text), fingerprint, risk class |
| A1.3 URL templates | `Template` nodes, `urlTemplate` on pages, `urlPattern` for unopened pages; 3 pages per template before look-alikes |
| A1.4 list templates | one action per list of 4+ items, with count, sample texts and an `item=` locator |
| A1.8 edge cost | reliability and routing cost on actions, links and recorded clicks |
| A3.1 site bootstrap | robots.txt, sitemap size and one model call → `App` node; its skip patterns feed the crawler |
| A3.2 algorithms | PageRank, betweenness, harmonic, communities, `reachable`, `deadEnd` |
| A3.4 areas | `Area` nodes named by the model (or after their top page) |
| A3.5 / A3.6 | frontier groups and brute / guided / auto exploration |

**Code:**
- `src/sections/`: `templates.ts`, `frontier.ts`, `algorithms.ts`, `bootstrap.ts`, `enrich.ts`, and changes to
  `sectionExtractor.ts` and `sectionCrawler.ts`.
- `src/llm.ts`: the model client for graph building.

**Tests:** `test/graphFeatures.test.ts` (7 tests), plus the teammate's 12, which still pass. One assertion changed:
the events list now also has its list-template action.

**Seen in the crawls:**
- **Guided exploration** ran on quotes and the-internet. On quotes the model chose to skip 20 author pages. The
  `quotes-neruda` task shows whether that hurts.
- **Areas** follow the categories on books ("Mystery Section", "Romance Library", …).

### Pending on `new_graph_base`

- **Not ported** (outside the graph-only scope):
  - healing: A1.5–A1.7 (resolver, locator hit counts, re-plan)
  - demo and recording: A1.9–A1.12
  - `demo_score` (A3.3)
  - the MCP server with elicitation (A3.7)
  - every Part B feature (demo, onboarding, healing)
- **Simplified:**
  - Clickables are found from attribute and style hints only; there is no DevTools event-listener scan.
  - There is no goal-directed exploration (the old `explore_toward`).
- **Areas are rebuilt on every crawl.** Their `status` is always `active`, because no older graph is kept to mark
  areas `stale`.
- **Risks to watch in the results:**
  - A `urlPattern` maps an unopened page to its template's representative page (the tools say `matched_by: url
    pattern`).
  - A model's skip patterns can drop useful pages. There are guards: a pattern that would drop more than half the
    queue is ignored, and a "stop" counts only after half the page budget is used.
