/**
 * The benchmark agent: an LLM that does a task on a website using only the app-graph MCP tools.
 * It starts the MCP server as a child process and talks to it over stdio, like any MCP client.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../config.js';
import { chat, type Message, type ToolSpec } from './llm.js';

export const SYSTEM_PROMPT = `You do tasks on one website for a user. You cannot see the website itself. You only have tools
over a graph of it: pages, the sections of each page, the actions in each section (links, buttons, fields), what
recorded clicks did, and links between pages. Some tools act in a live browser and tell you which graph page it is on.

Rules:
- Start with site_overview. Use search, list_pages, get_page and find_path to find things.
- Use only ids that appear in tool results. Never invent ids, labels or URLs.
- When the task asks you to go somewhere or click something, do it with open_page, perform or fill, then check where you are.
- If the graph has no way to do the task or no answer, say NOT FOUND in the answer. Do not guess.
- Be efficient: you have a limited number of tool calls.
- Always end by calling finish with a short answer. Include page_id when the task is about a page, and action_ids
  when it is about a control.`;

export interface CallLog { name: string; args: unknown; ms: number; result: string; error?: boolean }
export interface AgentResult {
  task: string;
  answer: string;
  finish?: { answer: string; page_id?: string; action_ids?: string[] };
  stop: 'finish' | 'text' | 'max_calls' | 'timeout' | 'error';
  error?: string;
  calls: CallLog[];
  toolCalls: number;
  llmTurns: number;
  tokens: { prompt: number; completion: number };
  ms: number;
  finalPage?: Record<string, unknown>;
  model: string;
}

export async function connectGraphServer(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.resolve('bench/mcp/server.ts')],
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'bench-agent', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

const textOf = (res: any): string => (res?.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');

export async function runAgent(task: string, opts: { client?: Client; onEvent?: (e: string) => void } = {}): Promise<AgentResult> {
  const started = Date.now();
  const client = opts.client ?? await connectGraphServer();
  const log = opts.onEvent ?? (() => undefined);
  const { tools: mcpTools } = await client.listTools();
  const specs: ToolSpec[] = mcpTools.map(t => ({
    type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: task }];
  const result: AgentResult = {
    task, answer: '', stop: 'error', calls: [], toolCalls: 0, llmTurns: 0, tokens: { prompt: 0, completion: 0 }, ms: 0, model: config.llm.model,
  };

  try {
    loop: while (true) {
      if (Date.now() - started > config.agent.maxMs) { result.stop = 'timeout'; break; }
      const { message, usage } = await chat(messages, specs);
      result.llmTurns++;
      result.tokens.prompt += usage.prompt;
      result.tokens.completion += usage.completion;
      messages.push(message);
      if (!message.tool_calls?.length) {
        result.answer = (message.content ?? '').trim();
        result.stop = 'text';
        log(`model answered without finish: ${result.answer.slice(0, 200)}`);
        break;
      }
      for (const call of message.tool_calls) {
        let args: any = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = { _unparsed: call.function.arguments }; }
        if (result.toolCalls >= config.agent.maxToolCalls) { result.stop = 'max_calls'; break loop; }
        result.toolCalls++;
        const t0 = Date.now();
        let text: string;
        let isError = false;
        try {
          const res: any = await client.callTool({ name: call.function.name, arguments: args });
          text = textOf(res);
          isError = !!res.isError;
        } catch (e: any) {
          text = JSON.stringify({ error: String(e?.message || e).split('\n')[0] });
          isError = true;
        }
        const clipped = text.length > config.agent.toolResultChars ? text.slice(0, config.agent.toolResultChars) + ' …[cut]' : text;
        result.calls.push({ name: call.function.name, args, ms: Date.now() - t0, result: clipped, ...(isError ? { error: true } : {}) });
        log(`${call.function.name} ${JSON.stringify(args)} -> ${clipped.slice(0, 160)}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: clipped });
        if (call.function.name === 'finish') {
          result.finish = { answer: String(args.answer ?? ''), page_id: args.page_id, action_ids: args.action_ids };
          result.answer = result.finish.answer;
          result.stop = 'finish';
          break loop;
        }
      }
    }
  } catch (e: any) {
    result.stop = 'error';
    result.error = String(e?.message || e);
  }

  try {
    result.finalPage = JSON.parse(textOf(await client.callTool({ name: 'where_am_i', arguments: {} })));
  } catch { /* the server may be gone */ }
  if (!opts.client) await client.close();
  result.ms = Date.now() - started;
  return result;
}
