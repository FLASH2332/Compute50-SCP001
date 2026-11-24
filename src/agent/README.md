# Demo agent

Give it a URL and a request ("show all features and suggest a python course"). It gets the site's graph from
Memgraph, crawling the site first if the graph isn't there yet. Then it plans a demo from the graph and the request,
asks you to approve the plan, records the screen and renders a narrated MP4.

```
URL + request ─► graph in Memgraph? ──no──► crawl (section crawler) + safe-click explore ─► save to Memgraph
                        │ yes                                                                    │
                        ▼                                                                        ▼
                 load AppMap ◄────────────────────────────────────────────────────────────────────┘
                        ▼
                 plan (Groq, or keyword rules) ─► storyboard ─► approve ─► style samples ─► record ─► voice + captions ─► MP4
                                                                                             │
                                                         learned stats, heals, new pages ─► saved back to Memgraph
```

## Run it

```bash
npm ci && npx playwright install chromium        # once; ffmpeg must be on PATH
docker run -p 7687:7687 memgraph/memgraph-platform   # or any Memgraph / Neo4j on NEO4J_URI

npm run agent -- https://www.geeksforgeeks.org/ "show all features and suggest a python course" --audience "1st timer" --seconds 60
npm run agent -- edit <runId> "shorten the intro"   |   undo <runId>   |   versions <runId>   |   resume <runId>
npm test                                              # 32 tests; the Memgraph one skips if no database is running
```

Useful options:

| Option | What it does |
| --- | --- |
| `--yes` | Skip the approval and style questions |
| `--rebuild` | Crawl the site again |
| `--no-db` | Don't use the database |
| `--graph file.json` | Use a saved section graph |
| `--takes 3` | Keep the cleanest of 3 takes |
| `--headed` | Show the browser while it works |

`.env` keys (all optional):

| Key | Used for | Without it |
| --- | --- | --- |
| `GROQ_API_KEY` | planning, narration, edits | keyword rules |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | voice | silent track + captions |
| `NEO4J_URI` | graph database (default `bolt://localhost:7687`) | — |
| `DEMO_ALLOW_HOSTS` | your own apps (default `localhost`) | — |

Output goes to `runs/<runId>/out/`: `demo.mp4`, `.srt`/`.vtt`, `.gif`, `chapters.txt`, and `stills/` (one image per step).

## Two site modes

| Mode | Hosts | The agent may |
| --- | --- | --- |
| **full** | in `DEMO_ALLOW_HOSTS` (your own app) | everything, including filling forms and pressing submit/save once the storyboard is approved |
| **public** | any other site | follow links, switch tabs, open dialogs, type into **search boxes**, open results. No other typing, no submit/save, form POSTs blocked |

## Code layout (plug and play)

```
src/agent/
  core/appMap.ts     AppMap: pages, sections, controls, UI states, edges + routing (Dijkstra) and edge stats
  core/ports.ts      interfaces: MapStore, TextModel, VisionModel, Speech, Approver, BrowserHooks
  explore/           safe-click explorer: learns dialogs and tabs (UI states) on top of the crawl
  nav/               locate a control (with healing), risk gate + site modes, driveTo (route, re-plan, recover)
  plan/              planner.ts (graph + request → steps), flows.ts, storyboard.ts
  record/            runner.ts (one take per shot; search / open_result / show / goto steps), overlay.js
  media/             cuts, zoom, voice fitting, captions, ffmpeg render, rule checks
  run/               DemoAgent (phases), edit / undo / versions
  providers/         Groq, ElevenLabs / silent speech, CLI / auto approver
  adapters/          sectionGraph.ts: crawler + section graph → AppMap; graphDbStore.ts: Memgraph/Neo4j MapStore
  cli.ts             composition root
```

Rule: only `adapters/` and `cli.ts` import code outside `src/agent/`. A test enforces it.

To swap one piece, implement the matching port:

| To change | Implement |
| --- | --- |
| The graph database | `MapStore` |
| The crawler | a `MapSource` that returns an `AppMap` |
| The LLM | `TextModel` |
| The voice | `Speech` |
| The approval step (web UI, MCP elicitation) | `Approver` |

## Graph schema in Memgraph

```
(:App {origin, startUrl})-[:HAS_PAGE]->(:Page {url, title, template})
(:Page)-[:HAS_SECTION]->(:Section {id, name, role, regionSelector})-[:HAS_ACTION]->(:Action {id, label, type, selector, risk, aliases, hits})
(:Action)-[:NAVIGATES_TO]->(:Page)
(:State {id, dialog, tab, visibleActions, preActions})-[:STATE_OF]->(:Page)
(:State)-[:ACTION {actionId, kind, n, s, reliability, cost, status}]->(:State)
```

`Page`, `Section` and `Action` use the same keys as the studio's Cypher export, so both write to the same nodes. An
edge that fails 3 times in a row gets `status: "broken"` and routing skips it. Nothing is deleted.

## Good next steps

- **Studio UI:** mount the agent behind `/api/studio`, with an `Approver` that shows the storyboard in the page.
- **MCP server:** a `make_demo` tool, with an `Approver` that asks through elicitation.
- **Ads:** hide ad overlays that don't block clicks. Today they can still appear in frame.
- **Graph analytics:** PageRank, communities → Features for chapters and better tours (FEATURES.md A3.2–A3.4).
- **Vision review:** set `GROQ_VISION_MODEL` and tune the take review in `record/runner.ts`.
