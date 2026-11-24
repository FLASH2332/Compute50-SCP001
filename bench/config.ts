/**
 * Settings for the benchmark harness. Everything comes from the environment (or `.env`), so both graph variants run
 * with exactly the same values. This folder must be identical on graph_base and new_graph_base.
 */
import dotenv from 'dotenv';

dotenv.config();

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  db: {
    uri: process.env.MEMGRAPH_URI || process.env.NEO4J_URI || 'bolt://localhost:7687',
    user: process.env.MEMGRAPH_USER ?? '',
    password: process.env.MEMGRAPH_PASSWORD ?? '',
  },
  llm: {
    // Any OpenAI-compatible server: Ollama (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1),
    // llama.cpp server, vLLM, or a hosted one.
    baseUrl: (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, ''),
    model: process.env.LLM_MODEL || 'qwen2.5:7b-instruct',
    apiKey: process.env.LLM_API_KEY || 'local',
    temperature: num(process.env.LLM_TEMPERATURE, 0),
    seed: num(process.env.LLM_SEED, 7),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 120_000),
  },
  agent: {
    maxToolCalls: num(process.env.AGENT_MAX_TOOL_CALLS, 15),
    maxMs: num(process.env.AGENT_MAX_MS, 120_000),
    toolResultChars: num(process.env.AGENT_TOOL_RESULT_CHARS, 6000),
  },
  browser: {
    headless: process.env.BENCH_HEADLESS !== 'false',
    channel: process.env.CRAWLER_BROWSER_CHANNEL || undefined,
    settleMs: num(process.env.BENCH_SETTLE_MS, 1500),
  },
};
