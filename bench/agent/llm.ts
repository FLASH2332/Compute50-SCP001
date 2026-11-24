/** Minimal client for any OpenAI-compatible chat-completions server with tool calling (Ollama, LM Studio, vLLM...). */
import { config } from '../config.js';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ToolSpec { type: 'function'; function: { name: string; description?: string; parameters: unknown } }
export interface Completion { message: Extract<Message, { role: 'assistant' }>; usage: { prompt: number; completion: number } }

export async function chat(messages: Message[], tools: ToolSpec[]): Promise<Completion> {
  const body = {
    model: config.llm.model, messages, tools, tool_choice: 'auto',
    temperature: config.llm.temperature, seed: config.llm.seed, stream: false,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
    try {
      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.apiKey}` },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`LLM server returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (!res.ok) throw Object.assign(new Error(`LLM server returned ${res.status}: ${(await res.text()).slice(0, 300)}`), { fatal: true });
      const data: any = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      return {
        message: { role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) },
        usage: { prompt: data.usage?.prompt_tokens ?? 0, completion: data.usage?.completion_tokens ?? 0 },
      };
    } catch (e: any) {
      lastError = e;
      if (e?.fatal) break;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
