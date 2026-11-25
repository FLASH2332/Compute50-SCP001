# Agents plan and build plan

Status: **draft, 2026-11-24**. How each agent sits on the structure in
[ARCHITECTURE.md](ARCHITECTURE.md), and the order to build them before round 1 closes (Nov 25).
Product design and research live in the team doc "Demo Agent: Product and Harness Design".

All agents share one harness (`agents/harness.py`): phases, tool gating, pydantic-validated tool
inputs, budgets, and a `log.jsonl` per run. Agents read the graph freely but **write only through
Graph API proposals**.

---

## 1. Shared tools

| Tool | Owner module | Used by | Notes |
| --- | --- | --- | --- |
| `graph.find_flows(goal)` | `graph/queries.py` | Demo, Onboarding | Flows matching a goal, with step counts |
| `graph.path(from_page, to_page or goal)` | `graph/queries.py` | Onboarding, Demo | Shortest action path over `HAS_SECTION/HAS_ACTION/NAVIGATES_TO` |
| `graph.locate(page)` | `graph/queries.py` | All | Which `Page` the browser is on (URL match for round 1) |
| `graph.propose(change)` | `graph/store.py` | Healer, Runner | Auto-applies small fixes, queues big ones, writes a `Change` |
| `runner.run_step(action_id)` | `runner/browser.py` | Demo, Onboarding, Healer | Pre-check, act, post-check; returns a `Take` |
| `llm.complete(messages, schema)` | `llm.py` | All | Structured output; provider hidden |
| `media.speak(line, voice)` | `media/voice.py` | Demo, Onboarding | Clip + length + word timings |
| `media.check(timeline)` | `media/checks.py` | Demo | List of rule failures |
| `media.render(timeline, range, quality)` | `media/render.py` | Demo, Onboarding | Preview or final |
| `ask_user(question, options)` | `agents/harness.py` | Demo, Healer | Only way to get human input |

---

## 2. Flow builder (small, but everything depends on it)

Turns the raw page/section/action graph into named flows.

- **Input:** the crawled graph (needs multi-page crawl, milestone M1).
- **How:** the LLM gets pages + action labels + intents and proposes flows as ordered action ids
  with a name and intent. Code checks every consecutive pair is reachable in the graph
  (`NAVIGATES_TO` or same page). Invalid flows are refused with the reason.
- **Writes:** `Flow` nodes and `STEP {order}` edges via `graph.propose`.
- **Round 1:** 2–3 flows on the sample app; hand-written flows are acceptable as a fallback.

---

## 3. Demo agent

| Phase | Tools visible | Gate to leave |
| --- | --- | --- |
| Plan | `graph.find_flows`, `timeline.storyboard`, `ask_user` | Storyboard approved |
| Sample | `runner.run_step`, `media.speak`, `media.render(preview)` | 2 style samples rendered |
| Pick style | `ask_user` | Style chosen |
| Record | `graph.locate`, `runner.run_step`, `graph.propose` | Every shot has a passing take, or flow flagged |
| Assemble | `timeline.edit`, `media.speak`, `media.check` | `media.check` returns no failures |
| Review | `media.render(preview)`, `ask_user` | Approved → final render; changes → back for those shots only |

- **Reads:** flows, action labels/aliases (narration must use on-screen names), boxes from takes.
- **Writes:** `runs/<id>/timeline.json`, takes, video; graph only via proposals from the runner.
- **Round 1 rules in `media.check`:** no silence > 1 s; voice clip ≤ shot length; every button name
  in narration matches an action label or alias.

---

## 4. Healer

Runs inside every `runner.run_step` failure, and as `compute50-scp001 heal <url>` after a release.

| Observation | Decision | Graph change |
| --- | --- | --- |
| Same locator, different box/screenshot | cosmetic | update `last_seen_at`, mark dependent takes stale |
| Locator fails, one strong match by role + similar name | rename | keep id, update `label`/`locator`, push old label to `aliases`, `Change{kind:"rename"}` auto-applied |
| Expected page not reached, new page reached | step added | propose new `Action`/`Page` + flow edit → **needs approval** |
| No match at all | removed | `status = "missing"`, flow marked broken → **needs approval** |

- **Reads:** current graph, the failing take (screenshot, DOM snapshot).
- **Writes:** only `graph.propose(...)`.
- **Round 1:** the rename case end to end on sample app v2, plus "removed → flag".

---

## 5. Onboarding agent

| Phase | Tools visible | Gate |
| --- | --- | --- |
| Understand | `graph.find_flows`, `graph.path`, `llm.complete` | Question mapped to a flow or path, or "no path" |
| Show | `runner.run_step`, `media.speak`, `media.render(preview)` | Clip ready (or existing clip reused) |
| Answer | — | Clip + short text steps returned |

- **Rule:** if `graph.path` finds nothing, answer "I can't find that in this app" and log the
  question to `runs/questions.jsonl`. Never invent steps.
- **Round 1:** one question → path → short narrated clip. Live in-app guiding is roadmap.

---

## 6. Build plan (thin slice through all three parts)

Each milestone ends in something runnable. Tracks A, B, C can run in parallel once M1 is done.

| # | Milestone | Track | Done when | Est. |
| --- | --- | --- | --- | --- |
| M0 | Single-page crawl into Memgraph | A | ✅ `crawl_to_graph.py` (commit e526637) | done |
| M1 | Crawl fixes: same-origin BFS (depth 2), role+name `locator`, bounding boxes, more input types, `status` instead of delete | A | Sample app's pages all in the graph with replayable locators | 3–4 h |
| M2 | Sample app v1 / v2 (rename a button) / v3 (remove a step) | C | Three versions served locally | 1–2 h |
| M3 | Flow builder | A | 2–3 valid `Flow` nodes on v1 | 2 h |
| M4 | Runner: `run_step` with pre/post checks + Playwright video per step | B | A flow replays on v1 and yields takes | 3 h |
| M5 | Media: TTS with timings, captions, ffmpeg render from `timeline.json` | B | A narrated, captioned MP4 from one flow | 3–4 h |
| M6 | Demo agent harness: phases, 2 style samples, `media.check` (3 rules), one edit request | C | Goal in → samples → pick → final video | 3 h |
| M7 | Healer: rename on v2 auto-healed + only that shot re-recorded; removal on v3 flagged | A | Change log shows the rename; video diff shows one new shot | 2–3 h |
| M8 | Onboarding agent: question → path → clip | C | One live question answered on stage | 2 h |
| M9 | Demo script + pitch | all | 3-minute run-through rehearsed | 1 h |

**Cut order if time runs short:** M8 → second style sample → v3 removal case → captions styling.
Never cut M7's rename case: it is the novelty claim.

**Riskiest first:** M1 locators and M4 runner. Test both on the sample app before building on them.

The full feature list and the finals milestones (F1–F7) are in [FEATURES.md](FEATURES.md).
