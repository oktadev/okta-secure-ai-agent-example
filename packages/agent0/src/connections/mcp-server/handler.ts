// handler.ts — MCP Server managed connection
//
// Third of the three managed-connection types this sample covers (alongside
// Authorization Server and Application). Unlike the other two, this
// connection represents the *MCP resource server itself* (here: todo0)
// registered with Okta so Okta knows about its protected-resource metadata
// and can enforce policy on it.
//
// The actual MCP protocol connection (tool listing, tool calls, streamable
// HTTP) is established in `agent.ts` via the MCP SDK Client. This handler's
// job is informational: surface "is the MCP configured / registered / ACTIVE
// at Okta?" to the UI and the agent runtime.
//
// Registration is performed out-of-band via the Okta Admin Console
// (Directory → AI Agents → Managed connections → MCP Server). After
// registering, Okta auto-discovers the MCP's Authorization Server metadata
// from `<resourceUrl>/.well-known/oauth-protected-resource` →
// `<issuer>/.well-known/oauth-authorization-server`. Status lifecycle:
// PENDING → INACTIVE (or INVALID) → ACTIVE. Copy the generated
// `mcpServerId` into OKTA_MCP_SERVER_ID (or OKTA_GITHUB_MCP_SERVER_ID) so
// this handler can report "registered at Okta".

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
   * Okta MCP server ID, if the MCP has been registered at Okta via the
   * Admin Console. Copy from Directory → AI Agents → Managed connections →
   * MCP Server and set in env so this handler can report "registered at
   * Okta" in /api/connections/status.
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
