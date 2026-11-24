# Feature list: what to port and what to build

Status: **draft, 2026-11-24**. One list of every feature we plan to have, in two parts:

- **Part A, ported from the old SiteGraph project:** Tier 1 and Tier 2 from [OLD_VS_NEW.md](OLD_VS_NEW.md) §4, plus
  ten features moved up from Tier 3 at the team's request: the MCP server with elicitation, PageRank, betweenness,
  harmonic centrality, label propagation, Features, `demo_score`, guided / auto exploration, site bootstrap and frontier
  groups.
- **Part B, new features** for the demo agent, the onboarding agent and the self-healing graph. These come from the team
  doc "Demo Agent: Product and Harness Design" and from [AGENTS.md](AGENTS.md).

The priority rule is the same as in OLD_VS_NEW: **first make it work, then keep it simple.** Old-code facts were
checked against `D:\BrowserAgent_FullCode\BrowserAutomation_Agent\src\sitegraph\` (written `old/` below).

> ⚠️ Still open: confirm Compute 50's rules allow reusing your own earlier code, or what disclosure they require,
> before porting anything in Part A.

## When each feature is due

| Tag | Meaning | Deadline |
| --- | --- | --- |
| **R1** | Needed for the round 1 thin slice | Nov 25, 2026 (round 1 closes) |
| **F** | Build for the finals | Dec 3, 2026 (finals Dec 4–5) |
| **Later** | Pitch as roadmap; build only if there is time | — |

Round 1 closes tomorrow, so the ten promoted features are **F**: they are added after the thin slice works, not
instead of it.

---

# Part A — ported from the old project

## A1. Tier 1: needed for it to work (R1)

| # | Feature | Old source | Lands in | How to adapt |
| --- | --- | --- | --- | --- |
| A1.1 | DOM extractor: ARIA roles, accessible names, boxes, visibility, modal state, click-listener detection | `capture/extract.js` (175 lines) | `explore/extract.js`, `explore/fetch.py` | Use as is |
| A1.2 | Element building: role, name, 4 locators, fingerprint, risk class | `capture/segment.py` (parts), `risk.py`, `normalize.py` | `explore/extract.py` | Skip ComponentState hashing and coarse identity at first |
| A1.3 | URL templates (`/product/123` → `/product/{id}`) | `normalize.url_template` | `explore/extract.py`, Page id | As is |
| A1.4 | List templates (4 or more same-shaped items → one element plus samples) | `segment._find_templates` | `explore/extract.py` | As is |
| A1.5 | Healing resolver, tiers 1, 3 and 6: locators ordered by hits, fingerprint score (≥ 0.65 with a 0.05 lead), text LLM pick | `browser/locate.py` | `runner/locate.py` | Tier 2 (full-text) optional; no embedding or vision tiers yet |
| A1.6 | Locator hit counts and heal log | `MapWriter.bump_locator`, `_heal_bookkeeping` | `graph/store.py` | Write a `Change{kind:'heal'}` instead of an Observation |
| A1.7 | Check where each step landed, then re-plan (up to 3 times) | `Navigator.execute_step`, `drive_to` | `runner/browser.py` | Memgraph weighted shortest path instead of `algo.SPpaths` |
| A1.8 | Edge reliability and cost: reliability = (s+1)/(n+2), cost = 1 + 2·(−ln reliability), plus risk cost | `_COST` in `graph/map_writer.py` | ACTION edge properties | As is |
| A1.9 | Recording overlay (caption, highlight ring, step badge, cursor, zoom, title cards), continuous take, `TakeFailed` | `demo/overlay.js`, `DemoSession.play` | `media/overlay.js`, `runner/record.py` | Record per flow and keep each shot's start and end time |
| A1.10 | ffmpeg cutting (contiguous and segment lists) | `demo/render.py` | `media/render.py` | As is |
| A1.11 | Tool layer core: argument check, risk gate with one-time approval, untrusted-output wrapping, `pause` | `tools/core.py`, `agents/loop.py` | `agents/harness.py` | Pydantic is fine instead of jsonschema; add phase gating on top |
| A1.12 | "The script may only use actions that worked" | `demo/script.py:build_script` | timeline `check` rule | A shot must point at a flow step that exists and has a passing take |

## A2. Tier 2: cheap robustness

| # | Feature | Why | Cost | Due |
| --- | --- | --- | --- | --- |
| A2.1 | Fixture site (18 HTML pages) as the sample app | Ready-made v1; edit it into v2 / v3 | Copy the folder | **R1** (it is M2) |
| A2.2 | Approval pause with approval words ("approve", "lgtm", …) | It is our "storyboard approved" gate | Small | **R1** (part of M6) |
| A2.3 | Quarantine edges as `BROKEN_ACTION` instead of deleting | Matches the "never delete" rule; routing skips them | Small | F |
| A2.4 | Learned `pre_actions` (for example, close a cookie banner first) | Stops the same failure repeating | Small | F |
| A2.5 | `verify`: the answer must quote the page word for word | Onboarding answers stay grounded | Small | F |
| A2.6 | `review_take`: a vision model checks each keyframe | Catches a covered or off-screen highlight | Small; needs a vision model | F |
| A2.7 | `find_targets` (intents + embeddings) | Maps questions to screens for onboarding | Medium: needs embeddings | F |
| A2.8 | Recovery agent: screenshot + restricted tools, up to 30 turns, at most 5 per run | Gets past obstacles nobody planned for | Medium | F |

## A3. Promoted from Tier 3

The order below is the suggested build order. Each feature lists what it did in the old code, what it is for here, and
how to port it.

### A3.1 Site bootstrap (F)

**Old (`agents/bootstrap.py`, 182 lines):**
- Before the first exploration, one LLM call looks at:
  - the entry page (up to 80 elements)
  - robots.txt
  - the sitemap's size: up to 50,000 URLs, 20 child sitemaps, 5 s fetch timeout
- It returns a `SiteProfile`:
  - `purpose`
  - up to 12 `sections`
  - `size`: small, medium or large
  - up to 20 `skip` rules, as regex patterns with reasons
  - the 3–5 most important `flows`
- Bad patterns are dropped. Nothing depends on the profile; with no model, no profile is made.

**Here:**
- `flows` and `sections` seed the flow builder (M3) and Features (A3.4), so the LLM starts from a list instead of a blank page.
- `skip` feeds the crawler's deny list.
- `purpose` feeds the demo intro line and the onboarding agent's system prompt.

**Port:** store it as `(:App {purpose, size, …})` through the Graph API. Use one Groq call; keep the "nothing depends on
it" rule.

### A3.2 Graph algorithms: PageRank, betweenness, harmonic, label propagation (F)

**Old (`Curator.run_algorithms`):**
- Runs over `State` nodes and `ACTION` edges, using FalkorDB's `algo.*` procedures:
  - `pagerank`
  - `betweenness`, sampled over 64 nodes with seed 42
  - `community`, by label propagation with up to 20 iterations
  - `harmonic`
- It also ran WCC (weakly connected components) to set `reachable`: whether a screen is in the same component as the entry.
- `:DeadEnd` marks screens with no way out.
- Separately, `harmonic` ranked which open screens to explore first (`graph/queries.py`, frontier listing).

**Here:**

| Score | Used by |
| --- | --- |
| PageRank | `demo_score`; Feature medoids; "start here" suggestions for onboarding |
| Betweenness | `demo_score` (hub pages that many flows pass through); the healer checks these pages first after a release |
| Harmonic | Order of pages to explore in guided mode |
| Label propagation | Communities → Features (A3.4) |
| WCC / `reachable`, `DeadEnd` | Healer warnings: pages that can no longer be reached, or that trap the user |

**Port:**
- Run the algorithms over `Page` nodes with Page→Page edges, derived from `HAS_SECTION/HAS_ACTION/NAVIGATES_TO`.
- Compute in Python with **networkx** (+ scipy, which networkx's PageRank needs), then write the scores back through the
  Graph API. All four algorithms exist there:
  - `pagerank`
  - `betweenness_centrality`
  - `harmonic_centrality`
  - `label_propagation_communities`
- The sample app has tens of pages, so this runs in milliseconds, and it works the same on any Memgraph image.
- Memgraph MAGE has some of these as procedures (PageRank, betweenness, WCC, Louvain community detection), but check
  with `CALL mg.procedures()` before relying on them. Harmonic centrality and label propagation may not be there.
- Run it after each crawl and after each heal that changes edges.

### A3.3 `demo_score` (F)

**Old (`Curator.compute_demo_scores`):**
- For a screen: `0.6 · pagerank/max + 0.4 · betweenness/max`.
- For a workflow: `0.35 · max pagerank + 0.25 · avg betweenness + 0.2 · communities spanned + 0.1 · run count +
  0.1 · success rate`, each part divided by its maximum.
- The storyboard's `highlights` scope took the top 3 workflows (or screens) by this score.

**Here:** `Flow.demo_score`, using the same workflow formula over each flow's pages. The run count and success rate
come from the runner's takes.
- It is used in the demo agent's **Plan** phase when the goal is vague ("demo the app in 2 minutes").
- A specific goal still wins: `find_flows(goal)` first, `demo_score` only to break ties or fill time.
- It also picks which flow the style samples use.

### A3.4 Features: named areas of the app (F)

**Old (`Curator.build_features`):**
- One `Feature` per community. The medoid is the community's screen with the highest PageRank.
- The LLM names each area in 2–4 words, from up to 8 screen summaries. An embedding is stored too.
- The `feature` scope in the storyboard demoed the top 4 screens of one Feature by PageRank.
- Features no longer found were deleted.

**Here:** `(:Feature {id, name, summary, size, status})-[:CONTAINS]->(:Page)`, and `Flow-[:IN_FEATURE]->Feature`.
- **Demo:** chapter titles and order ("Projects → Members → Billing"), and "tour of one area" demos.
- **Onboarding:** answers "what can I do in this app?" and narrows a question to one area before searching for a path.
- **Healer:** groups changes by area in the change report.

**Port:**
- Keep the LLM naming; drop the embedding, and match questions to Features with the LLM instead.
- Follow our rule: a Feature that disappears gets `status = "stale"`, not `DELETE`.
- Keep the id stable across runs by minting it from the medoid page id.

### A3.5 Frontier groups (F)

**Old (`agents/frontier.py`, 177 lines):**
- Open work items are grouped into a short frontier, one line per group of look-alike items (links of one template,
  pages of one URL template). A regex flags pagination ("next", "load more", "page 3", "›").
- For a look-alike group, one representative is explored; otherwise all of its items are.
- The model returns `{pick, skip: [{pattern, reason}], stop}`:
  - unknown group ids and patterns that do not compile are dropped
  - an unusable answer falls back to priority order

**Here:** the crawler's BFS queue is the work list. Group it the same way before each round.

**Port:** keep the work list in memory (we dropped the old `WorkItem` nodes and leases along with parallel
explorers). Port `group_frontier`, `representatives`, `parse_choice` and `skipped_groups` mostly as is.

### A3.6 Guided and auto exploration modes (F)

**Old (`Orchestrator.explore`, `_explore_guided`; settings in `config.py`):**
- `brute`: every safe element in priority order (our current BFS).
- `guided`: rounds. Each round shows the model up to 40 frontier groups and runs until 10 new states have been added.
  It stops on `stop`, the budget, 12 rounds, or a round with no new states.
- `auto`:
  - with no model → brute
  - if the profile says "large", or the sitemap has more than 300 URLs → guided
  - otherwise a probe of 8 states by brute force, then guided if more than 15 frontier groups are still open
- Goal-directed exploration (`explore_toward`) ran guided rounds with the goal in the prompt.

**Here:**
- The sample app is small and brute force covers it, so this is for pointing the product at a real, larger app (a
  judge's URL, a sponsor's app).
- It is also the base for "the onboarding agent can't find a path → explore toward the question", but that part is
  Later.

**Port:** after A3.1 and A3.5. Keep the three modes and the thresholds as settings. Default to `auto`.

### A3.7 MCP server with elicitation (F)

**Old (`mcp_server.py`, 125 lines):**
- Serves the same toolbox the built-in agents use over stdio, so any MCP client (Claude Desktop, Claude Code, …) can
  act as the agent. Only `ask_user` is hidden, because the client talks to its own user.
- A risky action needs approval, and over MCP that approval is asked through **elicitation**: a form with one boolean,
  "Allow this once".
  - Protocol 2026-07-28 and later: the question is returned as an `InputRequiredResult`, and the client repeats the call
    with the answer.
  - Older revisions: it is asked over the back-channel (`elicit_form`).
  - A client that cannot ask gets a refusal that says why.
- An approval covers that exact (tool, arguments) pair once, and a "no" is final for that call.
- Every tool runs on one worker thread, because Playwright's sync API is tied to the thread that started it.

**Here:**
- It lets judges or users drive the product from Claude: "make a 2-minute demo of the members flow", "how do I invite a
  user?".
- Elicitation is the natural channel for our human gates: storyboard approval, style pick, and healer changes that
  need approval.

**Port:**
- After the harness (M6), because it wraps the harness's tool registry.
- Expose:
  - `find_flows`
  - `path`
  - `make_demo`
  - `ask` (onboarding)
  - `heal`
  - `list_changes`
  - `approve_change`
- Map `ask_user` and approval-needed proposals to elicitation, and keep the same fallback for clients that cannot ask.
- The old code uses a recent `mcp` Python SDK API (`Server(on_list_tools=…, on_call_tool=…)`, `ServerRequestContext`,
  `MODERN_PROTOCOL_VERSIONS`). Pin the same SDK version, or adapt it to the version you install.

---

# Part B — new features

## B1. Demo agent

Phases and their gates: Plan → Sample → Pick style → Record → Assemble → Review (see [AGENTS.md](AGENTS.md) §3).

| Group | Feature | Due | Uses |
| --- | --- | --- | --- |
| **Planning** | Goal + audience in ("new admin, 2 minutes"), chosen flows out | R1 | `find_flows`; A3.3 for vague goals (F) |
| | Storyboard: shots with intent and target length, approved before recording | R1 | A2.2 approval pause |
| | Chapters from Features | F | A3.4 |
| **Style samples** | 2 samples (fast vs calm) of the same opening shots, from one recording | R1 | A1.9 overlay, render presets |
| | 3 or more styles, mixing ("A's pace, B's voice"), saved style profile | Later | — |
| **Recording** | One take per step on a seeded demo account; graph checked and healed as each step runs | R1 | A1.5–A1.9 |
| | Several takes, keep the cleanest (no spinner, stray hover, failed click) | F | A2.6 `review_take` |
| **Video decisions** | Cuts: drop page loads and waits, speed up typing | R1 | A1.10, per-shot times |
| | Zoom: ease in on the target, hold, ease out, with limits on depth and frequency | R1 | element boxes from A1.1 |
| | Cursor smoothing and click highlight | F | A1.9 overlay |
| | Intro / outro cards, transitions, music ducked under speech | Later | — |
| **Voice-over** | One line per shot, from the step's intent and what changed on screen | R1 | LLM |
| | Fit to length: shorten the line or hold the shot; add a bridging line or trim the shot | R1 | TTS with timestamps |
| | Pronunciation list, voice choice, other languages | Later | — |
| **Captions** | From the voice's word timings; line and length limits; burned in, or SRT / VTT | R1 (burned in), F (files) | TTS timings |
| **Rule checks (`media.check`)** | No silence over 1 s; voice clip fits its shot; narrated button names match a label or alias | R1 | timeline + graph |
| | Shots only reference flow steps that have a passing take | R1 | A1.12 |
| | Full rule table and an eval set | Later | — |
| **Edits on request** | One request ("shorten the intro") → the shots it touches → only those re-recorded, re-voiced or re-rendered | R1 | timeline JSON |
| | Versions with a list of what changed, and undo | F | timeline files per version |
| **Outputs** | MP4 | R1 | A1.10 |
| | GIF, chapter list, a screenshot per step | F | keyframes from A1.9 |
| **Front doors** | CLI | R1 | — |
| | MCP tool `make_demo` with elicitation for approvals | F | A3.7 |

## B2. Onboarding agent

Phases: Understand → Show → Answer (see [AGENTS.md](AGENTS.md) §5).

| Feature | Due | Uses |
| --- | --- | --- |
| Question → flow, or a path between two screens in the graph | R1 | `graph.path`, `find_flows` |
| "No path" → say "I can't find that in this app"; never invent steps | R1 | — |
| Show: replay the existing clip if one exists, else record a short narrated clip | R1 | runner, media |
| Short text steps next to the clip, using on-screen names | R1 | action labels and aliases |
| Answer grounded by a word-for-word quote from the page | F | A2.5 `verify` |
| Narrow by area first ("that's in Members") and answer "what can I do here?" | F | A3.4 Features |
| "Where should I start?" from the most central pages | F | A3.2 PageRank |
| Better question → screen matching | F | A2.7 `find_targets` |
| Start from where the viewer is, not from the home page | F | `graph.locate` |
| Demand list: unanswered or frequent questions in `runs/questions.jsonl`, shown to the team | F | — |
| MCP tool `ask` | F | A3.7 |
| Explore toward a question when no path exists | Later | A3.6 guided mode |
| Live guiding inside the app (highlights on each element) | Later | needs a script or extension in the app |

## B3. Self-healing graph (shared by both agents)

| Feature | Due | Uses |
| --- | --- | --- |
| Heal during every run: locator fallbacks, hit counts, heal log | R1 | A1.5, A1.6 |
| Rename: keep the id, update the label, push the old name to `aliases`, `Change{kind:'rename'}`, re-record only that shot | R1 | A1.5 tier 3 / 6, timeline |
| Removed: `status = "missing"`, flow marked broken, its clips flagged, never silently patched | R1 | — |
| Moved or restyled: update the box, mark dependent takes stale | F | A1.1 boxes |
| Step added (new dialog): propose the new page and edge plus a flow edit → needs approval | F | A1.7 landed-state check |
| New screen: add a node, ask whether it starts a new flow | F | — |
| Approval queue for changes that alter what a flow means | F | A2.2, A3.7 elicitation |
| Broken edges kept as `BROKEN_ACTION` | F | A2.3 |
| Unreachable pages and dead ends reported after a release | F | A3.2 WCC / `DeadEnd` |
| Check central pages first after a release | F | A3.2 betweenness |
| Scheduled check after each release | Later | — |

---

## Build order

The round 1 slice is unchanged ([AGENTS.md](AGENTS.md) §6, M0–M9). The finals add these milestones:

| # | Milestone | Contents | Est. |
| --- | --- | --- | --- |
| F1 | Robustness | A2.3 quarantine, A2.4 pre-actions, A2.5 verify, several takes + A2.6 review | 4 h |
| F2 | Graph analytics | A3.2 algorithms (networkx) → A3.3 `demo_score` → A3.4 Features | 3–4 h |
| F3 | Bigger apps | A3.1 bootstrap → A3.5 frontier groups → A3.6 guided / auto | 5–6 h |
| F4 | MCP | A3.7 server + elicitation over the harness tools | 3 h |
| F5 | Demo polish | cursor, GIF / chapters / screenshots, caption files, versions with undo | 4 h |
| F6 | Onboarding+ | start from the viewer's page, demand list, Feature-narrowed answers, `find_targets` | 3–4 h |
| F7 | Healer+ | moved / added / new screen cases, approval queue, release report | 4 h |

Cut order for the finals if time runs short: F3 guided / auto (keep bootstrap) → F5 polish → F6 → F1 review_take.
Keep F2 and F4: they show up directly in the demo (chapters, "tour" demos, driving it from Claude).
