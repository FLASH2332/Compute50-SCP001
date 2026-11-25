# Old SiteGraph: the graph

The site is stored as a **state machine**: screens are nodes, the things a user does to move between screens are
edges. Agents plan on this map, then check the plan in the real browser.

Sources: `old/schema.py`, `old/capture/segment.py`, `old/graph/map_writer.py`, `old/graph/queries.py`, and the old
README's "The graph" section (the most complete description).

---

## 1. Graph keys (several graphs in one FalkorDB)

| Key | Holds |
| --- | --- |
| `u:{uid}:site:{domain}:{device}` | **Device graph**: the map of one site on one device type plus runs, workflows, demos. The main one. |
| `…@br:{agent}-{8hex}` | A branch copy one explorer writes to; merged back by the Curator |
| `…@tag:{name}`, `…@at:{8hex}` | Named snapshot; checkout of one commit |
| `u:{uid}:ops:{domain}` | Agents, tasks, leases, the shared exploration queue (`WorkItem`), commit history |
| `u:{uid}:profile` | Preferences, exploration policies, memories, sessions, references to secrets (values live in the OS keyring) |
| `u:{uid}:semantic` | Patterns shared across sites and devices, rebuilt from device graphs |

Only the device graph matters for us; the rest is the "needless complexity" discussed in `../OLD_VS_NEW.md`.

## 2. The device graph

```
(:Page)-[:HAS_STATE]->(:State)-[:ACTION {el_gid,...}]->(:State)
(:State)-[:COMPOSED_OF]->(:ComponentState)<-[:HAS_CSTATE]-(:Component)
(:ComponentState)-[:CONTAINS]->(:Element)
(:ComponentState)-[:TRANSITION]->(:ComponentState)      // e.g. hover opens a menu, screen unchanged
(:Intent)-[:FULFILLED_BY]->(:State | :Workflow)
(:WStep)-[:STEP_OF]->(:Workflow), (:WStep)-[:ON]->(:Element)
(:Step)-[:IN_RUN]->(:Run), (:Step)-[:FROM|TO]->(:State)   // activity log
(:DemoRequest)-[:PRODUCED]->(:Storyboard)-[:IN_STORYBOARD|SHOWS|RENDERED_AS]-...
```

| Label | Is | Key properties |
| --- | --- | --- |
| `Site` | One record per device graph | domain, device, `schema_version`, `algo_version`, `embed_model` (refuses a different model) |
| `Page` | A **URL template**: all URLs differing only in ids or query values | `url_template`, `title`, `example_urls` (≤5), `example_titles` (≤8) |
| `State` | One screen: a page + its set of *persistent* component states | `summary`, `emb`, `aliases`, `tokens`, `untried_count`, centrality scores, `demo_score`, `phash`, `screenshot_ref`; labels `:Entry` `:Frontier` `:Blocking` `:DeadEnd` |
| `Component` | A region with an ARIA landmark/widget role (navigation, form, dialog, menu, list…) or the page body | `kind`, `blocking` (modal), `ephemeral` |
| `ComponentState` | One version of a region's contents (menu `absent` / `open`) | `skeleton_hash`, `aria_state`, `screenshot_ref` (crop) |
| `Element` | An interactive control | `role`, `name_sample`, **`locators`** (ordered by `locator_hits`), **`fingerprint`** (role, name, tag, attrs, CSS path, bbox), `risk`, `risk_cost`, `tried`, `heal_count`, template fields |
| `Intent` | A user goal in words ("view shopping cart") | `text`, `emb`, `hits` |
| `Feature` | A community of States (label propagation) | `name`, `size` |
| `Workflow`, `WStep` | A saved automation; steps reference ACTION gids and only a *variable name* for typed input | `run_count`, `success_rate` |
| `Run`, `Step`, `Observation` | The activity log; observations are evidence (`heal`, `unexpected_state`, `recovery`, `item_choice`, `visual_diff`) | last 100 runs kept |
| `DemoRequest`, `Storyboard`, `Shot`, `Render` | A demo from request to file | captions, `map_commit`, blob refs |

### Edges that matter

| Type | From → To | Meaning |
| --- | --- | --- |
| `ACTION` | State → State | Using element `el_gid` on the source screen leads to the target. Props: `action_type` (click, hover, select, check, press), `label`, `risk_cost`, `seen_count`, `success_count`, `reliability`, `cost`, `pre_cstates` (menus to open first), `pre_actions` (learned from recoveries), `requires_inputs`, `value_var` |
| `TRANSITION` | ComponentState → ComponentState | Same screen, one region changed (hover opens a menu) |
| `BROKEN_ACTION`, `BROKEN_TRANSITION` | same | A quarantined edge: same props + `reason`, `broken_since`, `superseded_by`. Different type, so routing ignores it. |

## 3. Identity: when two observations are the same node

`gid = prefix + first 16 hex of SHA-1("\x1f".join(parts))` (`old/ids.py`). Same thing seen twice → same gid →
idempotent `MERGE`.

| Node | Identity parts |
| --- | --- |
| Page | domain + URL template (`/catalogue/a-light_1000/index.html` → `/catalogue/:id/index.html`; query *keys* only) |
| Component | region role + accessible name + generic CSS path (whole page and `main` use the URL template) |
| ComponentState | component + hash of its elements' `role|key` tokens |
| State | page + sorted *persistent* component states (menus, tooltips, tabs, alerts are ephemeral: opening a menu is not a new screen) |
| Element | component + role + key (link → its URL template, else normalised name) + index among identical siblings |
| ACTION | src State + Element + action type + variable name + dst State |

Three rules keep the map small:

1. **List templates.** ≥4 sibling items with the same structure and link pattern become ONE template Element
   (`is_template`, `count`, up to 60 `sample_items`). "Open Travel" and "open Mystery" use the same edge; the item is
   chosen at run time.
2. **Coarse identity** (`state_identity: coarse`, default). Content regions (`main`, list, feed, grid, table, article,
   region) contribute `role|count-bucket` tokens (1, 2–4, 5–19, 20+) instead of names, so a changing result list stays
   one State.
3. **Near-duplicate folding.** A new observation joins an existing State of the same page when the same modal dialogs
   are open and Jaccard(tokens) ≥ 0.85; the new gid is kept in `State.aliases`.

Note: an Element's gid includes its normalised name, so a renamed button becomes a **new** Element on the next
exploration. Continuity across renames comes from healing (locators get re-learned), not from identity.

## 4. How the DOM becomes a State (`capture/`)

1. `extract.js` runs in the page: every node gets an ARIA role (explicit, or implicit from the tag), accessible name,
   bbox, states (expanded, checked, modal…), a unique CSS and a generic CSS path, test id, and an `inferred` flag for
   role-less elements that have click listeners.
2. `BrowserSession.load_all` scrolls until the page stops growing (lazy content), then back to top.
3. `segment.build_state(raw)` groups interactive nodes under their nearest component, finds list templates, builds
   element locators — `role=<role>|name=<name>`, `testid=…`, `css=…`, `text=…` (in that order) — and the fingerprint,
   classifies risk, and hashes everything into gids.

## 5. Scoring on edges

- `reliability = (success_count + 1) / (seen_count + 2)` — a new edge starts at 0.5.
- `cost = 1 + 2 · (−ln reliability)` — flaky edges are expensive for the shortest-path search.
- `risk_cost` by class: 0 read/navigate/input, 1 safe submit, 100 changes data, 1000 leaves the site, 10000 destructive.
  Routes are capped by the policy's `max_risk`.

FalkorDB gotcha recorded in the code: in one query a later `SET` does not see a value written by an earlier `SET` on the
same entity; put `WITH r` between them.

## 6. Queries the agents ask (`graph/queries.py`)

| Question | Function | How |
| --- | --- | --- |
| Which screen does the user mean? | `find_targets` | 1) list-item text in the request → the screen behind that list; 2) vector search on `Intent`; 3) vector search on State / Workflow summaries |
| How do I get there safely? | `best_routes` | `algo.SPpaths` over `ACTION`, weight `cost`, capped `risk_cost`, top 3 |
| What can I do from here? | `next_actions` | outgoing ACTIONs by `seen_count · reliability` |
| What is unexplored? | `frontier_states` | BFS from `:Entry`, `:Frontier` states by untried count, then harmonic centrality |
| Stored element gone — what else could it be? | `fulltext_elements` | full-text search on Element names, same role, never riskier |
| What breaks if this region changes? | `impact_of_component` | workflows and storyboards using its elements |

The Curator precomputes PageRank, betweenness, harmonic, label propagation (→ `Feature`), WCC (reachability) and
`:DeadEnd`, and stores them as properties.
