"""Agent loop: given a URL, plan a narrated walkthrough and record a demo video.

The agent never sees raw HTML. Its only tools read the navigation graph that
crawl_to_graph.py stored in Memgraph, and the media tools that save the plan
and drive a headless browser recording.

Usage:
    python demo_agent.py <url> [--out demos] [--model openai/gpt-oss-20b]

Run `python crawl_to_graph.py <url>` first so the page (and the same-site
pages it links to) exist in the graph. The demo can click through to any
linked page that was crawled.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from groq import BadRequestError, Groq, RateLimitError
from neo4j import GraphDatabase
from playwright.sync_api import Page, sync_playwright

from crawl_to_graph import (
    AUTH,
    GROQ_MODEL,
    MEMGRAPH_URI,
    reasoning_kwargs,
    retry_after_seconds,
    slugify,
    url_key,
)

DEFAULT_MODEL = GROQ_MODEL
MAX_TURNS = 16
TOOL_CALL_RETRIES = 5  # retries for malformed tool calls and rate limits
MAX_LINKED_PAGES = 10
VIEWPORT = {"width": 1280, "height": 720}
WORDS_PER_SECOND = 2.5
MIN_STEP_SECONDS = 2.5

SYSTEM_PROMPT = """You produce short narrated product demos of a website.
You cannot see any HTML. You only know the site through its navigation graph:
pages, their sections (nav, header, main, form, footer, sidebar, list) and the
actions inside them (links, buttons, inputs).

Work in this order:
1. Call get_page_overview (no url) for the start page. It lists the page's
   sections and linked_pages: other crawled pages you can click through to.
2. Call get_section_actions for the sections worth showing.
3. Optionally pick 1-2 linked pages to visit. Call get_page_overview with that
   page's url, then get_section_actions on its sections.
4. Call save_narration_plan with 5-10 steps. Start with an intro step (no
   section_id) and end with a closing step. Each narration is 1-2 short,
   friendly sentences spoken to a first-time visitor.
   To move to another page, add a step with "navigate": true and the
   action_id of the link (from linked_pages). Every later step must use
   sections and actions from the page you navigated to, until you navigate
   again. Only use ids returned by the graph tools.
5. Call record_demo.
6. Reply with a one-paragraph summary of the demo. Do not call more tools."""


# --------------------------------------------------------------------------- #
# Graph access (read-only)
# --------------------------------------------------------------------------- #
class Graph:
    def __init__(self) -> None:
        self.driver = GraphDatabase.driver(MEMGRAPH_URI, auth=AUTH)

    def close(self) -> None:
        self.driver.close()

    def _rows(self, query: str, **params) -> list[dict]:
        with self.driver.session() as s:
            return [r.data() for r in s.run(query, **params)]

    def resolve(self, url: str) -> str | None:
        """URL of the crawled page for `url`, following redirects and slash variants."""
        variants = list(dict.fromkeys([url, url.rstrip("/"), url.rstrip("/") + "/"]))
        rows = self._rows(
            """
            MATCH (p:Page) WHERE p.url IN $urls
            OPTIONAL MATCH (p)-[:REDIRECTS_TO]->(r:Page)
            WITH coalesce(r, p) AS dest
            MATCH (dest)-[:HAS_SECTION]->()
            RETURN DISTINCT dest.url AS url
            """,
            urls=variants,
        )
        return rows[0]["url"] if rows else None

    def linked_pages(self, page_url: str) -> list[dict]:
        """Crawled pages this page links to, with one action_id that clicks there."""
        rows = self._rows(
            """
            MATCH (p:Page {url: $url})-[:HAS_SECTION]->(:Section)-[:HAS_ACTION]->(a:Action)
                  -[:NAVIGATES_TO]->(t:Page)
            OPTIONAL MATCH (t)-[:REDIRECTS_TO]->(r:Page)
            WITH p, a, coalesce(r, t) AS dest
            MATCH (dest)-[:HAS_SECTION]->()
            WITH DISTINCT p, a, dest
            WITH p, dest, collect(a) AS links
            WHERE dest.url <> p.url
            WITH dest, head(links) AS link
            RETURN dest.url AS url, dest.title AS title,
                   link.id AS action_id, link.label AS link_label
            """,
            url=page_url,
        )
        return rows[:MAX_LINKED_PAGES]

    def section_page(self, section_id: str) -> str | None:
        rows = self._rows(
            "MATCH (p:Page)-[:HAS_SECTION]->(:Section {id: $id}) RETURN p.url AS url",
            id=section_id,
        )
        return rows[0]["url"] if rows else None

    def action_page(self, action_id: str) -> str | None:
        rows = self._rows(
            "MATCH (p:Page)-[:HAS_SECTION]->()-[:HAS_ACTION]->(:Action {id: $id}) "
            "RETURN p.url AS url",
            id=action_id,
        )
        return rows[0]["url"] if rows else None

    def page(self, url: str) -> dict | None:
        resolved = self.resolve(url)
        if not resolved:
            return None
        rows = self._rows(
            """
            MATCH (p:Page {url: $url})
            OPTIONAL MATCH (p)-[:HAS_SECTION]->(s:Section)
            OPTIONAL MATCH (s)-[:HAS_ACTION]->(a:Action)
            WITH p, s, count(a) AS n
            RETURN p.url AS url, p.title AS title,
                   collect(CASE WHEN s IS NULL THEN NULL ELSE {
                       section_id: s.id, name: s.name, role: s.role,
                       summary: s.summary, action_count: n,
                       collapsed: coalesce(s.collapsed, false),
                       total_links: s.total_count
                   } END) AS sections
            """,
            url=resolved,
        )
        if not rows:
            return None
        page = rows[0]
        page["linked_pages"] = self.linked_pages(resolved)
        return page

    def section_actions(self, section_id: str) -> list[dict]:
        return self._rows(
            """
            MATCH (:Section {id: $id})-[:HAS_ACTION]->(a:Action)
            RETURN a.id AS action_id, a.label AS label, a.type AS type,
                   a.navigates_to AS navigates_to
            """,
            id=section_id,
        )

    def action(self, action_id: str) -> dict | None:
        rows = self._rows(
            "MATCH (a:Action {id: $id}) RETURN a.label AS label, a.type AS type, "
            "a.selector AS selector",
            id=action_id,
        )
        return rows[0] if rows else None

    def actions_of(self, section_id: str) -> list[dict]:
        """Actions of a section with selectors, for the recorder only."""
        return self._rows(
            "MATCH (:Section {id: $id})-[:HAS_ACTION]->(a:Action) "
            "RETURN a.label AS label, a.type AS type, a.selector AS selector",
            id=section_id,
        )

    def action_link(self, action_id: str) -> str | None:
        """navigates_to URL of an action, if any."""
        rows = self._rows(
            "MATCH (a:Action {id: $id}) RETURN a.navigates_to AS url", id=action_id
        )
        return rows[0]["url"] if rows and rows[0]["url"] else None


# --------------------------------------------------------------------------- #
# Recording (media)
# --------------------------------------------------------------------------- #
CAPTION_JS = """text => {
  let el = document.getElementById('__demo_caption');
  if (!el) {
    el = document.createElement('div');
    el.id = '__demo_caption';
    el.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);'
      + 'max-width:80%;padding:12px 20px;border-radius:10px;z-index:2147483647;'
      + 'background:rgba(0,0,0,.78);color:#fff;font:18px/1.4 system-ui,sans-serif;'
      + 'text-align:center;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = text;
}"""

HIGHLIGHT_JS = """(el, on) => {
  if (on) {
    el.dataset.demoOutline = el.style.outline;
    el.style.outline = '3px solid #ff6a00';
    el.style.outlineOffset = '3px';
  } else {
    el.style.outline = el.dataset.demoOutline || '';
  }
}"""


def locate(page: Page, action: dict | None):
    """Find the element for an action using its stored selector and label."""
    if not action or not action.get("selector"):
        return None
    try:
        loc = page.locator(action["selector"])
        label = action.get("label") or ""
        if label and label != action["selector"]:
            by_text = loc.filter(has_text=label)
            if by_text.count():
                loc = by_text
        for i in range(min(loc.count(), 10)):
            if loc.nth(i).is_visible():
                return loc.nth(i)
    except Exception:
        pass
    return None


def follow_link(page: Page, target, expected_url: str, step_no: int, notes: list[str]) -> None:
    """Click the link like a user would; load the expected page directly if that fails."""
    if target:
        try:
            target.evaluate("el => el.removeAttribute('target')")  # keep it in this tab
            with page.expect_navigation(wait_until="networkidle", timeout=30_000):
                target.click(timeout=5000, force=True)
        except Exception as e:
            notes.append(f"step {step_no}: click did not navigate ({e.__class__.__name__})")
    else:
        notes.append(f"step {step_no}: link not found, loading the page directly")
    if url_key(page.url) != url_key(expected_url):
        if target:
            notes.append(f"step {step_no}: landed on {page.url}, loading {expected_url}")
        page.goto(expected_url, wait_until="networkidle", timeout=60_000)


def srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def record(url: str, steps: list[dict], graph: Graph, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    cues: list[tuple[float, float, str]] = []
    notes: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport=VIEWPORT,
            record_video_dir=str(out_dir),
            record_video_size=VIEWPORT,
        )
        page = context.new_page()
        t0 = time.monotonic()
        page.goto(url, wait_until="networkidle", timeout=60_000)

        for i, step in enumerate(steps, 1):
            text = step["narration"]
            duration = max(MIN_STEP_SECONDS, len(text.split()) / WORDS_PER_SECOND)
            action = graph.action(step["action_id"]) if step.get("action_id") else None
            target = locate(page, action)
            if not target and step.get("section_id"):
                # Fall back to the first visible action in the section
                for candidate in graph.actions_of(step["section_id"]):
                    target = locate(page, candidate)
                    if target:
                        action = candidate
                        break

            start = time.monotonic() - t0
            page.evaluate(CAPTION_JS, text)
            if target:
                try:
                    target.scroll_into_view_if_needed(timeout=3000)
                    target.evaluate(HIGHLIGHT_JS, True)
                    # force: skip actionability waits (overlays, animations)
                    target.hover(timeout=2000, force=True)
                    if action and action.get("type") == "input":
                        target.fill("demo", timeout=2000)
                except Exception as e:
                    notes.append(f"step {i}: could not interact ({e.__class__.__name__})")
            elif action:
                notes.append(f"step {i}: element '{action.get('label')}' not found on page")
            elif i == 1:
                page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")

            if step.get("navigate"):
                # Show the link for half the step, click through, narrate the rest on arrival
                page.wait_for_timeout(int(duration * 500))
                follow_link(page, target, step["target_url"], i, notes)
                page.evaluate(CAPTION_JS, text)
                page.wait_for_timeout(int(duration * 500))
            else:
                page.wait_for_timeout(int(duration * 1000))
                if target:
                    try:
                        target.evaluate(HIGHLIGHT_JS, False)
                    except Exception:
                        pass
            cues.append((start, time.monotonic() - t0, text))

        video = page.video
        context.close()  # finalizes the video file
        raw_video = Path(video.path())
        browser.close()

    video_path = out_dir / "demo.webm"
    if video_path.exists():
        video_path.unlink()
    raw_video.rename(video_path)

    srt_path = out_dir / "demo.srt"
    srt_path.write_text(
        "\n".join(
            f"{n}\n{srt_time(a)} --> {srt_time(b)}\n{t}\n" for n, (a, b, t) in enumerate(cues, 1)
        ),
        encoding="utf-8",
    )
    return {
        "video": str(video_path),
        "subtitles": str(srt_path),
        "duration_seconds": round(cues[-1][1], 1) if cues else 0,
        "notes": notes,
    }


# --------------------------------------------------------------------------- #
# Agent tools
# --------------------------------------------------------------------------- #
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_page_overview",
            "description": "Get a page's title, its sections (id, name, role, summary, action count) and linked_pages (crawled pages you can navigate to, each with the action_id of the link). Omit url for the start page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "a url from linked_pages; omit for the start page"}
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_section_actions",
            "description": "List the actions (links, buttons, inputs) inside one section of the navigation graph.",
            "parameters": {
                "type": "object",
                "properties": {"section_id": {"type": "string"}},
                "required": ["section_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_narration_plan",
            "description": "Save the ordered narration plan for the demo. Each step narrates one moment; section_id/action_id say what to highlight. A step with navigate=true clicks its action_id link and moves the demo to that page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "narration": {"type": "string"},
                                "section_id": {"type": "string"},
                                "action_id": {"type": "string"},
                                "navigate": {
                                    "type": "boolean",
                                    "description": "true to click action_id and go to the linked page",
                                },
                            },
                            "required": ["narration"],
                        },
                    },
                },
                "required": ["title", "steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "record_demo",
            "description": "Record the demo video (with on-screen captions and an .srt subtitle file) from the saved narration plan.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


class DemoAgent:
    def __init__(self, url: str, out_root: Path, model: str) -> None:
        self.graph = Graph()
        self.client = Groq(api_key=os.environ["GROQ_API_KEY"])
        self.model = model
        self.url = url
        self.page_url = url
        self.out_dir = out_root / slugify(url)
        self.plan: dict | None = None
        self.result: dict | None = None

    # ---- tools ----
    def get_page_overview(self, url: str | None = None) -> dict:
        page = self.graph.page(url or self.url)
        if not page:
            if url:
                return {"error": f"{url} was not crawled. Pick a url from linked_pages."}
            return {"error": f"{self.url} is not in the graph. Run crawl_to_graph.py first."}
        if not url:
            self.page_url = page["url"]
        return page

    def get_section_actions(self, section_id: str) -> dict:
        actions = self.graph.section_actions(section_id)
        if not actions:
            return {"error": f"No actions for section '{section_id}'. Use ids from get_page_overview."}
        return {"section_id": section_id, "actions": actions}

    def save_narration_plan(self, title: str, steps: list[dict]) -> dict:
        problems = []
        start = self.graph.resolve(self.url)
        if not start:
            return {"error": f"{self.url} is not in the graph. Run crawl_to_graph.py first."}
        current = start  # page the demo is on at each step
        for i, step in enumerate(steps, 1):
            step["page_url"] = current
            if not step.get("narration", "").strip():
                problems.append(f"step {i}: empty narration")
            sid, aid = step.get("section_id"), step.get("action_id")
            if sid:
                on = self.graph.section_page(sid)
                if not on:
                    problems.append(f"step {i}: unknown section_id '{sid}'")
                elif on != current:
                    problems.append(f"step {i}: section '{sid}' is on {on}, but the demo is on {current} at this step")
            if aid:
                on = self.graph.action_page(aid)
                if not on:
                    problems.append(f"step {i}: unknown action_id '{aid}'")
                elif on != current:
                    problems.append(f"step {i}: action '{aid}' is on {on}, but the demo is on {current} at this step")
            if step.get("navigate"):
                links = {p["action_id"]: p["url"] for p in self.graph.linked_pages(current)}
                dest = None
                if aid:
                    dest = links.get(aid)
                    if not dest:  # any link on this page to a crawled page works
                        nav = self.graph.action_link(aid)
                        dest = self.graph.resolve(nav) if nav else None
                if dest == current:
                    dest = None
                if not dest:
                    problems.append(
                        f"step {i}: navigate needs the action_id of a link to a crawled page; "
                        f"options here: {list(links)}"
                    )
                else:
                    step["target_url"] = dest
                    current = dest
        if not steps:
            problems.append("plan has no steps")
        if problems:
            return {"error": "Plan rejected", "problems": problems}

        self.plan = {"url": start, "title": title, "steps": steps}
        self.out_dir.mkdir(parents=True, exist_ok=True)
        path = self.out_dir / "plan.json"
        path.write_text(json.dumps(self.plan, indent=2), encoding="utf-8")
        return {"saved": str(path), "steps": len(steps)}

    def record_demo(self) -> dict:
        if not self.plan:
            return {"error": "No plan saved yet. Call save_narration_plan first."}
        self.result = record(self.plan["url"], self.plan["steps"], self.graph, self.out_dir)
        return self.result

    # ---- loop ----
    def call_tool(self, name: str, args: dict) -> dict:
        fn = {
            "get_page_overview": self.get_page_overview,
            "get_section_actions": self.get_section_actions,
            "save_narration_plan": self.save_narration_plan,
            "record_demo": self.record_demo,
        }.get(name)
        if not fn:
            return {"error": f"Unknown tool '{name}'"}
        # Drop stray keys the model sometimes sends (e.g. {"": ""} for no-arg tools)
        accepted = inspect.signature(fn).parameters
        args = {k: v for k, v in args.items() if k in accepted}
        try:
            return fn(**args)
        except TypeError as e:
            return {"error": f"Bad arguments: {e}"}
        except Exception as e:  # report tool failures to the model instead of crashing
            return {"error": f"{name} failed: {e.__class__.__name__}: {e}"}

    def complete(self, messages: list[dict]):
        """One model call; retries when Groq rejects a malformed tool call."""
        for attempt in range(1, TOOL_CALL_RETRIES + 1):
            try:
                resp = self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    tools=TOOLS,
                    tool_choice="auto",
                    temperature=0.3,
                    **reasoning_kwargs(self.model, effort="medium"),
                )
                return resp.choices[0].message
            except RateLimitError as e:
                if attempt == TOOL_CALL_RETRIES:
                    raise
                wait = retry_after_seconds(e)
                print(f"      ! Groq rate limit hit, waiting {wait:.0f}s")
                time.sleep(wait)
            except BadRequestError as e:
                body = e.body if isinstance(e.body, dict) else {}
                code = (body.get("error") or body).get("code")
                if code != "tool_use_failed" or attempt == TOOL_CALL_RETRIES:
                    raise
                print(f"      ! model sent a malformed tool call, retrying ({attempt})")

    def run(self) -> str:
        messages: list[dict] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Create and record a narrated demo of {self.url}"},
        ]
        try:
            for turn in range(1, MAX_TURNS + 1):
                msg = self.complete(messages)
                if not msg.tool_calls:
                    return msg.content or ""

                messages.append({
                    "role": "assistant",
                    "content": msg.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                        }
                        for tc in msg.tool_calls
                    ],
                })
                for tc in msg.tool_calls:
                    try:
                        args = json.loads(tc.function.arguments or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    print(f"[{turn}] -> {tc.function.name}({', '.join(args)})")
                    out = self.call_tool(tc.function.name, args)
                    status = "error" if "error" in out else "ok"
                    print(f"      <- {status}")
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(out, default=str)[:8000],
                    })
            return "Stopped: reached the turn limit."
        finally:
            self.graph.close()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Plan and record a narrated demo of a crawled page.")
    parser.add_argument("url")
    parser.add_argument("--out", default="demos", help="output folder (default: demos)")
    parser.add_argument(
        "--model", help=f"Groq model (default: GROQ_MODEL from env, else {DEFAULT_MODEL})"
    )
    args = parser.parse_args()

    load_dotenv()  # values already set in the shell take precedence
    if not os.environ.get("GROQ_API_KEY"):
        sys.exit("Error: GROQ_API_KEY must be set in the environment or in .env.")

    model = args.model or os.environ.get("GROQ_MODEL") or DEFAULT_MODEL
    agent = DemoAgent(args.url, Path(args.out), model)
    summary = agent.run()
    print("\n" + summary)
    if agent.result:
        print(f"\nVideo:     {agent.result['video']}")
        print(f"Subtitles: {agent.result['subtitles']}")
        print(f"Plan:      {agent.out_dir / 'plan.json'}")
        for note in agent.result["notes"]:
            print(f"  note: {note}")


if __name__ == "__main__":
    main()
