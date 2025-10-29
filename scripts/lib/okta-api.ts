import {
  Client,
  AuthorizationServer,
  Application,
  OpenIdConnectApplication,
  OAuth2Scope,
  AuthorizationServerPolicyRule
} from '@okta/okta-sdk-nodejs';

export interface OktaConfig {
  orgUrl: string;
  token: string;
}

export interface AuthServerConfig {
  name: string;
  description: string;
  audiences: string[];
}

export interface ScopeConfig {
  name: string;
  description: string;
  displayName?: string;
}

export interface PolicyConfig {
  name: string;
  description: string;
  priority: number;
  clientIds: string[];
}

export interface PolicyRuleConfig {
  name: string;
  priority: number;
  grantTypes: string[];
  scopes?: string[];
  accessTokenLifetimeMinutes: number;
  refreshTokenLifetimeMinutes?: number;
  refreshTokenWindowMinutes?: number;
  userGroups?: string[];
}

import type { ApplicationSignOnMode } from '@okta/okta-sdk-nodejs';

export interface ApplicationConfig {
  name: string;
  label: string;
  signOnMode: ApplicationSignOnMode;
  credentials?: {
    oauthClient?: {
      token_endpoint_auth_method: string;
      autoKeyRotation?: boolean;
    };
  };
  settings: {
    oauthClient: {
      client_uri?: string;
      logo_uri?: string;
      redirect_uris?: string[];
      post_logout_redirect_uris?: string[];
      response_types?: string[];
      grant_types: string[];
      application_type?: string;
      consent_method?: string;
      issuer_mode?: string;
    };
    implicitAssignment?: boolean;
  };
}

export class OktaAPIClient {
  private client: Client;

  constructor(config: OktaConfig) {
    this.client = new Client({
      orgUrl: config.orgUrl,
      token: config.token,
    });
  }

  /**
   * Create a new custom authorization server
   */
  async createAuthorizationServer(config: AuthServerConfig): Promise<AuthorizationServer> {
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
  async getAuthorizationServerByName(name: string): Promise<AuthorizationServer | null> {
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
  async deleteAuthorizationServer(authServerId: string): Promise<void> {
    await this.client.authorizationServerApi.deactivateAuthorizationServer({ authServerId });
    await this.client.authorizationServerApi.deleteAuthorizationServer({ authServerId });
  }

  /**
   * Add custom scopes to an authorization server
   */
  async addScopes(authServerId: string, scopes: ScopeConfig[]): Promise<OAuth2Scope[]> {
    const createdScopes: OAuth2Scope[] = [];

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
  async createPolicy(authServerId: string, config: PolicyConfig): Promise<any> {
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
  async createPolicyRule(
    authServerId: string,
    policyId: string,
    config: PolicyRuleConfig
  ): Promise<AuthorizationServerPolicyRule> {
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
  async createApplication(config: ApplicationConfig): Promise<Application> {
    const app = await this.client.applicationApi.createApplication({
      application: config as any,
    });
    return app;
  }

  /**
   * Get application by label
   */
  async getApplicationByLabel(label: string): Promise<Application | null> {
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
  async deleteApplication(appId: string): Promise<void> {
    await this.client.applicationApi.deactivateApplication({ appId });
    await this.client.applicationApi.deleteApplication({ appId });
  }

  /**
   * Upload public key to application for private key JWT authentication
   */
  async uploadPublicKey(appId: string, publicKeyPem: string): Promise<{ kid: string }> {
    const result = await this.client.applicationApi.generateApplicationKey({
      appId,
      validityYears: 2,
    });
    return { kid: result.kid! };
  }

  /**
   * Create a trusted origin for CORS
   */
  async createTrustedOrigin(name: string, origin: string): Promise<void> {
    await this.client.trustedOriginApi.createTrustedOrigin({
      trustedOrigin: {
        name,
        origin,
        scopes: [
          { type: 'CORS' as const },
          { type: 'REDIRECT' as const },
        ],
      },
    });
  }

  /**
   * Delete trusted origin by name
   */
  async deleteTrustedOriginByName(name: string): Promise<void> {
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
  async grantApplicationToAuthServer(authServerId: string, clientId: string): Promise<void> {
    // This is typically done by adding the client to a policy
    // The policy creation already handles this via the clientIds parameter
    console.log(`Application ${clientId} granted access to auth server ${authServerId} via policy`);
  }

  /**
   * Delete a policy rule from an authorization server policy
   */
  async deletePolicyRule(authServerId: string, policyId: string, ruleId: string): Promise<void> {
    await this.client.authorizationServerApi.deleteAuthorizationServerPolicyRule({
      authServerId,
      policyId,
      ruleId,
    });
  }

  /**
   * Delete a policy from an authorization server
   */
  async deletePolicy(authServerId: string, policyId: string): Promise<void> {
    await this.client.authorizationServerApi.deleteAuthorizationServerPolicy({
      authServerId,
      policyId,
    });
  }
}
