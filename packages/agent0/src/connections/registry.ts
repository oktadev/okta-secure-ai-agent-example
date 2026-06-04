// registry.ts — Aggregates ConnectionStatus across the managed-connection
// types shipped with this sample for the /api/connections/status endpoint.
//
// The GA sample covers three of the five Okta managed-connection types:
//   - authorization_server (ID-JAG → MCP access token)
//   - application          (OAuth STS brokered consent)
//   - mcp_server           (Okta-registered MCP server)
//
// Secret and service_account connections are intentionally out of scope for
// this sample and are not wired here.

import type { Agent } from '../agent.js';
import { ConnectionStatus } from './types.js';
import { isConnectionDisabled } from './config.js';
import { McpServerHandler, loadMcpServerConfig } from './mcp-server/handler.js';

// ============================================================================
// Env helpers
// ============================================================================

/**
 * Authorization Server connection is configured when the full set of env
 * vars needed to build a TokenExchangeConfig is present. This mirrors
 * `buildTokenExchangeConfig()` in agent.ts.
 */
function isAuthorizationServerConfigured(): boolean {
  return !!(
    process.env.MCP_AUTHORIZATION_SERVER &&
    process.env.MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT &&
    process.env.OKTA_DOMAIN &&
    process.env.AI_AGENT_ID &&
    process.env.AI_AGENT_PRIVATE_KEY_FILE &&
    process.env.AI_AGENT_PRIVATE_KEY_KID &&
    process.env.AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST
  );
}

/**
 * OAuth STS (Application) connection is configured when the Resource
 * Indicator of the managed connection is exported.
 */
function isApplicationConfigured(): boolean {
  return !!process.env.OAUTH_STS_RESOURCE;
}

/**
 * A2A server connection is configured when the A2A transport + authorization
 * server env vars are present (alongside the shared agent identity).
 */
function isA2aServerConfigured(): boolean {
  return !!(
    process.env.A2A_SERVER_URL &&
    process.env.A2A_RESOURCE_INDICATOR &&
    process.env.A2A_AUTHORIZATION_SERVER &&
    process.env.A2A_AUTHORIZATION_SERVER_TOKEN_ENDPOINT &&
    process.env.OKTA_DOMAIN &&
    process.env.AI_AGENT_ID &&
    process.env.AI_AGENT_PRIVATE_KEY_FILE &&
    process.env.AI_AGENT_PRIVATE_KEY_KID
  );
}

// ============================================================================
// Per-kind status builders
// ============================================================================

function buildAuthorizationServerStatus(agent: Agent | null): ConnectionStatus {
  const configured = isAuthorizationServerConfigured();
  // "connected" on this slot = at least one id-jag-authed MCP session is live
  // (which implies the ID-JAG → MCP-access-token exchange succeeded).
  const perMcp = agent?.getMcpConnectionStatuses() ?? [];
  const connected = !!(configured && perMcp.some(m => m.strategy === 'id-jag' && m.connected));
  return {
    kind: 'authorization_server',
    configured,
    connected,
    details: configured
      ? {
          authorizationServer: process.env.MCP_AUTHORIZATION_SERVER,
          tokenEndpoint: process.env.MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT,
          agentId: process.env.AI_AGENT_ID,
        }
      : undefined,
  };
}

function buildApplicationStatus(agent: Agent | null): ConnectionStatus {
  const configured = isApplicationConfigured();
  const stsHandler = agent?.getOAuthStsHandler() ?? null;
  // "Connected" = the user has successfully authorized this resource at
  // least once this process lifetime. The access-token cache expires on its
  // own TTL (getCachedToken()); the Application card intentionally reflects
  // the durable authorization state so it doesn't flicker between exchanges.
  const connected = !!(configured && stsHandler && stsHandler.isAuthorized());
  return {
    kind: 'application',
    configured,
    connected,
    details: configured
      ? { resource: process.env.OAUTH_STS_RESOURCE }
      : undefined,
  };
}

function buildMcpServerStatus(agent: Agent | null): ConnectionStatus {
  const base = new McpServerHandler().getStatus();
  const cfg = loadMcpServerConfig();
  if (!cfg) return base;

  // Multi-MCP aware: emit a per-MCP `servers` array so the UI can render
  // one row per registered MCP (Todo0 / GitHub / future). Top-level
  // `connected` is true only when every configured MCP is live — the UI
  // can still introspect `details.servers` to show partial state.
  const perMcp = agent?.getMcpConnectionStatuses() ?? [];
  const allConnected = perMcp.length > 0 && perMcp.every(m => m.connected);

  return {
    ...base,
    connected: allConnected,
    details: {
      ...(base.details || {}),
      servers: perMcp,
    },
  };
}

function buildA2aServerStatus(agent: Agent | null): ConnectionStatus {
  const configured = isA2aServerConfigured();
  const handler = agent?.getA2AServerHandler() ?? null;
  // "Connected" = agent0 has successfully obtained a token for Agent B and
  // completed at least one A2A call this process lifetime.
  const connected = !!(configured && handler && handler.isAuthorized());
  return {
    kind: 'a2a_server',
    configured,
    connected,
    details: configured
      ? {
          agentServerUrl: process.env.A2A_SERVER_URL,
          resourceIndicator: process.env.A2A_RESOURCE_INDICATOR,
          authorizationServer: process.env.A2A_AUTHORIZATION_SERVER,
          registeredAtOkta: !!process.env.OKTA_A2A_SERVER_ID,
          oktaAgentServerId: process.env.OKTA_A2A_SERVER_ID,
        }
      : undefined,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Mark a status as disabled when its kind is opted out via
 * DISABLED_CONNECTIONS. `configured` is preserved (env vars may still be set;
 * the user has deliberately turned the slot off), but `connected` is forced
 * to false — disabled kinds never hold live state.
 */
function applyDisabledFlag(status: ConnectionStatus): ConnectionStatus {
  if (!isConnectionDisabled(status.kind)) return status;
  return { ...status, disabled: true, connected: false };
}

/**
 * Returns ConnectionStatus for the managed-connection slots this sample
 * supports, in the order they appear in the Okta "Add connection" admin UI.
 */
export function buildConnectionStatuses(agent: Agent | null): ConnectionStatus[] {
  return [
    buildAuthorizationServerStatus(agent),
    buildApplicationStatus(agent),
    buildMcpServerStatus(agent),
    buildA2aServerStatus(agent),
  ].map(applyDisabledFlag);
}
