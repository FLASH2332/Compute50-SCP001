# Old SiteGraph: the demo agent

Two ways to make a demo existed. The **fixed pipeline** (`DemoDirector`) plans shots from the graph with no LLM
judgement. The **Demo agent** (`DemoAgent`) is an LLM tool loop that rehearses on the live site, writes a script,
records one clean take and renders it. With no tool-calling model, the agent hands the job to the fixed pipeline.

Sources: `old/agents/demo_agent.py` (347 lines), `old/demo/` (`script.py`, `capture.py`, `director.py`,
`storyboard.py`, `spec.py`, `render.py`, `tts.py`, `overlay.js`), `old/tools/demo_tools.py`.

---

## 1. The fixed pipeline (`DemoDirector.run`)

```
spec  = interpret(llm, text)            # DemoSpec: formats, scope_kind, target, audience, max_seconds, narration
sb    = StoryboardBuilder.build(spec)   # shots from graph paths (below), captions by LLM, persisted as Storyboard/Shot nodes
cap   = DemoCapturer.capture(sb)        # one recording browser, shot by shot
render_all(sb, cap, formats)            # video, gif, screenshot, guide (HTML), guide_md (zip), clickthrough (HTML)
```

How `build` picks shots, by `scope_kind`:

| Scope | Shots |
| --- | --- |
| `workflow` | hidden route from entry to the workflow's start, then one shot per workflow step |
| `goal` / `state` | route from entry to the best `find_targets` State, then a still of it |
| `transition` | hidden route to the state, the interaction (e.g. open a menu), a still |
| `highlights` | top 3 workflows (or top 3 States) by `demo_score` (from PageRank/betweenness), chained |
| `feature` | the 4 highest-PageRank States of a `Feature` community |

Each shot is recorded by `DemoSession.record`: highlight the element and take a keyframe, zoom for 0.7 s, unzoom,
run the step through `Navigator.execute_step` (so **healing works during recording**), hold, and store the shot's
`(start, end)` seconds in the video.

## 2. The Demo agent (`DemoAgent`), four phases

The system prompt spells out the phases; tools enforce them.

### Phase 1 — Rehearse (nothing recorded)

- Tools: `find_screens`, `plan_route`, `describe_state`, `observe`, `list_items`, `scroll`, `read_text`, `ask_user`
  + acting tools `click`, `hover`, `fill`, `select_option`, `set_checked`, `press`, `open_url`, `run_goal`.
- The browser tools **log every action that worked** into `ctx.extra["rehearsal"]` (`tools/browser_tools.py:rehearse`):
  `{"id": "a3", "kind": "click", "label": "click 'Mystery'", "element": <full element props>, "item": ..., "value": ...}`.
  Actions above the risk policy are not logged, so an approval is never replayed.
- Mistakes and detours are fine; they never reach the video.

### Phase 2 — Script (`write_script`)

- The model sends: title, intro, outro, and scenes `{action: "a3" | none, caption, narration?, hold?, zoom?}`.
- `build_script` **refuses unknown action ids** and lists the valid ones, so a script can only replay what really
  worked. Empty captions are refused.
- Hold time per scene = reading time of narration or caption: 0.4 s per word, clamped to 2.5–8 s.
- Saved as Markdown + JSON blobs. If `demo_approve_script` (default true), the tool returns `pause=` with the Markdown
  and the loop stops with `needs_input`. The user's reply is matched against approval words ("approve", "lgtm", "go
  ahead", …); anything else is treated as change requests, and `record_final` refuses until the script is rewritten.

### Phase 3 — Final take (`record_final` → `DemoSession.play`)

One continuous recording in a **fresh browser**:

```
title card (title + intro, held for reading time)
for each scene i:
    resolve the element (healing resolver) → scroll into view → bounding box
    step badge "Step i of n" + caption box + highlight ring (+ cursor dot)
    hold scene.hold seconds → keyframe
    if zoom: zoom to 1.35× on the element for 0.9 s, unzoom
    perform the action exactly as rehearsed (fill types with a 70 ms key delay)
    settle → caption stays 1.2 s on the result
closing card (outro)
```

- Any scene failing raises `TakeFailed(scene, reason)`: the **whole take is thrown away**; the model fixes the script
  and records again (up to `demo_retakes` = 2 extra takes).
- The overlay is plain injected JS (`demo/overlay.js`, 54 lines): caption box, pink highlight ring with page dimming,
  step badge, title cards, cursor, CSS zoom.

### Phase 4 — Check and render

- `review_take(scene)` shows the model that scene's keyframe (vision) to check the step is visible and nothing covers it.
- `render(formats, narration)`: builds a storyboard of stills from the script, then `render_all`.
  - Video: ffmpeg cut of the recording (`render_video` or `render_video_segments` when shots are not contiguous).
  - Narration: `pyttsx3` makes one WAV per shot (narration, else caption); `mix_narration` places each WAV at its
    shot's start time on a silent track and muxes it. No TTS installed → silent video kept.
  - Guide / click-through / GIF / screenshot from keyframes and hotspots.
- The script's Markdown is shown in the frontend's Demos tab (playback, downloads, script approval).

## 3. The earlier shot-by-shot mode (still available)

Tools `capture_route`, `capture_interaction`, `capture_still`, `preview_frame`, `discard_shot`, `set_caption`,
`list_shots`, `compose_storyboard`, `render`. The agent records shots as it goes, discards bad ones, and the renderer
cuts only the chosen shots' segments. Replaced as the default by rehearse → script → final take because a
continuous take looks cleaner and dead ends never get recorded.

## 4. Versions and re-rendering

A demo's map writes become one commit; the storyboard stores `map_commit`. `rerender(sb, pinned)` re-records the same
storyboard against the latest map, or against a checkout of the pinned commit.

---

## Strengths worth keeping

- The script can only reference actions that worked in the rehearsal (an enforced rule, not a prompt hint).
- Script approval before recording, as a real pause in the loop.
- One continuous take, discarded whole on failure: no half-broken videos.
- Healing runs during recording because playback goes through the same resolver.
- Per-shot `(start, end)` times are already recorded, so cutting or replacing a shot later is possible.

## Weaknesses (relevant to our plan)

- Voice is not fitted to the shot: hold time comes from word count, not from the audio clip's length. A long clip can
  run past its scene, and `mix_narration` overwrites the track, so a later clip cuts off an earlier one. Silent gaps are
  not checked.
- Captions are burned in by the overlay; there is no caption file and no word-level timing.
- No style choice: one fixed look (overlay colours, 1.35× zoom, fixed waits).
- Any change means re-recording the whole take; no "re-record only the changed scenes".
- The rehearsal log and script live in memory and blobs, not in the graph, so a later UI change cannot be traced to the
  scenes it breaks (only the fixed pipeline's storyboards link shots to Steps).
