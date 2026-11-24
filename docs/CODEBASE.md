# Codebase guide (detailed)

Status as of 2026-11-24, branch `graph`, commit `e526637`.
This is the "what is actually here" document. For the "where it is going" view, read
[ARCHITECTURE.md](ARCHITECTURE.md). For the agents built on top, read [AGENTS.md](AGENTS.md).

Update this file whenever the code changes shape (new module, new graph label, new env var).

---

## 1. What exists today

One working script, `crawl_to_graph.py`, at the repo root. Given one URL it:

1. Loads the page in headless Chromium (Playwright) and waits for network idle.
2. Parses the rendered HTML with BeautifulSoup.
3. Splits the page into **sections** (nav, header, main, aside, footer, form).
4. Pulls the **actions** out of each section (links, buttons, inputs, selects).
5. Asks Groq (`llama-3.1-8b-instant`) for a one-sentence summary per section.
6. Writes `Page -> Section -> Action -> Page` into Memgraph.
7. Prints a confirmation query and a summary table.

Everything else in the repo is scaffolding:

| Path | What it is |
| --- | --- |
| `crawl_to_graph.py` | The crawler. All logic lives here (432 lines). |
| `src/compute50_scp001/__init__.py` | uv template: `main()` prints "Hello". Not used yet. |
| `pyproject.toml` | uv project, Python ≥ 3.13. Deps: `beautifulsoup4`, `groq`, `neo4j`, `playwright`. Script entry `compute50-scp001` points at the placeholder `main`. |
| `uv.lock` | Locked versions (pydantic comes in through `groq`). |
| `.python-version` | `3.13` |
| `.gitignore` | Node + Python templates; `.env` is ignored. |

No tests, no Docker Compose, no `.env` loader, no UI.

Branches: `main` holds only the README. All code is on `graph` (author FLASH2332, 2026-11-23).

---

## 2. How to run it

```powershell
uv sync                                   # create .venv from uv.lock
uv run playwright install chromium        # browser binary, once per machine
docker run -d -p 7687:7687 -p 7444:7444 --name memgraph memgraph/memgraph-mage
$env:GROQ_API_KEY = "<your key>"
uv run python crawl_to_graph.py https://example.com
```

- Memgraph is reached at `bolt://localhost:7687` with empty auth (hard-coded `MEMGRAPH_URI`, `AUTH`).
- The `neo4j` Python driver is used because Memgraph speaks the same Bolt protocol and Cypher.
- Memgraph Lab (optional UI) can inspect the graph: `MATCH (n) RETURN n LIMIT 200`.
- Exits early if `GROQ_API_KEY` is missing or no sections are found.

---

## 3. Graph schema (as written today)

```
(:Page {url, title})
   -[:HAS_SECTION]->
(:Section {id, name, role, summary, collapsed?, total_count?})
   -[:HAS_ACTION]->
(:Action {id, label, type, selector, navigates_to})
   -[:NAVIGATES_TO]->
(:Page {url})            // stub page: no title until it is crawled itself
```

| Property | Meaning | Source |
| --- | --- | --- |
| `Page.url` | Final URL after redirects (`page.url`) | Playwright |
| `Section.id` | `slugify(page_url + name)` | `build_sections` |
| `Section.role` | `nav` `header` `main` `sidebar` `footer` `form`, or `list` for collapsed div regions | `SEMANTIC_TAGS`, fallback |
| `Section.summary` | One sentence from Groq; on failure, the raw prompt text | `summarize_sections` |
| `Section.collapsed`, `total_count` | Set when >6 similar links were cut to 3 | `extract_actions` |
| `Action.id` | `slugify(page_url + section_name + label)`, `-2`, `-3` suffix on clashes | `extract_actions.add` |
| `Action.type` | `link` `button` `form_submit` `input` | `extract_actions` |
| `Action.selector` | Short CSS: `tag#id`, else `tag.class1.class2`, else `tag[name=..]`, else `tag` | `css_selector` |
| `Action.navigates_to` | Absolute URL without fragment; only for links | `urljoin` + `urldefrag` |

Write behaviour (`write_graph`):

- Every write is a `MERGE`, so re-crawling the same page updates in place.
- Before re-writing a section's actions it `DETACH DELETE`s actions no longer present in that section.
- Each statement is a separate auto-commit query (no transaction, no `UNWIND` batching).
- `nodes`/`edges` counters only count *newly created* items, so a re-crawl prints near-zero.

---

## 4. The pipeline, function by function

| Function | Does | Notes |
| --- | --- | --- |
| `fetch_html(url)` | Headless Chromium, `goto(wait_until="networkidle", timeout=60s)`, returns `(final_url, title, html)` | Pages with polling or websockets may never go idle and time out. |
| `find_regions(soup)` | Collects semantic regions in `SEMANTIC_TAGS` order; if none, falls back to top-level `<div>`s with id/class | Fallback marks a div `list` if it has >6 links. |
| `owning_region(el, ids)` | Nearest ancestor that is a chosen region | Stops a `<form>` inside `<main>` from double-counting actions. |
| `extract_actions(...)` | Walks `a, button, input, select` owned by the region; classifies; applies the collapse rule; builds `Action`s | Inputs kept: `text`, `search`, `select`, `submit` only. |
| `structure_signature(a)` | `(grandparent tag, parent tag, sorted classes)` | Groups "same-shaped" links for collapsing. |
| `element_label(el)` | First non-empty of text, `aria-label`, input `value`, `placeholder`, `title`, `name`, child `img[alt]`, else selector | Truncated to 80 chars. |
| `region_name(el, role, i)` | `aria-label`, else id, else first heading, else first class, else `role-i` | Names are also used inside ids (see risks). |
| `build_sections(soup, url)` | Regions → unique names → actions → `Section`s | Duplicate names get ` (2)`, ` (3)`. |
| `summarize_sections(...)` | One Groq call per section, sequential, `temperature=0.2`, `max_tokens=100` | Failure is non-fatal. |
| `write_graph(...)` | Memgraph writes + confirmation query | See §3. |
| `print_table(...)`, `main()` | CLI output and argument parsing | Forces UTF-8 stdout on Windows. |

Constants worth knowing: `COLLAPSE_THRESHOLD = 6`, `COLLAPSE_KEEP = 3`, `GROQ_MODEL`, `GROQ_PROMPT`.

---

## 5. Known limits and risks (ranked by how much they hurt the demo agent)

1. **Selectors are not replayable.** `css_selector` returns things like `a` or `button.btn`, which
   match many elements. The runner cannot click reliably from these. Store a Playwright
   role-and-name locator (`get_by_role("button", name="Save")`) plus the CSS as a fallback.
2. **Ids are built from labels.** Renaming "Save" to "Save changes" produces a new `Action.id`, so
   a rename looks like delete + create. Healing needs ids that survive renames (see ARCHITECTURE §4).
3. **Deletes lose history.** `DETACH DELETE` on missing actions throws away exactly what the healer
   needs (old label, old selector). Mark `status = "missing"` instead.
4. **One page only.** `NAVIGATES_TO` targets are stub `Page` nodes; nothing crawls them. Flows need
   at least a same-origin breadth-first crawl to depth 2–3.
5. **No positions or screenshots.** No bounding boxes, so zoom targets and visual diffs are
   impossible yet. Playwright can give `bounding_box()` and screenshots during the same load.
6. **Static view of a dynamic page.** Only what is in the DOM after load: no menus, modals, tabs,
   shadow DOM, iframes, or `div role="button"`. Buttons never get `navigates_to`. Hidden elements
   are included because visibility is not checked.
7. **Missing input kinds.** `email`, `password`, `number`, `textarea`, checkbox, radio are skipped,
   so most real forms are half-captured.
8. **Stale sections linger.** Actions are cleaned per section, but a section that disappeared keeps
   its node and `HAS_SECTION` edge.
9. **Slug collisions.** `slugify(url + name)` concatenates without a separator, so different
   pairs can produce the same id (rare).
10. **Summaries are per section, not per action.** Fine for search; flows will need intent per action.

---

## 6. Glossary used across the docs

| Term | Meaning here |
| --- | --- |
| Page | A URL. Later maybe a `Screen` (URL + visible state). |
| Section | A semantic region of a page. |
| Action | One thing a user can do: click a link or button, type in an input, submit a form. |
| Flow | A named, ordered path of actions with an intent ("create an invoice"). Not built yet. |
| Take | One recording of one flow step: video segment, timings, element boxes. Not built yet. |
| Timeline | JSON edit list for one video: shots that point at flow steps and takes. Not built yet. |
| Heal | Detecting a UI change during a run and updating the graph, with a logged reason. Not built yet. |
