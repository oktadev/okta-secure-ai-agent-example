/**
 * Okta Agent Identity API Client
 *
 * This file contains the implementation for the Okta Agent Identity API.
 * These APIs are part of the Workload Principals feature and are not yet
 * available in the public @okta/okta-sdk-nodejs package.
 */

import axios, { AxiosInstance } from 'axios';
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
  appId: string;
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
    resourceIndicator: string;
  };
  scopeCondition: string;
  scopes: string[];
}

export interface AgentConnection {
  id: string;
  connectionType: string;
  authorizationServer: {
    orn: string;
    resourceIndicator: string;
  };
  scopeCondition: string;
  scopes: string[];
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
  private oktaDomain: string;
  private apiToken: string;
  private baseUrl: string;

  constructor(config: AgentIdentityConfig) {
    this.oktaDomain = config.oktaDomain;
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
        throw new Error('Agent registration failed');
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
   * Delete a connection between agent and authorization server
   */
  async deleteConnection(agentId: string, connectionId: string): Promise<void> {
    try {
      const response = await axios.delete(
        `${this.baseUrl}/workload-principals/api/v1/ai-agents/${agentId}/connections/${connectionId}`,
        this.getAxiosConfig()
      );

      // spec wrong, says 204 but actually returns 200
      if (response.status !== 200) {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error: any) {
      this.handleAxiosError(error, 'Delete connection');
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
   * Sets principalOrns to null to remove all owners
   */
  async removeAgentOwnersStandard(agentId: string, orgId: string): Promise<void> {
    try {
      const resourceOrn = `orn:okta:directory:${orgId}:workload-principals:ai-agents:${agentId}`;

      const response = await axios.post(
        `${this.baseUrl}/governance/api/v1/resource-owners`,
        {
          principalOrns: null,
          resourceOrns: [resourceOrn],
        },
        this.getAxiosConfig()
      );

      if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error: any) {
      const requestBody = {
        principalOrns: null,
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
