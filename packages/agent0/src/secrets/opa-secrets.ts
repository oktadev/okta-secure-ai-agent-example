// opa-secrets.ts - Fetch LLM credentials from Okta Privileged Access (OPA)
import {
  OPAClient,
  createOPAClientFromCredentials,
  type RevealedSecret,
} from './opa-api.js';

// ============================================================================
// Types
// ============================================================================

export interface OPARuntimeConfig {
  baseUrl: string;
  teamName: string;
  keyId: string;
  keySecret: string;
  resourceGroupId: string;
  projectId: string;
  folderId?: string | undefined;
}

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
// Token Caching
// ============================================================================

interface CachedClient {
  client: OPAClient;
  expiresAt: number; // Unix timestamp in ms
  configHash: string;
}

let cachedClient: CachedClient | null = null;

/**
 * Generate a hash of config for cache invalidation
 */
function getConfigHash(cfg: OPARuntimeConfig): string {
  return `${cfg.baseUrl}:${cfg.teamName}:${cfg.keyId}`;
}

/**
 * Create an authenticated OPA client using runtime credentials
 * Uses token caching to avoid repeated authentication (tokens expire after ~1 hour)
 */
async function createRuntimeClient(config: OPARuntimeConfig): Promise<OPAClient> {
  const configHash = getConfigHash(config);

  // Check if we have a valid cached client
  // Use 5-minute buffer before expiry to avoid edge cases
  const bufferMs = 5 * 60 * 1000;
  if (cachedClient &&
      cachedClient.configHash === configHash &&
      cachedClient.expiresAt > Date.now() + bufferMs) {
    return cachedClient.client;
  }

  // Create new client and cache it
  const client = await createOPAClientFromCredentials(
    config.baseUrl,
    config.teamName,
    config.keyId,
    config.keySecret
  );

  // Cache with 1-hour expiry (OPA tokens typically expire in 1 hour)
  cachedClient = {
    client,
    expiresAt: Date.now() + 60 * 60 * 1000,
    configHash,
  };

  return client;
}

/**
 * Clear the cached client (useful for testing or forced re-authentication)
 */
export function clearClientCache(): void {
  cachedClient = null;
}

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Check if OPA secret management is configured with new API key auth
 */
export function isOPAConfigured(): boolean {
  return !!(
    process.env.OPA_BASE_URL &&
    process.env.OPA_TEAM_NAME &&
    process.env.OPA_KEY_ID &&
    process.env.OPA_KEY_SECRET &&
    process.env.OPA_RESOURCE_GROUP_ID &&
    process.env.OPA_PROJECT_ID &&
    process.env.OPA_LLM_PROVIDER
  );
}

/**
 * Check if legacy token-based OPA configuration is present
 */
export function isLegacyOPAConfigured(): boolean {
  return !!(
    process.env.OPA_BASE_URL &&
    process.env.OPA_TEAM_NAME &&
    process.env.OPA_SERVICE_ACCOUNT_TOKEN &&
    process.env.OPA_RESOURCE_GROUP_ID &&
    process.env.OPA_PROJECT_ID &&
    process.env.OPA_LLM_PROVIDER
  );
}

/**
 * Get OPA runtime configuration from environment variables
 */
function getOPARuntimeConfig(): OPARuntimeConfig {
  const baseUrl = process.env.OPA_BASE_URL;
  const teamName = process.env.OPA_TEAM_NAME;
  const keyId = process.env.OPA_KEY_ID;
  const keySecret = process.env.OPA_KEY_SECRET;
  const resourceGroupId = process.env.OPA_RESOURCE_GROUP_ID;
  const projectId = process.env.OPA_PROJECT_ID;
  const folderId = process.env.OPA_FOLDER_ID;

  if (!baseUrl || !teamName || !keyId || !keySecret || !resourceGroupId || !projectId) {
    throw new Error(
      'Missing OPA runtime configuration. Required environment variables:\n' +
      '  OPA_BASE_URL, OPA_TEAM_NAME, OPA_KEY_ID, OPA_KEY_SECRET,\n' +
      '  OPA_RESOURCE_GROUP_ID, OPA_PROJECT_ID\n\n' +
      'Set up OPA secrets using the setup-opa-secrets script.'
    );
  }

  return { baseUrl, teamName, keyId, keySecret, resourceGroupId, projectId, folderId };
}

// ============================================================================
// Secret Retrieval Functions
// ============================================================================

/**
 * Retrieve a single secret by name
 */
export async function getSecretByName(
  secretName: string,
  config?: OPARuntimeConfig
): Promise<string> {
  const cfg = config || getOPARuntimeConfig();
  const client = await createRuntimeClient(cfg);

  const secret = await client.getSecretByName(
    cfg.resourceGroupId,
    cfg.projectId,
    secretName,
    cfg.folderId
  );

  if (!secret) {
    throw new Error(`Secret not found: ${secretName}`);
  }

  const revealed = await client.revealSecret(
    cfg.resourceGroupId,
    cfg.projectId,
    secret.id
  );

  return revealed.secret;
}

/**
 * Retrieve a secret by its ID
 */
export async function getSecretById(
  secretId: string,
  config?: OPARuntimeConfig
): Promise<RevealedSecret> {
  const cfg = config || getOPARuntimeConfig();
  const client = await createRuntimeClient(cfg);

  return client.revealSecret(cfg.resourceGroupId, cfg.projectId, secretId);
}

/**
 * Retrieve multiple secrets by name
 */
export async function getSecrets(
  secretNames: string[],
  config?: OPARuntimeConfig
): Promise<Record<string, string>> {
  const cfg = config || getOPARuntimeConfig();
  const client = await createRuntimeClient(cfg);
  const results: Record<string, string> = {};

  for (const name of secretNames) {
    const secret = await client.getSecretByName(
      cfg.resourceGroupId,
      cfg.projectId,
      name,
      cfg.folderId
    );

    if (secret) {
      const revealed = await client.revealSecret(
        cfg.resourceGroupId,
        cfg.projectId,
        secret.id
      );
      results[name] = revealed.secret;
    }
  }

  return results;
}

/**
 * List all secret names in the configured folder
 */
export async function listSecretNames(
  config?: OPARuntimeConfig
): Promise<string[]> {
  const cfg = config || getOPARuntimeConfig();
  const client = await createRuntimeClient(cfg);

  const secrets = await client.listSecretsInProject(
    cfg.resourceGroupId,
    cfg.projectId,
    cfg.folderId
  );

  return secrets.map(s => s.name);
}

// ============================================================================
// LLM Credential Fetching
// ============================================================================

/**
 * Fetch LLM credentials from OPA
 * Returns null if OPA is not configured or secrets cannot be retrieved
 */
export async function fetchLLMCredentialsFromOPA(): Promise<LLMCredentials | null> {
  if (!isOPAConfigured()) {
    console.log('OPA secret management not configured, skipping...');
    return null;
  }

  const provider = process.env.OPA_LLM_PROVIDER;

  console.log('Fetching LLM credentials from OPA...');
  console.log(`  Provider: ${provider}`);

  try {
    if (provider === 'anthropic') {
      return await fetchAnthropicCredentials();
    } else if (provider === 'bedrock') {
      return await fetchBedrockCredentials();
    } else {
      console.error(`Unknown LLM provider: ${provider}`);
      return null;
    }
  } catch (error: any) {
    console.error('Failed to fetch credentials from OPA:', error.message);

    // Check for specific error types
    if (error.message?.includes('401')) {
      console.error('  OPA authentication failed - check OPA_KEY_ID and OPA_KEY_SECRET');
    } else if (error.message?.includes('403')) {
      console.error('  OPA authorization failed - check service user permissions');
    } else if (error.message?.includes('ECONNREFUSED') || error.message?.includes('ENOTFOUND')) {
      console.error('  Cannot connect to OPA server - check OPA_BASE_URL');
    }

    return null;
  }
}

/**
 * Fetch Anthropic credentials from OPA
 */
async function fetchAnthropicCredentials(): Promise<AnthropicCredentials> {
  const apiKeySecretName = process.env.OPA_ANTHROPIC_SECRET_NAME || 'ANTHROPIC_API_KEY';
  const modelSecretName = process.env.OPA_ANTHROPIC_MODEL_SECRET_NAME;

  console.log(`  Fetching Anthropic API key (secret: ${apiKeySecretName})`);
  const apiKey = await getSecretByName(apiKeySecretName);

  // Fetch model from OPA if configured, otherwise fall back to env var
  let model: string;
  if (modelSecretName) {
    console.log(`  Fetching Anthropic model (secret: ${modelSecretName})`);
    model = await getSecretByName(modelSecretName);
  } else {
    model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
    console.log(`  Using model from env: ${model}`);
  }

  console.log('Successfully retrieved Anthropic credentials from OPA');

  return {
    provider: 'anthropic',
    apiKey,
    model,
  };
}

/**
 * Fetch AWS Bedrock credentials from OPA
 */
async function fetchBedrockCredentials(): Promise<BedrockCredentials> {
  const accessKeySecretName = process.env.OPA_AWS_ACCESS_KEY_ID_SECRET_NAME || 'AWS_ACCESS_KEY_ID';
  const secretKeySecretName = process.env.OPA_AWS_SECRET_ACCESS_KEY_SECRET_NAME || 'AWS_SECRET_ACCESS_KEY';
  const sessionTokenSecretName = process.env.OPA_AWS_SESSION_TOKEN_SECRET_NAME;
  const awsRegion = process.env.AWS_REGION || 'us-east-1';
  const bedrockModelId = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';

  console.log('  Fetching AWS credentials from OPA...');

  // Fetch required credentials
  const secretNames = [accessKeySecretName, secretKeySecretName];
  if (sessionTokenSecretName) {
    secretNames.push(sessionTokenSecretName);
  }

  const secrets = await getSecrets(secretNames);

  const awsAccessKeyId = secrets[accessKeySecretName];
  const awsSecretAccessKey = secrets[secretKeySecretName];
  const awsSessionToken = sessionTokenSecretName ? secrets[sessionTokenSecretName] : undefined;

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('Failed to retrieve AWS credentials from OPA');
  }

  console.log('Successfully retrieved AWS Bedrock credentials from OPA');

  return {
    provider: 'bedrock',
    awsRegion,
    awsAccessKeyId,
    awsSecretAccessKey,
    awsSessionToken,
    bedrockModelId,
  };
}

// Re-export types from opa-api for convenience
export type { RevealedSecret } from './opa-api.js';
