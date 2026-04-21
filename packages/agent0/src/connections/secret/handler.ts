// opa-secrets.ts - Fetch LLM credentials from Okta Privileged Access (OPA) via Token Exchange
// Uses OAuth 2.0 Token Exchange to retrieve vaulted secrets from OPA

import { TokenExchangeHandler, TokenExchangeConfig } from '../authorization-server/handler.js';

// ============================================================================
// Types
// ============================================================================

export interface AnthropicCredentials {
  provider: 'anthropic';
  apiKey: string;
  model: string;
}

export interface BedrockCredentials {
  provider: 'bedrock';
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  bedrockModelId: string;
}

export type LLMCredentials = AnthropicCredentials | BedrockCredentials;

// ============================================================================
// Credential Cache (per-user, with TTL)
// ============================================================================

interface CachedCredentials {
  credentials: LLMCredentials;
  idTokenHash: string;  // Hash of ID token to detect refresh
  expiresAt: number;    // Unix timestamp in ms
}

const credentialCache = new Map<string, CachedCredentials>();
const CACHE_TTL_MS = 55 * 60 * 1000; // 55 minutes (ID tokens typically expire in 1 hour)

/**
 * Simple hash for ID token (to detect token refresh without storing full token)
 */
function hashToken(token: string): string {
  // Use last 16 chars of token as a simple fingerprint
  return token.slice(-16);
}

/**
 * Get cached credentials for a user
 */
function getCachedCredentials(userId: string, idToken: string): LLMCredentials | null {
  const cached = credentialCache.get(userId);
  if (!cached) return null;

  const tokenHash = hashToken(idToken);
  const now = Date.now();

  // Check if cache is valid (not expired and same token)
  if (cached.expiresAt > now && cached.idTokenHash === tokenHash) {
    return cached.credentials;
  }

  // Cache is stale, remove it
  credentialCache.delete(userId);
  return null;
}

/**
 * Cache credentials for a user
 */
function cacheCredentials(userId: string, idToken: string, credentials: LLMCredentials): void {
  credentialCache.set(userId, {
    credentials,
    idTokenHash: hashToken(idToken),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Clear cached credentials for a user (useful on logout)
 */
export function clearCredentialCache(userId?: string): void {
  if (userId) {
    credentialCache.delete(userId);
  } else {
    credentialCache.clear();
  }
}

// ============================================================================
// Token Exchange Handler (Singleton)
// ============================================================================

let tokenExchangeHandler: TokenExchangeHandler | null = null;

function getTokenExchangeHandler(): TokenExchangeHandler {
  if (!tokenExchangeHandler) {
    const config: TokenExchangeConfig = {
      oktaDomain: process.env.OKTA_DOMAIN || '',
      clientId: process.env.AI_AGENT_ID || '',
      privateKeyFile: process.env.AI_AGENT_PRIVATE_KEY_FILE || '',
      privateKeyKid: process.env.AI_AGENT_PRIVATE_KEY_KID || '',
      authorizationServer: process.env.MCP_AUTHORIZATION_SERVER || '',
      authorizationServerTokenEndpoint: process.env.MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT || '',
      agentScopes: process.env.AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST || '',
    };
    tokenExchangeHandler = new TokenExchangeHandler(config);
  }
  return tokenExchangeHandler;
}

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Check if OPA secret management is configured (token exchange mode)
 * Requires agent identity config and at least one secret ORN
 */
export function isOPAConfigured(): boolean {
  return !!(
    process.env.OKTA_DOMAIN &&
    process.env.AI_AGENT_ID &&
    process.env.AI_AGENT_PRIVATE_KEY_FILE &&
    process.env.AI_AGENT_PRIVATE_KEY_KID &&
    process.env.OPA_LLM_PROVIDER &&
    (process.env.OPA_ANTHROPIC_API_KEY_ORN || process.env.OPA_AWS_ACCESS_KEY_ORN)
  );
}

/**
 * Get the configured LLM provider
 */
export function getOPALLMProvider(): 'anthropic' | 'bedrock' | null {
  const provider = process.env.OPA_LLM_PROVIDER;
  if (provider === 'anthropic' || provider === 'bedrock') {
    return provider;
  }
  return null;
}

// ============================================================================
// Secret Retrieval via Token Exchange
// ============================================================================

/**
 * Retrieve a vaulted secret by its ORN using token exchange
 * @param idToken - The user's ID token (for delegation)
 * @param secretOrn - The ORN of the secret (e.g., orn:okta:pam:{orgId}:secrets:{secretId})
 * @param secretName - Optional name for logging
 * @returns The secret value
 */
export async function getSecretByOrn(
  idToken: string,
  secretOrn: string,
  secretName?: string
): Promise<string> {
  const handler = getTokenExchangeHandler();
  return handler.exchangeIdTokenForVaultedSecret(idToken, secretOrn, secretName);
}

/**
 * Retrieve multiple secrets in parallel
 * @param idToken - The user's ID token
 * @param secrets - Array of {orn, name} pairs
 * @returns Map of name to value
 */
export async function getSecretsParallel(
  idToken: string,
  secrets: Array<{ orn: string; name: string }>
): Promise<Map<string, string>> {
  const handler = getTokenExchangeHandler();
  const results = new Map<string, string>();

  const promises = secrets.map(async ({ orn, name }) => {
    try {
      const value = await handler.exchangeIdTokenForVaultedSecret(idToken, orn, name);
      return { name, value, error: null };
    } catch (error: any) {
      return { name, value: null, error: error.message };
    }
  });

  const settled = await Promise.all(promises);

  for (const result of settled) {
    if (result.value) {
      results.set(result.name, result.value);
    } else {
      console.error(`❌ Failed to fetch secret ${result.name}: ${result.error}`);
    }
  }

  return results;
}

// ============================================================================
// LLM Credential Fetching via Token Exchange
// ============================================================================

/**
 * Fetch LLM credentials from OPA via token exchange
 * @param idToken - The user's ID token (required for delegation)
 * @param userId - Optional user ID for caching (defaults to extracting from token)
 * @returns LLM credentials or null if not configured/failed
 */
export async function fetchLLMCredentialsFromOPA(
  idToken: string,
  userId?: string
): Promise<LLMCredentials | null> {
  if (!isOPAConfigured()) {
    return null;
  }

  const provider = getOPALLMProvider();
  if (!provider) {
    console.error('OPA_LLM_PROVIDER not set or invalid');
    return null;
  }

  // Try to get user ID from token if not provided
  const cacheKey = userId || extractUserIdFromToken(idToken) || 'default';

  // Check cache first
  const cached = getCachedCredentials(cacheKey, idToken);
  if (cached) {
    return cached;
  }

  try {
    let credentials: LLMCredentials;

    if (provider === 'anthropic') {
      credentials = await fetchAnthropicCredentials(idToken);
    } else if (provider === 'bedrock') {
      credentials = await fetchBedrockCredentials(idToken);
    } else {
      return null;
    }

    // Cache the credentials
    cacheCredentials(cacheKey, idToken, credentials);
    return credentials;
  } catch (error: any) {
    console.error('❌ Failed to fetch credentials from OPA:', error.message);

    if (error.message?.includes('invalid_grant')) {
      console.error('   Token exchange failed - check agent permissions and user authorization');
    } else if (error.message?.includes('invalid_target')) {
      console.error('   Invalid secret ORN - check OPA_*_ORN environment variables');
    } else if (error.message?.includes('Empty secret')) {
      console.error('   Secret exists but has empty value - check OPA secret configuration');
    }

    return null;
  }
}

/**
 * Extract user ID from ID token (without full JWT parsing)
 */
function extractUserIdFromToken(idToken: string): string | null {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload.sub || null;
  } catch {
    return null;
  }
}

/**
 * Fetch Anthropic credentials from OPA via token exchange (parallel)
 */
async function fetchAnthropicCredentials(idToken: string): Promise<AnthropicCredentials> {
  const apiKeyOrn = process.env.OPA_ANTHROPIC_API_KEY_ORN;
  if (!apiKeyOrn) {
    throw new Error('OPA_ANTHROPIC_API_KEY_ORN not configured');
  }

  const modelOrn = process.env.OPA_ANTHROPIC_MODEL_ORN;
  const defaultModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

  // Build list of secrets to fetch
  const secretsToFetch: Array<{ orn: string; name: string }> = [
    { orn: apiKeyOrn, name: 'ANTHROPIC_API_KEY' },
  ];

  if (modelOrn) {
    secretsToFetch.push({ orn: modelOrn, name: 'ANTHROPIC_MODEL' });
  }

  // Fetch all secrets in parallel
  const secrets = await getSecretsParallel(idToken, secretsToFetch);

  const apiKey = secrets.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('Failed to retrieve ANTHROPIC_API_KEY from OPA');
  }

  const model = secrets.get('ANTHROPIC_MODEL') || defaultModel;

  return {
    provider: 'anthropic',
    apiKey,
    model,
  };
}

/**
 * Fetch AWS Bedrock credentials from OPA via token exchange (parallel)
 */
async function fetchBedrockCredentials(idToken: string): Promise<BedrockCredentials> {
  const accessKeyOrn = process.env.OPA_AWS_ACCESS_KEY_ORN;
  const secretKeyOrn = process.env.OPA_AWS_SECRET_ACCESS_KEY_ORN;
  const sessionTokenOrn = process.env.OPA_AWS_SESSION_TOKEN_ORN;

  if (!accessKeyOrn || !secretKeyOrn) {
    throw new Error('OPA_AWS_ACCESS_KEY_ORN and OPA_AWS_SECRET_ACCESS_KEY_ORN must be configured');
  }

  // Build list of secrets to fetch
  const secretsToFetch: Array<{ orn: string; name: string }> = [
    { orn: accessKeyOrn, name: 'AWS_ACCESS_KEY_ID' },
    { orn: secretKeyOrn, name: 'AWS_SECRET_ACCESS_KEY' },
  ];

  if (sessionTokenOrn) {
    secretsToFetch.push({ orn: sessionTokenOrn, name: 'AWS_SESSION_TOKEN' });
  }

  // Fetch all secrets in parallel
  const secrets = await getSecretsParallel(idToken, secretsToFetch);

  const awsAccessKeyId = secrets.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = secrets.get('AWS_SECRET_ACCESS_KEY');

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    const missing = [];
    if (!awsAccessKeyId) missing.push('AWS_ACCESS_KEY_ID');
    if (!awsSecretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
    throw new Error(`Failed to retrieve ${missing.join(', ')} from OPA`);
  }

  const awsSessionToken = secrets.get('AWS_SESSION_TOKEN');
  const awsRegion = process.env.AWS_REGION || 'us-east-1';
  const bedrockModelId = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';

  return {
    provider: 'bedrock',
    awsRegion,
    awsAccessKeyId,
    awsSecretAccessKey,
    awsSessionToken,
    bedrockModelId,
  };
}
