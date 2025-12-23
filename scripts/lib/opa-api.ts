// opa-api.ts - Okta Privileged Access (OPA) API Client
// Based on official OPA API documentation: https://developer.okta.com/docs/api/openapi/opa/
import axios, { type AxiosInstance } from 'axios';
import * as jose from 'jose';

// ============================================================================
// Types
// ============================================================================

export interface OPAConfig {
  baseUrl: string;
  teamName: string;
}

export interface OPAClientWithToken extends OPAConfig {
  token: string;
  timeout?: number; // Request timeout in milliseconds (default: 30000)
}

export interface ResourceGroup {
  id: string;
  name: string;
  description?: string;
  deleted_at?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  resource_group_id?: string;
  deleted_at?: string;
}

export interface SecretFolder {
  id: string;
  name: string;
  description?: string;
  parent_folder_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Secret {
  id: string;
  name: string;
  description?: string;
  parent_folder_id?: string;
  created_at?: string;
  created_by?: string;
  updated_at?: string;
  updated_by?: string;
  path?: Array<{ id: string; name: string }>;
}

export interface SecretInput {
  name: string;
  secret_jwe: string;
  parent_folder_id: string;
  description?: string;
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
  deleted_at?: string;
}

export interface ServiceUserKey {
  id: string;
  secret?: string;
  issued_at: string;
  expires_at: string | null;
  last_used?: string;
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
  deleted_at?: string;
}

export type GroupRole = 'end_user' | 'pam_admin' | 'resource_admin' | 'security_admin';

export interface SecurityPolicy {
  id: string;
  name: string;
  description?: string;
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
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 30000; // 30 seconds

// ============================================================================
// OPA API Client
// ============================================================================

export class OPAClient {
  private client: AxiosInstance;
  private config: OPAClientWithToken;

  constructor(config: OPAClientWithToken) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
    };

    const timeout = config.timeout ?? DEFAULT_TIMEOUT;

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    // Add response interceptor for better error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.code === 'ECONNABORTED') {
          const timeoutError = new Error(
            `Request timed out after ${timeout}ms. The OPA API may be slow or unreachable.`
          );
          (timeoutError as NodeJS.ErrnoException).code = 'ETIMEDOUT';
          throw timeoutError;
        }

        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          throw new Error(
            `Cannot connect to OPA API at ${this.config.baseUrl}. ` +
            `Please check the URL and network connectivity.`
          );
        }

        // Handle HTTP errors with better messages
        if (error.response) {
          const status = error.response.status;
          const message = error.response.data?.message || error.response.statusText;

          if (status === 401) {
            throw new Error(
              `Authentication failed (401). The bearer token may have expired. ` +
              `Please get a fresh token from the OPA dashboard.`
            );
          }

          if (status === 403) {
            throw new Error(
              `Access denied (403). You don't have permission for this operation. ` +
              `Details: ${message}`
            );
          }

          if (status === 404) {
            throw new Error(
              `Resource not found (404). The requested resource may not exist. ` +
              `Details: ${message}`
            );
          }

          if (status >= 500) {
            throw new Error(
              `OPA server error (${status}). Please try again later. ` +
              `Details: ${message}`
            );
          }
        }

        throw error;
      }
    );
  }

  // ==========================================================================
  // Vault / Encryption
  // ==========================================================================

  async getVaultJWKS(): Promise<VaultJWKS> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/vault/jwks.json`
    );
    return response.data;
  }

  async encryptSecretValue(value: string, keyName: string = 'secret'): Promise<string> {
    const jwks = await this.getVaultJWKS();
    const publicKey = jwks.keys[0];

    if (!publicKey) {
      throw new Error('No public key found in vault JWKS');
    }

    const key = await jose.importJWK(publicKey, 'RSA-OAEP-256');
    const secretPayload = JSON.stringify({ [keyName]: value });

    const header: jose.JWEHeaderParameters = {
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
    };
    if (publicKey.kid) {
      header.kid = publicKey.kid;
    }

    const jwe = await new jose.FlattenedEncrypt(
      new TextEncoder().encode(secretPayload)
    )
      .setProtectedHeader(header)
      .encrypt(key);

    return JSON.stringify(jwe);
  }

  // ==========================================================================
  // Resource Groups
  // ==========================================================================

  async listResourceGroups(): Promise<ResourceGroup[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/resource_groups`
    );
    return response.data.list || [];
  }

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

  async getResourceGroupByName(name: string): Promise<ResourceGroup | null> {
    const groups = await this.listResourceGroups();
    return groups.find(g => g.name === name) || null;
  }

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

  async listProjects(resourceGroupId: string): Promise<Project[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects`
    );
    return response.data.list || [];
  }

  async createProject(resourceGroupId: string, name: string): Promise<Project> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects`,
      { name }
    );
    return response.data;
  }

  async getProjectByName(resourceGroupId: string, name: string): Promise<Project | null> {
    const projects = await this.listProjects(resourceGroupId);
    return projects.find(p => p.name === name) || null;
  }

  async getOrCreateProject(resourceGroupId: string, name: string): Promise<Project> {
    const existing = await this.getProjectByName(resourceGroupId, name);
    if (existing) return existing;
    return this.createProject(resourceGroupId, name);
  }

  // ==========================================================================
  // Secret Folders
  // ==========================================================================

  async listSecretFolders(resourceGroupId: string, projectId: string): Promise<SecretFolder[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders`
    );
    return response.data.list || [];
  }

  async createSecretFolder(
    resourceGroupId: string,
    projectId: string,
    name: string,
    description?: string
  ): Promise<SecretFolder> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders`,
      { name, description }
    );
    return response.data;
  }

  async getSecretFolderByName(
    resourceGroupId: string,
    projectId: string,
    name: string
  ): Promise<SecretFolder | null> {
    const folders = await this.listSecretFolders(resourceGroupId, projectId);
    return folders.find(f => f.name === name) || null;
  }

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

  async updateSecret(
    resourceGroupId: string,
    projectId: string,
    secretId: string,
    input: { name: string; secret_jwe: string; parent_folder_id: string; description?: string }
  ): Promise<Secret> {
    // OPA API uses PUT for updates with full object replacement
    const response = await this.client.put(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets/${secretId}`,
      input
    );
    return response.data;
  }

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

  async updateSecretWithEncryption(
    resourceGroupId: string,
    projectId: string,
    secretId: string,
    name: string,
    value: string,
    parentFolderId: string,
    description?: string,
    keyName: string = 'secret'
  ): Promise<Secret> {
    const secretJwe = await this.encryptSecretValue(value, keyName);
    const input: { name: string; secret_jwe: string; parent_folder_id: string; description?: string } = {
      name,
      secret_jwe: secretJwe,
      parent_folder_id: parentFolderId,
    };
    if (description !== undefined) {
      input.description = description;
    }
    return this.updateSecret(resourceGroupId, projectId, secretId, input);
  }

  async revealSecret(
    resourceGroupId: string,
    projectId: string,
    secretId: string
  ): Promise<RevealedSecret> {
    const { publicKey, privateKey } = await jose.generateKeyPair('RSA-OAEP-256');
    const publicJwk = await jose.exportJWK(publicKey);

    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets/${secretId}`,
      { public_key: publicJwk }
    );

    let plaintext: Uint8Array;
    const secretJwe = response.data.secret_jwe;

    if (typeof secretJwe === 'string' && secretJwe.includes('.')) {
      const result = await jose.compactDecrypt(secretJwe, privateKey);
      plaintext = result.plaintext;
    } else {
      const jweObj = typeof secretJwe === 'string' ? JSON.parse(secretJwe) : secretJwe;
      const result = await jose.flattenedDecrypt(jweObj, privateKey);
      plaintext = result.plaintext;
    }

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

  async getSecretByName(
    resourceGroupId: string,
    projectId: string,
    name: string,
    folderId?: string
  ): Promise<Secret | null> {
    const secrets = await this.listSecretsInProject(resourceGroupId, projectId, folderId);
    return secrets.find(s => s.name === name) || null;
  }

  // ==========================================================================
  // Service Users
  // ==========================================================================

  async listServiceUsers(): Promise<ServiceUser[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/service_users`
    );
    return response.data.list || [];
  }

  async createServiceUser(name: string): Promise<ServiceUser> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/service_users`,
      { name }
    );
    return response.data;
  }

  async getServiceUser(userName: string): Promise<ServiceUser> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/service_users/${userName}`
    );
    return response.data;
  }

  async rotateServiceUserKeys(userName: string): Promise<ServiceUserKey> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/service_users/${userName}/keys`
    );
    return response.data;
  }

  async listServiceUserKeys(userName: string): Promise<ServiceUserKey[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/service_users/${userName}/keys`
    );
    return response.data.list || [];
  }

  async deleteServiceUserKey(userName: string, keyId: string): Promise<void> {
    await this.client.delete(
      `/v1/teams/${this.config.teamName}/service_users/${userName}/keys/${keyId}`
    );
  }

  // ==========================================================================
  // Groups
  // ==========================================================================

  async listGroups(): Promise<Group[]> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/groups`
    );
    return response.data.list || [];
  }

  async createGroup(name: string, roles: GroupRole[]): Promise<Group> {
    const response = await this.client.post(
      `/v1/teams/${this.config.teamName}/groups`,
      { name, roles }
    );
    return response.data;
  }

  async getGroup(groupName: string): Promise<Group> {
    const response = await this.client.get(
      `/v1/teams/${this.config.teamName}/groups/${groupName}`
    );
    return response.data;
  }

  async addUserToGroup(groupName: string, userName: string): Promise<void> {
    await this.client.post(
      `/v1/teams/${this.config.teamName}/groups/${groupName}/users`,
      { name: userName }
    );
  }

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
// Static Token Operations
// ============================================================================

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
      { key_id: keyId, key_secret: keySecret },
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
    const err = error as { response?: { status?: number; data?: unknown } };
    throw new Error(
      `Failed to get service token: Status ${err.response?.status}, ` +
      `Response: ${JSON.stringify(err.response?.data)}`
    );
  }
}

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
