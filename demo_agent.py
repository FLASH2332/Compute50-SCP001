"""Agent loop: given a URL, plan a narrated walkthrough and record a demo video.

The agent never sees raw HTML. Its only tools read the navigation graph that
crawl_to_graph.py stored in Memgraph, and the media tools that save the plan
and drive a headless browser recording.

Usage:
    python demo_agent.py <url> [--out demos] [--model llama-3.3-70b-versatile]

Run `python crawl_to_graph.py <url>` first so the page exists in the graph.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from groq import Groq
from neo4j import GraphDatabase
from playwright.sync_api import Page, sync_playwright

from crawl_to_graph import AUTH, MEMGRAPH_URI, slugify

DEFAULT_MODEL = "llama-3.3-70b-versatile"
MAX_TURNS = 12
VIEWPORT = {"width": 1280, "height": 720}
WORDS_PER_SECOND = 2.5
MIN_STEP_SECONDS = 2.5

SYSTEM_PROMPT = """You produce short narrated product demos of a webpage.
You cannot see the page's HTML. You only know the page through its navigation
graph: sections (nav, header, main, form, footer, sidebar, list) and the
actions inside them (links, buttons, inputs).

Work in this order:
1. Call get_page_overview to see the page's sections.
2. Call get_section_actions for the sections worth showing.
3. Call save_narration_plan with 4-8 steps. Start with an intro step (no
   section_id) and end with a closing step. Each narration is 1-2 short,
   friendly sentences spoken to a first-time visitor. Only use section_id and
   action_id values returned by the graph tools.
4. Call record_demo.
5. Reply with a one-paragraph summary of the demo. Do not call more tools."""


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

    def page(self, url: str) -> dict | None:
        # Crawled URLs are stored after redirects, so try common variants.
        variants = list(dict.fromkeys([url, url.rstrip("/"), url.rstrip("/") + "/"]))
        rows = self._rows(
            """
            MATCH (p:Page) WHERE p.url IN $urls
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
            urls=variants,
        )
        rows = [r for r in rows if r["sections"]]
        return rows[0] if rows else None

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

    def first_action_of(self, section_id: str) -> dict | None:
        rows = self._rows(
            "MATCH (:Section {id: $id})-[:HAS_ACTION]->(a:Action) "
            "RETURN a.label AS label, a.type AS type, a.selector AS selector LIMIT 1",
            id=section_id,
        )
        return rows[0] if rows else None

    def section_exists(self, section_id: str) -> bool:
        return bool(self._rows("MATCH (s:Section {id: $id}) RETURN s.id", id=section_id))


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
            if not action and step.get("section_id"):
                action = graph.first_action_of(step["section_id"])

            start = time.monotonic() - t0
            page.evaluate(CAPTION_JS, text)
            target = locate(page, action)
            if target:
                try:
                    target.scroll_into_view_if_needed(timeout=3000)
                    target.evaluate(HIGHLIGHT_JS, True)
                    target.hover(timeout=2000)
                    if action and action.get("type") == "input":
                        target.fill("demo", timeout=2000)
                except Exception as e:
                    notes.append(f"step {i}: could not interact ({e.__class__.__name__})")
            elif action:
                notes.append(f"step {i}: element '{action.get('label')}' not found on page")
            elif i == 1:
                page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")

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
            "description": "Get the page title and its sections (id, name, role, summary, action count) from the navigation graph.",
            "parameters": {"type": "object", "properties": {}, "required": []},
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
            "description": "Save the ordered narration plan for the demo. Each step narrates one moment; section_id/action_id say what to highlight.",
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
    def get_page_overview(self) -> dict:
        page = self.graph.page(self.url)
        if not page:
            return {"error": f"{self.url} is not in the graph. Run crawl_to_graph.py first."}
        self.page_url = page["url"]
        return page

    def get_section_actions(self, section_id: str) -> dict:
        actions = self.graph.section_actions(section_id)
        if not actions:
            return {"error": f"No actions for section '{section_id}'. Use ids from get_page_overview."}
        return {"section_id": section_id, "actions": actions}

    def save_narration_plan(self, title: str, steps: list[dict]) -> dict:
        problems = []
        for i, step in enumerate(steps, 1):
            if not step.get("narration", "").strip():
                problems.append(f"step {i}: empty narration")
            if step.get("section_id") and not self.graph.section_exists(step["section_id"]):
                problems.append(f"step {i}: unknown section_id '{step['section_id']}'")
            if step.get("action_id") and not self.graph.action(step["action_id"]):
                problems.append(f"step {i}: unknown action_id '{step['action_id']}'")
        if not steps:
            problems.append("plan has no steps")
        if problems:
            return {"error": "Plan rejected", "problems": problems}

        self.plan = {"url": self.page_url, "title": title, "steps": steps}
        self.out_dir.mkdir(parents=True, exist_ok=True)
        path = self.out_dir / "plan.json"
        path.write_text(json.dumps(self.plan, indent=2), encoding="utf-8")
        return {"saved": str(path), "steps": len(steps)}

    def record_demo(self) -> dict:
        if not self.plan:
            return {"error": "No plan saved yet. Call save_narration_plan first."}
        self.result = record(self.page_url, self.plan["steps"], self.graph, self.out_dir)
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
        try:
            return fn(**args)
        except TypeError as e:
            return {"error": f"Bad arguments: {e}"}
        except Exception as e:  # report tool failures to the model instead of crashing
            return {"error": f"{name} failed: {e.__class__.__name__}: {e}"}

    def run(self) -> str:
        messages: list[dict] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Create and record a narrated demo of {self.url}"},
        ]
        try:
            for turn in range(1, MAX_TURNS + 1):
                resp = self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    tools=TOOLS,
                    tool_choice="auto",
                    temperature=0.3,
                )
                msg = resp.choices[0].message
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
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Groq model (default: {DEFAULT_MODEL})")
    args = parser.parse_args()

    if not os.environ.get("GROQ_API_KEY"):
        sys.exit("Error: GROQ_API_KEY must be set in the environment.")

    agent = DemoAgent(args.url, Path(args.out), args.model)
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
