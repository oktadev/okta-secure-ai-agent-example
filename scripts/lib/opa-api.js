// opa-api.ts - Okta Privileged Access (OPA) API Client
// Based on official OPA API documentation: https://developer.okta.com/docs/api/openapi/opa/
import axios from 'axios';
import * as jose from 'jose';
// ============================================================================
// OPA API Client
// ============================================================================
export class OPAClient {
    constructor(config) {
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
    async getVaultJWKS() {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/vault/jwks.json`);
        return response.data;
    }
    async encryptSecretValue(value, keyName = 'secret') {
        const jwks = await this.getVaultJWKS();
        const publicKey = jwks.keys[0];
        if (!publicKey) {
            throw new Error('No public key found in vault JWKS');
        }
        const key = await jose.importJWK(publicKey, 'RSA-OAEP-256');
        const secretPayload = JSON.stringify({ [keyName]: value });
        const header = {
            alg: 'RSA-OAEP-256',
            enc: 'A256GCM',
        };
        if (publicKey.kid) {
            header.kid = publicKey.kid;
        }
        const jwe = await new jose.FlattenedEncrypt(new TextEncoder().encode(secretPayload))
            .setProtectedHeader(header)
            .encrypt(key);
        return JSON.stringify(jwe);
    }
    // ==========================================================================
    // Resource Groups
    // ==========================================================================
    async listResourceGroups() {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/resource_groups`);
        return response.data.list || [];
    }
    async createResourceGroup(name, description, delegatedAdminGroups) {
        const body = { name };
        if (description)
            body.description = description;
        if (delegatedAdminGroups && delegatedAdminGroups.length > 0) {
            body.delegated_resource_admin_groups = delegatedAdminGroups;
        }
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/resource_groups`, body);
        return response.data;
    }
    async getResourceGroupByName(name) {
        const groups = await this.listResourceGroups();
        return groups.find(g => g.name === name) || null;
    }
    async getOrCreateResourceGroup(name, description, delegatedAdminGroups) {
        const existing = await this.getResourceGroupByName(name);
        if (existing)
            return existing;
        return this.createResourceGroup(name, description, delegatedAdminGroups);
    }
    // ==========================================================================
    // Projects
    // ==========================================================================
    async listProjects(resourceGroupId) {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects`);
        return response.data.list || [];
    }
    async createProject(resourceGroupId, name) {
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects`, { name });
        return response.data;
    }
    async getProjectByName(resourceGroupId, name) {
        const projects = await this.listProjects(resourceGroupId);
        return projects.find(p => p.name === name) || null;
    }
    async getOrCreateProject(resourceGroupId, name) {
        const existing = await this.getProjectByName(resourceGroupId, name);
        if (existing)
            return existing;
        return this.createProject(resourceGroupId, name);
    }
    // ==========================================================================
    // Secret Folders
    // ==========================================================================
    async listSecretFolders(resourceGroupId, projectId) {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders`);
        return response.data.list || [];
    }
    async createSecretFolder(resourceGroupId, projectId, name, description) {
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders`, { name, description });
        return response.data;
    }
    async getSecretFolderByName(resourceGroupId, projectId, name) {
        const folders = await this.listSecretFolders(resourceGroupId, projectId);
        return folders.find(f => f.name === name) || null;
    }
    async getOrCreateSecretFolder(resourceGroupId, projectId, name, description) {
        const existing = await this.getSecretFolderByName(resourceGroupId, projectId, name);
        if (existing)
            return existing;
        return this.createSecretFolder(resourceGroupId, projectId, name, description);
    }
    // ==========================================================================
    // Secrets
    // ==========================================================================
    async listSecretsInProject(resourceGroupId, projectId, folderId) {
        if (!folderId) {
            const response = await this.client.get(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders`);
            return response.data.list || [];
        }
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secret_folders/${folderId}/items`);
        return response.data.list || [];
    }
    async createSecret(resourceGroupId, projectId, input) {
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets`, input);
        return response.data;
    }
    async updateSecret(resourceGroupId, projectId, secretId, input) {
        const response = await this.client.patch(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets/${secretId}`, input);
        return response.data;
    }
    async createSecretWithEncryption(resourceGroupId, projectId, name, value, parentFolderId, description, keyName = 'secret') {
        const secretJwe = await this.encryptSecretValue(value, keyName);
        return this.createSecret(resourceGroupId, projectId, {
            name,
            secret_jwe: secretJwe,
            parent_folder_id: parentFolderId,
            description,
        });
    }
    async updateSecretWithEncryption(resourceGroupId, projectId, secretId, value, description, keyName = 'secret') {
        const secretJwe = await this.encryptSecretValue(value, keyName);
        const input = { secret_jwe: secretJwe };
        if (description !== undefined) {
            input.description = description;
        }
        return this.updateSecret(resourceGroupId, projectId, secretId, input);
    }
    async revealSecret(resourceGroupId, projectId, secretId) {
        const { publicKey, privateKey } = await jose.generateKeyPair('RSA-OAEP-256');
        const publicJwk = await jose.exportJWK(publicKey);
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/resource_groups/${resourceGroupId}/projects/${projectId}/secrets/${secretId}`, { public_key: publicJwk });
        let plaintext;
        const secretJwe = response.data.secret_jwe;
        if (typeof secretJwe === 'string' && secretJwe.includes('.')) {
            const result = await jose.compactDecrypt(secretJwe, privateKey);
            plaintext = result.plaintext;
        }
        else {
            const jweObj = typeof secretJwe === 'string' ? JSON.parse(secretJwe) : secretJwe;
            const result = await jose.flattenedDecrypt(jweObj, privateKey);
            plaintext = result.plaintext;
        }
        const decrypted = new TextDecoder().decode(plaintext);
        let secret;
        try {
            const parsed = JSON.parse(decrypted);
            secret = parsed.secret || parsed.password || parsed.api_key || parsed.token ||
                Object.values(parsed)[0] || decrypted;
        }
        catch {
            secret = decrypted;
        }
        return {
            id: secretId,
            name: response.data.name || '',
            secret,
        };
    }
    async getSecretByName(resourceGroupId, projectId, name, folderId) {
        const secrets = await this.listSecretsInProject(resourceGroupId, projectId, folderId);
        return secrets.find(s => s.name === name) || null;
    }
    // ==========================================================================
    // Service Users
    // ==========================================================================
    async listServiceUsers() {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/service_users`);
        return response.data.list || [];
    }
    async createServiceUser(name) {
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/service_users`, { name });
        return response.data;
    }
    async getServiceUser(userName) {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/service_users/${userName}`);
        return response.data;
    }
    async rotateServiceUserKeys(userName) {
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/service_users/${userName}/keys`);
        return response.data;
    }
    async listServiceUserKeys(userName) {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/service_users/${userName}/keys`);
        return response.data.list || [];
    }
    async deleteServiceUserKey(userName, keyId) {
        await this.client.delete(`/v1/teams/${this.config.teamName}/service_users/${userName}/keys/${keyId}`);
    }
    // ==========================================================================
    // Groups
    // ==========================================================================
    async listGroups() {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/groups`);
        return response.data.list || [];
    }
    async createGroup(name, roles) {
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/groups`, { name, roles });
        return response.data;
    }
    async getGroup(groupName) {
        const response = await this.client.get(`/v1/teams/${this.config.teamName}/groups/${groupName}`);
        return response.data;
    }
    async addUserToGroup(groupName, userName) {
        await this.client.post(`/v1/teams/${this.config.teamName}/groups/${groupName}/users`, { name: userName });
    }
    async getOrCreateGroup(name, roles) {
        try {
            return await this.getGroup(name);
        }
        catch {
            return this.createGroup(name, roles);
        }
    }
    // ==========================================================================
    // Security Policies
    // ==========================================================================
    async createSecurityPolicy(name, principals, rules, active = true, description) {
        const response = await this.client.post(`/v1/teams/${this.config.teamName}/security_policy`, {
            name,
            description,
            active,
            principals,
            rules,
            type: 'default',
        });
        return response.data;
    }
}
// ============================================================================
// Static Token Operations
// ============================================================================
export async function issueServiceUserToken(baseUrl, teamName, keyId, keySecret) {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const url = `${normalizedBaseUrl}/v1/teams/${teamName}/service_token`;
    try {
        const response = await axios.post(url, { key_id: keyId, key_secret: keySecret }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout: 10000,
        });
        return response.data;
    }
    catch (error) {
        const err = error;
        throw new Error(`Failed to get service token: Status ${err.response?.status}, ` +
            `Response: ${JSON.stringify(err.response?.data)}`);
    }
}
export async function createOPAClientFromCredentials(baseUrl, teamName, keyId, keySecret) {
    const tokenResponse = await issueServiceUserToken(baseUrl, teamName, keyId, keySecret);
    return new OPAClient({
        baseUrl,
        teamName,
        token: tokenResponse.bearer_token,
    });
}
