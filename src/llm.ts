/**
 * Small OpenAI-compatible chat client for graph building (site bootstrap, guided exploration, area names).
 *
 * Reads GRAPH_LLM_BASE_URL / GRAPH_LLM_MODEL / GRAPH_LLM_API_KEY, falling back to LLM_BASE_URL / LLM_MODEL /
 * LLM_API_KEY (the benchmark agent's settings), so one local model (Ollama, LM Studio) serves both.
 * Set GRAPH_LLM=off to build graphs without any model. Nothing in the graph depends on a model answer:
 * every caller has a plain fallback.
 */
import 'dotenv/config';

export interface GraphLlm {
  /** Returns the parsed JSON object the model answered with, or undefined on any failure. */
  json(system: string, user: string, maxTokens?: number): Promise<any | undefined>;
  calls: number;
}

const env = (k: string) => process.env['GRAPH_' + k] || process.env[k] || '';

/** A client when a model server answers, else undefined. */
export async function connectGraphLlm(): Promise<GraphLlm | undefined> {
  if (/^(off|0|false|none)$/i.test(process.env.GRAPH_LLM || '')) return undefined;
  const baseUrl = (env('LLM_BASE_URL') || 'http://localhost:11434/v1').replace(/\/$/, '');
  const model = env('LLM_MODEL') || 'qwen2.5:7b-instruct';
  const apiKey = env('LLM_API_KEY') || 'local';
  // Thinking models: 'none' turns thinking off (see bench/config.ts); empty = the model's default
  const effort = process.env.GRAPH_LLM_REASONING_EFFORT ?? process.env.LLM_REASONING_EFFORT ?? 'none';
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  try {
    const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    const body: any = await res.json().catch(() => ({}));
    const ids: string[] = (body?.data ?? []).map((m: any) => m.id);
    // Ollama / LM Studio list the models they can serve; no match means every call would fail
    if (!ids.includes(model)) return undefined;
  } catch {
    return undefined;
  }
  const client: GraphLlm = {
    calls: 0,
    async json(system, user, maxTokens = 800) {
      client.calls++;
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST', headers, signal: AbortSignal.timeout(120_000),
          body: JSON.stringify({
            model, temperature: 0, seed: 7, max_tokens: maxTokens, response_format: { type: 'json_object' },
            ...(effort ? { reasoning_effort: effort } : {}),
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          }),
        });
        if (!res.ok) return undefined;
        const body: any = await res.json();
        return parseJson(body?.choices?.[0]?.message?.content ?? '');
      } catch {
        return undefined;
      }
    },
  };
  return client;
}

/** The first JSON object in a model's text (models sometimes wrap it in prose or a code fence). */
export function parseJson(text: string): any | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
