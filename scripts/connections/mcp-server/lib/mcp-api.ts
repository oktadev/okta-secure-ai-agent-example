// mcp-api.ts - Okta MCP Server Registration REST client
//
// Wraps POST/GET/PATCH/DELETE on /resource-servers/api/v1/mcp-servers/* plus
// lifecycle activate/deactivate and the authorization-servers sub-resource.
//
// Auth: Okta SSWS API token (same convention as bootstrap-okta-tenant.ts and
// scripts/lib/agent-identity-api.ts). A SUPER_ADMIN-scoped SSWS token works on
// the /resource-servers/api/v1/mcp-servers/* endpoints.

import axios, { AxiosError, AxiosInstance } from 'axios';

// ============================================================================
// Types (modeled on the Redocly preview spec)
// ============================================================================

export type McpServerStatus = 'PENDING' | 'INACTIVE' | 'ACTIVE' | 'INVALID';

export interface McpServer {
  id: string;
  orn?: string;
  resourceUrl: string;
  status: McpServerStatus;
  created?: string;
  lastUpdated?: string;
  authorizationServerCount?: number;
  metadata?: {
    displayName?: string;
    description?: string;
  };
  detectedMetadata?: {
    resourceName?: string;
    scopesSupported?: string[];
    lastRefreshedAt?: string;
  };
  _links?: Record<string, unknown>;
}

export interface McpServerRegistration {
  resourceUrl: string;
  displayName?: string;
  description?: string;
}

export interface McpServerUpdate {
  displayName?: string;
  description?: string;
}

export interface McpAuthorizationServer {
  id: string;
  issuer: string;
  status: McpServerStatus;
  orn?: string;
  lastUpdated?: string;
  detectedMetadata?: Record<string, unknown>;
}

export interface OktaListResponse<T> {
  data: T[];
  _links?: Record<string, unknown>;
}

export interface OktaMcpClientConfig {
  /** Okta org base URL, e.g. https://dev-123.okta.com (no trailing slash). */
  orgUrl: string;
  /** Okta SSWS API token (SUPER_ADMIN). Same convention as OKTA_API_TOKEN. */
  apiToken: string;
}

// ============================================================================
// Client
// ============================================================================

export class OktaMcpClient {
  private readonly http: AxiosInstance;

  constructor(config: OktaMcpClientConfig) {
    const baseURL = config.orgUrl.replace(/\/$/, '');
    this.http = axios.create({
      baseURL,
      headers: {
        Authorization: `SSWS ${config.apiToken}`,
        Accept: 'application/json',
      },
      timeout: 20_000,
    });
  }

  // --- list ------------------------------------------------------------------

  async list(params?: { after?: string; limit?: number; search?: string }): Promise<OktaListResponse<McpServer>> {
    const res = await this.http.get<OktaListResponse<McpServer>>('/resource-servers/api/v1/mcp-servers', {
      params,
    }).catch(rethrow);
    return res.data;
  }

  // --- register --------------------------------------------------------------

  async register(payload: McpServerRegistration): Promise<McpServer> {
    const res = await this.http.post<unknown>('/resource-servers/api/v1/mcp-servers', payload)
      .catch(rethrow);
    // Okta's POST response shape for this endpoint has been inconsistent in
    // the Secure AI Agents preview (seen: empty body with 400 even though the
    // record was created, and empty body with 202 Location header). Normalize:
    // look for a top-level `id`, common envelopes, the Location header, or
    // fall back to LIST + match on resourceUrl.
    const body = res.data as any;
    const direct = extractMcpServer(body);
    if (direct) return direct;

    const locationId = extractIdFromLocation(res.headers?.location);
    if (locationId) return this.get(locationId);

    const list = await this.list({ limit: 50 });
    const match = list.data.find((m) => m.resourceUrl === payload.resourceUrl);
    if (match) return match;

    throw new Error(
      `Register succeeded but response shape was unrecognized and no list entry matched resourceUrl=${payload.resourceUrl}. Raw body: ${JSON.stringify(body)}`
    );
  }

  async listRaw(): Promise<unknown> {
    const res = await this.http.get('/resource-servers/api/v1/mcp-servers').catch(rethrow);
    return res.data;
  }

  // --- get -------------------------------------------------------------------

  async get(mcpServerId: string): Promise<McpServer> {
    const res = await this.http.get<McpServer>(`/resource-servers/api/v1/mcp-servers/${mcpServerId}`)
      .catch(rethrow);
    return res.data;
  }

  // --- update (PATCH, merge-patch+json) --------------------------------------

  async update(mcpServerId: string, patch: McpServerUpdate): Promise<McpServer> {
    const res = await this.http.patch<McpServer>(
      `/resource-servers/api/v1/mcp-servers/${mcpServerId}`,
      patch,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    ).catch(rethrow);
    return res.data;
  }

  // --- delete ----------------------------------------------------------------

  async delete(mcpServerId: string): Promise<void> {
    await this.http.delete(`/resource-servers/api/v1/mcp-servers/${mcpServerId}`).catch(rethrow);
  }

  // --- authorization servers -------------------------------------------------

  async listAuthorizationServers(mcpServerId: string): Promise<OktaListResponse<McpAuthorizationServer>> {
    const res = await this.http.get<OktaListResponse<McpAuthorizationServer>>(
      `/resource-servers/api/v1/mcp-servers/${mcpServerId}/authorization-servers`
    ).catch(rethrow);
    return res.data;
  }

  // --- lifecycle -------------------------------------------------------------

  async activate(mcpServerId: string): Promise<McpServer | void> {
    const res = await this.http.post(
      `/resource-servers/api/v1/mcp-servers/${mcpServerId}/lifecycle/activate`
    ).catch(rethrow);
    return res.data as McpServer | undefined;
  }

  async deactivate(mcpServerId: string): Promise<McpServer | void> {
    const res = await this.http.post(
      `/resource-servers/api/v1/mcp-servers/${mcpServerId}/lifecycle/deactivate`
    ).catch(rethrow);
    return res.data as McpServer | undefined;
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Poll GET until the MCP server leaves PENDING status.
   * Okta has to fetch `/.well-known/oauth-protected-resource` and each
   * discovered AS's metadata, so expect this to take a few seconds.
   */
  async waitForOutOfPending(mcpServerId: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<McpServer> {
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const intervalMs = opts?.intervalMs ?? 2_000;
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const server = await this.get(mcpServerId);
      if (server.status !== 'PENDING') return server;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for MCP server ${mcpServerId} to leave PENDING (still PENDING after ${timeoutMs}ms)`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

// ============================================================================
// Error formatting
// ============================================================================

function extractMcpServer(body: any): McpServer | null {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.id === 'string') return body as McpServer;
  // Common envelope shapes
  for (const key of ['data', 'mcpServer', 'resource', 'result']) {
    const inner = body[key];
    if (inner && typeof inner === 'object' && typeof inner.id === 'string') {
      return inner as McpServer;
    }
  }
  return null;
}

function extractIdFromLocation(location?: string): string | null {
  if (!location) return null;
  const m = location.match(/\/mcp-servers\/([A-Za-z0-9]+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

function rethrow(err: unknown): never {
  const ax = err as AxiosError<{ errorSummary?: string; errorCode?: string; errorCauses?: Array<{ errorSummary: string }> }>;
  if (ax.response) {
    const status = ax.response.status;
    const body = ax.response.data;
    const summary = body?.errorSummary || ax.message;
    const causes = body?.errorCauses?.map((c) => c.errorSummary).join('; ');
    const msg = causes ? `${summary} (${causes})` : summary;
    const e = new Error(`Okta MCP API ${status}: ${msg}`);
    (e as any).status = status;
    (e as any).body = body;
    throw e;
  }
  throw err;
}
