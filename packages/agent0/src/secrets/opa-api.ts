// opa-api.ts - Okta Privileged Access (OPA) API Client
// Based on official OPA API documentation: https://developer.okta.com/docs/api/openapi/opa/
import axios, { type AxiosInstance } from 'axios';
import * as jose from 'jose';

// ============================================================================
// Types
// ============================================================================

export interface OPAConfig {
  baseUrl: string;      // e.g., https://your-team.pam.okta.com
  teamName: string;
}

export interface OPAClientWithToken extends OPAConfig {
  token: string;        // Bearer token for API authentication
}

export interface ResourceGroup {
  id: string;
  name: string;
  description?: string | undefined;
  deleted_at?: string | undefined;
}

export interface Project {
  id: string;
  name: string;
  description?: string | undefined;
  resource_group_id?: string | undefined;
  deleted_at?: string | undefined;
}

export interface SecretFolder {
  id: string;
  name: string;
  description?: string | undefined;
  parent_folder_id?: string | undefined;
  created_at?: string | undefined;
  updated_at?: string | undefined;
}

export interface Secret {
  id: string;
  name: string;
  description?: string | undefined;
  parent_folder_id?: string | undefined;
  created_at?: string | undefined;
  created_by?: string | undefined;
  updated_at?: string | undefined;
  updated_by?: string | undefined;
  path?: Array<{ id: string; name: string }> | undefined;
}

export interface SecretInput {
  name: string;
  secret_jwe: string;
  parent_folder_id: string;
  description?: string | undefined;
}

export interface RevealedSecret {
  id: string;
  name: string;
  secret: string;
}

export interface ServiceUser {
  id: string;
  name: string;
  status: 'ACTIVE' | 'DISABLED' | 'DELETED';
  user_type: 'service';
  deleted_at?: string | undefined;
}

export interface ServiceUserKey {
  id: string;
  secret?: string | undefined;  // Only returned on creation
  issued_at: string;
  expires_at: string | null;
  last_used?: string | undefined;
}

export interface ServiceUserToken {
  bearer_token: string;
  expires_at: string;
  team_name: string;
}

export interface Group {
  id: string;
  name: string;
  roles: GroupRole[];
  deleted_at?: string | undefined;
}

export type GroupRole = 'end_user' | 'pam_admin' | 'resource_admin' | 'security_admin';

export interface SecurityPolicy {
  id: string;
  name: string;
  description?: string | undefined;
  active: boolean;
  principals: {
    user_groups: Array<{ id: string }>;
  };
  rules: SecurityPolicyRule[];
}

export interface SecurityPolicyPrivilege {
  privilege_type: 'password_checkout_rdp' | 'password_checkout_ssh' | 'principal_account_rdp' | 'principal_account_ssh' | 'reveal_password' | 'rotate_password' | 'secret' | 'update_password';
  privilege_value: Record<string, boolean>;
}

export interface SecurityPolicyRule {
  name: string;
  resource_type: 'secret_based_resource' | 'server_based_resource' | 'active_directory_based_resource' | 'managed_saas_app_based_resource' | 'okta_app_based_resource' | 'unmanaged_saas_app_based_resource';
  resource_selector: {
    selectors: Array<{
      selector_type: string;
      selector: {
        secret_folder?: { id: string };
      };
    }>;
  };
  privileges: SecurityPolicyPrivilege[];
}

export interface VaultJWKS {
  keys: jose.JWK[];
}

// ============================================================================
// OPA API Client
// ============================================================================

export class OPAClient {
  private client: AxiosInstance;
  private config: OPAClientWithToken;

  constructor(config: OPAClientWithToken) {
    // Normalize baseUrl to remove trailing slashes
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
    };
    this.client = axios.create({
      baseURL: this.config.baseUrl,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  }

  // ==========================================================================
  // Vault / Encryption
  // ==========================================================================

  /**
   * Retrieve the vault JWKS (public keys for encrypting secrets)
   * GET /v1/teams/{team_name}/vault/jwks.json
   */
  async getVaultJWKS(): Promise<VaultJWKS> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/vault/jwks.json`
    );
    return response.data;
  }

  /**
   * Encrypt a secret value using JWE with the vault's public key
   * Uses RSA-OAEP-256 for key encryption and A256GCM for content encryption
   *
   * @param value - The secret value to encrypt
   * @param keyName - The JSON key name for the secret (default: 'secret')
   *                  OPA expects secrets as JSON objects: {"keyName": "value"}
   * @returns JWE encrypted string in JSON serialization format
   */
  async encryptSecretValue(value: string, keyName: string = 'secret'): Promise<string> {
    const jwks = await this.getVaultJWKS();
    const publicKey = jwks.keys[0];

    if (!publicKey) {
      throw new Error('No public key found in vault JWKS');
    }

    const key = await jose.importJWK(publicKey, 'RSA-OAEP-256');

    // Secret must be a JSON object with string keys and values
    const secretPayload = JSON.stringify({ [keyName]: value });

    // Build header with optional kid
    const header: jose.JWEHeaderParameters = {
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
    };
    if (publicKey.kid) {
      header.kid = publicKey.kid;
    }

    // Use FlattenedEncrypt for JSON Serialization (required by OPA)
    const jwe = await new jose.FlattenedEncrypt(
      new TextEncoder().encode(secretPayload)
    )
      .setProtectedHeader(header)
      .encrypt(key);

    // Return the full JSON serialization
    return JSON.stringify(jwe);
  }

  // ==========================================================================
  // Resource Groups
  // ==========================================================================

  /**
   * List all resource groups
   * GET /v1/teams/{team_name}/resource_groups
   */
  async listResourceGroups(): Promise<ResourceGroup[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/resource_groups`
    );
    return response.data.list || [];
  }

  /**
   * Create a resource group
   * POST /v1/teams/{team_name}/resource_groups
   */
  async createResourceGroup(
    name: string,
    description?: string,
    delegatedAdminGroups?: Array<{ id: string }>
  ): Promise<ResourceGroup> {
    const body: Record<string, unknown> = { name };
    if (description) body.description = description;
    if (delegatedAdminGroups && delegatedAdminGroups.length > 0) {
      body.delegated_resource_admin_groups = delegatedAdminGroups;
    }
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/resource_groups`,
      body
    );
    return response.data;
  }

  /**
   * Get resource group by name
   */
  async getResourceGroupByName(name: string): Promise<ResourceGroup | null> {
    const groups = await this.listResourceGroups();
    return groups.find(g => g.name === name) || null;
  }

  /**
   * Get or create resource group
   */
  async getOrCreateResourceGroup(
    name: string,
    description?: string,
    delegatedAdminGroups?: Array<{ id: string }>
  ): Promise<ResourceGroup> {
    const existing = await this.getResourceGroupByName(name);
    if (existing) return existing;
    return this.createResourceGroup(name, description, delegatedAdminGroups);
  }

  // ==========================================================================
  // Projects
  // ==========================================================================

  /**
   * List projects in a resource group
   * GET /v1/teams/{team_name}/resource_groups/{resource_group_id}/projects
   */
  async listProjects(resourceGroupId: string): Promise<Project[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects`
    );
    return response.data.list || [];
  }

  /**
   * Create a project
   * POST /v1/teams/{team_name}/resource_groups/{resource_group_id}/projects
   */
  async createProject(resourceGroupId: string, name: string): Promise<Project> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects`,
      { name }
    );
    return response.data;
  }

  /**
   * Get project by name
   */
  async getProjectByName(resourceGroupId: string, name: string): Promise<Project | null> {
    const projects = await this.listProjects(resourceGroupId);
    return projects.find(p => p.name === name) || null;
  }

  /**
   * Get or create project
   */
  async getOrCreateProject(resourceGroupId: string, name: string): Promise<Project> {
    const existing = await this.getProjectByName(resourceGroupId, name);
    if (existing) return existing;
    return this.createProject(resourceGroupId, name);
  }

  // ==========================================================================
  // Secret Folders
  // ==========================================================================

  /**
   * List top-level secret folders in a project
   * GET /v1/teams/{team_name}/resource_groups/{rg_id}/projects/{project_id}/secret_folders
   */
  async listSecretFolders(resourceGroupId: string, projectId: string): Promise<SecretFolder[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders`
    );
    return response.data.list || [];
  }

  /**
   * Create a secret folder
   * POST /v1/teams/{team_name}/resource_groups/{rg_id}/projects/{project_id}/secret_folders
   */
  async createSecretFolder(
    resourceGroupId: string,
    projectId: string,
    name: string,
    description?: string,
    parentFolderId?: string
  ): Promise<SecretFolder> {
    const body: Record<string, string | undefined> = { name, description };
    if (parentFolderId) {
      body.parent_folder_id = parentFolderId;
    }
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders`,
      body
    );
    return response.data;
  }

  /**
   * Get secret folder by name
   */
  async getSecretFolderByName(
    resourceGroupId: string,
    projectId: string,
    name: string
  ): Promise<SecretFolder | null> {
    const folders = await this.listSecretFolders(resourceGroupId, projectId);
    return folders.find(f => f.name === name) || null;
  }

  /**
   * Get or create secret folder
   */
  async getOrCreateSecretFolder(
    resourceGroupId: string,
    projectId: string,
    name: string,
    description?: string
  ): Promise<SecretFolder> {
    const existing = await this.getSecretFolderByName(resourceGroupId, projectId, name);
    if (existing) return existing;
    return this.createSecretFolder(resourceGroupId, projectId, name, description);
  }

  // ==========================================================================
  // Secrets
  // ==========================================================================

  /**
   * List secrets in a specific folder
   * GET /v1/teams/{team_name}/resource_groups/{rg_id}/projects/{project_id}/secret_folders/{folder_id}/items
   */
  async listSecretsInProject(
    resourceGroupId: string,
    projectId: string,
    folderId?: string
  ): Promise<Secret[]> {
    if (!folderId) {
      const response = await this.client.get(
        `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders`
      );
      return response.data.list || [];
    }

    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders/${folderId}/items`
    );
    return response.data.list || [];
  }

  /**
   * Create a secret
   * POST /v1/teams/{team_name}/resource_groups/{rg_id}/projects/{project_id}/secrets
   */
  async createSecret(
    resourceGroupId: string,
    projectId: string,
    input: SecretInput
  ): Promise<Secret> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets`,
      input
    );
    return response.data;
  }

  /**
   * Update an existing secret
   * PATCH /v1/teams/{team_name}/resource_groups/{rg_id}/projects/{project_id}/secrets/{secret_id}
   */
  async updateSecret(
    resourceGroupId: string,
    projectId: string,
    secretId: string,
    input: { secret_jwe?: string; description?: string }
  ): Promise<Secret> {
    const response = await this.client.patch(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets/${secretId}`,
      input
    );
    return response.data;
  }

  /**
   * Create a secret with automatic encryption
   */
  async createSecretWithEncryption(
    resourceGroupId: string,
    projectId: string,
    name: string,
    value: string,
    parentFolderId: string,
    description?: string,
    keyName: string = 'secret'
  ): Promise<Secret> {
    const secretJwe = await this.encryptSecretValue(value, keyName);
    return this.createSecret(resourceGroupId, projectId, {
      name,
      secret_jwe: secretJwe,
      parent_folder_id: parentFolderId,
      description,
    });
  }

  /**
   * Update a secret with automatic encryption
   */
  async updateSecretWithEncryption(
    resourceGroupId: string,
    projectId: string,
    secretId: string,
    value: string,
    description?: string,
    keyName: string = 'secret'
  ): Promise<Secret> {
    const secretJwe = await this.encryptSecretValue(value, keyName);
    const input: { secret_jwe: string; description?: string } = { secret_jwe: secretJwe };
    if (description !== undefined) {
      input.description = description;
    }
    return this.updateSecret(resourceGroupId, projectId, secretId, input);
  }

  /**
   * Reveal (decrypt) a secret
   * POST /v1/teams/{team_name}/resource_groups/{rg_id}/projects/{project_id}/secrets/{secret_id}
   */
  async revealSecret(
    resourceGroupId: string,
    projectId: string,
    secretId: string
  ): Promise<RevealedSecret> {
    // Generate a key pair for receiving the decrypted secret
    const { publicKey, privateKey } = await jose.generateKeyPair('RSA-OAEP-256');
    const publicJwk = await jose.exportJWK(publicKey);

    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets/${secretId}`,
      { public_key: publicJwk }
    );

    // Decrypt the returned JWE (can be either JSON or Compact serialization)
    let plaintext: Uint8Array;
    const secretJwe = response.data.secret_jwe;

    if (typeof secretJwe === 'string' && secretJwe.includes('.')) {
      // Compact serialization (dot-separated)
      const result = await jose.compactDecrypt(secretJwe, privateKey);
      plaintext = result.plaintext;
    } else {
      // JSON serialization (Flattened or General)
      const jweObj = typeof secretJwe === 'string' ? JSON.parse(secretJwe) : secretJwe;
      const result = await jose.flattenedDecrypt(jweObj, privateKey);
      plaintext = result.plaintext;
    }

    // Parse the decrypted JSON payload to get the secret value
    const decrypted = new TextDecoder().decode(plaintext);
    let secret: string;
    try {
      const parsed = JSON.parse(decrypted);
      secret = parsed.secret || parsed.password || parsed.api_key || parsed.token ||
               Object.values(parsed)[0] || decrypted;
    } catch {
      secret = decrypted;
    }

    return {
      id: secretId,
      name: response.data.name || '',
      secret,
    };
  }

  /**
   * Get secret by name
   */
  async getSecretByName(
    resourceGroupId: string,
    projectId: string,
    name: string,
    folderId?: string
  ): Promise<Secret | null> {
    const secrets = await this.listSecretsInProject(resourceGroupId, projectId, folderId);
    return secrets.find(s => s.name === name) || null;
  }

  /**
   * Delete a secret
   * DELETE /v1/teams/{team_name}/resource_groups/{rg_id}/projects/{project_id}/secrets/{secret_id}
   */
  async deleteSecret(
    resourceGroupId: string,
    projectId: string,
    secretId: string
  ): Promise<void> {
    await this.client.delete(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets/${secretId}`
    );
  }

  // ==========================================================================
  // Service Users
  // ==========================================================================

  /**
   * List service users
   * GET /v1/teams/{team_name}/service_users
   */
  async listServiceUsers(): Promise<ServiceUser[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/service_users`
    );
    return response.data.list || [];
  }

  /**
   * Create a service user
   * POST /v1/teams/{team_name}/service_users
   */
  async createServiceUser(name: string): Promise<ServiceUser> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/service_users`,
      { name }
    );
    return response.data;
  }

  /**
   * Get service user by name
   * GET /v1/teams/{team_name}/service_users/{user_name}
   */
  async getServiceUser(userName: string): Promise<ServiceUser> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/service_users/${userName}`
    );
    return response.data;
  }

  /**
   * Rotate (create new) API keys for a service user
   * POST /v1/teams/{team_name}/service_users/{user_name}/keys
   * Returns the secret only once!
   */
  async rotateServiceUserKeys(userName: string): Promise<ServiceUserKey> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/service_users/${userName}/keys`
    );
    return response.data;
  }

  /**
   * List API keys for a service user (secrets not included)
   * GET /v1/teams/{team_name}/service_users/{user_name}/keys
   */
  async listServiceUserKeys(userName: string): Promise<ServiceUserKey[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/service_users/${userName}/keys`
    );
    return response.data.list || [];
  }

  /**
   * Delete an API key
   * DELETE /v1/teams/{team_name}/service_users/{user_name}/keys/{key_id}
   */
  async deleteServiceUserKey(userName: string, keyId: string): Promise<void> {
    await this.client.delete(
      `/v1/teams/${this.config.teamName}/service_users/${userName}/keys/${keyId}`
    );
  }

  // ==========================================================================
  // Groups
  // ==========================================================================

  /**
   * List groups
   * GET /v1/teams/{team_name}/groups
   */
  async listGroups(): Promise<Group[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/groups`
    );
    return response.data.list || [];
  }

  /**
   * Create a group
   * POST /v1/teams/{team_name}/groups
   */
  async createGroup(name: string, roles: GroupRole[]): Promise<Group> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/groups`,
      { name, roles }
    );
    return response.data;
  }

  /**
   * Get group by name
   * GET /v1/teams/{team_name}/groups/{group_name}
   */
  async getGroup(groupName: string): Promise<Group> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/groups/${groupName}`
    );
    return response.data;
  }

  /**
   * Add user to group
   * POST /v1/teams/{team_name}/groups/{group_name}/users
   */
  async addUserToGroup(groupName: string, userName: string): Promise<void> {
    await this.client.post(
      `/v1/teams/${this.config.teamName}/groups/${groupName}/users`,
      { name: userName }
    );
  }

  /**
   * Get or create group
   */
  async getOrCreateGroup(name: string, roles: GroupRole[]): Promise<Group> {
    try {
      return await this.getGroup(name);
    } catch {
      return this.createGroup(name, roles);
    }
  }

  // ==========================================================================
  // Security Policies
  // ==========================================================================

  /**
   * List security policies
   * GET /v1/teams/{team_name}/security_policy
   */
  async listSecurityPolicies(): Promise<SecurityPolicy[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/security_policy`
    );
    return response.data.list || [];
  }

  /**
   * Create a security policy
   * POST /v1/teams/{team_name}/security_policy
   */
  async createSecurityPolicy(
    name: string,
    principals: { user_groups: Array<{ id: string }> },
    rules: SecurityPolicyRule[],
    active: boolean = true,
    description?: string
  ): Promise<SecurityPolicy> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/security_policy`,
      {
        name,
        description,
        active,
        principals,
        rules,
        type: 'default',
      }
    );
    return response.data;
  }
}

// ============================================================================
// Static Token Operations (no bearer token required)
// ============================================================================

/**
 * Issue a service user token using API key credentials
 * POST /v1/teams/{team_name}/service_token
 * This is the only call that doesn't require a bearer token
 */
export async function issueServiceUserToken(
  baseUrl: string,
  teamName: string,
  keyId: string,
  keySecret: string
): Promise<ServiceUserToken> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${normalizedBaseUrl}/v1/teams/${teamName}/service_token`;
  try {
    const response = await axios.post(
      url,
      {
        key_id: keyId,
        key_secret: keySecret,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        timeout: 10000,
      }
    );
    return response.data;
  } catch (error: unknown) {
    const err = error as { response?: { status?: number; data?: unknown }; message?: string };
    throw new Error(
      `Failed to get service token from ${url}: ` +
      `Status ${err.response?.status}, ` +
      `Response: ${JSON.stringify(err.response?.data)}`
    );
  }
}

/**
 * Create an OPA client using stored runtime credentials
 */
export async function createOPAClientFromCredentials(
  baseUrl: string,
  teamName: string,
  keyId: string,
  keySecret: string
): Promise<OPAClient> {
  const tokenResponse = await issueServiceUserToken(baseUrl, teamName, keyId, keySecret);
  return new OPAClient({
    baseUrl,
    teamName,
    token: tokenResponse.bearer_token,
  });
}
