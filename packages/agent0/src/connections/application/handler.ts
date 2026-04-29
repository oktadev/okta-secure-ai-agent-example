// connections/application/handler.ts - OAuth STS Brokered Consent Token Exchange
//
// Connection type: "Application" in Okta's Add-connection UI.
// Flow: ID token -> Okta STS exchange (brokered consent) -> ISV access token.
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import axios from 'axios';

// ============================================================================
// OAuth STS Result Types (Discriminated Union)
// ============================================================================

export type OAuthStsResult =
  | { status: 'success'; access_token: string; token_type: string; scope?: string; expires_in: number }
  | { status: 'interaction_required'; interaction_uri: string; error_description?: string }
  | { status: 'error'; error: string; error_description?: string };

// ============================================================================
// OAuth STS Configuration
// ============================================================================

export interface OAuthStsConfig {
  oktaDomain: string;
  clientId: string;
  privateKeyFile: string;
  privateKeyKid: string;
  resource: string;
}

// ============================================================================
// OAuth STS Handler
// ============================================================================

export class OAuthStsHandler {
  private config: OAuthStsConfig;
  private privateKey: string | null = null;

  // Per-instance token cache (Agent is per-user, so this caches per-user)
  private cachedAccessToken: string | null = null;
  private cachedTokenExpiry: number = 0;

  // "Has the user ever successfully authorized this resource?" The in-memory
  // access-token cache comes and goes with the `expires_in` TTL; this flag
  // persists beyond that so the UI can show the Application connection as
  // Live across token-refresh gaps. Reset only on explicit revoke
  // (clearCachedToken) or on process restart — both reset the cache too.
  private hasEverSucceeded: boolean = false;

  constructor(config: OAuthStsConfig) {
    this.config = config;
    this.loadPrivateKey();
  }

  private loadPrivateKey(): void {
    try {
      // __dirname at runtime: dist/connections/application
      // -> package root (three levels up) holds the .pem referenced by AI_AGENT_PRIVATE_KEY_FILE
      const privateKeyPath = path.resolve(__dirname, '../../..', this.config.privateKeyFile);
      this.privateKey = fs.readFileSync(privateKeyPath, 'utf8');
      console.log('🔑 Private key loaded for OAuth STS exchange');
    } catch (error: any) {
      console.error('❌ Failed to load private key for OAuth STS:', error.message);
      this.privateKey = null;
    }
  }

  // ============================================================================
  // Create Client Assertion JWT
  // ============================================================================

  private createClientAssertion(audience: string): string {
    if (!this.privateKey) {
      throw new Error('Private key not loaded for OAuth STS');
    }

    const jwtPayload = {
      jti: randomUUID(),
    };

    const signingOptions: jwt.SignOptions = {
      algorithm: 'RS256',
      expiresIn: '5m',
      audience,
      issuer: this.config.clientId,
      subject: this.config.clientId,
      keyid: this.config.privateKeyKid,
    };

    return jwt.sign(jwtPayload, this.privateKey, signingOptions);
  }

  // ============================================================================
  // Cached Token Access
  // ============================================================================

  getCachedToken(): string | null {
    if (this.cachedAccessToken && Date.now() < this.cachedTokenExpiry) {
      return this.cachedAccessToken;
    }
    this.cachedAccessToken = null;
    this.cachedTokenExpiry = 0;
    return null;
  }

  /**
   * True once any exchange has returned an access token for this handler's
   * resource. Survives token expiry — use this for UI "connected" state;
   * use getCachedToken() when you actually need a bearer token.
   */
  isAuthorized(): boolean {
    return this.hasEverSucceeded;
  }

  clearCachedToken(): void {
    this.cachedAccessToken = null;
    this.cachedTokenExpiry = 0;
    // Explicit clear = revoke. Drop the "ever succeeded" flag too so the UI
    // flips back to Idle.
    this.hasEverSucceeded = false;
  }

  // ============================================================================
  // OAuth STS Token Exchange
  // ============================================================================

  async exchangeForISVToken(idToken: string): Promise<OAuthStsResult> {
    if (!this.privateKey) {
      return {
        status: 'error',
        error: 'configuration_error',
        error_description: 'Private key not loaded for OAuth STS exchange',
      };
    }

    // Return cached token if still valid
    const cached = this.getCachedToken();
    if (cached) {
      console.log('✅ Using cached ISV access token');
      return {
        status: 'success',
        access_token: cached,
        token_type: 'Bearer',
        expires_in: Math.floor((this.cachedTokenExpiry - Date.now()) / 1000),
      };
    }

    const tokenEndpoint = `https://${this.config.oktaDomain}/oauth2/v1/token`;
    const clientAssertion = this.createClientAssertion(tokenEndpoint);

    const formData = new URLSearchParams();
    formData.append('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
    formData.append('requested_token_type', 'urn:okta:params:oauth:token-type:oauth-sts');
    formData.append('subject_token', idToken);
    formData.append('subject_token_type', 'urn:ietf:params:oauth:token-type:id_token');
    formData.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    formData.append('client_assertion', clientAssertion);
    formData.append('resource', this.config.resource);

    console.log('🔄 OAuth STS: Exchanging ID token for ISV access token...');
    console.log(`📍 Resource: ${this.config.resource}`);

    try {
      const response = await axios.post(tokenEndpoint, formData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      // Success - cache the token
      const { access_token, token_type, scope, expires_in } = response.data;
      this.cachedAccessToken = access_token;
      // Cache with 60s buffer before actual expiry
      this.cachedTokenExpiry = Date.now() + (expires_in - 60) * 1000;
      this.hasEverSucceeded = true;

      console.log('✅ OAuth STS: ISV access token obtained');
      console.log(`⏰ Expires in: ${expires_in}s`);
      console.log(`🔑 Token type: ${token_type}`);
      console.log(`📋 Scopes granted: ${scope || '(none returned)'}`);

      return { status: 'success', access_token, token_type, scope, expires_in };
    } catch (error: any) {
      const errorData = error.response?.data;

      if (errorData?.error === 'interaction_required') {
        console.log('🔗 OAuth STS: User interaction required');
        console.log(`📍 Interaction URI: ${errorData.interaction_uri}`);
        return {
          status: 'interaction_required',
          interaction_uri: errorData.interaction_uri,
          error_description: errorData.error_description,
        };
      }

      console.error('❌ OAuth STS exchange failed:', errorData || error.message);
      return {
        status: 'error',
        error: errorData?.error || 'exchange_failed',
        error_description: errorData?.error_description || error.message,
      };
    }
  }
}
