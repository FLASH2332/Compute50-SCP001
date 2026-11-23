# Web Graph Engine

A robust, high-fidelity engine that converts any website into an interactive state-and-action knowledge graph. Built with **Playwright**, **Neo4j**, and **Cytoscape.js**.

---

## 🎯 Architecture

```
                    ┌─────────────────────────┐
                    │       Website URL       │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │   Playwright Explorer   │
                    │  (State & Action Crawl) │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │      Graph Builder      │
                    │  (Pages, States, Trans) │
                    └──────┬───────────┬──────┘
                           │           │
            ┌──────────────┘           └──────────────┐
            ▼                                         ▼
┌─────────────────────────┐               ┌─────────────────────────┐
│     Neo4j Database      │               │      Cytoscape.js       │
│  (Cypher Storage & BI)  │               │   (Interactive Web UI)  │
└─────────────────────────┘               └─────────────────────────┘
```

---

## 🧩 Graph Data Model

The graph structure models actual interactive website behavior rather than mere static hyperlinks:

1. **`Page`** — Represents a canonical URL route or document (`id`, `url`, `path`, `title`, `domain`).
2. **`UIState`** — A distinct screen condition and interactive environment. Captures dynamic states like open modals, expanded drawers, active tabs, and filled forms even when the URL does not change.
   - Distinct state fingerprints combine canonical URL + active modal/drawer/tab landmarks.
   - Includes screenshot thumbnail preview and element counts.
3. **`Element`** — Interactive controls on the screen (buttons, text inputs, dropdowns, links, checkboxes).
   - Identified by stable selectors (`data-testid`, accessible role + label, CSS path).
4. **`Action`** — User interactions executed on elements (`CLICK`, `FILL`, `SELECT`, `HOVER`, `NAVIGATE`).
5. **`Transition`** — Directed edge connecting `UIState (A)` to `UIState (B)` via an `Action`. Distinguishes in-page state changes from full URL route navigations.
6. **`Workflow`** — Multi-step sequences traversing states to achieve a goal (e.g. `Dashboard -> Modal: New Invoice -> Saved Invoice -> Alert View`).

### Neo4j Graph Relationships
```cypher
(:Website)-[:HAS_PAGE]->(:Page)
(:Page)-[:HAS_STATE]->(:UIState)
(:UIState)-[:CONTAINS_ELEMENT]->(:Element)
(:UIState)-[:TRANSITION {id, actionType, description, urlChanged}]->(:UIState)
(:Element)-[:TRIGGERS {actionType}]->(:UIState)
(:Workflow)-[:STARTS_AT]->(:UIState)
(:Workflow)-[:ENDS_AT]->(:UIState)
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
npx playwright install chromium
```

### 2. Configure Environment (`.env`)
```bash
cp .env.example .env
```
Default settings:
```ini
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password123
PORT=3000
```
> *Note: If Neo4j is offline or not installed, the engine continues running with in-memory storage, Cytoscape.js real-time visualization, and automatic `.cypher` export.*

### 3. Start the Interactive Dashboard
```bash
npm start
```
Open your browser at:
- **Interactive Graph UI:** [http://localhost:3000](http://localhost:3000)
- **Built-in Demo App:** [http://localhost:3000/demo](http://localhost:3000/demo)

### 4. Or Run via CLI
```bash
# Syntax: npm run crawl <target_url> [max_states] [max_depth]
npm run crawl http://localhost:3000/demo 15 3
```

---

## 📊 Cytoscape.js Visualizer Features

- **Force-Directed & Hierarchical Layouts:** Switch between `CoSE`, `Breadthfirst`, `Concentric`, `Circle`, and `Grid`.
- **Detail Filtering:**
  - *High-Level:* Shows UIState transitions and exploration coverage.
  - *Sitemap:* Shows observed pages and same-origin links, including destinations the crawler has yet to visit.
  - *Detailed:* Expands to show individual interactive DOM Elements.
  - *Workflows Focus:* Highlights end-to-end user journeys.
- **Node Inspector:** Inspect state landmarks and coverage. Screenshots are opt-in in the dashboard or with the CLI flag `--screenshots`.
- **Live Terminal Activity:** Real-time WebSocket streaming of browser actions, state discovery, and workflow detection.
- **Direct Neo4j Sync & Export:** 1-click sync to Neo4j, or 1-click download of the complete `website_graph.cypher` script.

---

## 🔍 Useful Neo4j Cypher Queries

Once synced or imported into Neo4j:

### Find all modal dialog states
```cypher
MATCH (s:UIState {isModal: true})
RETURN s.name, s.modalTitle, s.url
```

### Trace all paths from landing page to form submission
```cypher
MATCH path = (start:UIState)-[:TRANSITION*1..4]->(goal:UIState)
WHERE start.name CONTAINS "Home" OR start.name CONTAINS "/"
RETURN path LIMIT 25
```

### Identify high-degree bottleneck states
```cypher
MATCH (s:UIState)
RETURN s.name, count{(s)-[:TRANSITION]->()} AS outgoing, count{()-[:TRANSITION]->(s)} AS incoming
ORDER BY outgoing + incoming DESC
```
