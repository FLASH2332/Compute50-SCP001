/** Memgraph access for the harness (Bolt via the neo4j driver). */
import neo4j, { type Driver } from 'neo4j-driver';
import { config } from '../config.js';

let driver: Driver | undefined;

export function db(): Driver {
  if (!driver) {
    const auth = config.db.user ? neo4j.auth.basic(config.db.user, config.db.password) : neo4j.auth.basic('', '');
    driver = neo4j.driver(config.db.uri, auth, { disableLosslessIntegers: true, connectionAcquisitionTimeout: 10_000 });
  }
  return driver;
}

/** Runs one query and returns plain objects (one per record). */
export async function query<T = Record<string, any>>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const session = db().session();
  try {
    const res = await session.run(cypher, params);
    return res.records.map(r => r.toObject() as T);
  } finally {
    await session.close();
  }
}

export async function closeDb(): Promise<void> {
  await driver?.close();
  driver = undefined;
}
