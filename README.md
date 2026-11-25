# Self-Healing App Graph

**Compute50, PSG Tech Golden Jubilee National Level Hackathon**

Web apps change with every release, but their demo videos, help guides and click-through scripts do not. They
silently go wrong and have to be redone by hand.

This project builds **one map of a web app** (a graph of its pages, sections, buttons and screens), keeps it in
Memgraph, and lets **two AI agents** use it:

- the **Demo agent** turns a goal like *"show all features to a new admin in 60 seconds"* into a narrated,
  captioned demo video, recorded on the real app;
- the **Onboarding agent** answers *"how do I invite a teammate?"* with numbered steps and a short clip.

When a button is renamed, moved or removed, the agents **heal the map** while they work instead of failing, and
nothing is ever deleted, so the history stays.

---

## Demo videos

### 1. Demo agent: from a goal to a video

<!-- Replace this line with your first video (see "Adding the videos" below). -->
_Video coming soon._

### 2. Onboarding agent: answering a question by showing it

<!-- Replace this line with your second video. -->
_Video coming soon._

---

## How it works

```
 Web app ──► Map builder ──► The map (Memgraph) ──► Demo agent ─────► narrated MP4, subtitles, GIF
             (Playwright)          ▲                Onboarding agent ► steps + short clip
                                   │                       │
                                   └── renamed buttons, popups, failing links are saved back
```

1. **Understand the site:** one AI call describes what the app is for.
2. **Crawl:** a browser visits each page and records its sections and actions. It never submits a form.
3. **Score:** pages are ranked by importance (PageRank) and grouped into named areas like "Billing".
4. **Explore safely:** safe buttons are clicked to find popups and tabs that aren't visible on first load.
5. **Save:** everything goes into Memgraph, keyed by site, so several apps can share one database.

The AI only plans and writes text. Ordinary code does every click, checks where it landed, and renders the video.

---

## Features

### The map

- **Pages → Sections → Actions**: every page, its regions (header, nav, form, footer…) and its buttons, links
  and fields.
- **Several ways to find each button**: role and name, test id, CSS path and text, so one change doesn't lose it.
- **States**: a page plus whichever dialog or tab is open, linked by the clicks that move between them.
- **Reliability and cost on every click**: routes prefer clicks that worked before and avoid risky ones (Delete).
- **Page importance and areas**: PageRank, betweenness and named groups of related pages.
- **Look-alike pages**: `/product/1` and `/product/2` are one page type; long lists are stored once with examples.

### Demo agent

- **Six phases with gates**: Plan → Sample → Pick style → Record → Assemble → Review.
- **Storyboard approval** before anything is recorded.
- **Script first, voice first**: the voice-over is written once, and recording is paced so each click happens as
  the narration mentions it.
- **Two style samples** (fast and calm) to choose from.
- **Cuts, zooms and captions**: waiting time is cut, the camera zooms on the button, captions come from the voice's
  word timings.
- **Rule checks before rendering**: no long silences, every voice line fits its shot, every button named in the
  narration is really on screen, every shot was recorded, no repeated wording, length matches the request.
- **Edits in plain words**: *"shorten the intro"* redoes only the shots it touches, with versions and undo.
- **Best of several takes**, and runs can be resumed.
- **Outputs**: MP4, SRT and VTT subtitles, a GIF, a chapter list and a still image per step.

### Onboarding agent

- **Question → route** between two screens, or a known flow, from the page the user is on.
- **Shows, then tells**: a short narrated clip plus numbered steps using the exact button names.
- **Honest**: if there is no route it says *"I can't find that in this app"* instead of inventing steps.
- **"What can I do here?"** and **"Where should I start?"** answered from areas and the most important pages.
- **Search fallback** on public sites, using the site's own search box.
- **Question log**: every question is saved; unanswered ones become a to-do list for the team.

### Self-healing

- **Moved button**: found with another saved locator; the new one is saved and logged as a repair.
- **Renamed button**: matched by role and a similar name; it keeps its id and remembers the old name.
- **Removed button**: marked `missing`, never deleted.
- **Unexpected page**: the route is re-planned from where the agent is (up to 3 times).
- **Popups and banners**: the agent learns how to close them and saves that as a first step for next time.
- **Failing link**: after 3 failures in a row it is marked `broken` and routes avoid it.
- **Change log**: every heal, rename, removal and broken link is written with a timestamp.

### Safety

- **Public sites**: the agents only browse, open tabs and dialogs, and search. Form submits are blocked.
- **Your own app** (hosts in `DEMO_ALLOW_HOSTS`): forms can be filled and saved, but only after you approve the
  storyboard.
- **The explorer** blocks every request that isn't a GET, so nothing can be saved even if a guess is wrong.

---

## Tech stack

| Area | Used |
| --- | --- |
| Browser and app | Playwright, Chromium, Node.js 22, TypeScript, Express |
| Map storage | Memgraph, Cypher, neo4j-driver, Cytoscape.js |
| AI | Claude (through the Claude Code CLI) or Groq; any OpenAI-compatible model, such as Ollama, for map building |
| Video | ElevenLabs, FFmpeg |

---

## Getting started

### You need

- Node.js 22
- Docker Desktop, running (for Memgraph)
- FFmpeg on your `PATH` (Windows: `winget install Gyan.FFmpeg`)
- Optional: Claude Code, logged in, for AI planning and narration on your Claude subscription
- Optional: an ElevenLabs API key for the voice (without it: silent track with captions)

### 1. Install

```bash
npm ci
```
```bash
npx playwright install chromium
```

### 2. Start Memgraph and Memgraph Lab

```bash
docker run -d --name memgraph -p 7687:7687 -p 7444:7444 memgraph/memgraph-mage
```
```bash
docker run -d --name memgraph-lab -p 3000:3000 -e QUICK_CONNECT_MG_HOST=host.docker.internal memgraph/lab
```

Memgraph Lab is then at http://localhost:3000.

### 3. Create `.env`

```
NEO4J_URI=bolt://localhost:7687

# The agents' AI: Claude Code on your subscription (or set GROQ_API_KEY instead)
AGENT_LLM=claude
CLAUDE_MODEL=sonnet

# Map building without an AI (or set LLM_BASE_URL / LLM_MODEL / LLM_API_KEY)
GRAPH_LLM=off

# Voice (optional)
ELEVENLABS_API_KEY=
```

### 4. Run the UI

```bash
npx tsx ui/server.ts
```

Open http://localhost:4300:

- **Site graph**: paste a link and press **Build**.
- **Make a demo**: write a goal, pick a style and length, approve the storyboard.
- **Ask a question**: type *"how do I…?"*.

A local test site is available with `npm run fixture` (http://127.0.0.1:5050).

### Command line

```bash
npm run graph -- https://your.app/
```
```bash
npm run agent -- https://your.app/ "show all features" --audience "new admin" --seconds 60
```
```bash
npm run onboard -- https://your.app/ "how do I invite a teammate?"
```

Outputs: demos in `runs/<runId>/out/`, answer clips in `runs/onboarding/`, questions in `runs/questions.jsonl`.

---

## Configuration

| Setting | What it does | Without it |
| --- | --- | --- |
| `AGENT_LLM=claude` (+ `CLAUDE_MODEL`) | Planning, narration and answers through the Claude Code CLI on your subscription | Groq if `GROQ_API_KEY` is set, else keyword rules |
| `GROQ_API_KEY` (+ `GROQ_MODEL`, `GROQ_VISION_MODEL`) | Planning and narration through Groq; vision review of takes | Keyword rules |
| `ELEVENLABS_API_KEY` (+ `ELEVENLABS_VOICE_ID`) | Voice-over | Silent track with captions |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | AI for map building: site profile, guided crawl, area names | Brute-force crawl, areas named after their top page |
| `GRAPH_LLM=off` | Build maps without any AI | — |
| `NEO4J_URI` | Graph database (default `bolt://localhost:7687`) | — |
| `DEMO_ALLOW_HOSTS` | Your own apps, where forms may be saved (default `localhost`) | Public-site mode |
| `UI_PORT` | UI port (default `4300`) | — |

---

## Benchmark

`bench/` measures whether the map helps an AI agent. The test agent only gets **map-only tools** (it never sees the
page's code) and works through 18 tasks on 7 real websites, from finding a page to filling in a form. In a small
test run with limited compute, it completed **7 of 9** tasks with the new map features, against **6 of 9** with the
original map. See [`bench/README.md`](bench/README.md).

---

## Project layout

```
src/sections/   map builder: crawler, sections, locators, templates, PageRank, areas
src/agent/      demo agent, onboarding agent, healing, media (voice, captions, render)
ui/             web page for both agents
bench/          benchmark harness
docs/           architecture, agent plan, feature list, status
test/           unit and end-to-end tests (npm test)
```

More detail: [`src/agent/README.md`](src/agent/README.md) and [`docs/`](docs/).

### Also in this repo: Graph Explorer and Demo Studio

The original engine: `npm start` opens a graph viewer and Demo Studio at http://localhost:3000 (crawl a site,
view its graph, record a captioned walkthrough). `npm run crawl -- https://example.com 10 2` writes a Cypher export.
Note that Memgraph Lab also uses port 3000, so set `PORT` in `.env` if you run both.

---

## Adding the videos

GitHub plays a video inline when its link comes from GitHub's own upload. A video file committed to the repo shows as
a plain link instead.

1. On github.com, open `README.md` and click the pencil icon (**Edit**).
2. Drag your `.mp4` (or `.mov`) file into the editor, onto the line under the video's heading. GitHub uploads it
   and inserts a link like `https://github.com/user-attachments/assets/…`.
3. Keep that link on its own line, delete the `_Video coming soon._` line, and commit.

The limit is 10 MB per file on a free account (100 MB on paid plans). For a larger video, compress it:

```bash
ffmpeg -i demo.mp4 -vcodec libx264 -crf 28 -preset slow -vf "scale=1280:-2" -acodec aac -b:a 96k demo-small.mp4
```

Other options: a GIF in `docs/media/` (`![Demo](docs/media/demo.gif)`), or a YouTube thumbnail that links to the
video (`[![Demo](https://img.youtube.com/vi/VIDEO_ID/0.jpg)](https://youtu.be/VIDEO_ID)`).
