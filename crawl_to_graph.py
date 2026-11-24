"""Crawl a single webpage and store its navigation graph in Memgraph.

Usage:
    python crawl_to_graph.py <url>

Requires GROQ_API_KEY in the environment and Memgraph on bolt://localhost:7687.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from urllib.parse import urljoin, urldefrag

from bs4 import BeautifulSoup, Tag
from dotenv import load_dotenv
from groq import Groq
from neo4j import GraphDatabase
from playwright.sync_api import sync_playwright

MEMGRAPH_URI = "bolt://localhost:7687"
AUTH = ("", "")
GROQ_MODEL = "openai/gpt-oss-20b"
GROQ_PROMPT = "In one sentence, describe what a user can do in this section of a webpage."

# Priority order for semantic regions, mapped to Section.role
SEMANTIC_TAGS = [
    ("nav", "nav"),
    ("header", "header"),
    ("main", "main"),
    ("aside", "sidebar"),
    ("footer", "footer"),
    ("form", "form"),
]
COLLAPSE_THRESHOLD = 6
COLLAPSE_KEEP = 3
TEXT_INPUT_TYPES = {"text", "search"}
SUBMIT_INPUT_TYPES = {"submit"}


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #
@dataclass
class Action:
    id: str
    label: str
    type: str  # link | button | form_submit | input
    selector: str
    navigates_to: str | None = None


@dataclass
class Section:
    id: str
    name: str
    role: str
    actions: list[Action] = field(default_factory=list)
    summary: str = ""
    collapsed: bool = False
    total_count: int | None = None


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r"^https?://", "", text)
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def clean_text(text: str | None, limit: int = 80) -> str:
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def css_selector(el: Tag) -> str:
    """Short selector: tag + #id, else tag + up to two .classes."""
    tag = el.name
    el_id = el.get("id")
    if el_id and re.match(r"^[A-Za-z][\w-]*$", el_id):
        return f"{tag}#{el_id}"
    classes = [c for c in (el.get("class") or []) if re.match(r"^-?[A-Za-z_][\w-]*$", c)]
    if classes:
        return tag + "".join(f".{c}" for c in classes[:2])
    name = el.get("name")
    if name:
        return f'{tag}[name="{name}"]'
    return tag


def element_label(el: Tag) -> str:
    for candidate in (
        el.get_text(" ", strip=True),
        el.get("aria-label"),
        el.get("value") if el.name == "input" else None,
        el.get("placeholder"),
        el.get("title"),
        el.get("name"),
    ):
        label = clean_text(candidate)
        if label:
            return label
    img = el.find("img", alt=True)
    if img and clean_text(img["alt"]):
        return clean_text(img["alt"])
    return css_selector(el)


def structure_signature(a: Tag) -> tuple:
    """Signature used to decide whether links are 'similar structure'."""
    parent = a.parent
    grandparent = parent.parent if parent else None
    return (
        grandparent.name if grandparent else None,
        parent.name if parent else None,
        tuple(sorted(a.get("class") or [])),
    )


def region_name(el: Tag, role: str, index: int) -> str:
    aria = clean_text(el.get("aria-label"), 50)
    if aria:
        return aria
    if el.get("id"):
        return clean_text(el["id"], 50)
    heading = el.find(["h1", "h2", "h3", "h4", "legend"])
    if heading and clean_text(heading.get_text(" ", strip=True), 50):
        return clean_text(heading.get_text(" ", strip=True), 50)
    classes = el.get("class") or []
    if classes:
        return clean_text(classes[0], 50)
    return f"{role}-{index}"


# --------------------------------------------------------------------------- #
# Scraping
# --------------------------------------------------------------------------- #
def fetch_html(url: str) -> tuple[str, str, str]:
    """Return (final_url, title, html)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto(url, wait_until="networkidle", timeout=60_000)
            return page.url, page.title(), page.content()
        finally:
            browser.close()


def find_regions(soup: BeautifulSoup) -> list[tuple[Tag, str]]:
    regions: list[tuple[Tag, str]] = []
    seen: set[int] = set()
    for tag, role in SEMANTIC_TAGS:
        for el in soup.find_all(tag):
            if id(el) not in seen:
                seen.add(id(el))
                regions.append((el, role))
    if regions:
        return regions

    # Fallback: top-level <div>s (direct children of body) with an id or class
    body = soup.body or soup
    for el in body.find_all("div", recursive=False):
        if el.get("id") or el.get("class"):
            role = "list" if len(el.find_all("a", href=True)) > COLLAPSE_THRESHOLD else "main"
            regions.append((el, role))
    return regions


def owning_region(el: Tag, region_ids: set[int]) -> int | None:
    """id() of the nearest ancestor that is a selected region."""
    for parent in el.parents:
        if id(parent) in region_ids:
            return id(parent)
    return None


def extract_actions(
    region: Tag, region_ids: set[int], page_url: str, section_name: str
) -> tuple[list[Action], bool, int | None]:
    """Extract actions belonging directly to this region (not to a nested region)."""
    me = id(region)
    links: list[Tag] = []
    others: list[tuple[Tag, str]] = []

    for el in region.find_all(["a", "button", "input", "select"]):
        if owning_region(el, region_ids) != me:
            continue
        if el.name == "a":
            if el.get("href") is not None:
                links.append(el)
        elif el.name == "button":
            btype = (el.get("type") or "submit").lower()
            in_form = el.find_parent("form") is not None
            others.append((el, "form_submit" if in_form and btype == "submit" else "button"))
        elif el.name == "input":
            itype = (el.get("type") or "text").lower()
            if itype in SUBMIT_INPUT_TYPES:
                others.append((el, "form_submit"))
            elif itype in TEXT_INPUT_TYPES:
                others.append((el, "input"))
        elif el.name == "select":
            others.append((el, "input"))

    # COLLAPSE rule: >6 similarly-structured links -> keep first 3
    collapsed, total_count = False, None
    if len(links) > COLLAPSE_THRESHOLD:
        groups: dict[tuple, list[Tag]] = defaultdict(list)
        for a in links:
            groups[structure_signature(a)].append(a)
        dropped = {
            id(a)
            for group in groups.values()
            if len(group) > COLLAPSE_THRESHOLD
            for a in group[COLLAPSE_KEEP:]
        }
        if dropped:
            collapsed, total_count = True, len(links)
            links = [a for a in links if id(a) not in dropped]

    actions: list[Action] = []
    used_ids: set[str] = set()

    def add(el: Tag, atype: str, navigates_to: str | None = None) -> None:
        label = element_label(el)
        aid = slugify(page_url + section_name + label)
        base, n = aid, 2
        while aid in used_ids:  # keep ids unique for repeated labels
            aid, n = f"{base}-{n}", n + 1
        used_ids.add(aid)
        actions.append(Action(aid, label, atype, css_selector(el), navigates_to))

    for a in links:
        href = (a.get("href") or "").strip()
        target = None
        if href and not href.lower().startswith(("javascript:", "mailto:", "tel:")):
            target = urldefrag(urljoin(page_url, href))[0] or None
        add(a, "link", target)
    for el, atype in others:
        add(el, atype)

    return actions, collapsed, total_count


def build_sections(soup: BeautifulSoup, page_url: str) -> list[Section]:
    regions = find_regions(soup)
    region_ids = {id(el) for el, _ in regions}
    sections: list[Section] = []
    used_names: set[str] = set()
    role_counts: dict[str, int] = defaultdict(int)

    for el, role in regions:
        role_counts[role] += 1
        name = region_name(el, role, role_counts[role])
        base, n = name, 2
        while name in used_names:
            name, n = f"{base} ({n})", n + 1
        used_names.add(name)

        actions, collapsed, total = extract_actions(el, region_ids, page_url, name)
        if collapsed and role == "main" and el.name == "div":
            role = "list"
        sections.append(
            Section(
                id=slugify(page_url + name),
                name=name,
                role=role,
                actions=actions,
                collapsed=collapsed,
                total_count=total,
            )
        )
    return sections


# --------------------------------------------------------------------------- #
# Summaries
# --------------------------------------------------------------------------- #
def reasoning_kwargs(model: str, effort: str = "low") -> dict:
    """Extra Groq params for gpt-oss reasoning models; empty for other models."""
    if "gpt-oss" in model:
        return {"reasoning_effort": effort, "include_reasoning": False}
    return {}


def summarize_sections(sections: list[Section], page_url: str) -> None:
    client = Groq(api_key=os.environ["GROQ_API_KEY"])
    model = os.environ.get("GROQ_MODEL") or GROQ_MODEL
    for s in sections:
        labels = ", ".join(a.label for a in s.actions) or "none"
        text = f"Section '{s.name}' on {page_url}. Role: {s.role}. Actions: {labels}"
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": GROQ_PROMPT},
                    {"role": "user", "content": text},
                ],
                temperature=0.2,
                # gpt-oss reasons before answering; reasoning tokens count toward max_tokens
                max_tokens=512,
                **reasoning_kwargs(model),
            )
            s.summary = (resp.choices[0].message.content or "").strip()
        except Exception as e:  # keep crawling even if one summary fails
            print(f"  ! Groq summary failed for '{s.name}': {e}", file=sys.stderr)
            s.summary = text


# --------------------------------------------------------------------------- #
# Memgraph
# --------------------------------------------------------------------------- #
def write_graph(page_url: str, title: str, sections: list[Section]) -> tuple[int, int]:
    nodes = edges = 0

    def tally(result) -> None:
        nonlocal nodes, edges
        c = result.consume().counters
        nodes += c.nodes_created
        edges += c.relationships_created

    with GraphDatabase.driver(MEMGRAPH_URI, auth=AUTH) as driver:
        with driver.session() as session:
            tally(session.run(
                "MERGE (p:Page {url: $url}) SET p.title = $title",
                url=page_url, title=title,
            ))
            for s in sections:
                props = {"name": s.name, "role": s.role, "summary": s.summary}
                if s.collapsed:
                    props.update(collapsed=True, total_count=s.total_count)
                tally(session.run(
                    """
                    MATCH (p:Page {url: $url})
                    MERGE (s:Section {id: $id})
                    SET s += $props
                    MERGE (p)-[:HAS_SECTION]->(s)
                    """,
                    url=page_url, id=s.id, props=props,
                ))
                # Re-crawl hygiene: drop actions no longer present in this section
                session.run(
                    """
                    MATCH (s:Section {id: $sid})-[:HAS_ACTION]->(a:Action)
                    WHERE NOT a.id IN $keep
                    DETACH DELETE a
                    """,
                    sid=s.id, keep=[a.id for a in s.actions],
                ).consume()
                for a in s.actions:
                    tally(session.run(
                        """
                        MATCH (s:Section {id: $sid})
                        MERGE (a:Action {id: $id})
                        SET a.label = $label, a.type = $type,
                            a.selector = $selector, a.navigates_to = $nav
                        MERGE (s)-[:HAS_ACTION]->(a)
                        """,
                        sid=s.id, id=a.id, label=a.label, type=a.type,
                        selector=a.selector, nav=a.navigates_to,
                    ))
                    if a.navigates_to:
                        tally(session.run(
                            """
                            MATCH (a:Action {id: $id})
                            MERGE (t:Page {url: $target})
                            MERGE (a)-[:NAVIGATES_TO]->(t)
                            """,
                            id=a.id, target=a.navigates_to,
                        ))

            print("\nConfirmation query:")
            rows = session.run(
                """
                MATCH (p:Page)-[:HAS_SECTION]->(s)-[:HAS_ACTION]->(a)
                WHERE p.url = $url
                RETURN p.url, s.name, s.role, collect(a.label) AS actions
                """,
                url=page_url,
            )
            for r in rows:
                print(f"  {r['p.url']} | {r['s.name']} | {r['s.role']} | {r['actions']}")

    return nodes, edges


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
def print_table(page_url: str, sections: list[Section]) -> None:
    rows = [("Page", "Section", "Role", "Actions count")]
    for s in sections:
        count = str(len(s.actions))
        if s.collapsed:
            count += f" (collapsed, {s.total_count} total)"
        rows.append((page_url, s.name, s.role, count))
    widths = [min(max(len(r[i]) for r in rows), 60) for i in range(4)]
    sep = "-+-".join("-" * w for w in widths)
    print()
    for i, r in enumerate(rows):
        print(" | ".join(r[j][: widths[j]].ljust(widths[j]) for j in range(4)))
        if i == 0:
            print(sep)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Store a webpage's navigation graph in Memgraph.")
    parser.add_argument("url", help="URL of the page to crawl, e.g. https://example.com")
    args = parser.parse_args()

    load_dotenv()  # values already set in the shell take precedence
    if not os.environ.get("GROQ_API_KEY"):
        sys.exit("Error: GROQ_API_KEY must be set in the environment or in .env.")

    print(f"Loading {args.url} ...")
    page_url, title, html = fetch_html(args.url)
    soup = BeautifulSoup(html, "html.parser")

    sections = build_sections(soup, page_url)
    if not sections:
        sys.exit("No sections found on the page.")
    print(f"Found {len(sections)} sections; summarizing with Groq ...")
    summarize_sections(sections, page_url)

    nodes, edges = write_graph(page_url, title, sections)
    print_table(page_url, sections)
    print(f"\nTotal nodes created: {nodes}")
    print(f"Total edges created: {edges}")


if __name__ == "__main__":
    main()
