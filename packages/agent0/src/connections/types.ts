// types.ts - Shared types for Okta AI Agent managed connections
//
// This sample covers three of the five managed-connection types exposed by
// the Okta "Add connection" admin UI for AI agents:
//   - Authorization server
//   - Application
//   - MCP server
//
// Secret and Service account connections are out of scope for this sample.
//
// Handlers may be partially adopted — some still export their own classes
// (TokenExchangeHandler, OAuthStsHandler, ...) and are wired directly from
// agent.ts. New handlers should implement the ConnectionHandler interface
// and register through connections/registry.ts.

// ============================================================================
// Connection Kinds — subset of the Okta "Add connection" admin UI
// ============================================================================

export type ConnectionKind =
  | 'authorization_server' // Custom Okta AS → ID-JAG → MCP access token
  | 'application'          // OIN / custom resource server → OAuth STS (brokered consent)
  | 'mcp_server';          // Okta-registered MCP server (agent-side discovery)

// ============================================================================
// Connection Status (surfaced on the Connections panel in the UI)
// ============================================================================

export interface ConnectionStatus {
  kind: ConnectionKind;
  configured: boolean;   // required env vars are set
  connected: boolean;    // handler currently holds a usable token / credential
  disabled?: boolean;    // opted out via DISABLED_CONNECTIONS env var
  details?: Record<string, unknown>;
}

// ============================================================================
// LLM Tool Descriptor — what a connection contributes to the agent
// ============================================================================

export interface ToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ============================================================================
// Tool Execution Results (Discriminated Union)
// ============================================================================

export type ToolExecutionResult =
  | { status: 'ok'; content: unknown }
  | { status: 'interaction_required'; interaction_uri: string; message?: string }
  | { status: 'scope_challenge'; required_scopes: string[] }
  | { status: 'error'; error: string };

// ============================================================================
// Connection Handler Contract
// ============================================================================

export interface ConnectionHandler {
  readonly kind: ConnectionKind;

  /** True if the required env vars for this connection are set. */
  isConfigured(): boolean;

  /** Called once at agent startup when configured. */
  init?(): Promise<void>;

  /** LLM tools contributed by this connection. Empty array if none. */
  getTools(): ToolDescriptor[];

  /** Execute a tool owned by this connection. */
  executeTool(
    name: string,
    args: unknown,
    ctx: { idToken: string; userId: string }
  ): Promise<ToolExecutionResult>;

  /** Status for the UI Connections panel. */
  getStatus(): ConnectionStatus;
}
