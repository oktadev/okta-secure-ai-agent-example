// types.ts - Shared types for Okta AI Agent managed connections
//
// Each managed-connection type in the Okta admin UI (Authorization server,
// Application, Secret, Service account, MCP server) has a corresponding
// handler module under packages/agent0/src/connections/<kind>/.
//
// This file defines the shared contract. Handlers may be partially
// adopted — during the incremental migration, some handlers still export
// their own classes (TokenExchangeHandler, OAuthStsHandler, ...) and are
// wired directly from agent.ts. New handlers should implement the
// ConnectionHandler interface and register through connections/registry.ts.

// ============================================================================
// Connection Kinds — 1:1 with the Okta "Add connection" admin UI
// ============================================================================

export type ConnectionKind =
  | 'authorization_server' // Custom Okta AS → ID-JAG → MCP access token
  | 'application'          // OIN / custom resource server → OAuth STS (brokered consent)
  | 'secret'               // Static credential vaulted in Okta Privileged Access
  | 'service_account'      // OPA-vaulted username/password for a UD app
  | 'mcp_server';          // Okta-registered MCP server (agent-side discovery)

// ============================================================================
// Connection Status (surfaced on the Connections panel in the UI)
// ============================================================================

export interface ConnectionStatus {
  kind: ConnectionKind;
  configured: boolean;   // required env vars are set
  connected: boolean;    // handler currently holds a usable token / credential
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
