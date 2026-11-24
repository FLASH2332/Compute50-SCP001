import neo4j, { type Driver, type Session } from 'neo4j-driver';

export interface Neo4jConfig {
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
}

export class Neo4jService {
  private driver: Driver | null = null;
  private database: string;
  private isConnected: boolean = false;

  constructor(config?: Neo4jConfig) {
    const uri = config?.uri || process.env.NEO4J_URI || 'bolt://localhost:7687';
    const user = config?.username || process.env.NEO4J_USERNAME || 'neo4j';
    const password = config?.password || process.env.NEO4J_PASSWORD || 'password123';
    this.database = config?.database || process.env.NEO4J_DATABASE || 'neo4j';

    try {
      this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
        maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 5000
      });
    } catch {
      this.driver = null;
    }
  }

  public getSession(): Session | null {
    if (!this.driver) return null;
    return this.driver.session({ database: this.database });
  }

  public async verifyConnection(): Promise<{ connected: boolean; version?: string; error?: string }> {
    if (!this.driver) {
      return { connected: false, error: 'Neo4j driver not initialized' };
    }
    const session = this.getSession();
    if (!session) {
      return { connected: false, error: 'Could not obtain session' };
    }
    try {
      let version = 'connected';
      try {
        const res = await session.run('CALL dbms.components() YIELD name, versions, edition RETURN name, versions[0] AS version, edition');
        version = res.records[0]?.get('version') || 'Neo4j';
      } catch {
        // Memgraph (and other Bolt databases) don't have dbms.components()
        await session.run('RETURN 1');
        version = 'Bolt database';
      }
      this.isConnected = true;
      return { connected: true, version };
    } catch (err: any) {
      this.isConnected = false;
      return { connected: false, error: err.message || String(err) };
    } finally {
      await session.close();
    }
  }

  public async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}
