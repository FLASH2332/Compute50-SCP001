# Old project: SiteGraph (reference docs)

These docs describe the earlier project at `D:\BrowserAgent_FullCode\`, written 2026-10-16 to 2026-10-19 for a
different hackathon. They exist so we can reuse what worked. Nothing here is part of Compute50-SCP001's code.

| Doc | What it covers |
| --- | --- |
| [graph.md](graph.md) | The graph: node and edge types, how identity (`gid`) is computed, scoring, the other graphs |
| [agents.md](agents.md) | Agents that **build** the graph (Navigator explore, Curator, Orchestrator) and agents that **use** it (execute, chat, recovery) and the tool layer |
| [healing.md](healing.md) | Every healing mechanism, from locator fallbacks to quarantined edges, in the order they fire |
| [demo-agent.md](demo-agent.md) | The fixed demo pipeline and the LLM Demo agent (rehearse, script, final take, render, voice) |
| [../OLD_VS_NEW.md](../OLD_VS_NEW.md) | Comparison with the current repo and plan: what to carry over, what to drop |
| [../FEATURES.md](../FEATURES.md) | The full feature list: what we port from here and what we build new |

Base path used in these docs: `old/` = `D:\BrowserAgent_FullCode\BrowserAutomation_Agent\src\sitegraph\`.

---

## The two repositories

| Repo | Language | Size | Role |
| --- | --- | --- | --- |
| `BrowserAutomation_Agent` | Python 3.11 | ≈12,600 lines in `src/sitegraph`, 76 test files, 18 fixture HTML pages | The engine, agents, CLI and MCP server. Package name `sitegraph`. Branch `llm_test` checked out (35 commits). |
| `BrowserAgent-Frontend` | TypeScript + React (Vite), one FastAPI bridge | ≈4,500 lines | A live console: a WebSocket bridge (`bridge/server.py`) imports the backend and streams its events (model turns, tool calls, routes, heals, approvals, commits, demos) to a React trace view. |

## Stack

| Piece | Choice | Notes |
| --- | --- | --- |
| Graph DB | FalkorDB **4.22.1** (Redis module) via Docker | Pinned: 6.x not supported. Uses `algo.SPpaths`, `algo.pageRank`, betweenness, harmonic, label propagation, WCC, vector and full-text indexes, `GRAPH.COPY`. |
| Browser | Playwright Chromium | DOM captured by an injected script, `old/capture/extract.js` (175 lines). |
| LLM | LiteLLM (any provider), default `openai/gpt-4o-mini` | Every feature has an offline fallback (`OfflineLLM`). |
| Embeddings | `sentence-transformers`, `BAAI/bge-small-en-v1.5` (384-d) | Cached in SQLite; `hash` embedder for offline tests. |
| Video | ffmpeg via `imageio-ffmpeg` | Playwright records the page; ffmpeg cuts and encodes. |
| Voice | `pyttsx3` (optional extra), offline | WAVs mixed onto one track. |
| Other | `mcp` (MCP server), `keyring` (secrets), `jsonschema` (tool args), `pillow` |

## How it was driven

```bash
docker compose up -d                                   # FalkorDB
python -m sitegraph run https://books.toscrape.com/ "explore the site" "open the travel category" "make a gif of the menu"
python -m sitegraph chat https://books.toscrape.com/   # LLM tool-calling agent
python -m sitegraph mcp  https://books.toscrape.com/   # same tools over MCP
python -m sitegraph eval eval/suites/quick.yaml        # evaluation harness
```

## Status it reached (from its own `docs/PROGRESS.md`)

- Last full test run: 275 passed, 1 skipped (live LLM), 2 fixture errors later fixed (2026-10-18, 32 min).
- Run live on books.toscrape.com and the-internet.herokuapp.com, with Claude over MCP and a small local model.
- The demo flow "rehearse → script → one clean take" was the last big feature (commit `f60ab67`).
- Known limits it listed: public pages only, slow exploration (every path replays from a fresh load), no drag, slider,
  upload or virtualised lists, little real-LLM testing of the vision features.
