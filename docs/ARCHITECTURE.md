# Architecture (abstract, draft)

Status: **draft for round 1 (Nov 23–25, 2026)**. This describes the shape we are building toward,
not the code that exists. Names, schema and folders will change; the *boundaries* in §2 and the
*rules* in §6 are the parts meant to last. For the code as it is today, see
[CODEBASE.md](CODEBASE.md).

Product in one line: a shared **app graph** of a web app drives three things: a demo agent that
makes narrated demo videos, an onboarding agent that answers viewers' questions by showing them,
and a healer that keeps the graph correct as the UI changes.

---

## 1. Components

```
                    +-------------------+
                    |    Your web app   |
                    +---------+---------+
                              ^  Playwright
             +----------------+----------------+
             |                |                |
      +------+-----+   +------+------+   +-----+------+
      |  Explorer  |   |   Runner    |   |  (viewer)  |
      |  (crawl)   |   | run_step()  |   +-----+------+
      +------+-----+   +--+-------+--+         |
             | observations  |  takes          | questions
             v               v       |         v
      +------+---------------+--+    |   +-----+------------+
      |   Graph API (only writer)|<---+---| Onboarding agent |
      |   Memgraph underneath    |<-------|    Demo agent    |
      +------+-------------------+  heal  |      Healer      |
             ^ proposals                  +-----+------------+
             |                                  | timeline edits
             +----------------------------------+
                                                v
                                   +------------+-----------+
                                   | Media: voice, captions, |
                                   | checks, renderer        |
                                   +-------------------------+
```

| Component | Job | Exists? |
| --- | --- | --- |
| Explorer | Load pages, extract sections and actions, propose graph updates | Partly: `crawl_to_graph.py`, one page |
| Graph store | Memgraph, Cypher over Bolt | Yes |
| Graph API | The only code that writes the graph; typed functions, change log | No (writes are inline in the crawler) |
| LLM client | One wrapper over the model provider (Groq today) | No (Groq called inline) |
| Runner | Run one action in a real browser, check the result, return a take | No |
| Demo agent | Goal → storyboard → takes → timeline → video | No |
| Onboarding agent | Question → path in graph → clip or guided steps | No |
| Healer | Compare what the runner saw with the graph; fix or flag | No |
| Media | Text-to-speech with timings, captions, rule checks, render | No |
| Harness | Phases, tool gating, budgets, logging for every agent | No |

---

## 2. Boundaries (the parts meant to last)

1. **Only the Graph API writes the graph.** Explorer, runner and agents *propose*; the Graph API
   validates, applies, and logs. This is what makes healing auditable.
2. **Agents never touch the browser or ffmpeg directly.** They call tools: `runner.run_step`,
   `media.render`. The LLM decides; plain code acts.
3. **Video is data first.** An agent edits a timeline JSON; the renderer turns it into MP4. The same
   timeline always renders the same video.
4. **The LLM provider sits behind one wrapper.** Swapping Groq for another provider touches one file.
5. **Everything is keyed by stable ids.** Shots point at flow steps, flow steps point at actions,
   actions keep their id across renames.

---

## 3. Data that flows between components

| Object | Produced by | Consumed by | Stored in |
| --- | --- | --- | --- |
| Observation (page, sections, actions, boxes, screenshot hash) | Explorer, Runner | Graph API, Healer | transient |
| Graph (pages, sections, actions, flows, changes) | Graph API | every agent | Memgraph |
| Take (video segment, step timings, element boxes, pass/fail) | Runner | Demo agent, Healer | `runs/<run-id>/` |
| Timeline (shots, zooms, narration, voice clips, captions) | Demo agent | Media | `runs/<run-id>/timeline.json` |
| Style profile (pace, zoom, voice, captions, length) | User pick | Demo agent, Media | `styles/*.json` |
| Change proposal (kind, before, after, evidence) | Healer, Runner | Graph API | Memgraph `Change` nodes |

---

## 4. Target graph schema (additive to today's)

Today's labels stay; new properties and labels are added. Bold = new.

```
(:Page {url, title, **last_crawled_at**})
  -[:HAS_SECTION]-> (:Section {id, name, role, summary, ...})
  -[:HAS_ACTION]->  (:Action {id, label, type, selector, navigates_to,
                              **role, name, locator, aliases[], status,
                              intent, last_seen_at**})
  -[:NAVIGATES_TO]-> (:Page)

**(:Flow {id, name, intent, source})-[:STEP {order}]->(:Action)**
**(:Change {id, kind, before, after, evidence, at, approved})-[:ON]->(:Action|:Section|:Page)**
```

- `locator` = Playwright role-and-name locator, the primary way to find the element again.
- `status` = `active | missing | renamed`. Never delete; mark.
- `aliases` = old labels, so the onboarding agent still understands "the Save button".
- `intent` = what the action does, one line, from the LLM (per action, not per section).
- **Stable id rule (proposal):** mint the id once from `page path + section role + element role +
  first-seen label`, then never recompute it. On later crawls, match observed elements to existing
  actions by locator → selector → label similarity → position; only unmatched ones get new ids.
- Later, if modals and same-URL states matter: split `Page` into `Screen {url, fingerprint}`.

Timelines, takes and styles stay as files, not graph nodes: they are per-video, bulky, and the
renderer reads them directly.

---

## 5. Proposed package layout (move code here gradually)

```
src/compute50_scp001/
  config.py            env vars, URIs, model names
  llm.py               provider wrapper (Groq now)
  graph/
    schema.py          dataclasses / pydantic models for Page, Section, Action, Flow, Change
    store.py           Memgraph driver, batched writes (UNWIND), the only writer
    queries.py         find_flows, path_between, locate, actions_on_page
  explore/
    fetch.py           Playwright load + boxes + screenshot
    extract.py         today's region / action extraction
    summarize.py       section and action intents
  runner/
    browser.py         run_step(action) -> Take, with pre/post checks
  agents/
    harness.py         phases, tool gating, budgets, logging
    demo.py            demo agent
    onboarding.py      onboarding agent
    healer.py          healer
  media/
    timeline.py        timeline model + edit ops
    voice.py           TTS with timestamps
    captions.py        captions from word timings
    checks.py          rule checks (silence, length, names, zoom)
    render.py          ffmpeg (or Remotion) from timeline
  cli.py               `compute50-scp001 crawl|flows|demo|heal|ask`
```

Move `crawl_to_graph.py` into `explore/` + `graph/` only when the next feature needs it; keep the
root script working until then.

---

## 6. Rules every agent follows

- A rule in a prompt is a hint; a rule in code is a guarantee. Enforce in code.
- Each agent runs in **phases**; each phase exposes only its tools.
- Every tool input is validated (pydantic). Bad input is refused with a reason.
- Every browser step checks "am I on the expected page?" before acting and "did the expected thing
  happen?" after. A mismatch goes to the healer, never silently onward.
- Small, confident graph fixes apply automatically and are logged; anything that changes what a
  flow means waits for a human.
- Budgets: caps on LLM calls, takes per step, renders. Hitting a cap stops and reports.
- Every decision is logged with its reason (`runs/<run-id>/log.jsonl`).

---

## 7. Open decisions

| Decision | Options | Leaning |
| --- | --- | --- |
| Renderer | ffmpeg from timeline JSON / Remotion (React) | ffmpeg for round 1; keep the JSON so Remotion can come later |
| Text-to-speech | ElevenLabs with timestamps / a free local TTS + forced alignment | Whatever key the team has; timings are required |
| Planning model | `llama-3.1-8b-instant` (today) / a larger Groq model | Larger for flow planning; keep 8B for summaries |
| User interface | Streamlit / FastAPI + one HTML page / CLI only | Decide by who builds it |
| Screen identity | URL only / URL + DOM fingerprint | URL only for round 1 |
