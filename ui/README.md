# Demo Agent UI

A small web page for the demo agent in `src/agent/`, so you can make a demo without the CLI.

```bash
npm ci && npx playwright install chromium   # once
npx tsx ui/server.ts                         # → http://localhost:4300
npm run fixture                              # optional: the local test site on http://127.0.0.1:5050
```

FFmpeg must be on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH` in `.env`) for the final MP4. Without it the UI still
maps, plans, asks for approval and records; you can watch the recorded takes, then press **Continue this run** after
installing FFmpeg and restarting the UI.

Settings: `UI_PORT` (default `4300`), `UI_RUNS_DIR` (default `runs/`, the same folder the CLI uses). The server loads
the nearest `.env` walking up from the working directory, so a git worktree picks up the main checkout's `.env`.
Keys never reach the page; the page only sees on/off flags (LLM planner, voice, FFmpeg).

## What the page does

| In the page | Agent call / option |
| --- | --- |
| Site link, prompt, audience | `agent.make({ url, goal, audience })`; the badge shows `modeFor(url)` (full / public mode) |
| Style: Fast / Calm | `style: 'fast' \| 'calm'` (the `PRESETS` in `media/timeline.ts`) |
| Style: Compare | no `style`: the agent records the first two shots, renders both samples, and the page asks which one (`Approver.style`) |
| Length | `seconds` |
| Review the storyboard | `Approver.storyboard`: the page shows the storyboard; **Approve & record**, or send a change ("drop 2", "90 seconds", …) which goes through the agent's own revise loop. Off = auto-approve |
| Takes per shot | `takes` |
| Pages to crawl | `crawlSource(url, { maxPages })` |
| Explore dialogs and tabs | `deepen` |
| Extras | `extras` (.srt/.vtt, GIF, chapters, stills) |
| Show the browser | `headless: false` |
| Crawl again | `rebuild` |
| Graph store | none (default: map in memory for the run) or `GraphDbStore({ uri })` for a Memgraph/Neo4j URI you type in |
| Saved section graph | `appMapFromGraphFile(path)` instead of crawling |
| Login state | `storageState` |
| Result: Edit / Undo / versions | `editDemo`, `undoDemo`, `listVersions` |
| Result: Continue this run | `agent.resume(runId)` |

Progress comes from the agent's `log` port (streamed to the page over Server-Sent Events) and from the run's
`state.json` phase. One job runs at a time, since the agent drives one browser.

## Files

```
ui/server.ts         express server: REST + SSE, WebApprover (the agent's Approver port, answered from the page)
ui/public/index.html the page
ui/public/app.js     plain JS, no build step
ui/public/styles.css light and dark
```

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/options` | styles, defaults, environment flags |
| POST | `/api/runs` | start `make` (body: the fields above) |
| GET | `/api/jobs/:id/events` | SSE: `snapshot`, `log`, `state` |
| POST | `/api/jobs/:id/answer` | `{ answer }` for the pending storyboard / style question |
| POST | `/api/jobs/:id/cancel` | cancel while a question is pending |
| GET | `/api/runs`, `/api/runs/:runId` | past runs; one run's storyboard, takes, outputs, versions |
| POST | `/api/runs/:runId/edit` \| `/undo` \| `/resume` | edit by request, undo, continue |
| GET | `/media/...` | files under the runs folder (videos, captions, stills) |
