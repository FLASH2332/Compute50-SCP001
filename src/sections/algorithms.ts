/**
 * Graph algorithms over the page graph (port of the old SiteGraph `Curator.run_algorithms`).
 *
 * Small graphs (tens to a few hundred pages), so plain exact implementations: deterministic, no dependencies.
 *  - PageRank (damping 0.85, power iteration)
 *  - betweenness (Brandes, directed, normalized)
 *  - harmonic centrality (incoming: how easy a page is to reach from the others)
 *  - label propagation communities (undirected, fixed node order, up to 20 rounds)
 *  - reachable from the start page, and dead ends (opened pages with no way out)
 */

export interface PageGraph {
  nodes: string[];
  edges: Array<[string, string]>;  // directed, no duplicates, no self loops
}

export interface PageScores {
  pagerank: number;
  betweenness: number;
  harmonic: number;
  community: number;
  reachable: boolean;
}

export function buildIndex(g: PageGraph) {
  const index = new Map(g.nodes.map((n, i) => [n, i]));
  const out: number[][] = g.nodes.map(() => []);
  const inn: number[][] = g.nodes.map(() => []);
  for (const [a, b] of g.edges) {
    const i = index.get(a), j = index.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    out[i].push(j);
    inn[j].push(i);
  }
  return { index, out, inn };
}

export function pagerank(g: PageGraph, damping = 0.85, iterations = 100, tol = 1e-10): number[] {
  const n = g.nodes.length;
  if (!n) return [];
  const { out } = buildIndex(g);
  let rank = new Array(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = new Array(n).fill((1 - damping) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!out[i].length) { dangling += rank[i]; continue; }
      const share = (damping * rank[i]) / out[i].length;
      for (const j of out[i]) next[j] += share;
    }
    for (let i = 0; i < n; i++) next[i] += (damping * dangling) / n;
    const diff = next.reduce((s, v, i) => s + Math.abs(v - rank[i]), 0);
    rank = next;
    if (diff < tol) break;
  }
  return rank;
}

/** Brandes betweenness for a directed, unweighted graph, normalized by (n-1)(n-2). */
export function betweenness(g: PageGraph): number[] {
  const n = g.nodes.length;
  const { out } = buildIndex(g);
  const cb = new Array(n).fill(0);
  for (let s = 0; s < n; s++) {
    const stack: number[] = [];
    const preds: number[][] = Array.from({ length: n }, () => []);
    const sigma = new Array(n).fill(0); sigma[s] = 1;
    const dist = new Array(n).fill(-1); dist[s] = 0;
    const queue = [s];
    for (let h = 0; h < queue.length; h++) {
      const v = queue[h];
      stack.push(v);
      for (const w of out[v]) {
        if (dist[w] < 0) { dist[w] = dist[v] + 1; queue.push(w); }
        if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; preds[w].push(v); }
      }
    }
    const delta = new Array(n).fill(0);
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of preds[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) cb[w] += delta[w];
    }
  }
  const scale = n > 2 ? 1 / ((n - 1) * (n - 2)) : 1;
  return cb.map(v => v * scale);
}

/** Sum of 1/d(u, v) over all u that reach v, divided by n-1. */
export function harmonic(g: PageGraph): number[] {
  const n = g.nodes.length;
  const { inn } = buildIndex(g);
  return g.nodes.map((_, v) => {
    const dist = new Array(n).fill(-1); dist[v] = 0;
    const queue = [v];
    let sum = 0;
    for (let h = 0; h < queue.length; h++) {
      const x = queue[h];
      for (const u of inn[x]) if (dist[u] < 0) { dist[u] = dist[x] + 1; sum += 1 / dist[u]; queue.push(u); }
    }
    return n > 1 ? sum / (n - 1) : 0;
  });
}

/** Seeded PRNG (mulberry32), so communities are the same for the same graph. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Asynchronous label propagation on the undirected graph (Raghavan et al.; networkx `asyn_lpa_communities`):
 * nodes in a random order each round take the most frequent label among their neighbours, ties broken at random.
 * The random source is seeded, so the result is deterministic.
 */
export function labelPropagation(g: PageGraph, rounds = 20, seed = 42): number[] {
  const n = g.nodes.length;
  const { out, inn } = buildIndex(g);
  const nbrs = g.nodes.map((_, i) => [...new Set([...out[i], ...inn[i]])]);
  const label = g.nodes.map((_, i) => i);
  const random = rng(seed);
  const order = g.nodes.map((_, i) => i);
  for (let r = 0; r < rounds; r++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let changed = false;
    for (const i of order) {
      if (!nbrs[i].length) continue;
      const counts = new Map<number, number>();
      for (const j of nbrs[i]) counts.set(label[j], (counts.get(label[j]) ?? 0) + 1);
      const max = Math.max(...counts.values());
      const best = [...counts.entries()].filter(([, c]) => c === max).map(([l]) => l).sort((a, b) => a - b);
      if (best.includes(label[i])) continue;
      label[i] = best[Math.floor(random() * best.length)];
      changed = true;
    }
    if (!changed) break;
  }
  // Renumber 0..k-1 by first appearance so ids are stable for the same graph
  const renum = new Map<number, number>();
  return label.map(l => { if (!renum.has(l)) renum.set(l, renum.size); return renum.get(l)!; });
}

export function reachableFrom(g: PageGraph, start: string): boolean[] {
  const { index, out } = buildIndex(g);
  const seen = new Array(g.nodes.length).fill(false);
  const s = index.get(start);
  if (s === undefined) return seen;
  seen[s] = true;
  const queue = [s];
  for (let h = 0; h < queue.length; h++) for (const w of out[queue[h]]) if (!seen[w]) { seen[w] = true; queue.push(w); }
  return seen;
}

export function scorePages(g: PageGraph, start: string): Map<string, PageScores> {
  const pr = pagerank(g), bc = betweenness(g), hc = harmonic(g), lp = labelPropagation(g), reach = reachableFrom(g, start);
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return new Map(g.nodes.map((id, i) => [id, { pagerank: r4(pr[i]), betweenness: r4(bc[i]), harmonic: r4(hc[i]), community: lp[i], reachable: reach[i] }]));
}
