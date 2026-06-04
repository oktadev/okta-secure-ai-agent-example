// ============================================================================
// AGENT B — TASK HANDLER
// ============================================================================
// Given an inbound A2A task (already authenticated) and the inbound access
// token, perform the second hop and act on todo0 on behalf of the original
// user. Returns a human-readable result plus a redacted token-chain summary
// that makes the identity chaining visible in the demo UI.
//
// Task interpretation is intentionally simple (deterministic, no second LLM):
// the focus of this sample is the identity chain, not NLP. "list/show" lists
// todos; anything else is treated as the title of a new todo.

import { SecondHopExchange } from './auth/token-exchange';
import { TodoClient } from './todo-client';
import { loadLLMConfig, LlmAgent, type LlmTool } from './llm-agent';
import type { AgentBConfig } from './config';

const AGENT_B_SYSTEM_PROMPT =
  'You are Agent B, a task agent that manages the user\'s todos by calling the provided tools, ' +
  'acting on the user\'s behalf. Fulfil the request precisely and concisely. When creating a todo, ' +
  'use only the essential title — do NOT include words like "add", "create", or "to my todos". ' +
  'After acting, briefly confirm what you did in one sentence.';

export interface TaskResult {
  text: string;
  tokenChain: TokenChainSummary;
}

export interface TokenChainSummary {
  inbound: TokenSummary;
  idJag: TokenSummary;
  todoAccessToken: TokenSummary;
}

interface TokenSummary {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  scp?: string[];
  act?: unknown;
}

/** Decode a JWT payload for display only (no signature verification). */
function decodeClaims(token: string): Record<string, any> {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return {};
  }
}

function summarize(token: string): TokenSummary {
  const c = decodeClaims(token);
  return { sub: c.sub, aud: c.aud, iss: c.iss, scp: c.scp, act: c.act };
}

function isListIntent(text: string): boolean {
  return /\b(list|show|get|what(?:'s| is| are)?)\b/i.test(text);
}

/**
 * Pull a clean todo title out of a natural-language task. Prefers a quoted
 * span (straight or curly quotes), e.g. `add "X" to my todos` → `X`. Otherwise
 * strips common command boilerplate ("add/create … to my todos").
 */
function extractTitle(taskText: string): string {
  const quoted = taskText.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  const stripped = taskText
    .replace(/^\s*(please\s+)?(add|create|make|new|insert)\s+(a\s+|an\s+)?(new\s+)?(todo|task|item|reminder)?\s*/i, '')
    .replace(/\s*(to|in|on|into)\s+(my\s+)?(todo|todos|task|tasks)(\s+list)?\.?\s*$/i, '')
    .trim();
  return stripped || taskText.trim();
}

export async function handleTask(
  taskText: string,
  inboundAccessToken: string,
  config: AgentBConfig,
  onNote?: (text: string) => void,
): Promise<TaskResult> {
  const note = onNote ?? (() => {});

  // ── Second hop: mint a user-scoped todo0 access token ──────────────────────
  const exchange = new SecondHopExchange(config);
  const { accessToken: todoAccessToken, idJag } = await exchange.exchange(inboundAccessToken, note);

  const tokenChain: TokenChainSummary = {
    inbound: summarize(inboundAccessToken),
    idJag: summarize(idJag),
    todoAccessToken: summarize(todoAccessToken),
  };

  // ── Act on todo0 as the original user ──────────────────────────────────────
  note('Connecting to todo0 (MCP)…');
  const todo = new TodoClient(config);
  await todo.connect(todoAccessToken);

  try {
    const llmConfig = loadLLMConfig();
    let text: string;

    if (llmConfig) {
      // Intelligent path: Claude decides which todo tools to call and with what
      // arguments (handles add / list / toggle / delete and clean titles).
      const mcpTools = await todo.listTools();
      const tools: LlmTool[] = mcpTools.map((t) => ({
        name: t.name,
        description: t.description || t.name,
        input_schema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
      }));
      const agent = new LlmAgent(llmConfig);
      text = await agent.run(
        AGENT_B_SYSTEM_PROMPT,
        tools,
        taskText,
        (name, args) => todo.callTool(name, args),
        note,
      );
    } else {
      // Deterministic fallback when Agent B has no LLM credentials.
      if (isListIntent(taskText)) {
        note('todo0 · listing todos…');
        const result = await todo.callTool('get-todos');
        text = `Listed todos for the requesting user.\n${renderToolResult(result)}`;
      } else {
        const title = extractTitle(taskText);
        note('todo0 · creating todo…');
        const created = await todo.callTool('create-todo', { title });
        text = `Created a todo titled "${title}" on behalf of the user.\n${renderToolResult(created)}`;
      }
    }

    return { text, tokenChain };
  } finally {
    await todo.close();
  }
}

/** Flatten an MCP tool result's content into a short text string. */
function renderToolResult(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part)))
      .join('\n');
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}
