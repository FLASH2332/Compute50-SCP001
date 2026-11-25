# Old SiteGraph vs current repo + plan

Status: 2026-11-24. Compares the old project (`docs/old-sitegraph/`) with this repo's code (`crawl_to_graph.py`) and
plan (`ARCHITECTURE.md`, `AGENTS.md`). Priority order used throughout: **first make it work, then keep it simple.**

## Bottom line

- **The old project is far ahead on everything that makes a browser agent actually work**: real DOM capture with
  ARIA roles and boxes, several locators per element, a six-tier healing resolver, a check after every step, and a
  demo recorder that already produces clean narrated takes. The current crawler has none of these yet, and its
  selectors cannot be replayed.
- **The current plan is ahead on the parts that make the pitch new**: a timeline file as the single source of truth,
  re-recording only the changed shots, voice fitted to shot length, captions from word timings, style samples,
  rename-aware healing with an approval rule, and an onboarding agent built on the same graph.
- **Most of the old project's size is coordination machinery we do not need**: git for graphs, parallel explorers
  with leases, semantic cross-site graphs, profiles and secrets, curator review agents. (MCP, the graph algorithms
  and guided exploration were later moved up for the finals: see [FEATURES.md](FEATURES.md) §A3.)
- **Recommendation:** port about eight small, proven pieces from the old code (§4, Tier 1) into the current structure,
  keep the current stack (Memgraph, Groq, uv), and build the new parts from the plan on top. Do not fork the old repo.

> ⚠️ Check before porting: the old code was written in October 2026 for a different hackathon. Confirm Compute 50's rules
> allow reusing your own earlier code (many hackathons require code written during the event, or a disclosure).

---

## 1. Side by side

| Area | Old SiteGraph | Current code | Current plan |
| --- | --- | --- | --- |
| Size | ≈12,600 lines, 76 test files, 275 tests passing (last full run) | 432-line script, no tests | — |
| Graph DB | FalkorDB 4.22.1 (pinned) | Memgraph | Memgraph |
| Page capture | Injected `extract.js`: ARIA roles, names, bboxes, states, unique + generic CSS, test ids, click-listener detection | BeautifulSoup over static HTML | Playwright, role + name locators, boxes (M1) |
| Graph shape | Page → State → ComponentState → Element; ACTION between States; TRANSITION inside a screen | Page → Section → Action → Page | + Flow, Change; `status` instead of delete |
| Identity | SHA-1 gids over identity parts; URL templates; list templates; coarse identity; near-dup folding | slug of URL + section name + label | id minted once, matched on later crawls |
| Locators | 4 kinds per element, ordered by hit count | one short CSS, often non-unique | role + name, CSS fallback |
| Healing | 6-tier resolver + bookkeeping + landed-state check + re-plan + recovery agent + learned pre-steps + quarantine | none | rename / cosmetic / added / removed, with an approval rule and a `Change` log |
| Execution | `drive_to`: route → step → verify landed state → re-plan | none | `run_step` with pre/post checks |
| Flows | Workflows saved from runs; routes are shortest paths | none | Flow nodes built by an LLM, checked for reachability |
| Demo | Rehearse → script (only rehearsed actions) → approval → one continuous take → review → render | none | Storyboard → style samples → record → assemble timeline → rule checks → review → render |
| Video model | Script + per-shot segment times; any change re-records the whole take | — | Timeline JSON; re-record only affected shots |
| Voice | pyttsx3 offline; clip placed at shot start; no length check | — | TTS with timestamps; voice must fit shot; no silence > 1 s |
| Captions | Burned-in overlay text | — | From word timings; burned in or SRT/VTT |
| Q&A | Chat agent + `ask` kind (navigate, read page, quote evidence) | — | Onboarding agent: question → graph path → clip |
| Agent harness | `AgentLoop` + `Toolbox` (schema checks, risk gate, approvals, untrusted output, restricted tool sets, pause for input) | — | Phases that gate tools, pydantic checks, budgets, logs |
| UI | React console + WebSocket bridge (separate repo) | none | open decision |

---

## 2. Where the old project is better (and why it matters for "it works")

1. **Capturing the page from the live DOM, not static HTML.** `extract.js` sees what the user sees: roles, accessible
   names, boxes, visibility, modal state, buttons made from `div`s with click listeners. Without this the runner and
   the zoom both have nothing reliable to point at.
2. **Several locators per element, re-ordered by what keeps working.** `role|name` first, then test id, CSS, text.
   One CSS string (current code) breaks on the first restyle.
3. **The healing resolver.** Locators → fingerprint score (with a margin over the runner-up) → embedding → LLM pick.
   Proven on real sites; this is exactly the "changed but still works" bucket in our plan.
4. **Checking where each step landed, and re-planning.** Our plan says the same; the old code already does it.
5. **URL templates and list templates.** Without them a real site explodes into one node per product page or list
   entry. Cheap to port, saves the graph from day-one bloat.
6. **The demo recording mechanics.** Overlay JS (caption, highlight, step badge, cursor, zoom, title cards), the
   continuous take, "throw the whole take away if a scene fails", per-shot `(start, end)` times, ffmpeg cutting.
7. **"The script may only use actions that worked."** An enforced rule (`build_script` refuses unknown action ids),
   exactly the kind of code-level rule our harness design asks for.
8. **The tool layer.** JSON-schema validation, risk gate with one-time human approval, untrusted-output wrapping,
   per-agent tool subsets, and a `pause` result that stops the loop for the user.
9. **It is tested.** Fixture site (18 HTML pages) and 275 passing tests. The fixture site alone is a ready sample app.

## 3. Where the current code + plan is better

1. **Simplicity and a stack the team already runs.** Memgraph + Groq + uv, one script; no pinned FalkorDB build,
   no 130 MB embedding model required up front.
2. **Timeline JSON as the source of truth.** Shots point at flow steps and takes, so one change touches one shot. The
   old agent re-records the whole take for any change.
3. **Voice that fits.** TTS with timestamps gives clip lengths; rules enforce "voice ≤ shot" and "no silence > 1 s";
   captions come from the same word timings. The old voice track can overrun scenes and cut clips off.
4. **Style samples.** Cheap variants from one recording; the old project has one fixed look.
5. **Rename-aware healing with a human gate.** Old identity includes the element's name, so a rename creates a new
   Element and is never reported as a rename; old graph edits are logged but never approved. The plan keeps the id,
   records an alias, and asks a human before changing what a flow means — this is the pitch's novelty.
6. **Change detection per release, not only per replay.** The plan re-checks flows after a release and marks stale
   takes; the old code only heals when a step happens to be replayed.
7. **Flows as named, first-class objects** that link graph → shots, so "what broke in the video" is a query.
8. **One graph serving three jobs** (demo, onboarding Q&A, healing) instead of a general-purpose automation platform.

---

## 4. What to carry over, in priority order

### Tier 1 — carry, needed for it to work

| Piece | Old source | Lands in (plan layout) | Adapt |
| --- | --- | --- | --- |
| DOM extractor | `capture/extract.js` (175 lines) | `explore/extract.js` + `explore/fetch.py` | Use as is |
| Element building: roles, names, 4 locators, fingerprint, risk | `capture/segment.py` (parts), `risk.py`, `normalize.py` | `explore/extract.py` | Drop ComponentState hashing and coarse identity at first |
| URL templates | `normalize.url_template` | `explore/extract.py`, Page id | As is |
| List templates (≥4 same-shaped items → one element + samples) | `segment._find_templates` | `explore/extract.py` | As is |
| Healing resolver tiers 1, 3, 6 (locators by hits, fingerprint score, text LLM pick) | `browser/locate.py` | `runner/locate.py` | Keep tier 2 (full-text) optional; skip embedding and vision tiers for round 1 |
| Locator hit counts + heal log | `MapWriter.bump_locator`, `_heal_bookkeeping` | `graph/store.py` | Write a `Change{kind:'heal'}` instead of an Observation |
| Step check + re-plan | `Navigator.execute_step`, `drive_to` | `runner/browser.py` | Memgraph shortest path instead of `algo.SPpaths` |
| Edge reliability and cost | `_COST` in `map_writer.py` | ACTION edge props | Laplace formula as is |
| Recording overlay + continuous take + `TakeFailed` | `demo/overlay.js`, `DemoSession.play` | `media/overlay.js`, `runner/record.py` | Record per flow, keep per-shot segment times (enables re-recording one flow) |
| ffmpeg cutting | `demo/render.py` (`render_video`, `render_video_segments`) | `media/render.py` | As is |
| Tool layer core: schema check, risk gate, pause | `tools/core.py`, `agents/loop.py` | `agents/harness.py` | Pydantic instead of jsonschema is fine; add phase gating on top |
| "Script uses only rehearsed actions" rule | `demo/script.py:build_script` | timeline `check` rule | Shots must reference flow steps that exist |

### Tier 2 — carry if there is time (cheap, adds robustness)

| Piece | Why | Cost |
| --- | --- | --- |
| Quarantine edges as `BROKEN_ACTION` instead of deleting | Matches our "never delete" rule; routing ignores them | Small |
| Learned `pre_actions` (close a cookie banner first) | Real sites have banners; stops repeat failures | Small |
| Script approval pause with approval words | Our "storyboard approved" gate, already written | Small |
| `review_take` (model looks at keyframes) | Catches covered or off-screen highlights | Small; needs a vision model |
| Fixture site (18 HTML pages) | A ready sample app for v1 / v2 / v3 | Copy the folder |
| `verify` with a verbatim quote | Onboarding answers must be grounded | Small |
| `find_targets` (intents + embeddings) | Onboarding agent maps questions to screens | Medium: needs embeddings |
| Recovery agent (escalation with screenshot + restricted tools) | Gets past obstacles nobody planned for | Medium |

### Tier 3 — drop for now (needless complexity for this product)

> Moved up on 2026-11-24 and planned for the finals in [FEATURES.md](FEATURES.md) §A3: the MCP server and elicitation,
> PageRank, betweenness, harmonic, label propagation, Features, `demo_score`, guided / auto exploration, site
> bootstrap and frontier groups.

| Old feature | Why drop |
| --- | --- |
| Git for graphs: branches, merges, tags, checkout, revert, blame, compaction (`git.py`, 369 lines) | One writer, one graph. A `Change` log gives the audit trail we need. |
| Parallel explorers, work-item leases, dynamic spawning (`ops.py`, `spawner.py`) | One explorer on a small sample app is enough; concurrency adds races |
| Semantic cross-site / cross-device graphs, multi-device | Not part of the product |
| Profile graph, keyring vault, memories, sessions | Single user, public sample app |
| Curator review agent and anomaly detection | Our healer plus human approval covers it |
| ComponentState / TRANSITION layer, coarse identity, near-duplicate folding | Add back only if menus or dynamic lists break the sample app; until then store menu-opening clicks as `pre` steps on the action |
| Six output formats (GIF, click-through, HTML/MD guides, screenshot) | Video first; guide later |
| Planner, finish check, multi-step request plans | The demo agent's phases replace them |
| Embedding and vision healing tiers | Need extra models; fingerprint + LLM pick are enough for round 1 |

---

## 5. Porting notes (FalkorDB → Memgraph)

- `MERGE` / `SET` / `UNWIND` Cypher ports almost as is. The "later `SET` does not see an earlier `SET`" workaround
  (`WITH r`) is harmless on Memgraph.
- `algo.SPpaths` (risk-capped weighted shortest path) → Memgraph's built-in weighted shortest path
  (`*WSHORTEST` with a filter lambda for `risk_cost`). Check the exact syntax on the Memgraph version you run.
- Vector and full-text indexes have different syntax in Memgraph; for round 1, do matching in Python (or by LLM) and
  skip the indexes.
- `GRAPH.COPY` (branches) has no equivalent and is not needed (Tier 3).
- The old LLM layer uses LiteLLM; the current code calls Groq directly. Keep one wrapper (`llm.py`) either way.

## 6. Effect on the build plan (`AGENTS.md`)

| Milestone | Reuse from old | Change |
| --- | --- | --- |
| M1 crawl fixes | `extract.js`, element building, URL + list templates | Replaces the BeautifulSoup extraction instead of patching it |
| M2 sample app | old fixture site | Copy, then make v2 / v3 edits |
| M4 runner | resolver tiers 1/3/6, `execute_step` check, re-plan, cost formula | Faster and safer than writing from scratch |
| M5 media | overlay, continuous take, ffmpeg cutting | Add TTS with timestamps and caption files (new) |
| M6 demo harness | tool layer core, script-only-rehearsed-actions rule, approval pause | Add phase gating and the timeline rules (new) |
| M7 healer | locator hit counts, quarantine | Rename detection + approval gate are new work |
| M8 onboarding | `verify` quote rule; maybe `find_targets` | Path search on Memgraph is new |
