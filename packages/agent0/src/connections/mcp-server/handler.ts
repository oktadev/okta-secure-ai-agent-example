// handler.ts — MCP Server managed connection
//
// Fifth of the five managed-connection types from Okta's "Add connection"
// admin UI. Unlike the other four, this connection represents the *MCP
// resource server itself* (here: todo0) registered with Okta so Okta knows
// about its protected-resource metadata and can enforce policy on it.
//
// The actual MCP protocol connection (tool listing, tool calls, streamable
// HTTP) is established in `agent.ts` via the MCP SDK Client. This handler's
// job is informational: surface "is the MCP configured / registered / ACTIVE
// at Okta?" to the UI and the agent runtime.
//
// Registration is performed out-of-band by `scripts/connections/mcp-server/
// register.ts` (run via `pnpm register:mcp`). Okta auto-discovers the MCP's
// Authorization Server metadata from `<resourceUrl>/.well-known/oauth-
// protected-resource` → `<issuer>/.well-known/oauth-authorization-server`.
// Status lifecycle: PENDING → INACTIVE (or INVALID) → ACTIVE.

import {
  ConnectionHandler,
  ConnectionStatus,
  ToolDescriptor,
  ToolExecutionResult,
} from '../types.js';

// ============================================================================
// Env / Configuration
// ============================================================================

export interface McpServerConfig {
  /** URL the MCP client connects to (e.g. http://localhost:5002/mcp). */
  mcpServerUrl: string;
  /** Resource Indicator the MCP advertises (usually same as mcpServerUrl). */
  resourceIndicator?: string;
  /**
   * Okta MCP server ID, if the MCP has been registered via
   * `pnpm register:mcp`. Read from `.mcp-register-state.json` by the
   * script; exposed to the agent via env for runtime status reporting.
   */
  oktaMcpServerId?: string;
}

/** True when the agent has an MCP server URL configured. */
export function isMcpServerConfigured(): boolean {
  return !!process.env.MCP_SERVER_URL;
}

export function loadMcpServerConfig(): McpServerConfig | null {
  if (!isMcpServerConfigured()) return null;
  return {
    mcpServerUrl: process.env.MCP_SERVER_URL!,
    resourceIndicator: process.env.MCP_RESOURCE_INDICATOR || process.env.MCP_SERVER_URL,
    oktaMcpServerId: process.env.OKTA_MCP_SERVER_ID,
  };
}

// ============================================================================
// Handler
// ============================================================================

export class McpServerHandler implements ConnectionHandler {
  readonly kind = 'mcp_server' as const;

  private config: McpServerConfig | null;

  constructor(config?: McpServerConfig | null) {
    this.config = config ?? loadMcpServerConfig();
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * MCP tools are discovered dynamically by the MCP SDK Client in agent.ts
   * (`client.listTools()`). This handler doesn't contribute static tools to
   * the LLM — it just represents the connection metadata.
   */
  getTools(): ToolDescriptor[] {
    return [];
  }

  async executeTool(): Promise<ToolExecutionResult> {
    return {
      status: 'error',
      error:
        'MCP tools are executed through the MCP protocol client in agent.ts, ' +
        'not through this handler.',
    };
  }

  getStatus(): ConnectionStatus {
    if (!this.config) {
      return {
        kind: this.kind,
        configured: false,
        connected: false,
      };
    }
    return {
      kind: this.kind,
      configured: true,
      // "connected" here means the MCP URL is wired; live MCP session
      // health is tracked inside Agent.connect() separately.
      connected: true,
      details: {
        mcpServerUrl: this.config.mcpServerUrl,
        resourceIndicator: this.config.resourceIndicator,
        registeredAtOkta: !!this.config.oktaMcpServerId,
        oktaMcpServerId: this.config.oktaMcpServerId,
      },
    };
  }
}
