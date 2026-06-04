// ============================================================================
// AGENT B — todo0 MCP CLIENT
// ============================================================================
// A thin MCP client that connects to todo0 with a freshly-minted, user-scoped
// access token (from the second-hop exchange) and invokes todo tools.
// One short-lived client per request keeps the demo simple and stateless.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentBConfig } from './config';

export class TodoClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport | null = null;

  constructor(private readonly config: AgentBConfig) {
    this.client = new Client({ name: 'agentb-todo-client', version: '1.0.0' }, { capabilities: {} });
  }

  async connect(accessToken: string): Promise<void> {
    this.transport = new StreamableHTTPClientTransport(new URL(this.config.mcpServerUrl), {
      requestInit: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    });
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: any }>> {
    const resp = await this.client.listTools();
    return resp.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      /* best-effort */
    }
  }
}
