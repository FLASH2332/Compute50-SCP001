# Compute50-SCP001

Hackathon project (Compute 50, PSG Tech, round 1 Nov 23–25, 2026; finals Dec 4–5).
A self-healing **app graph** of a web app drives a demo-video agent, an onboarding Q&A agent,
and a healer.

Branches:

- `graph` — the Python prototype (Python 3.13, uv, Playwright, Memgraph, Groq). `docs/CODEBASE.md` describes it.
- `demo-studio` / `section-graph` — the teammate's TypeScript graph engine and Demo Studio (Node 22, tsx, Playwright,
  neo4j-driver, Cytoscape). See `README.md` on those branches.
- `graph_base` — `demo-studio` unchanged, plus the benchmark harness in `bench/` (see `bench/README.md`).
- `new_graph_base` — `graph_base` plus the graph features from `docs/FEATURES.md` (graph only). Never edit `bench/`
  there: harness fixes go on `graph_base` and are merged forward, so both variants run the same agent code.

Read before changing code:

- `docs/CODEBASE.md` — what exists now, how to run it, graph schema, known limits. Keep it current.
- `docs/ARCHITECTURE.md` — abstract target design (draft): components, boundaries, target schema.
- `docs/AGENTS.md` — per-agent plan and the milestone build plan (M0–M9).
- `docs/old-sitegraph/` — docs of the earlier SiteGraph project (`D:\BrowserAgent_FullCode`): graph, agents, healing, demo agent.
- `docs/OLD_VS_NEW.md` — what to port from the old project (Tier 1), what is optional, what to leave out.
- `bench/README.md` — the benchmark harness: graph-only MCP tools, the agent, the contract graph variants must keep.
- `docs/FEATURES.md` — the full feature list: features to port (Tier 1, Tier 2, promoted ones) and new demo,
  onboarding and healing features, each tagged R1 / F / Later, plus the finals build order.

Rules that matter here:

- Only the Graph API layer writes the graph; agents propose changes.
- Never delete graph nodes for missing UI; mark `status` so the healer keeps history.
- Agents edit timeline JSON; rendering is plain code.
- `main` has only the README.
