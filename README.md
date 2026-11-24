# Web Graph Engine

Turns a website into a graph of **pages → sections → actions**, using Playwright, with a Cytoscape.js viewer and export to Neo4j or Memgraph.

The default graph crawl follows **same-site links** and inventories buttons and fields. Demo Studio also probes eligible buttons in a read-only browser to learn what happens when they are clicked.

## Graph model

```
(:Page)-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(:Action)-[:NAVIGATES_TO]->(:Page)
```

| Node | What it is |
|---|---|
| `Page` | One URL (tracking params, `#hash` and trailing slash removed). `crawled=false` means it is only known through a link. |
| `Section` | A part of the page a visitor sees: `header`, `nav`, `main`, `sidebar`, `form`, `dialog`, `footer`, or a titled block (`content`, e.g. "FAQ"). Named from aria-label, its own heading, or its first links. |
| `Action` | Something a visitor can do there: `link`, `button`, `submit`, `input` (with `inputType`: email, password, search…), `select`, `choice`, `tab`. Links store `href`; same-site links point to a `Page`. |

Repeats are grouped when there are more than 6: 3 are kept, each with `groupSize`. A repeat is a link at the same spot in a repeated card or row (product cards, story rows, e.g. 20 books), a control with the same label over and over ("hide", "Add to basket"), or addresses that differ only by a number (`/item/1`, `/item/2`). Plain menus and lists of different pages, and buttons with different labels (FAQ questions), are never grouped. When a card links to the same place twice (image + title), it is counted once.

## Quick start

```bash
npm install
npx playwright install chromium
npm start            # UI at http://localhost:3000
```

### Demo Studio

Open **Demo Studio** from the graph dashboard or visit `http://localhost:3000/studio.html`. Enter a URL and an optional prompt such as “Show how to browse the catalog and go to the next page.”

1. The crawler inventories same-site links and sections. It interleaves pagination with ordinary links and records which URLs remain unvisited when a limit is reached. Demo Studio can also use a clearly labeled **Next page** button and record its resulting view when the URL stays the same.
   It also clicks up to 6 buttons/tabs on each of the first 3 pages (calls to action like "Register now" first) and records what each one does: opens a dialog, expands a panel, or goes to another page. This runs in a read-only browser: every non-GET request and every off-site navigation is blocked, so a click cannot change data. Login, delete, pay, submit and similar buttons are never clicked, and nothing is typed.
2. Set `GROQ_API_KEY` in the server environment or project `.env` to use Groq for planning. The planner sends your prompt and a compact map of pages, sections, observed clicks and routes to `openai/gpt-oss-20b`. Each proposed step is checked against the current page and its recorded routes. Skipped steps have reasons in the plan. If the key is missing or Groq fails, Studio uses keyword rules and reports why. Studio shows the planner, captions and reasons, and offers `plan.json` for download. The planner checks run offline in `test/groqPlanner.test.ts`.
3. The recorder opens the pages in a fresh read-only browser, declines (or hides) cookie banners, moves a visible cursor to each control, clicks the planned buttons to show their result, and captures live footage with captions. Download the captioned MP4, graph JSON and plan, or open the click-through HTML.

Video generation needs **FFmpeg** on PATH, or an executable path in `FFMPEG_PATH`. Install Playwright's Chromium and recording dependencies with the command above, even if setting `CRAWLER_BROWSER_CHANNEL=chrome` to use an installed Chrome browser.

The default exploration budget is 40 pages, 12 link hops, and four minutes. Increase the page and hop limits under **Crawl limits**. Coverage is limited to discoverable pages and supported pagination controls within the same site. Demo Studio does not sign in, type into fields, or submit forms. It stops at bot checks. Video output contains captions and no audio narration. Finished files are saved under `.demo-runs/`.

Studio saves the explored graph before planning. By default it records from the pages it opened, even when page or hop limits leave linked pages unvisited; the plan only uses opened pages. For a strict run, tick **Strict: require every discovered page to load before recording** under **Crawl limits**: Studio then stops with the partial graph and the reason if any page is pending.

After starting a walkthrough, click **Graph Explorer** in Studio to inspect its live graph in a new tab. The explorer follows that run as pages are discovered. **Back to walkthrough** opens the same run and its video when ready.

To verify the full pipeline with a local fixture, run `node test/studio.e2e.mjs` with Playwright and FFmpeg (including `ffprobe`) installed. This requires free port 3975, or set `STUDIO_TEST_PORT` to another free port.

In Graph Explorer, enter a URL, set **Max Pages** and **Link hops**, then click **Start Graph Exploration**. Use **Pages & sections** for an overview, **Actions by section** to inspect nine actions at a time, and **Site map (opened pages)** to follow routes between attempted pages. Select a page to highlight its routes and see its unopened links in the inspector.

CLI:

```bash
npm run crawl -- https://example.com 10 2            # writes website_sections.cypher
npm run crawl -- https://example.com 10 2 --sync     # also writes to the database
```

Database: set `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` in `.env` (see `.env.example`). Works with Neo4j and Memgraph over Bolt. Without a database, use **Export Cypher**.

## Tests

```bash
npm test
```

`test/sections.test.ts` crawls a local fixture site and checks: sections are found and named, repeated cards are grouped while menus are kept, email/password fields are recorded, a closed dialog is marked hidden, no form is submitted (no POST request), and the Cypher export uses the schema above.

## Example query

```cypher
MATCH path = (p:Page {url: "https://www.wemakedevs.org/hackathons/flagsmith"})-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(:Action)
RETURN path LIMIT 100
```
