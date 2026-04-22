// auth-strategy.ts — Uniform MCP auth strategy interface.
//
// Wraps the two existing credential handlers so Agent.connect() can iterate
// over multiple MCPs without caring which auth flavor each one uses:
//   - ID-JAG (authorization_server managed connection, same-org Okta custom AS)
//   - OAuth STS (mcp_server managed connection, external AS like GitHub)
//
// The handlers themselves (TokenExchangeHandler, OAuthStsHandler) are NOT
// rewritten — these are thin adapters that normalize their results into an
// AuthTokenResult discriminated union.
import { TokenExchangeHandler, TokenExchangeConfig } from './authorization-server/handler.js';
import { OAuthStsHandler, OAuthStsConfig } from './application/handler.js';

// ============================================================================
// Result shape (discriminated union)
// ============================================================================

export type AuthTokenResult =
  | { status: 'success'; accessToken: string; expiresIn: number; scope?: string }
  | { status: 'interaction_required'; interactionUri: string; resource: string; message?: string }
  | { status: 'error'; error: string; errorDescription?: string };

// ============================================================================
// Strategy interface
// ============================================================================

export type AuthStrategyKind = 'id-jag' | 'oauth-sts';

export interface AuthStrategy {
  readonly kind: AuthStrategyKind;
  /**
   * Human-oriented resource identifier — OAuth STS Resource Indicator URI for
   * oauth-sts, or the AS issuer URL for id-jag. Surfaced in pending-consent
   * responses and status logs.
   */
  readonly resource: string;

  /**
   * Acquire an access token for the MCP transport. `requestedScopes` is only
   * meaningful for id-jag (scope step-up); oauth-sts ignores it.
   */
  getAccessToken(idToken: string, requestedScopes?: string): Promise<AuthTokenResult>;

  /** Drop any cached token — use when the resource returns 401/403. */
  clearCache(): void;
}

// ============================================================================
// ID-JAG adapter
// ============================================================================

export class IdJagAuthStrategy implements AuthStrategy {
  readonly kind = 'id-jag' as const;
  readonly resource: string;
  private handler: TokenExchangeHandler;

  constructor(config: TokenExchangeConfig) {
    this.handler = new TokenExchangeHandler(config);
    this.resource = config.authorizationServer;
  }

  async getAccessToken(idToken: string, requestedScopes?: string): Promise<AuthTokenResult> {
    try {
      const result = await this.handler.exchangeToken(idToken, requestedScopes);
      if (result.success && result.access_token) {
        return {
          status: 'success',
          accessToken: result.access_token,
          expiresIn: result.expires_in ?? 3600,
          scope: result.scope,
        };
      }
      return {
        status: 'error',
        error: 'token_exchange_failed',
        errorDescription: result.note || 'ID-JAG exchange did not return an access token',
      };
    } catch (err: any) {
      return {
        status: 'error',
        error: 'token_exchange_error',
        errorDescription: err?.message || String(err),
      };
    }
  }

  /** TokenExchangeHandler does not cache today; method kept for interface parity. */
  clearCache(): void { /* no-op */ }

  /** Escape hatch for reconnect flow that still uses TokenExchangeHandler directly. */
  getUnderlyingHandler(): TokenExchangeHandler {
    return this.handler;
  }
}

// ============================================================================
// OAuth STS adapter
// ============================================================================

export class OAuthStsAuthStrategy implements AuthStrategy {
  readonly kind = 'oauth-sts' as const;
  readonly resource: string;
  private handler: OAuthStsHandler;

  constructor(config: OAuthStsConfig) {
    this.handler = new OAuthStsHandler(config);
    this.resource = config.resource;
  }

  async getAccessToken(idToken: string): Promise<AuthTokenResult> {
    const result = await this.handler.exchangeForISVToken(idToken);
    if (result.status === 'success') {
      return {
        status: 'success',
        accessToken: result.access_token,
        expiresIn: result.expires_in,
        scope: result.scope,
      };
    }
    if (result.status === 'interaction_required') {
      return {
        status: 'interaction_required',
        interactionUri: result.interaction_uri,
        resource: this.resource,
        message: result.error_description,
      };
    }
    return {
      status: 'error',
      error: result.error,
      errorDescription: result.error_description,
    };
  }

  clearCache(): void {
    this.handler.clearCachedToken();
  }

  /** Exposed so /api/oauth-sts/status and tool-execution paths can reuse the cache. */
  getUnderlyingHandler(): OAuthStsHandler {
    return this.handler;
  }
}

// ============================================================================
// MCP connection config (auth strategy + server URL)
// ============================================================================

export type McpAuthStrategyConfig =
  | { kind: 'id-jag'; config: TokenExchangeConfig }
  | { kind: 'oauth-sts'; config: OAuthStsConfig };

export interface McpConnectionConfig {
  /** Stable id used in logs, tool-dispatch map, and ConnectionStatus details. */
  id: string;
  /** MCP transport URL (passed to StreamableHTTPClientTransport). */
  serverUrl: string;
  /** Human-readable label for UI / ConnectionStatus.details. */
  displayName?: string;
  /** Okta Resource Indicator, if one is advertised (used by oauth-sts flow). */
  resourceIndicator?: string;
  /** Okta's MCP server id (from `.mcp-register-state*.json`), if known. */
  oktaMcpServerId?: string;
  /** Auth strategy bundle (constructor materialises this into an AuthStrategy). */
  auth: McpAuthStrategyConfig;
}

/** Factory — turns a config bundle into a live AuthStrategy instance. */
export function buildAuthStrategy(cfg: McpAuthStrategyConfig): AuthStrategy {
  if (cfg.kind === 'id-jag') return new IdJagAuthStrategy(cfg.config);
  return new OAuthStsAuthStrategy(cfg.config);
}

// ============================================================================
// Env-driven loader (consumed by agent.ts at construction time)
// ============================================================================

import { isConnectionDisabled } from './config.js';

/**
 * Read env and assemble the list of MCPs this agent should connect to.
 *
 * Two potential entries today:
 *   1. Primary MCP (Todo0-style, ID-JAG auth) — enabled when MCP_SERVER_URL +
 *      MCP_AUTHORIZATION_SERVER_* + AI_AGENT_* are all set and the
 *      `authorization_server` kind isn't disabled.
 *   2. GitHub MCP (OAuth STS auth) — enabled when GITHUB_MCP_SERVER_URL +
 *      OAUTH_STS_RESOURCE_GITHUB_MCP + AI_AGENT_* are all set and the
 *      `mcp_server` kind isn't disabled.
 *
 * The loader returns whichever subset is actually configured; Agent.connect()
 * tolerates an empty list (logs a warning) and any mix of the two.
 */
export function loadMcpConnectionConfigs(): McpConnectionConfig[] {
  const out: McpConnectionConfig[] = [];

  // --- Shared agent identity (required by both strategies) ------------------
  const oktaDomain = process.env.OKTA_DOMAIN;
  const agentId = process.env.AI_AGENT_ID;
  const privateKeyFile = process.env.AI_AGENT_PRIVATE_KEY_FILE;
  const privateKeyKid = process.env.AI_AGENT_PRIVATE_KEY_KID;
  const hasAgentIdentity = !!(oktaDomain && agentId && privateKeyFile && privateKeyKid);

  // --- Entry 1: Primary MCP via ID-JAG --------------------------------------
  if (!isConnectionDisabled('authorization_server')) {
    const mcpServerUrl = process.env.MCP_SERVER_URL;
    const authServer = process.env.MCP_AUTHORIZATION_SERVER;
    const tokenEndpoint = process.env.MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT;
    const scopes = process.env.AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST;

    if (mcpServerUrl && authServer && tokenEndpoint && scopes && hasAgentIdentity) {
      out.push({
        id: 'primary',
        serverUrl: mcpServerUrl,
        displayName: 'Primary MCP (ID-JAG)',
        resourceIndicator: process.env.MCP_RESOURCE_INDICATOR || mcpServerUrl,
        oktaMcpServerId: process.env.OKTA_MCP_SERVER_ID,
        auth: {
          kind: 'id-jag',
          config: {
            authorizationServer: authServer,
            authorizationServerTokenEndpoint: tokenEndpoint,
            oktaDomain: oktaDomain!,
            clientId: agentId!,
            privateKeyFile: privateKeyFile!,
            privateKeyKid: privateKeyKid!,
            agentScopes: scopes,
          },
        },
      });
    }
  }

  // --- Entry 2: GitHub MCP via OAuth STS ------------------------------------
  if (!isConnectionDisabled('mcp_server')) {
    const githubMcpUrl = process.env.GITHUB_MCP_SERVER_URL;
    const githubMcpResource = process.env.OAUTH_STS_RESOURCE_GITHUB_MCP;

    if (githubMcpUrl && githubMcpResource && hasAgentIdentity) {
      out.push({
        id: 'github',
        serverUrl: githubMcpUrl,
        displayName: 'GitHub MCP (OAuth STS)',
        resourceIndicator: githubMcpResource,
        oktaMcpServerId: process.env.OKTA_GITHUB_MCP_SERVER_ID,
        auth: {
          kind: 'oauth-sts',
          config: {
            oktaDomain: oktaDomain!,
            clientId: agentId!,
            privateKeyFile: privateKeyFile!,
            privateKeyKid: privateKeyKid!,
            resource: githubMcpResource,
          },
        },
      });
    }
  }

  return out;
}
