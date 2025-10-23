// token-exchange.ts - Cross-App Access (ID-JAG) Token Exchange
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import axios from 'axios';

// ============================================================================
// Token Exchange Configuration
// ============================================================================

export interface TokenExchangeConfig {
  oktaDomain: string;
  clientId: string;
  privateKeyFile: string;
  targetAudience: string;
  tokenEndpoint: string;
  resourceTokenEndpoint?: string;
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
      jti: Math.random().toString(36).substring(7),
    };

    const signingOptions: jwt.SignOptions = {
      algorithm: 'RS256',
      expiresIn: '5m', // 5 minutes
      audience,
      issuer: this.config.clientId,
      subject: this.config.clientId,
      keyid: '{yourKID}',
    };

    return jwt.sign(jwtPayload, this.privateKey, signingOptions);
  }

  // ============================================================================
  // Step 1: Exchange ID Token for ID-JAG
  // ============================================================================

  private async exchangeIdTokenForIdJag(idToken: string): Promise<string> {
    const clientAssertion = this.createClientAssertion(
      `https://${this.config.oktaDomain}/oauth2/v1/token`
    );

    const formData = new URLSearchParams();
    formData.append('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
    formData.append('requested_token_type', 'urn:ietf:params:oauth:token-type:id-jag');
    formData.append('subject_token', idToken);
    formData.append('subject_token_type', 'urn:ietf:params:oauth:token-type:id_token');
    formData.append('audience', this.config.targetAudience);
    formData.append('client_id', this.config.clientId);
    formData.append('scope', 'read:todo0');
    formData.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    formData.append('client_assertion', clientAssertion);

    console.log(`🔄 Step 1: Exchanging ID token for ID-JAG token...`);
    console.log(`📍 Audience: ${this.config.targetAudience}`);
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
    const resourceTokenEndpoint = this.config.resourceTokenEndpoint ||
      `https://${this.config.oktaDomain}/oauth2/default/v1/token`;

    console.log(`🔄 Step 2: Exchanging ID-JAG for Access Token at Resource Server...`);
    console.log(`📍 Resource Token Endpoint: ${resourceTokenEndpoint}`);

    const clientAssertion = this.createClientAssertion(resourceTokenEndpoint);

    const resourceTokenForm = new URLSearchParams();
    resourceTokenForm.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    resourceTokenForm.append('assertion', idJag);
    resourceTokenForm.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    resourceTokenForm.append('client_assertion', clientAssertion);

    const response = await axios.post(
      resourceTokenEndpoint,
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
  // Full Token Exchange Flow
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

      if (!this.privateKey) {
        res.status(500).json({
          success: false,
          error: 'Cross-app access not configured properly. Private key not loaded.',
        });
        return;
      }

      console.log(`👻 Subject token: ${idToken}`);

      try {
        // Step 1: Exchange ID token for ID-JAG
        const idJag = await this.exchangeIdTokenForIdJag(idToken);

        // Step 2: Exchange ID-JAG for Access Token
        try {
          const accessTokenResponse = await this.exchangeIdJagForAccessToken(idJag);

          // Return the access token so the Resource Server can set it in the Agent
          const accessToken = accessTokenResponse.access_token;
          console.log('✅ Access token obtained successfully');
          console.log('💡 Token will be set in Agent for MCP tool calls');

          res.json({
            success: true,
            id_jag: idJag,
            access_token: accessToken,
            token_type: accessTokenResponse.token_type,
            expires_in: accessTokenResponse.expires_in,
            scope: accessTokenResponse.scope,
            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
          });
        } catch (resourceError: any) {
          console.error('❌ Failed to exchange ID-JAG for Access Token:', resourceError.response?.data || resourceError.message);

          // If the second step fails, return the ID-JAG anyway
          res.json({
            success: true,
            id_jag: idJag,
            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
            note: 'ID-JAG obtained successfully, but Access Token exchange failed',
            error: resourceError.response?.data || resourceError.message,
          });
        }
      } catch (error: any) {
        console.error('Token exchange request failed:', error.response?.data || error.message);
        res.status(500).json({
          success: false,
          error: 'Token exchange request failed',
          details: error.response?.data || error.message,
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

// ============================================================================
// Configuration Helper
// ============================================================================

export function createTokenExchangeConfig(): TokenExchangeConfig | null {
  const targetAudience = process.env.TARGET_SERVICE_AUDIENCE;
  const tokenEndpoint = process.env.OKTA_TOKEN_ENDPOINT;
  const clientId = process.env.AI_AGENT_ID;
  const oktaDomain = process.env.OKTA_DOMAIN;
  const privateKeyFile = process.env.OKTA_CC_PRIVATE_KEY_FILE;

  if (!targetAudience || !tokenEndpoint || !clientId || !oktaDomain || !privateKeyFile) {
    console.warn('⚠️  Cross-app access not fully configured. Missing required environment variables.');
    return null;
  }

  return {
    oktaDomain,
    clientId,
    privateKeyFile,
    targetAudience,
    tokenEndpoint,
    resourceTokenEndpoint: process.env.RESOURCE_TOKEN_ENDPOINT,
  };
}
