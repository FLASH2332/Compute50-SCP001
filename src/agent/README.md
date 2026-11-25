# Agents on one site graph

**One graph, two agents.**
- **The graph:** built by the graph builder in `src/sections/` (crawler + enrichment: locators, URL templates,
  PageRank, areas, site profile) and kept in Memgraph.
- **The demo agent:** turns a request ("show all features and suggest a python course") into a narrated MP4.
- **The onboarding agent:** answers a question ("how do I invite a teammate?") with steps and a short clip.

Both read the same graph through one map provider (`core/mapProvider.ts`).

```
            npm run graph / first demo / first question
URL ─► graph in Memgraph? ──no──► crawl + enrich (src/sections) ─► adapt to AppMap ─► safe-click explore (dialogs, tabs) ─► save
                │ yes                                                                                                         │
                ▼                                                                                                             ▼
         AppMap (pages, areas, PageRank, controls, UI states, routes) ◄────────────────────────────────────────────────────────┘
           │                                               │
           ▼                                               ▼
   demo agent: plan → approve → record → voice → MP4    onboarding agent: understand → route / overview / site search → steps + clip
           │                                               │
           └──────── learned stats, heals, new pages ──────┴──► saved back to Memgraph
```

## Run it

```bash
npm ci && npx playwright install chromium            # once; ffmpeg must be on PATH
docker run -d -p 7687:7687 memgraph/memgraph-platform # or any Memgraph / Neo4j on NEO4J_URI

npm run graph   -- https://your.app/                   # build (or show) the site's graph once
npm run agent   -- https://your.app/ "show all features" --audience "new admin" --seconds 60
npm run onboard -- https://your.app/ "how do I invite a teammate?" [--from https://your.app/settings]
npx tsx ui/server.ts                                    # web page: site graph card, "Make a demo" and "Ask a question"
npm run agent -- edit <runId> "shorten the intro"   |   undo <runId>   |   versions <runId>   |   resume <runId>
npm test                                                # the Memgraph round trip skips if no database is running
```

Useful options:

| Option | What it does |
| --- | --- |
| `--yes` | Skip the approval and style questions |
| `--rebuild` | Build the graph again |
| `--no-db` | Don't use the database |
| `--graph file.json` | Use a saved section graph |
| `--takes 3` | Keep the cleanest of 3 takes |
| `--headed` | Show the browser while it works |

`.env` keys (all optional):

| Key | Used for | Without it |
| --- | --- | --- |
| `GROQ_API_KEY` (+`GROQ_MODEL`) | the agents: planning, narration, edits, picking answers | keyword rules |
| `AGENT_LLM=claude` (+`CLAUDE_MODEL`, default `sonnet`) | the same agent work through the Claude Code CLI (`claude -p`), on the subscription it is logged in with instead of an API key. Overrides `GROQ_API_KEY` for text; Groq still does vision if set. Counts against the plan's usage limits | — |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | voice | silent track + captions |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | the **graph builder**: site profile, guided crawl, area names. Any OpenAI-compatible server: a local Ollama, or Groq (`https://api.groq.com/openai/v1`, `openai/gpt-oss-20b`, your Groq key) | brute-force crawl; areas named after their top page; no profile |
| `NEO4J_URI` | graph database (default `bolt://localhost:7687`) | — |
| `DEMO_ALLOW_HOSTS` | your own apps (default `localhost`) | — |

Output:
- demos: `runs/<runId>/out/` (`demo.mp4`, `.srt`/`.vtt`, `.gif`, `chapters.txt`, `stills/`)
- answer clips: `runs/onboarding/<key>/out/answer.mp4`
- every question: `runs/questions.jsonl`, the demand list shown in the UI

## What each agent takes from the graph

| From the graph builder | Demo agent | Onboarding agent |
| --- | --- | --- |
| PageRank, betweenness | tour order; `demo_score` for vague requests | "where should I start?" |
| Areas (named communities) | chapters; one page per area in an overview | "what can I do?"; questions can name an area ("team admin") |
| Site profile (`App.purpose`) | the intro line; planner context | overview answers |
| Locators, risk classes, reliability | finding controls (tier 1); the risk gate; route costs | the same |
| Pages, sections, controls, links + our UI states | planning and routing | routes from the viewer's page (`--from`) |
| Search boxes | search → result steps | fallback when the map has no route (never invented) |

## Two site modes

| Mode | Hosts | The agents may |
| --- | --- | --- |
| **full** | in `DEMO_ALLOW_HOSTS` (your own app) | everything, including filling forms and pressing submit/save once the storyboard is approved |
| **public** | any other site | follow links, switch tabs, open dialogs, type into **search boxes**, open results. No other typing, no submit/save, form POSTs blocked |

## Code layout (plug and play)

```
src/agent/
  core/appMap.ts       AppMap: pages, areas, sections, controls, UI states, edges + routing (Dijkstra) and edge stats
  core/mapProvider.ts  ensureMap(): given map → saved graph → build, save, read back (shared by both agents)
  core/ports.ts        interfaces: MapStore, TextModel, VisionModel, Speech, Approver, BrowserHooks
  explore/             safe-click explorer: learns dialogs and tabs (UI states) on top of the graph
  nav/                 locate a control (with healing), risk gate + site modes, driveTo (route, re-plan, recover)
  plan/                planner.ts (graph + request → steps), flows.ts, storyboard.ts
  record/              runner.ts (one take per shot; search / open_result / show / goto steps), overlay.js
  media/               cuts, zoom, voice fitting, captions, ffmpeg render, rule checks
  run/                 DemoAgent (phases), edit / undo / versions
  onboard/             OnboardingAgent: understand (question → route), overview (areas, PageRank), search fallback,
                       answer (text steps), show (clip, cached)
  providers/           Groq, Claude Code CLI, ElevenLabs / silent speech, CLI / auto approver
  adapters/            sectionGraph.ts: graph builder → AppMap; graphDbStore.ts: Memgraph/Neo4j MapStore
  cli.ts, graphCli.ts, onboard/cli.ts   composition roots
```

Rule: only `adapters/` and `cli.ts` import code outside `src/agent/`. A test enforces it. The graph builder
(`src/sections/`) is not edited by the agents.

To swap one piece, implement the matching port:

| To change | Implement |
| --- | --- |
| The graph database | `MapStore` |
| The graph builder / crawler | a `MapSource` that returns an `AppMap` |
| The LLM | `TextModel` |
| The voice | `Speech` |
| The approval step (web UI, MCP elicitation) | `Approver` |

## Graph schema in Memgraph

```
(:App {origin, startUrl, source, purpose, size, flows})-[:HAS_PAGE]->(:Page {url, id, title, template, pagerank, betweenness, reachable, deadEnd})
(:App)-[:HAS_AREA]->(:Area {id: "<origin>#<area>", name, summary, medoid})-[:CONTAINS]->(:Page)
(:Page)-[:HAS_SECTION]->(:Section {id, name, role, regionSelector})-[:HAS_ACTION]->(:Action {id, label, type, selector, risk, locators, samples, count, reliability, aliases, hits})
(:Action)-[:NAVIGATES_TO]->(:Page)
(:State {id, dialog, tab, visibleActions, preActions})-[:STATE_OF]->(:Page)
(:State)-[:ACTION {actionId, kind, n, s, reliability, cost, status}]->(:State)
```

Several sites live in one database, keyed by origin.
- `Page`, `Section` and `Action` use the same keys as the studio's Cypher export.
- Areas are replaced on every save (each crawl rebuilds them).
- An edge that fails 3 times in a row gets `status: "broken"` and routing skips it. Nothing is deleted.

**The benchmark (`bench/`) empties the database when it loads a snapshot,** so give it its own Memgraph (see
`bench/README.md`).

## Good next steps

- **Narration:** redo the whole-script writing, style guide and repetition check on this branch. It improves both
  agents, because they share `media/voice.ts`.
- **MCP server:** `make_demo` and `ask` tools, with an `Approver` that asks through elicitation.
- **Grounded answers (FEATURES A2.5):** check an answer against a word-for-word quote from the page.
- **Ads:** hide ad overlays that don't block clicks. Today they can still appear in frame.
- **Vision review:** set `GROQ_VISION_MODEL` and tune the take review in `record/runner.ts`.
