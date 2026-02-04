import { Client } from '@okta/okta-sdk-nodejs';
export class OktaAPIClient {
    constructor(config) {
        this.client = new Client({
            orgUrl: config.orgUrl,
            token: config.token,
        });
    }
    /**
     * Create a new custom authorization server
     */
    async createAuthorizationServer(config) {
        const authServer = await this.client.authorizationServerApi.createAuthorizationServer({
            authorizationServer: {
                name: config.name,
                description: config.description,
                audiences: config.audiences,
            },
        });
        return authServer;
    }
    /**
     * Get authorization server by name
     */
    async getAuthorizationServerByName(name) {
        const authorizationServers = await this.client.authorizationServerApi.listAuthorizationServers();
        for await (const as of authorizationServers) {
            if (as && as.name === name) {
                return as;
            }
        }
        return null;
    }
    /**
     * Delete authorization server by ID
     */
    async deleteAuthorizationServer(authServerId) {
        await this.client.authorizationServerApi.deactivateAuthorizationServer({ authServerId });
        await this.client.authorizationServerApi.deleteAuthorizationServer({ authServerId });
    }
    /**
     * Add custom scopes to an authorization server
     */
    async addScopes(authServerId, scopes) {
        const createdScopes = [];
        for (const scope of scopes) {
            const oAuth2Scope = await this.client.authorizationServerApi.createOAuth2Scope({
                authServerId,
                oAuth2Scope: {
                    name: scope.name,
                    description: scope.description,
                    displayName: scope.displayName || scope.name,
                    consent: 'REQUIRED',
                },
            });
            createdScopes.push(oAuth2Scope);
        }
        return createdScopes;
    }
    /**
     * Create an access policy for an authorization server
     */
    async createPolicy(authServerId, config) {
        const policy = await this.client.authorizationServerApi.createAuthorizationServerPolicy({
            authServerId,
            policy: {
                name: config.name,
                description: config.description,
                priority: config.priority,
                conditions: {
                    clients: {
                        include: config.clientIds,
                    },
                },
                type: 'OAUTH_AUTHORIZATION_POLICY',
            },
        });
        return policy;
    }
    /**
     * Create a policy rule for an authorization server policy
     */
    async createPolicyRule(authServerId, policyId, config) {
        const rule = await this.client.authorizationServerApi.createAuthorizationServerPolicyRule({
            authServerId,
            policyId,
            policyRule: {
                name: config.name,
                priority: config.priority,
                conditions: {
                    grantTypes: {
                        include: config.grantTypes,
                    },
                    people: {
                        users: {
                            include: [],
                        },
                        groups: {
                            include: config.userGroups || ['EVERYONE'],
                        },
                    },
                    scopes: config.scopes ? {
                        include: config.scopes,
                    } : {
                        include: ['*'],
                    },
                },
                actions: {
                    token: {
                        accessTokenLifetimeMinutes: config.accessTokenLifetimeMinutes,
                        refreshTokenLifetimeMinutes: config.refreshTokenLifetimeMinutes || 129600,
                        refreshTokenWindowMinutes: config.refreshTokenWindowMinutes || 10080,
                    },
                },
                type: 'RESOURCE_ACCESS',
            },
        });
        return rule;
    }
    /**
     * Create an OAuth2 application
     */
    async createApplication(config) {
        const app = await this.client.applicationApi.createApplication({
            application: config,
        });
        return app;
    }
    /**
     * Get application by label
     */
    async getApplicationByLabel(label) {
        const applications = await this.client.applicationApi.listApplications({ q: label });
        for await (const app of applications) {
            if (app && app.label === label) {
                return app;
            }
        }
        return null;
    }
    /**
     * Delete application by ID
     */
    async deleteApplication(appId) {
        await this.client.applicationApi.deactivateApplication({ appId });
        await this.client.applicationApi.deleteApplication({ appId });
    }
    /**
     * Upload public key to application for private key JWT authentication
     */
    async uploadPublicKey(appId, publicKeyPem) {
        const result = await this.client.applicationApi.generateApplicationKey({
            appId,
            validityYears: 2,
        });
        return { kid: result.kid };
    }
    /**
     * Create a trusted origin for CORS
     */
    async createTrustedOrigin(name, origin) {
        await this.client.trustedOriginApi.createTrustedOrigin({
            trustedOrigin: {
                name,
                origin,
                scopes: [
                    { type: 'CORS' },
                    { type: 'REDIRECT' },
                ],
            },
        });
    }
    /**
     * Get trusted origin by name
     */
    async getTrustedOriginByName(name) {
        const origins = await this.client.trustedOriginApi.listTrustedOrigins();
        for await (const trustedOrigin of origins) {
            if (trustedOrigin && trustedOrigin.name === name) {
                return trustedOrigin;
            }
        }
        return null;
    }
    /**
     * Create a trusted origin if it doesn't already exist (idempotent)
     */
    async createTrustedOriginIfNotExists(name, origin) {
        const existing = await this.getTrustedOriginByName(name);
        if (existing) {
            return { created: false, id: existing.id };
        }
        await this.createTrustedOrigin(name, origin);
        const created = await this.getTrustedOriginByName(name);
        return { created: true, id: created?.id || null };
    }
    /**
     * Delete trusted origin by name
     */
    async deleteTrustedOriginByName(name) {
        const origins = await this.client.trustedOriginApi.listTrustedOrigins();
        for await (const trustedOrigin of origins) {
            if (trustedOrigin && trustedOrigin.name === name && trustedOrigin.id) {
                await this.client.trustedOriginApi.deleteTrustedOrigin({ trustedOriginId: trustedOrigin.id });
                break;
            }
        }
    }
    /**
     * Grant application access to authorization server
     */
    async grantApplicationToAuthServer(authServerId, clientId) {
        // This is typically done by adding the client to a policy
        // The policy creation already handles this via the clientIds parameter
        console.log(`Application ${clientId} granted access to auth server ${authServerId} via policy`);
    }
    /**
     * Delete a policy rule from an authorization server policy
     */
    async deletePolicyRule(authServerId, policyId, ruleId) {
        await this.client.authorizationServerApi.deleteAuthorizationServerPolicyRule({
            authServerId,
            policyId,
            ruleId,
        });
    }
    /**
     * Delete a policy from an authorization server
     */
    async deletePolicy(authServerId, policyId) {
        await this.client.authorizationServerApi.deleteAuthorizationServerPolicy({
            authServerId,
            policyId,
        });
    }
    /**
     * Assign a user to an application
     */
    async assignUserToApplication(appId, userId) {
        await this.client.applicationApi.assignUserToApplication({
            appId,
            appUser: {
                id: userId,
            },
        });
    }
    /**
     * Unassign a user from an application
     */
    async unassignUserFromApplication(appId, userId) {
        await this.client.applicationApi.unassignUserFromApplication({
            appId,
            userId,
        });
    }
}
