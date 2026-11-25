/**
 * One way to get a site's map, shared by every agent (demo, onboarding):
 *
 *   a given AppMap            → use it
 *   else the store's map      → use the saved graph (Memgraph / Neo4j)
 *   else build from a source  → crawl (the graph builder), deepen, save to the store, read it back
 *
 * The store is the source of truth, so both agents see exactly the same graph.
 */
import { classifyRisk, exploreInteractions, linkEdges } from '../explore/interact.js';
import { AppMap } from './appMap.js';
import type { BrowserHooks, Logger, MapSource, MapStore } from './ports.js';

export interface MapRequest {
  url?: string;                    // the site; with a store, its saved map is used when there is one
  map?: AppMap | MapSource;        // a ready map, or a source that builds one
  rebuild?: boolean;               // ignore the saved map and build again
  deepen?: boolean;                // run the safe-click explorer on a newly built map
}

export interface MapEnv {
  store?: MapStore;
  hooks?: BrowserHooks;
  log: Logger;
  browserChannel?: string;
  storageState?: string;
}

export interface MapResult { map: AppMap; from: 'given' | 'store' | 'built' }

export async function ensureMap(req: MapRequest, env: MapEnv, defaultDeepen = true): Promise<MapResult> {
  const deepen = req.deepen ?? defaultDeepen;
  if (req.map instanceof AppMap) return { map: await prepareMap(req.map, deepen, env), from: 'given' };
  const { store, log } = env;
  if (store && req.url && !req.rebuild) {
    const saved = await store.find(req.url);
    if (saved) {
      log(`Using the saved map of ${new URL(req.url).origin} from ${store.name}: ${Object.keys(saved.pages).length} pages, ${Object.keys(saved.areas).length} areas, ${Object.keys(saved.states).length} UI states`);
      return { map: await prepareMap(saved, false, env), from: 'store' };
    }
    log(`No saved map for ${new URL(req.url).origin} in ${store.name}; building one`);
  }
  if (!req.map) throw new Error('No map: give a map source (crawl), a graph file, or a store that has this site.');
  const built = await prepareMap(await req.map(log), deepen, env);
  if (!store) return { map: built, from: 'built' };
  await store.save(built);
  log(`Saved the map to ${store.name}`);
  return { map: (await store.find(built.startUrl)) || built, from: 'built' };
}

/** Risk classes and link edges always; the safe-click explorer (UI states) only when deepening. */
export async function prepareMap(map: AppMap, deepen: boolean, env: MapEnv): Promise<AppMap> {
  if (!Object.keys(map.pages).length) throw new Error('The map has no pages (the site could not be crawled).');
  classifyRisk(map);
  if (deepen) {
    const r = await exploreInteractions(map, { browserChannel: env.browserChannel, storageState: env.storageState, hooks: env.hooks, log: env.log });
    env.log(`Map: ${Object.keys(map.pages).length} pages, ${r.states} UI states, ${r.edges} actions between them (source: ${map.data.source})`);
  } else linkEdges(map);
  return map;
}
