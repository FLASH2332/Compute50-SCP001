# Old SiteGraph: agents

Design rule of the old project: **a deterministic engine does the clicking; LLM agents sit on top and take over only
where judgement is needed.** With no model configured, every feature falls back to the engine (`OfflineLLM`).
Everything an agent does goes through one **tool layer**, where safety is enforced.

Sources: `old/agents/*.py`, `old/tools/*.py`, `old/capture/*`, the old README "Agents and tools", and the v3 plan design.

---

## 1. Who does what

| Component | File | Programs or LLM? | Job |
| --- | --- | --- | --- |
| **Navigator** | `agents/navigator.py` (1,072 lines) | Program; escalates to an LLM recovery agent | Explores (builds the graph) and executes routes (uses it), heals locators |
| **Curator** | `agents/curator.py` | Program; escalates to an LLM review agent | Summaries, intents, embeddings, graph algorithms, features, retention, anomaly review |
| **Orchestrator** | `agents/orchestrator.py` (933 lines) | Program + LLM at branch points | Turns a request into a plan of steps, runs them, verifies |
| **Execution (chat) agent** | `agents/execution_agent.py` | LLM tool loop | Conversational front door over 60+ tools |
| **Recovery agent** | `agents/escalation.py` | LLM tool loop (restricted tools) | Gets the Navigator unstuck (cookie wall, overlay, element gone) |
| **Curator review agent** | `agents/escalation.py` + `tools/curator_tools.py` | LLM tool loop | Merges / renames states, quarantines / restores edges, each with a logged reason |
| **Demo agent** | `agents/demo_agent.py` | LLM tool loop | See [demo-agent.md](demo-agent.md) |
| **Demo Director** | `demo/director.py` | Program | Fixed demo pipeline, the no-LLM fallback |

Shared machinery: `agents/loop.py` (`AgentLoop`: run the model ↔ tools until `done`, `max_steps` (60), `max_tokens`
(~400k), `stuck` (same call repeated), `needs_approval`, `needs_input`, `error`), `llm.py` (LiteLLM client, tool
calling, `TracingLLM` traces with redacted arguments).

---

## 2. Agents that BUILD the graph

### 2.1 Navigator.explore — pull-and-claim exploration

Work lives as `WorkItem` nodes in the ops graph, so several Navigators can share one site without repeating work.

```
seed WorkItem(page, entry_url)
loop until budget / max_states / no work:
    item = ops.next_item(...)          # highest priority, claimed with a 2-minute lease
    if item.kind == "page":   _process_page:  goto url → observe → write_state → mark Entry
                                              → queue a click/hover/select/check/press item per candidate element
    else:                     _process_click: replay the `pre` chain from a fresh load → observe "before"
                                              → resolve element → act → observe "after"
                                              → if screen changed:  write_state(after) + write_action(ACTION edge)
                                                                    new URL template → queue a page item (depth+1)
                                                                    same URL → queue the new elements with pre+(this step)
                                                else if a region changed: write_transition(TRANSITION edge) + queue revealed items
                                              → mark element tried, log a Step
    ops.finish_item(item)
refresh :Frontier labels
```

- Candidates are filtered by the **exploration policy** (risk limit, deny patterns, robots.txt, `allow_forms`).
- Login walls (a password field) and robots-blocked pages are skipped and leave a note.
- `max_path_len` bounds chained clicks (open menu → click Help).
- Every path replays from a fresh page load: correct but slow (the old project's main performance limit).

### 2.2 Orchestrator.explore — how many explorers, which mode

- **Modes** (`exploration_mode`): `brute` (the loop above), `guided` (rounds: open work items grouped into frontier
  groups, one LLM call picks groups to explore and patterns to skip), `auto` (no model → brute; big site → guided).
- **Site bootstrap** (`agents/bootstrap.py`): one LLM call over the entry page, robots.txt and sitemap size → a
  `SiteProfile` (purpose, sections, size, skip rules, top flows) stored on `Site`.
- **Parallel explorers**: N Navigators (`navigators_per_site`: 2 in code, 3 in `config.yaml`), each forking its own **branch
  graph** (`GRAPH.COPY`), sharing one work queue; `spawner.py` adds explorers while the backlog grows. The Curator
  merges branches back (`git.py`: commits, merge, blame, revert, tags).
- **Goal-directed exploration** (`explore_toward`, `goal_explore.py`, `inputs.py`): when a request names a screen the map
  lacks, try the site's own controls first (search box, dropdown, filters, with values derived from the goal), then
  guided rounds with the goal in the prompt, until a screen scores high enough.

### 2.3 Curator.run_all — making the raw map useful

Runs once after exploration: `annotate` (LLM summary + intents per State, embeddings) → `run_algorithms` (PageRank,
betweenness, harmonic, WCC, label propagation, `:DeadEnd`) → `build_features` → `compute_demo_scores` →
`workflow_intelligence` (FOLLOWED_BY, SIMILAR_TO, workflow rank, intent dedupe) → `refresh_frontiers` →
`apply_retention` (keep 100 runs).

With a model it then runs `find_anomalies` — near-duplicate states (Jaccard 0.6–0.85), clashing or generic names,
state explosion (>8 states per page), failing edges (seen ≥5, reliability <0.4) — and hands them to the **review
agent**, which may `merge_states`, `rename_state`, `quarantine_edge`, `restore_edge` (max 20 edits, each logged as an
`Observation{kind:'curation'}`). If anything changed, algorithms are recomputed.

---

## 3. Agents that USE the graph

### 3.1 Request path (`Orchestrator.handle`, used by `run`, `chat` and eval)

```
plan   = Planner.plan(text)            # LLM: up to 6 steps, each {kind, goal, params, item}; fallback: keyword classify
for step in plan:                      # kinds: explore | automate | ask | demo | recommend | save_workflow | remember
    run_task(step)                     # shares one browser across steps so "ask" reads the page "automate" reached
    stop at first step that is not done
finish_check(results)                  # LLM: complete / answer with a verbatim quote as evidence / not finished
```

### 3.2 Automate: `Navigator.execute_goal`

1. `find_targets(goal)` → candidate States/Workflows with scores; below `min_target_score` (0.35) → "no target"
   (then `explore_toward` may run). Two targets within `choose_margin` (0.05) → one LLM call picks (`planner.choose_target`,
   cached on the Intent).
2. A Workflow target → `execute_workflow`; a State → `drive_to`.
3. `drive_to`: `best_routes(cur, target)` → `execute_step` for each step → on a failed step, re-plan from where it
   landed (up to `max_replans` = 3) → then escalate the whole goal to the recovery agent.
4. For list templates, `choose_item` picks the entry (text in the request → embedding match → LLM over live entry
   texts → first item); logged as `Observation{kind:'item_choice'}`.

### 3.3 Ask

Drive to the screen, read the page, answer with one LLM call; `verify` requires the answer's evidence to be a verbatim
quote from the page, otherwise "could not confirm".

### 3.4 Chat (`ExecutionAgent`)

An `AgentLoop` over the full toolbox. Each user message first goes through `Orchestrator.handle`; the tool loop is the
fallback when a step fails. System prompt rules: prefer the map (`find_screens`, `run_goal`, `plan_route`) over
clicking by hand; observe → act with element ids; stop on `needs_approval`.

Tool families (`tools/`): graph (`find_screens`, `plan_route`, `describe_state`, `recommend`, `list_workflows`),
browser (`observe`, `list_items`, `click`, `hover`, `fill`, `select_option`, `set_checked`, `press`, `scroll`,
`read_text`, `open_url`), engine (`run_goal`, `run_route`, `explore`, `explore_toward`, `fill_inputs`, `make_demo`,
`save_workflow`), memory (`remember`, `recall`, `list_memories`, `forget`), git (`git_log`, `blame`, `git_tag`,
`git_revert`, `rerender_demo`), insight (`next_actions`, `frontier`, `impact`), ops, semantic, profile, `ask_user`.

---

## 4. The tool layer (`tools/core.py`) — where the rules are enforced

| Mechanism | What it does |
| --- | --- |
| `ToolSpec` | name, description, JSON schema, function, effect (`read` / `act` / `risky`), `untrusted_output`, `sensitive_args` |
| Validation | args checked with `jsonschema`; a bad call becomes an error result the model can read |
| Risk gate | `risky` tools, or a tool calling `ctx.require_approval(reason)` mid-run (e.g. a click on Checkout), need a **one-time approval for that exact (tool, args)**; models can never approve |
| Untrusted output | page text wrapped in "[untrusted website content …]" markers and trimmed to 6,000 chars |
| Redaction | typed values are never stored; only variable names; `Toolbox.redacted` hides them in logs/traces |
| `box.restrict(include)` | each agent gets only its tool subset (recovery agent: observe, list_items, click, hover, scroll, read_text, open_url, find_screens, plan_route, describe_state) |
| `ToolResult.pause` / `image_png` | a tool can pause the loop for user input, or attach an image the model sees next turn |

The same toolbox is served over MCP (`mcp_server.py`), with approvals through MCP elicitation.
