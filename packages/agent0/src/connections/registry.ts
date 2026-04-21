// registry.ts — Aggregates ConnectionStatus across all five managed-connection
// types for the /api/connections/status endpoint.
//
// Some connection handlers in this repo are classes that implement the full
// ConnectionHandler contract (ServiceAccountHandler, McpServerHandler) while
// others (authorization-server, application, secret) predate the contract and
// expose their runtime via bespoke classes held inside the Agent. Rather than
// refactor those three end-to-end, this registry derives their ConnectionStatus
// from env presence plus per-user state available on the current Agent.

import type { Agent } from '../agent.js';
import { ConnectionStatus } from './types.js';
import { isOPAConfigured, getOPALLMProvider } from './secret/handler.js';
import { ServiceAccountHandler } from './service-account/handler.js';
import { McpServerHandler, loadMcpServerConfig } from './mcp-server/handler.js';
import { getLLMConfigSource } from '../agent.js';

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

// ============================================================================
// Per-kind status builders
// ============================================================================

function buildAuthorizationServerStatus(agent: Agent | null): ConnectionStatus {
  const configured = isAuthorizationServerConfigured();
  // "connected" on this slot = agent has established a live MCP session
  // (which implies the ID-JAG → MCP-access-token exchange succeeded).
  const connected = !!(configured && agent?.isAgentConnected());
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
  const connected = !!(configured && stsHandler && stsHandler.getCachedToken() !== null);
  return {
    kind: 'application',
    configured,
    connected,
    details: configured
      ? { resource: process.env.OAUTH_STS_RESOURCE }
      : undefined,
  };
}

function buildSecretStatus(agent: Agent | null): ConnectionStatus {
  const configured = isOPAConfigured();
  // "connected" = the current agent is running with credentials fetched
  // from OPA this session (not from .env.agent fallback).
  const connected = !!(configured && agent && getLLMConfigSource() === 'opa');
  return {
    kind: 'secret',
    configured,
    connected,
    details: configured
      ? {
          provider: getOPALLMProvider(),
          source: connected ? 'opa' : getLLMConfigSource(),
        }
      : undefined,
  };
}

function buildServiceAccountStatus(): ConnectionStatus {
  return new ServiceAccountHandler().getStatus();
}

function buildMcpServerStatus(agent: Agent | null): ConnectionStatus {
  const base = new McpServerHandler().getStatus();
  // Override "connected" with live MCP session health when an agent exists.
  const cfg = loadMcpServerConfig();
  if (!cfg) return base;
  return {
    ...base,
    connected: !!agent?.isAgentConnected(),
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Returns ConnectionStatus for all five managed-connection slots in the
 * order they appear in the Okta "Add connection" admin UI.
 */
export function buildConnectionStatuses(agent: Agent | null): ConnectionStatus[] {
  return [
    buildAuthorizationServerStatus(agent),
    buildApplicationStatus(agent),
    buildSecretStatus(agent),
    buildServiceAccountStatus(),
    buildMcpServerStatus(agent),
  ];
}
