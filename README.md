# Web Graph Engine

Turns a website into a graph of **pages → sections → actions**, using Playwright, with a Cytoscape.js viewer and export to Neo4j or Memgraph.

The crawler opens pages and follows **same-site links only**. It never clicks buttons, types into fields or submits forms, so it is safe to run on real sites. Sites behind bot protection (e.g. Cloudflare "Just a moment…") are detected and reported, never bypassed.

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

In the UI: enter a URL, set **Max Pages** and **Link hops**, click **Start Graph Exploration**. Views: *Pages & sections*, *Pages, sections & actions*, *Site map*. Click any node for details.

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
