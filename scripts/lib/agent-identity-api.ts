/**
 * Okta Agent Identity API Client
 *
 * This file contains the implementation for the Okta Agent Identity API.
 * These APIs are part of the Workload Principals feature and are not yet
 * available in the public @okta/okta-sdk-nodejs package.
 */

import axios from 'axios';
import * as jose from 'jose';

// ============================================================================
// INTERFACES & TYPES
// ============================================================================

export interface AgentIdentity {
  id: string;
  name: string;
  description?: string;
  clientId: string;
  status: 'ACTIVE' | 'INACTIVE' | 'STAGED';
  created: string;
  lastUpdated: string;
}

export interface RegisterAgentRequest {
  profile: {
    name: string;
    description: string;
  };
  /**
   * Link to an existing OIDC app (first-hop "linked app" model). Used by agent0.
   */
  appId?: string;
  /**
   * Resource URL (audience URI) for the agent's A2A server. When provided, Okta
   * auto-creates a read-only a2a-server projection sharing the agent's primary key,
   * making the agent a valid downstream target for agent-to-agent identity chaining.
   */
  resourceUrl?: string;
}

export interface AgentOperationResult {
  id: string;
  status: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS';
  type: string;
  resource: {
    id: string;
    status: string;
    type: string;
    _links: {
      self: {
        href: string;
      };
    };
  };
  created: string;
  started?: string;
  completed?: string;
}

export interface CreateConnectionRequest {
  connectionType: string;
  authorizationServer: {
    orn: string;
  };
  resourceIndicator: string;
  scopeCondition: string;
  scopes: string[];
}

export interface CreateVaultSecretConnectionRequest {
  connectionType: 'STS_VAULT_SECRET';
  resourceIndicator: string;
  secret: {
    orn: string;
  };
}

/**
 * Managed connection targeting an A2A server (agent-to-agent identity chaining).
 * The output token type is an ID-JAG; the resource is the target agent's a2a-server.
 */
export interface CreateA2aConnectionRequest {
  connectionType: 'IDENTITY_ASSERTION_A2A_SERVER';
  a2aServer: {
    orn: string;
  };
  authorizationServer: {
    orn: string;
  };
  scopeCondition: string;
  scopes: string[];
}

/**
 * Delegation link — inbound policy declaring whose tokens an agent will accept as
 * a subject_token. Generalizes/replaces the legacy single `appId` linked-app model.
 */
export interface CreateDelegationLinkRequest {
  from: {
    type: 'OKTA_AUTHORIZATION_SERVER';
    clientOrn: string;
    tokenType: 'ACCESS_TOKEN' | 'ID_TOKEN';
  };
  to: {
    resourceOrn: string;
  };
}

export interface DelegationLink {
  id: string;
  from?: Record<string, unknown>;
  to?: Record<string, unknown>;
  [key: string]: any;
}

export interface AgentConnection {
  id: string;
  connectionType: string;
  authorizationServer?: {
    orn: string;
  };
  resource?: {
    orn: string;
  };
  resourceIndicator?: string;
  scopeCondition?: string;
  scopes?: string[];
  status: string;
}

export interface OrgMetadata {
  id: string;
  [key: string]: any;
}

export interface AgentIdentityConfig {
  oktaDomain: string;
  apiToken: string;
}

// ============================================================================
// AGENT IDENTITY API CLIENT
// ============================================================================

export class AgentIdentityAPIClient {
  private apiToken: string;
  private baseUrl: string;

  constructor(config: AgentIdentityConfig) {
    this.apiToken = config.apiToken;
    this.baseUrl = `https://${config.oktaDomain}`;
  }

  /**
   * Get axios config with authorization headers
   */
  private getAxiosConfig() {
    return {
      headers: {
        'Authorization': `SSWS ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
    };
  }

  /**
   * Handle axios errors and provide detailed error messages
   */
  private handleAxiosError(error: any, context: string, requestBody?: any): never {
    if (error.response) {
      // Server responded with error status
      const status = error.response.status;
      const data = error.response.data;

      console.error(`\n${context} failed with status ${status}:`);

      // Log request details if available
      if (error.config?.method) {
        console.error('Request method:', error.config.method.toUpperCase());
      }
      if (error.config?.url) {
        console.error('Request URL:', error.config.url);
      }
      if (requestBody !== undefined) {
        console.error('Request body:', JSON.stringify(requestBody, null, 2));
      }

      console.error('Response body:', JSON.stringify(data, null, 2));

      // Extract error message if available
      const errorMessage = data?.errorSummary || data?.message || error.message;
      throw new Error(`${context}: ${errorMessage} (HTTP ${status})`);
    } else if (error.request) {
      // Request made but no response received
      throw new Error(`${context}: No response received from server`);
    } else {
      // Error in request setup
      throw new Error(`${context}: ${error.message}`);
    }
  }

  // ==========================================================================
  // AGENT REGISTRATION & LIFECYCLE
  // ==========================================================================

  /**
   * Register a new agent identity (async operation)
   * Returns the operation URL to poll for completion
   */
  async registerAgent(request: RegisterAgentRequest): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents`,
        request,
        this.getAxiosConfig()
      );

      if (response.status !== 202) {
        throw new Error(`Unexpected status: ${response.status}`);
      }

      const operationUrl = response.headers['location'];
      if (!operationUrl) {
        throw new Error('No Location header in registration response');
      }

      return operationUrl;
    } catch (error: any) {
      this.handleAxiosError(error, 'Register agent', request);
    }
  }

  /**
   * Poll an async operation until it completes
   */
  async pollOperation(
    operationUrl: string,
    timeoutMs: number = 60000,
    intervalMs: number = 2000
  ): Promise<AgentOperationResult> {
    const maxAttempts = Math.ceil(timeoutMs / intervalMs);
    let attempts = 0;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      attempts++;

      const response = await axios.get(operationUrl, this.getAxiosConfig());
      const operation = response.data as AgentOperationResult;

      if (operation.status === 'COMPLETED') {
        return operation;
      } else if (operation.status === 'FAILED') {
        throw new Error(`Operation failed: ${operation.type || 'unknown operation'}`);
      }
    }

    throw new Error(`Operation timed out after ${timeoutMs}ms`);
  }

  /**
   * Get agent identity details by ID
   */
  async getAgent(agentId: string): Promise<AgentIdentity> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}`,
        this.getAxiosConfig()
      );

      return response.data as AgentIdentity;
    } catch (error: any) {
      this.handleAxiosError(error, 'Get agent');
    }
  }

  /**
   * Activate an agent identity (async operation)
   * Returns the operation URL to poll for completion
   */
  async activateAgent(agentId: string): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/lifecycle/activate`,
        {},
        this.getAxiosConfig()
      );

      if (response.status !== 202) {
        throw new Error(`Unexpected status: ${response.status}`);
      }

      const operationUrl = response.headers['location'];
      if (!operationUrl) {
        throw new Error('No Location header in activation response');
      }

      return operationUrl;
    } catch (error: any) {
      this.handleAxiosError(error, 'Activate agent');
    }
  }

  /**
   * Deactivate an agent identity (async operation)
   * Returns the operation URL to poll for completion
   */
  async deactivateAgent(agentId: string): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/lifecycle/deactivate`,
        {},
        this.getAxiosConfig()
      );

      if (response.status !== 202) {
        throw new Error(`Unexpected status: ${response.status}`);
      }

      const operationUrl = response.headers['location'];
      if (!operationUrl) {
        throw new Error('No Location header in deactivation response');
      }

      return operationUrl;
    } catch (error: any) {
      this.handleAxiosError(error, 'Deactivate agent');
    }
  }

  /**
   * Delete an agent identity (async operation)
   * Returns the operation URL to poll for completion
   */
  async deleteAgent(agentId: string): Promise<string> {
    try {
      const response = await axios.delete(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}`,
        this.getAxiosConfig()
      );

      if (response.status !== 202) {
        throw new Error(`Unexpected status: ${response.status}`);
      }

      const operationUrl = response.headers['location'];
      if (!operationUrl) {
        throw new Error('No Location header in deletion response');
      }

      return operationUrl;
    } catch (error: any) {
      this.handleAxiosError(error, 'Delete agent');
    }
  }

  // ==========================================================================
  // KEY MANAGEMENT
  // ==========================================================================

  /**
   * Upload a public key to an agent identity
   */
  async uploadPublicKey(agentId: string, jwk: jose.JWK): Promise<{ kid: string }> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/credentials/jwks`,
        jwk,
        this.getAxiosConfig()
      );

      const kid = response.data.kid;
      if (!kid) {
        throw new Error('Public key uploaded but no kid found in response');
      }

      return { kid };
    } catch (error: any) {
      this.handleAxiosError(error, 'Upload public key', jwk);
    }
  }

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  /**
   * Create a connection between agent and authorization server
   */
  async createConnection(
    agentId: string,
    request: CreateConnectionRequest
  ): Promise<AgentConnection> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/connections`,
        request,
        this.getAxiosConfig()
      );

      return response.data as AgentConnection;
    } catch (error: any) {
      this.handleAxiosError(error, 'Create connection', request);
    }
  }

  /**
   * Create a vault secret connection between agent and OPA secret
   */
  async createVaultSecretConnection(
    agentId: string,
    secretOrn: string
  ): Promise<AgentConnection> {
    const request: CreateVaultSecretConnectionRequest = {
      connectionType: 'STS_VAULT_SECRET',
      resourceIndicator: secretOrn,
      secret: {
        orn: secretOrn,
      },
    };

    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/connections`,
        request,
        this.getAxiosConfig()
      );

      return response.data as AgentConnection;
    } catch (error: any) {
      this.handleAxiosError(error, 'Create vault secret connection', request);
    }
  }

  /**
   * List all connections for an agent
   */
  async listConnections(agentId: string): Promise<AgentConnection[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/connections`,
        this.getAxiosConfig()
      );

      // API returns { data: [...], _links: {...} }
      return (response.data?.data || []) as AgentConnection[];
    } catch (error: any) {
      this.handleAxiosError(error, 'List connections');
    }
  }

  /**
   * Deactivate a connection between agent and authorization server
   */
  async deactivateConnection(agentId: string, connectionId: string): Promise<void> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/connections/${connectionId}/lifecycle/deactivate`,
        {},
        this.getAxiosConfig()
      );

      if (response.status !== 200) {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error: any) {
      this.handleAxiosError(error, 'Deactivate connection');
    }
  }

  /**
   * Delete a connection between agent and authorization server
   */
  async deleteConnection(agentId: string, connectionId: string): Promise<void> {
    try {
      const response = await axios.delete(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/connections/${connectionId}`,
        this.getAxiosConfig()
      );

      if (response.status !== 204) {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error: any) {
      this.handleAxiosError(error, 'Delete connection');
    }
  }

  // ==========================================================================
  // A2A SERVERS & DELEGATION LINKS (agent-to-agent identity chaining)
  // ==========================================================================

  /**
   * Associate an Okta custom authorization server with an agent's A2A server.
   * After this, the a2a-server's resourceUrl is accepted as a `resource` for the
   * custom AS, enabling it to mint access tokens scoped to that agent.
   *
   * The a2aServerId is the same id as the agent identity. The write is async
   * (202 + resource-servers operation); we poll to completion when needed.
   */
  async addAuthorizationServerToA2aServer(
    a2aServerId: string,
    authServerOrn: string
  ): Promise<void> {
    const body = { type: 'OKTA', orn: authServerOrn };
    try {
      const response = await axios.post(
        `${this.baseUrl}/resource-servers/api/v1/a2a-servers/${a2aServerId}/authorization-servers`,
        body,
        this.getAxiosConfig()
      );

      if (response.status === 202) {
        const operationUrl = response.headers['location'];
        if (operationUrl) {
          await this.pollOperation(operationUrl);
        }
      }
    } catch (error: any) {
      this.handleAxiosError(error, 'Add authorization server to A2A server', body);
    }
  }

  /**
   * Retrieve an agent's A2A server (the read-only resource projection). Returns
   * its canonical `orn` and `resourceUrl` as stored by Okta — prefer these over
   * client-constructed values to avoid ORN-format drift.
   */
  async getA2aServer(a2aServerId: string): Promise<{ a2aServerId: string; orn: string; resourceUrl: string; [k: string]: any }> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/resource-servers/api/v1/a2a-servers/${a2aServerId}`,
        this.getAxiosConfig()
      );
      return response.data;
    } catch (error: any) {
      this.handleAxiosError(error, 'Get A2A server');
    }
  }

  /**
   * List authorization servers linked to an agent's A2A server.
   */
  async listA2aServerAuthorizationServers(a2aServerId: string): Promise<Array<{ id: string; orn?: string; issuer?: string }>> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/resource-servers/api/v1/a2a-servers/${a2aServerId}/authorization-servers`,
        this.getAxiosConfig()
      );
      return (response.data?.data || []) as Array<{ id: string; orn?: string; issuer?: string }>;
    } catch (error: any) {
      this.handleAxiosError(error, 'List A2A server authorization servers');
    }
  }

  /**
   * Create a delegation link (inbound policy) declaring which caller's tokens the
   * target agent will accept as a subject_token.
   * Returns the created link (including its id, when present) for rollback tracking.
   */
  async createDelegationLink(request: CreateDelegationLinkRequest): Promise<DelegationLink> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/delegation-links`,
        request,
        this.getAxiosConfig()
      );
      return response.data as DelegationLink;
    } catch (error: any) {
      this.handleAxiosError(error, 'Create delegation link', request);
    }
  }

  /**
   * List delegation links (best-effort; used for rollback discovery).
   */
  async listDelegationLinks(): Promise<DelegationLink[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/workload-principals/api/v1/delegation-links?limit=50`,
        this.getAxiosConfig()
      );
      return (response.data?.data || []) as DelegationLink[];
    } catch (error: any) {
      this.handleAxiosError(error, 'List delegation links');
    }
  }

  /**
   * Delete a delegation link by id.
   */
  async deleteDelegationLink(linkId: string): Promise<void> {
    try {
      await axios.delete(
        `${this.baseUrl}/workload-principals/api/v1/delegation-links/${linkId}`,
        this.getAxiosConfig()
      );
    } catch (error: any) {
      this.handleAxiosError(error, 'Delete delegation link');
    }
  }

  /**
   * Create a managed connection from an agent to a target agent's A2A server
   * (connectionType IDENTITY_ASSERTION_A2A_SERVER). This is the outbound plumbing
   * that lets the source agent obtain an ID-JAG for the target agent's resource.
   */
  async createA2aConnection(
    agentId: string,
    request: CreateA2aConnectionRequest
  ): Promise<AgentConnection> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/connections`,
        request,
        this.getAxiosConfig()
      );
      return response.data as AgentConnection;
    } catch (error: any) {
      // Callers may probe this type and fall back (older org builds reject
      // IDENTITY_ASSERTION_A2A_SERVER). Throw quietly — no verbose dump — so the
      // expected fallback path doesn't look like a hard failure.
      const status = error?.response?.status;
      const summary = error?.response?.data?.errorSummary || error.message;
      throw new Error(`Create A2A connection failed${status ? ` (HTTP ${status})` : ''}: ${summary}`);
    }
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  /**
   * Get organization metadata (includes org ID for ORN construction)
   */
  async getOrgMetadata(): Promise<OrgMetadata> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/api/v1/org`,
        this.getAxiosConfig()
      );

      return response.data as OrgMetadata;
    } catch (error: any) {
      this.handleAxiosError(error, 'Get org metadata');
    }
  }

  /**
   * Get the current authenticated user (associated with the API token)
   */
  async getCurrentUser(): Promise<{ id: string; login: string }> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/api/v1/users/me`,
        this.getAxiosConfig()
      );

      return {
        id: response.data.id,
        login: response.data.profile.login,
      };
    } catch (error: any) {
      this.handleAxiosError(error, 'Get current user');
    }
  }

  // ==========================================================================
  // AGENT OWNERSHIP
  // ==========================================================================

  /**
   * Set agent owners using the standard governance API
   */
  async setAgentOwnersStandard(
    agentId: string,
    orgId: string,
    userId: string
  ): Promise<void> {
    try {
      const principalOrn = `orn:okta:directory:${orgId}:users:${userId}`;
      const resourceOrn = `orn:okta:directory:${orgId}:workload-principals:ai-agents:${agentId}`;

      const response = await axios.post(
        `${this.baseUrl}/governance/api/v1/resource-owners`,
        {
          principalOrns: [principalOrn],
          resourceOrns: [resourceOrn],
        },
        this.getAxiosConfig()
      );

      if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error: any) {
      const requestBody = {
        principalOrns: [`orn:okta:directory:${orgId}:users:${userId}`],
        resourceOrns: [`orn:okta:directory:${orgId}:workload-principals:ai-agents:${agentId}`],
      };
      this.handleAxiosError(error, 'Set agent owners (standard)', requestBody);
    }
  }

  /**
   * Set agent owners using the developer API (for local development)
   * This requires two API calls: setupProxy and then set resource owners
   */
  async setAgentOwnersDeveloper(agentId: string, orgId: string): Promise<void> {
    try {
      // Step 1: Setup proxy
      const setupResponse = await axios.post(
        `${this.baseUrl}/devtools/api/ai-agent/ramp/setupProxy?orgId=${orgId}`,
        {},
        this.getAxiosConfig()
      );

      if (setupResponse.status !== 200 && setupResponse.status !== 201 && setupResponse.status !== 204) {
        throw new Error(`Setup proxy unexpected status: ${setupResponse.status}`);
      }

      // Step 2: Set resource owners
      const resourceOrn = `orn:okta:directory:${orgId}:workload-principals:ai-agents:${agentId}`;
      const ownersResponse = await axios.put(
        `${this.baseUrl}/devtools/api/ai-agent/ramp/resourceOwners/${encodeURIComponent(resourceOrn)}`,
        {},
        this.getAxiosConfig()
      );

      if (ownersResponse.status !== 200 && ownersResponse.status !== 201 && ownersResponse.status !== 204) {
        throw new Error(`Set resource owners unexpected status: ${ownersResponse.status}`);
      }
    } catch (error: any) {
      this.handleAxiosError(error, 'Set agent owners (developer)', {});
    }
  }

  /**
   * Remove agent owners using the standard governance API
   * Sets principalOrns to empty array to remove all owners
   */
  async removeAgentOwnersStandard(agentId: string, orgId: string): Promise<void> {
    try {
      const resourceOrn = `orn:okta:directory:${orgId}:workload-principals:ai-agents:${agentId}`;

      const response = await axios.post(
        `${this.baseUrl}/governance/api/v1/resource-owners`,
        {
          principalOrns: [],
          resourceOrns: [resourceOrn],
        },
        this.getAxiosConfig()
      );

      if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error: any) {
      const requestBody = {
        principalOrns: [],
        resourceOrns: [`orn:okta:directory:${orgId}:workload-principals:ai-agents:${agentId}`],
      };
      this.handleAxiosError(error, 'Remove agent owners (standard)', requestBody);
    }
  }

  /**
   * Remove agent owners using the developer API (for local development)
   */
  async removeAgentOwnersDeveloper(orgId: string): Promise<void> {
    try {
      const response = await axios.delete(
        `${this.baseUrl}/devtools/api/ai-agent/ramp/setupProxy?orgId=${orgId}`,
        this.getAxiosConfig()
      );

      if (response.status !== 200 && response.status !== 204) {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error: any) {
      this.handleAxiosError(error, 'Remove agent owners (developer)');
    }
  }
}

// ============================================================================
// HELPER UTILITIES
// ============================================================================

/**
 * Convert PEM-encoded public key (SPKI format) to JWK format for Okta JWKS endpoint
 */
export async function convertPublicKeyToJWK(publicKeyPem: string): Promise<jose.JWK> {
  // Import the public key using jose
  const publicKey = await jose.importSPKI(publicKeyPem, 'RS256');

  // Export as JWK
  const jwk = await jose.exportJWK(publicKey);

  // Calculate JWK thumbprint for kid (RFC 7638)
  const kid = await jose.calculateJwkThumbprint(jwk, 'sha256');

  // Add required fields for Okta
  return {
    ...jwk,
    kid,
    alg: 'RS256',
    use: 'sig',
  };
}

/**
 * Construct an Okta Resource Name (ORN) for an authorization server
 */
export function constructAuthServerORN(orgId: string, authServerId: string): string {
  return `orn:okta:idp:${orgId}:authorization_servers:${authServerId}`;
}

/**
 * Construct an Okta Resource Name (ORN) for a PAM vault secret
 */
export function constructPamSecretORN(orgId: string, secretId: string): string {
  return `orn:okta:pam:${orgId}:secrets:${secretId}`;
}

/**
 * Construct an Okta Resource Name (ORN) for an agent's A2A server.
 * The a2a-server shares the agent's primary key. NOTE: the path segment is
 * `a2a-servers` (plural), matching the API's returned ORNs. Prefer reading the
 * canonical ORN from `getA2aServer()` where possible.
 */
export function constructA2aServerORN(orgId: string, agentId: string): string {
  return `orn:okta:directory:${orgId}:resource-servers:a2a-servers:${agentId}`;
}

/**
 * Construct an Okta Resource Name (ORN) for an AI agent (workload principal).
 */
export function constructAgentORN(orgId: string, agentId: string): string {
  return `orn:okta:directory:${orgId}:workload-principals:ai-agents:${agentId}`;
}

/**
 * Construct an Okta Resource Name (ORN) for an OIDC application instance.
 */
export function constructAppORN(orgId: string, clientId: string): string {
  return `orn:okta:idp:${orgId}:apps:oidc:${clientId}`;
}
