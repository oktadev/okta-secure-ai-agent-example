// token-exchange.ts - Cross-App Access (ID-JAG) Token Exchange
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import axios from 'axios';

// Debug mode for verbose auth logging - OFF by default for security
// Set AUTH_DEBUG=true to enable detailed logging (includes sensitive data)
const AUTH_DEBUG = process.env.AUTH_DEBUG === 'true';

// ============================================================================
// Scope Challenge Types and Parser (MCP Authorization Best Practices)
// ============================================================================

export interface ScopeChallenge {
  error: string;
  scope: string[];
  resourceMetadata?: string;
  errorDescription?: string;
}

/**
 * Parse WWW-Authenticate header for scope challenges per MCP spec
 * Example: Bearer error="insufficient_scope", scope="files:read files:write", error_description="..."
 */
export function parseScopeChallenge(wwwAuthenticate: string): ScopeChallenge | null {
  if (!wwwAuthenticate || !wwwAuthenticate.startsWith('Bearer ')) {
    return null;
  }

  const params = wwwAuthenticate.substring(7); // Remove "Bearer "
  const result: ScopeChallenge = {
    error: '',
    scope: [],
  };

  // Parse key="value" pairs
  const regex = /(\w+)="([^"]*)"/g;
  let match;

  while ((match = regex.exec(params)) !== null) {
    const [, key, value] = match;
    switch (key) {
      case 'error':
        result.error = value;
        break;
      case 'scope':
        result.scope = value.split(' ').filter(s => s.length > 0);
        break;
      case 'resource_metadata':
        result.resourceMetadata = value;
        break;
      case 'error_description':
        result.errorDescription = value;
        break;
    }
  }

  // Only return if this is a scope challenge
  if (result.error === 'insufficient_scope' && result.scope.length > 0) {
    return result;
  }

  return null;
}

// ============================================================================
// Token Exchange Configuration
// ============================================================================

export interface TokenExchangeConfig {
  oktaDomain: string;
  clientId: string;
  privateKeyFile: string;
  privateKeyKid: string;
  authorizationServer: string;
  authorizationServerTokenEndpoint: string;
  agentScopes: string;
}

// ============================================================================
// Token Exchange Handler
// ============================================================================

export class TokenExchangeHandler {
  private config: TokenExchangeConfig;
  private privateKey: string | null = null;

  constructor(config: TokenExchangeConfig) {
    this.config = config;
    this.loadPrivateKey();
  }

  private loadPrivateKey(): void {
    try {
      const privateKeyPath = path.resolve(__dirname, '../..', this.config.privateKeyFile);
      this.privateKey = fs.readFileSync(privateKeyPath, 'utf8');
      console.log('🔑 Private key loaded for token exchange');
    } catch (error: any) {
      console.error('❌ Failed to load private key:', error.message);
      this.privateKey = null;
    }
  }

  // ============================================================================
  // Create Client Assertion JWT
  // ============================================================================

  private createClientAssertion(audience: string): string {
    if (!this.privateKey) {
      throw new Error('Private key not loaded');
    }

    const jwtPayload = {
      jti: randomUUID(),
    };

    const signingOptions: jwt.SignOptions = {
      algorithm: 'RS256',
      expiresIn: '5m', // 5 minutes
      audience,
      issuer: this.config.clientId,
      subject: this.config.clientId,
      keyid: this.config.privateKeyKid,
    };

    return jwt.sign(jwtPayload, this.privateKey, signingOptions);
  }

  // ============================================================================
  // Step 1: Exchange ID Token for ID-JAG
  // ============================================================================

  private async exchangeIdTokenForIdJag(idToken: string, scopes?: string): Promise<string> {
    const clientAssertion = this.createClientAssertion(
      `https://${this.config.oktaDomain}/oauth2/v1/token`
    );

    const formData = new URLSearchParams();
    formData.append('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
    formData.append('requested_token_type', 'urn:ietf:params:oauth:token-type:id-jag');
    formData.append('subject_token', idToken);
    formData.append('subject_token_type', 'urn:ietf:params:oauth:token-type:id_token');
    formData.append('audience', this.config.authorizationServer);
    formData.append('scope', scopes || this.config.agentScopes);
    formData.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    formData.append('client_assertion', clientAssertion);

    const requestedScopes = scopes || this.config.agentScopes;
    console.log(`🔄 Step 1: Exchanging ID token for ID-JAG token...`);
    console.log(`🎯 Requested scopes: ${requestedScopes}`);
    console.log(`📍 Audience: ${this.config.authorizationServer}`);
    console.log(`🆔 Client ID: ${this.config.clientId}`);

    const response = await axios.post(
      `https://${this.config.oktaDomain}/oauth2/v1/token`,
      formData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log(`✅ ID-JAG token obtained`);
    console.log(`🎯 Issued token type: ${response.data.issued_token_type}`);

    return response.data.access_token; // This is actually the ID-JAG token
  }

  // ============================================================================
  // Step 2: Exchange ID-JAG for Access Token
  // ============================================================================

  private async exchangeIdJagForAccessToken(idJag: string): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    scope?: string;
  }> {
    const authorizationServer = this.config.authorizationServer;
    const authorizationServerTokenEndpoint = this.config.authorizationServerTokenEndpoint;

    console.log(`🔄 Step 2: Exchanging ID-JAG for Access Token at Resource Server...`);
    console.log(`📍 MCP authorization server: ${authorizationServer}`);

    const clientAssertion = this.createClientAssertion(authorizationServerTokenEndpoint);

    const resourceTokenForm = new URLSearchParams();
    resourceTokenForm.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    resourceTokenForm.append('assertion', idJag);
    resourceTokenForm.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    resourceTokenForm.append('client_assertion', clientAssertion);

    const response = await axios.post(
      authorizationServerTokenEndpoint,
      resourceTokenForm,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log(`✅ Access Token obtained from Resource Server`);
    console.log(`🎯 Token type: ${response.data.token_type}`);
    console.log(`⏰ Expires in: ${response.data.expires_in}s`);

    return response.data;
  }

  // ============================================================================
  // Token Exchange Flow (Programmatic)
  // ============================================================================

  /**
   * Exchange ID token for MCP access token
   * @param idToken - The user's ID token
   * @param requestedScopes - Optional scopes to request (for step-up authorization)
   */
  async exchangeToken(idToken: string, requestedScopes?: string): Promise<{
    success: boolean;
    id_jag: string;
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    issued_token_type: string;
    note?: string;
    error?: any;
  }> {
    if (!this.privateKey) {
      throw new Error('Cross-app access not configured properly. Private key not loaded.');
    }

    // Only log tokens in debug mode - contains sensitive credentials
    if (AUTH_DEBUG) {
      console.log(`👻 Subject token: ${idToken}`);
    }
    if (requestedScopes) {
      console.log(`🔄 Step-up authorization requested with scopes: ${requestedScopes}`);
    }

    try {
      // Step 1: Exchange ID token for ID-JAG
      const idJag = await this.exchangeIdTokenForIdJag(idToken, requestedScopes);

      // Step 2: Exchange ID-JAG for Access Token
      try {
        const accessTokenResponse = await this.exchangeIdJagForAccessToken(idJag);

        // Return the access token
        const accessToken = accessTokenResponse.access_token;
        console.log('✅ Access token obtained successfully');
        console.log('💡 Token can be used for MCP tool calls');

        return {
          success: true,
          id_jag: idJag,
          access_token: accessToken,
          token_type: accessTokenResponse.token_type,
          expires_in: accessTokenResponse.expires_in,
          scope: accessTokenResponse.scope,
          issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        };
      } catch (resourceError: any) {
        console.error('❌ Failed to exchange ID-JAG for Access Token:', resourceError.response?.data || resourceError.message);

        // If the second step fails, return the ID-JAG anyway
        return {
          success: true,
          id_jag: idJag,
          issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
          note: 'ID-JAG obtained successfully, but Access Token exchange failed',
          error: resourceError.response?.data || resourceError.message,
        };
      }
    } catch (error: any) {
      console.error('Token exchange request failed:', error.response?.data || error.message);
      throw new Error(
        `Token exchange request failed: ${error.response?.data?.error_description || error.message}`
      );
    }
  }

  // ============================================================================
  // Full Token Exchange Flow (Express Handler)
  // ============================================================================

  async handleCrossAppAccess(req: Request, res: Response): Promise<void> {
    try {
      const session = req.session as any;
      const idToken = session.idToken;

      if (!idToken) {
        res.status(401).json({
          success: false,
          error: 'No ID token found in session',
        });
        return;
      }

      // Use the programmatic exchangeToken method
      try {
        const result = await this.exchangeToken(idToken);
        res.json(result);
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: 'Token exchange failed',
          details: error.message || 'Unknown error',
        });
      }
    } catch (error: any) {
      console.error('Error in cross-app access:', error);
      res.status(500).json({
        success: false,
        error: 'Token exchange failed',
        details: error.message || 'Unknown error',
      });
    }
  }
}

