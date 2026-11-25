# Old SiteGraph: healing

"Healing" in the old project is not one feature but seven layers, from cheap and automatic to expensive and
LLM-driven. They fire in this order when a stored step is replayed.

Sources: `old/browser/locate.py` (`ElementResolver`), `old/agents/navigator.py` (`execute_step`, `drive_to`,
`_escalate_*`, `_run_pre_actions`, `_learn_from_recovery`), `old/graph/map_writer.py` (`bump_locator`, `quarantine`),
`old/agents/curator.py` (`find_anomalies`).

---

## 1. Finding the element again — `ElementResolver.resolve` (tiers, first hit wins)

| Tier | Method tag | How | Guard |
| --- | --- | --- | --- |
| 1 | `locator:i` | Try the stored `locators` in order (`role=…|name=…`, `testid=…`, `css=…`, `text=…`, or `item=` for list templates). Order = by `locator_hits`, so the ones that keep working go first. | Must match exactly 1 visible element (`item=` may match many: first one, filtered by the chosen entry's text) |
| 2 | `graph:j` | Full-text search over other known Elements with a similar name and the same role (`fulltext_elements`); try their locators | Never an element riskier than the original ("Cart" must not heal into "Empty cart") |
| 3 | `fingerprint` | Score every interactive node on the page against the stored fingerprint: role (w3), name similarity (w3), id/name/placeholder (w1 each), class overlap (w1), generic CSS path similarity (w2), bbox distance (w1) | best ≥ 0.65 **and** ≥ 0.05 ahead of the runner-up |
| 4 | `embedding` | Cosine of `"role name"` embeddings | ≥ 0.80 |
| 5 | `vision` | Set-of-marks: the old crop of the element (left) beside the live page with numbered boxes (right); vision LLM returns an index | only when a reference crop exists (State screenshot + bbox) |
| 6 | `llm` | Text LLM picks from a numbered list of up to 60 `role 'name'` candidates | returns −1 when unsure |

`locators_only=True` (used for optional learned pre-steps) stops after tier 1 with name-bearing locators only: there a
wrong match is worse than none.

## 2. Remembering the fix — `_heal_bookkeeping` + `bump_locator`

When tier ≥ 2 or a non-first locator worked:

- the working locator (or the found element's CSS) is added to `Element.locators`, its hit count goes up, the list is
  re-sorted by hits, `heal_count` +1;
- an `Observation{kind:'heal', method}` is attached to the Step, with a screenshot as evidence.

So the *next* run hits tier 1 straight away. That is the "self-healing locator" the console shows.

## 3. Checking where the step landed — inside `execute_step`

After acting, the Navigator observes, resolves the State and compares it with the step's expected `dst`:

- landed == dst → `write_action(..., success=True)` (reliability goes up).
- landed ≠ dst → `record_attempt(False)` on the planned edge, **and** writes a new ACTION edge to where it actually
  landed (the map learns the real behaviour), plus `Observation{kind:'unexpected_state'}`.

## 4. Re-planning — `drive_to`

A failed step ends the current route; `best_routes` is asked again from the landed State. Because failures lower
`reliability` and raise `cost`, the next route avoids the flaky edge. Up to `max_replans` (3).

## 5. The recovery agent — `_escalate_step`, `_escalate_goal`

When the element cannot be found or the click throws (overlay intercepts it), and escalations remain (max 5 per run):

- An `EscalationContext` is built: goal, failed step, error, **screenshot**, what was expected afterwards, the element's
  role/name/locators, alternative actions from this screen, the last 5 steps, the policy.
- An `AgentLoop` runs on the Navigator's own browser with a restricted toolbox (observe, list_items, click, hover,
  scroll, read_text, open_url, find_screens, plan_route, describe_state). Max 30 turns.
- Afterwards the Navigator re-observes: `reached` (already at the destination) or `ready` (the element can now be used,
  so the Navigator clicks it itself), else the step fails with the original error.
- When re-planning is exhausted, `_escalate_goal` asks the agent to reach the target screen directly.
- An action needing user approval inside a recovery is not surfaced: the recovery stops and the reason is logged.

## 6. Learning from recoveries — `pre_actions`

If a recovered step then succeeds, the actions the agent took (e.g. "click 'Accept cookies'") are stored on the ACTION
edge as `pre_actions`, and the first try is counted as a failure. Next time `_run_pre_actions` runs them first — each is
optional: only if its element is present (name-bearing locators only), within policy, and still on-site.

## 7. Graph-level repair

| Mechanism | Where | What |
| --- | --- | --- |
| Quarantine | `MapWriter.quarantine` | An ACTION/TRANSITION becomes `BROKEN_ACTION`/`BROKEN_TRANSITION` with `reason`, `broken_since`, `superseded_by`. Routing no longer sees it; `unquarantine` restores it. Nothing is deleted. |
| Failing-edge review | `Curator.find_anomalies` → review agent | Edges with ≥5 attempts and reliability <0.4 are flagged; the agent may quarantine them (logged). |
| State merging | review agent `merge_states` | Near-duplicate states folded; ACTION edges re-pointed and counters summed; removed node kept in the log. |
| Visual diff | `visual.py`, `_visual_diff` | dHash of before/after when an action changed nothing in the DOM; stored as evidence. |
| Git for the graph | `git.py` | Every map change is a recorded `Change` in a commit; `blame` says which agent found an edge; `revert` undoes a change; demos are pinned to the commit they were made against and can be re-recorded against that version or the latest map. |

---

## What healing does NOT do in the old code

- It does not detect "the button was renamed" as a rename. A renamed element gets a new gid on the next exploration;
  the old Element stays (marked tried). Execution still works because healing finds the new one and stores its locator
  on the old Element.
- It does not compare a whole release against the previous one. Healing only happens when a step is replayed.
- It never asks a human to approve a graph change; edits are logged, not gated.
