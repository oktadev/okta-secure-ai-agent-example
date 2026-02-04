// agent.ts - Agent Identity: MCP Client + LLM Integration
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { TokenExchangeHandler, TokenExchangeConfig, parseScopeChallenge } from './auth/token-exchange.js';

// ============================================================================
// Scope Challenge Types
// ============================================================================

interface ScopeChallenge {
  error: string;
  scope: string[];
  errorDescription?: string;
}

/**
 * Extract scope challenge from any source (HTTP error, MCP response, or error message)
 * Returns null if no scope challenge found
 */
function extractScopeChallenge(source: any): ScopeChallenge | null {
  if (!source) return null;

  // Source 1: MCP tool response with isError
  if (source.isError && source.content) {
    for (const block of source.content) {
      if (block.type === 'text' && block.text) {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed.error === 'insufficient_scope') {
            if (parsed.www_authenticate) {
              return parseScopeChallenge(parsed.www_authenticate);
            }
            if (parsed.required_scopes?.length) {
              return {
                error: 'insufficient_scope',
                scope: parsed.required_scopes,
                errorDescription: parsed.error_description,
              };
            }
          }
        } catch { /* not JSON */ }
      }
    }
  }

  // Source 2: WWW-Authenticate header (various locations)
  const wwwAuth =
    source.response?.headers?.get?.('www-authenticate') ||
    source.response?.headers?.['www-authenticate'] ||
    source.headers?.get?.('www-authenticate') ||
    source.headers?.['www-authenticate'] ||
    source.data?.headers?.['www-authenticate'];

  if (wwwAuth) {
    return parseScopeChallenge(wwwAuth);
  }

  // Source 3: Error message containing WWW-Authenticate
  if (source.message) {
    const match = source.message.match(/WWW-Authenticate:\s*(Bearer[^\n]+)/i);
    if (match) {
      return parseScopeChallenge(match[1]);
    }
  }

  return null;
}

import { Request } from 'express';
import * as dotenv from 'dotenv';
import {
  isOPAConfigured,
  fetchLLMCredentialsFromOPA,
} from './secrets/opa-secrets.js';

// Load environment variables for agent
dotenv.config({ path: path.resolve(__dirname, '../.env.agent') });
// Load OPA configuration (if present)
dotenv.config({ path: path.resolve(__dirname, '../.env.opa') });

// ============================================================================
// Agent LLM Configuration Types
// ============================================================================

/**
 * Agent LLM configuration (discriminated union for Anthropic vs Bedrock)
 */
type AgentLLMConfig = {
  mcpServerUrl: string;
} & (
  | {
      llmProvider: 'anthropic';
      anthropicApiKey: string;
      anthropicModel: string;
    }
  | {
      llmProvider: 'bedrock';
      awsRegion: string;
      awsAccessKeyId: string;
      awsSecretAccessKey: string;
      awsSessionToken?: string; // Optional
      bedrockModelId: string;
    }
);

// ============================================================================
// Environment Validation Function
// ============================================================================

/**
 * Validate agent LLM environment variables and return typed configuration
 */
function validateAgentLLMEnv(): AgentLLMConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  // Check MCP_SERVER_URL
  if (!process.env.MCP_SERVER_URL || process.env.MCP_SERVER_URL.trim() === '') {
    missing.push('MCP_SERVER_URL');
  } else {
    try {
      new URL(process.env.MCP_SERVER_URL);
    } catch {
      invalid.push('MCP_SERVER_URL (invalid URL format)');
    }
  }

  // Detect which LLM provider is being configured
  const hasAnthropicKey = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim() !== '';
  const hasBedrockVars = (process.env.AWS_REGION && process.env.AWS_REGION.trim() !== '') ||
                          (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_KEY_ID.trim() !== '');

  // Error if both providers are configured
  if (hasAnthropicKey && hasBedrockVars) {
    console.error('❌ Environment configuration error in .env.agent');
    console.error('   Cannot configure both Anthropic and AWS Bedrock providers');
    console.error('   Please choose one LLM provider:');
    console.error('   - For Anthropic: Set ANTHROPIC_API_KEY and ANTHROPIC_MODEL');
    console.error('   - For Bedrock: Set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, BEDROCK_MODEL_ID');
    process.exit(1);
  }

  // Error if neither provider is configured
  if (!hasAnthropicKey && !hasBedrockVars) {
    console.error('❌ No LLM credentials configured\n');
    console.error('   You have two options to configure LLM credentials:\n');
    console.error('   Option 1: Direct Mode (simple, credentials in .env.agent)');
    console.error('   ─────────────────────────────────────────────────────────');
    console.error('   For Anthropic:');
    console.error('     ANTHROPIC_API_KEY=sk-ant-...');
    console.error('     ANTHROPIC_MODEL=claude-sonnet-4-20250514\n');
    console.error('   For AWS Bedrock:');
    console.error('     AWS_REGION=us-east-1');
    console.error('     AWS_ACCESS_KEY_ID=AKIA...');
    console.error('     AWS_SECRET_ACCESS_KEY=...');
    console.error('     BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0\n');
    console.error('   Option 2: OPA Mode (secure, credentials from Okta PAM)');
    console.error('   ─────────────────────────────────────────────────────────');
    console.error('   Requires .env.opa with:');
    console.error('     OPA_LLM_PROVIDER=anthropic');
    console.error('     OPA_ANTHROPIC_API_KEY_ORN=orn:okta:pam:{orgId}:secrets:{secretId}\n');
    console.error('   Run: pnpm run setup:opa (then link secrets to agent)\n');
    process.exit(1);
  }

  // Validate Anthropic configuration
  if (hasAnthropicKey) {
    if (!process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL.trim() === '') {
      missing.push('ANTHROPIC_MODEL');
    }
  }

  // Validate Bedrock configuration
  if (hasBedrockVars) {
    if (!process.env.AWS_REGION || process.env.AWS_REGION.trim() === '') {
      missing.push('AWS_REGION');
    }
    if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID.trim() === '') {
      missing.push('AWS_ACCESS_KEY_ID');
    }
    if (!process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY.trim() === '') {
      missing.push('AWS_SECRET_ACCESS_KEY');
    }
    if (!process.env.BEDROCK_MODEL_ID || process.env.BEDROCK_MODEL_ID.trim() === '') {
      missing.push('BEDROCK_MODEL_ID');
    }
    // AWS_SESSION_TOKEN is optional, don't validate
  }

  // Report errors and exit if validation fails
  if (missing.length > 0 || invalid.length > 0) {
    console.error('❌ Environment configuration error in .env.agent');
    if (missing.length > 0) {
      console.error('   Missing required variables:', missing.join(', '));
    }
    if (invalid.length > 0) {
      console.error('   Invalid variables:', invalid.join(', '));
    }
    console.error('   Check packages/agent0/.env.agent file');
    process.exit(1);
  }

  console.log('✅ Agent LLM environment variables validated');

  // Return properly typed discriminated union
  if (hasAnthropicKey) {
    return {
      mcpServerUrl: process.env.MCP_SERVER_URL!,
      llmProvider: 'anthropic',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
      anthropicModel: process.env.ANTHROPIC_MODEL!,
    };
  } else {
    return {
      mcpServerUrl: process.env.MCP_SERVER_URL!,
      llmProvider: 'bedrock',
      awsRegion: process.env.AWS_REGION!,
      awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      awsSessionToken: process.env.AWS_SESSION_TOKEN,
      bedrockModelId: process.env.BEDROCK_MODEL_ID!,
    };
  }
}

// ============================================================================
// LLM Configuration Initialization
// ============================================================================

// Module-level state for LLM configuration
let llmConfig: AgentLLMConfig | null = null;
let llmConfigInitialized = false;
let llmConfigSource: 'opa' | 'env' | 'none' = 'none';

/**
 * Initialize LLM configuration from OPA or environment variables
 * OPA is tried first if configured, with fallback to env vars
 */
export async function initializeLLMConfig(): Promise<void> {
  if (llmConfigInitialized) {
    return;
  }

  console.log('\n Initializing LLM configuration from environment variables...');

  // Note: OPA credentials are now fetched per-user-session in getAgentForUserContext()
  // This function only handles environment variable fallback

  try {
    llmConfig = validateAgentLLMEnv();
    llmConfigSource = 'env';
    llmConfigInitialized = true;
    console.log(' LLM credentials loaded from environment variables');
  } catch (error) {
    llmConfigInitialized = true;
    llmConfigSource = 'none';
    console.error(' No LLM credentials available');
    throw error;
  }
}

/**
 * Get the current LLM configuration source
 */
export function getLLMConfigSource(): 'opa' | 'env' | 'none' {
  return llmConfigSource;
}

/**
 * Check if LLM configuration has been initialized
 */
export function isLLMConfigInitialized(): boolean {
  return llmConfigInitialized;
}

// Initialize LLM configuration at module load
// OPA credentials are fetched per-user-session, env vars are loaded at startup
if (isOPAConfigured()) {
  // OPA mode: credentials will be fetched per-user via token exchange
  console.log('🔐 OPA mode enabled - LLM credentials will be fetched per-user session');
  llmConfigInitialized = true;
  llmConfigSource = 'opa';
} else {
  // Direct mode: validate and load env vars now
  llmConfig = validateAgentLLMEnv();
  llmConfigSource = 'env';
  llmConfigInitialized = true;
}

// ============================================================================
// Agent Configuration
// ============================================================================

export interface AgentConfig {
  mcpServerUrl: string;
  name: string;
  version: string;

  // This instance is bound to a particular user and id token
  userContext: UserContext;
  idToken: string;

  // Token Exchange Config
  tokenExchange?: TokenExchangeConfig;

  // Anthropic Direct
  anthropicApiKey?: string;
  anthropicModel?: string;
  // AWS Bedrock
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  bedrockModelId?: string;
  enableLLM?: boolean;
}

export interface UserContext {
  email: string;
  name: string;
  sub: string;
}

// Build TokenExchangeConfig from environment variables
const buildTokenExchangeConfig = (): TokenExchangeConfig | undefined => {
  const mcpAuthServer = process.env.MCP_AUTHORIZATION_SERVER;
  const mcpAuthServerTokenEndpoint = process.env.MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT;
  const oktaDomain = process.env.OKTA_DOMAIN;
  const agentId = process.env.AI_AGENT_ID;
  const privateKeyFile = process.env.AI_AGENT_PRIVATE_KEY_FILE;
  const privateKeyKid = process.env.AI_AGENT_PRIVATE_KEY_KID;
  const agentScopes = process.env.AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST;

  if (mcpAuthServer && mcpAuthServerTokenEndpoint && oktaDomain && agentId && privateKeyFile && privateKeyKid && agentScopes) {
    return {
      authorizationServer: mcpAuthServer,
      authorizationServerTokenEndpoint: mcpAuthServerTokenEndpoint,
      oktaDomain,
      clientId: agentId,
      privateKeyFile,
      privateKeyKid,
      agentScopes,
    };
  }
  return undefined;
};

// Build agentConfig dynamically from current LLM configuration
function buildAgentConfig(): Omit<AgentConfig, 'idToken' | 'userContext'> | null {
  if (!llmConfig) {
    return null;
  }

  if (llmConfig.llmProvider === 'anthropic') {
    return {
      mcpServerUrl: llmConfig.mcpServerUrl,
      name: 'agent0',
      version: '1.0.0',
      tokenExchange: buildTokenExchangeConfig(),
      anthropicApiKey: llmConfig.anthropicApiKey,
      anthropicModel: llmConfig.anthropicModel,
      enableLLM: true,
    };
  } else {
    return {
      mcpServerUrl: llmConfig.mcpServerUrl,
      name: 'agent0',
      version: '1.0.0',
      tokenExchange: buildTokenExchangeConfig(),
      awsRegion: llmConfig.awsRegion,
      awsAccessKeyId: llmConfig.awsAccessKeyId,
      awsSecretAccessKey: llmConfig.awsSecretAccessKey,
      awsSessionToken: llmConfig.awsSessionToken,
      bedrockModelId: llmConfig.bedrockModelId,
      enableLLM: true,
    };
  }
}

export async function getAgentForUserContext(idToken: string, userContext: UserContext): Promise<Agent> {
  // OPA mode: fetch credentials via token exchange (per-user-session)
  if (isOPAConfigured()) {
    try {
      const opaCredentials = await fetchLLMCredentialsFromOPA(idToken);

      if (opaCredentials) {
        const baseConfig = {
          mcpServerUrl: process.env.MCP_SERVER_URL || '',
          name: 'agent0',
          version: '1.0.0',
          tokenExchange: buildTokenExchangeConfig(),
          enableLLM: true,
          idToken,
          userContext,
        };

        let agentConfig: AgentConfig;

        if (opaCredentials.provider === 'anthropic') {
          agentConfig = {
            ...baseConfig,
            anthropicApiKey: opaCredentials.apiKey,
            anthropicModel: opaCredentials.model,
          };
        } else {
          agentConfig = {
            ...baseConfig,
            awsRegion: opaCredentials.awsRegion,
            awsAccessKeyId: opaCredentials.awsAccessKeyId,
            awsSecretAccessKey: opaCredentials.awsSecretAccessKey,
            awsSessionToken: opaCredentials.awsSessionToken,
            bedrockModelId: opaCredentials.bedrockModelId,
          };
        }

        llmConfigSource = 'opa';
        return new Agent(agentConfig);
      }
    } catch (error: any) {
      console.warn('⚠️  Failed to fetch OPA credentials:', error.message);
      console.warn('   Falling back to environment variables...');
    }
  }

  // Fallback to environment variables
  await initializeLLMConfig();

  const agentConfig = buildAgentConfig();
  if (!agentConfig) {
    throw new Error('LLM configuration not available. Cannot create agent.');
  }

  return new Agent({
    ...agentConfig,
    idToken,
    userContext,
  });
}

const subjectToAgent = new Map<string, Agent>();

export async function getAgentForSession (req: Request): Promise<Agent | null> {
  const userInfo = req.session.userInfo;
  const idToken = req.session.idToken;
  if (!userInfo || !userInfo.sub || !idToken) {
    console.warn('⚠️  Cannot get agent: missing user info or id token in session');
    console.info(userInfo);
    console.info(idToken);
    return null;
  }
  const subject = userInfo.sub;

  const existingAgent = subjectToAgent.get(subject);

  if (existingAgent) {
    return existingAgent;
  }

  const agent = await getAgentForUserContext(
    idToken, userInfo
  );

  subjectToAgent.set(subject, agent);

  await agent.connect();

  return agent;
};

export async function disconnectAll(): Promise<void> {
  for (const agent of subjectToAgent.values()) {
    await agent.disconnect();
  }
  subjectToAgent.clear();
}

// ============================================================================
// Agent Class - MCP Client + LLM Integration
// ============================================================================

// Maximum number of step-up authorization retries per tool call
const MAX_STEPUP_RETRIES = 2;

export class Agent {
  private client: Client;
  private transport: StreamableHTTPClientTransport | null = null;
  private config: AgentConfig;
  private isConnected = false;
  private availableTools: any[] = [];
  private anthropic: Anthropic | null = null;
  private bedrockClient: BedrockRuntimeClient | null = null;
  private conversationHistory: Array<{
    role: 'user' | 'assistant';
    content: string | Array<any>;
  }> = [];
  private tokenExchangeHandler: TokenExchangeHandler | null = null;
  private grantedScopes: string[] = []; // Tracks scopes from last token exchange

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new Client(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {},
      }
    );

    // Initialize Token Exchange Handler if configured
    if (config.tokenExchange) {
      this.tokenExchangeHandler = new TokenExchangeHandler(config.tokenExchange);
    }

    // Initialize LLM client - Priority: Anthropic Direct > AWS Bedrock
    if (config.anthropicApiKey && config.enableLLM !== false) {
      this.anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
      });
      console.log('🤖 LLM integration enabled (Anthropic Direct)');
    } else if (
      config.awsRegion &&
      config.awsAccessKeyId &&
      config.awsSecretAccessKey &&
      config.enableLLM !== false
    ) {
      this.bedrockClient = new BedrockRuntimeClient({
        region: config.awsRegion,
        credentials: {
          accessKeyId: config.awsAccessKeyId,
          secretAccessKey: config.awsSecretAccessKey,
          sessionToken: config.awsSessionToken,
        },
      });
      console.log('🤖 LLM integration enabled (AWS Bedrock)');
    } else {
      console.log('🤖 ❌ LLM integration not enabled');
    }
  }

  // ============================================================================
  // MCP Connection Methods
  // ============================================================================

  /**
   * Connect to MCP server with token exchange
   * @param requestedScopes - Optional scopes for step-up authorization
   */
  async connect(requestedScopes?: string): Promise<boolean> {
    if (!this.isLLMEnabled()) {
      console.warn('⚠️ LLM integration not enabled. Cannot connect agent to MCP.');
      return false;
    }

    if (!this.tokenExchangeHandler) {
      console.error('❌ Token exchange not configured. Cannot connect to MCP server.');
      return false;
    }

    try {
      console.log('🔌 Connecting to MCP server...');
      console.log(`   Server: ${this.config.mcpServerUrl}`);
      console.log('   Performing token exchange: ID Token → ID-JAG → MCP Access Token');

      // Perform token exchange to get MCP access token
      const tokenResult = await this.tokenExchangeHandler.exchangeToken(
        this.config.idToken,
        requestedScopes
      );

      if (!tokenResult.success || !tokenResult.access_token) {
        throw new Error('Token exchange failed or did not return access token');
      }

      console.log('✅ Token exchange successful');
      console.log(`⏰ Token expires in: ${tokenResult.expires_in}s`);

      // Track granted scopes (replace, don't accumulate)
      this.grantedScopes = tokenResult.scope?.split(' ') || [];
      if (this.grantedScopes.length) {
        console.log(`🎯 Granted scopes: ${this.grantedScopes.join(' ')}`);
      }

      // Create transport with access token in Authorization header
      this.transport = new StreamableHTTPClientTransport(
        new URL(this.config.mcpServerUrl),
        {
          requestInit: {
            headers: {
              'Authorization': `Bearer ${tokenResult.access_token}`
            }
          },

        }
      );

      await this.client.connect(this.transport);
      this.isConnected = true;

      console.log('✅ Connected to MCP server successfully!\n');

      // Fetch available tools
      await this.fetchAvailableTools();
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to MCP server:', error);
      throw error;
    }
  }

  /**
   * Reconnect to MCP server with additional scopes (step-up authorization)
   */
  private async reconnectWithScopes(requiredScopes: string[]): Promise<boolean> {
    // Combine existing and new scopes (MCP spec recommends including existing)
    const allScopes = [...new Set([...this.grantedScopes, ...requiredScopes])];
    console.log('🔄 Step-up authorization...');
    console.log(`   Current: ${this.grantedScopes.join(' ') || '(none)'}`);
    console.log(`   Required: ${requiredScopes.join(' ')}`);
    console.log(`   Requesting: ${allScopes.join(' ')}`);

    if (this.isConnected) {
      await this.disconnect();
    }

    return this.connect(allScopes.join(' '));
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.client.close();
      this.isConnected = false;
      console.log('\n👋 Disconnected from MCP server');
    }
  }

  isAgentConnected(): boolean {
    return this.isConnected;
  }

  // ============================================================================
  // Tool Discovery and Execution
  // ============================================================================

  async fetchAvailableTools(): Promise<void> {
    try {
      const response = await this.client.listTools();
      this.availableTools = response.tools || [];

      console.log('🔧 Available Tools:');
      console.log('='.repeat(60));
      this.availableTools.forEach((tool, index) => {
        console.log(`${index + 1}. ${tool.name}`);
        console.log(`   📝 ${tool.description}`);
        if (tool.inputSchema?.properties) {
          const params = Object.keys(tool.inputSchema.properties);
          if (params.length > 0) {
            console.log(`   📋 Parameters: ${params.join(', ')}`);
          }
        }
        console.log('');
      });
      console.log('='.repeat(60));
    } catch (error) {
      console.error('❌ Failed to fetch tools:', error);
    }
  }

  /**
   * Call an MCP tool with automatic scope challenge handling
   * Implements step-up authorization per MCP spec when insufficient_scope is returned
   */
  async callTool(toolName: string, args: any = {}, _retryCount: number = 0): Promise<any> {
    console.log(`\n🔄 Executing tool: ${toolName}`);
    console.log(`   Arguments: ${JSON.stringify(args, null, 2)}`);

    try {
      const response = await this.client.callTool({ name: toolName, arguments: args });

      // Check for scope challenge in response
      const challenge = extractScopeChallenge(response);
      if (challenge && _retryCount < MAX_STEPUP_RETRIES) {
        return this.retryWithStepUp(toolName, args, challenge, _retryCount);
      }

      return response;
    } catch (error: any) {
      // Check for scope challenge in error
      const challenge = extractScopeChallenge(error);
      if (challenge && _retryCount < MAX_STEPUP_RETRIES) {
        return this.retryWithStepUp(toolName, args, challenge, _retryCount);
      }

      console.error('❌ Tool execution failed:', error);
      throw error;
    }
  }

  /**
   * Retry tool call after step-up authorization
   */
  private async retryWithStepUp(
    toolName: string,
    args: any,
    challenge: ScopeChallenge,
    retryCount: number
  ): Promise<any> {
    console.log(`\n⚠️  Scope challenge for: ${toolName}`);
    console.log(`   Required: ${challenge.scope.join(' ')}`);

    if (await this.reconnectWithScopes(challenge.scope)) {
      console.log('✅ Retrying tool call...');
      return this.callTool(toolName, args, retryCount + 1);
    }

    throw new Error(`Step-up authorization failed for: ${challenge.scope.join(' ')}`);
  }

  // ============================================================================
  // Auth Provider Management
  // ============================================================================

  /**
   * Update the ID token (useful when session is refreshed)
   * Note: Will need to reconnect to MCP server with new token
   */
  updateIdToken(newIdToken: string): void {
    this.config.idToken = newIdToken;
    console.log('🔑 ID token updated - reconnect to MCP server for new access token');
  }

  getAvailableTools(): any[] {
    return this.availableTools;
  }

  // ============================================================================
  // LLM Integration - Process User Input
  // ============================================================================

  async processUserInput(
    input: string,
    userContext?: UserContext | null
  ): Promise<{ success: boolean; message: string; data?: any; toolResults?: any[] }> {
    if (!this.anthropic && !this.bedrockClient) {
      throw new Error('LLM client not initialized');
    }
    try {
      return await this.processWithLLM(input, userContext);
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Error processing input',
      };
    }
  }

  private async processWithLLM(
    userMessage: string,
    userContext?: UserContext | null
  ): Promise<{ success: boolean; message: string; data?: any; toolResults?: any[] }> {
    try {
      // Add user message to conversation history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Convert MCP tools to Anthropic tool format
      const tools = this.availableTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
      }));

      // Create system message with context
      let systemMessage = `You are a helpful AI assistant that can manage todos using the available MCP tools.
You have access to the following tools: ${this.availableTools.map(t => t.name).join(', ')}.

When the user asks to do something, analyze their request and call the appropriate tool with the correct parameters.
- For creating todos: extract the todo content from the user's message
- For listing todos: call get-todos without parameters
- For updating todos: extract the todo ID and new title
- For toggling todos: extract the todo ID
- For deleting todos: extract the todo ID

Always be helpful and conversational. If you successfully complete an action, let the user know in a friendly way.
If you need more information, ask the user for clarification.`;

      // Add user context if available
      if (userContext) {
        systemMessage += `\n\nCurrent user context:
- User: ${userContext.name} (${userContext.email})
- User ID: ${userContext.sub}

When the user asks "who am I" or "who is the owner", you can refer to this information.
The todos you manage belong to this user.`;
      }

      // Call LLM based on which client is initialized
      const response = this.anthropic
        ? await this.callAnthropicAPI(systemMessage, tools)
        : await this.callBedrockAPI(systemMessage, tools);

      // Handle tool calls
      let toolResults: any[] = [];
      let responseMessage = '';
      let toolResultBlocks: Array<any> = [];

      // Check if there are tool uses
      const hasToolUse = response.content.some((block: any) => block.type === 'tool_use');

      // Execute all tool calls and collect results
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          // Execute the MCP tool
          const result = await this.callTool(block.name, block.input);

          // Parse the result
          let parsedResult: any = {};
          if (result.content && result.content[0]) {
            try {
              parsedResult = JSON.parse(result.content[0].text);
            } catch {
              parsedResult = result;
            }
          }

          toolResults.push({
            tool: block.name,
            arguments: block.input,
            result: parsedResult,
          });

          // Collect tool result blocks for next request
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } else if (block.type === 'text') {
          if (block.text) {
            responseMessage += block.text;
          }
        }
      }

      // Add assistant's response to history (with tool_use and text blocks only)
      this.conversationHistory.push({
        role: 'assistant',
        content: response.content,
      });

      // If there were tool calls, process them
      if (hasToolUse && toolResultBlocks.length > 0) {
        // Add tool results to history as user message
        this.conversationHistory.push({
          role: 'user',
          content: toolResultBlocks,
        });

        // Get final response after tool execution
        const finalResponse = this.anthropic
          ? await this.callAnthropicAPI(systemMessage, tools)
          : await this.callBedrockAPI(systemMessage, tools);

        // Extract text from final response
        const textBlocks = finalResponse.content.filter((block: any) => block.type === 'text');
        if (textBlocks.length > 0) {
          responseMessage = textBlocks.map((block: any) => block.text).join('\n');
        }

        // Add final response to history
        this.conversationHistory.push({
          role: 'assistant',
          content: finalResponse.content,
        });
      }

      // Keep conversation history manageable
      // Keep messages in groups of 3 (user question, assistant with tools, user with tool_results + assistant final)
      // Minimum 2 messages (latest user + assistant), maximum ~12 messages
      if (this.conversationHistory.length > 12) {
        // Always keep the latest exchanges intact
        // Try to remove complete conversation turns (groups of 2-4 messages)
        const messagesToRemove = this.conversationHistory.length - 12;
        this.conversationHistory = this.conversationHistory.slice(messagesToRemove);
      }

      return {
        success: true,
        message: responseMessage || 'Task completed',
        toolResults,
      };
    } catch (error: any) {
      console.error('❌ LLM processing failed:', error.message);
      return {
        success: false,
        message: error.message || 'LLM processing failed',
      };
    }
  }

  // ============================================================================
  // Anthropic Direct API Call
  // ============================================================================

  private async callAnthropicAPI(systemMessage: string, tools: any[]): Promise<any> {
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    return await this.anthropic.messages.create({
      model: this.config.anthropicModel || 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      system: systemMessage,
      messages: this.conversationHistory,
      tools: tools.length > 0 ? tools : undefined,
    });
  }

  // ============================================================================
  // AWS Bedrock API Call
  // ============================================================================

  private async callBedrockAPI(systemMessage: string, tools: any[]): Promise<any> {
    if (!this.bedrockClient) {
      throw new Error('Bedrock client not initialized');
    }

    // Construct Anthropic Messages API request body
    const requestBody: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: systemMessage,
      messages: this.conversationHistory,
    };

    if (tools.length > 0) {
      requestBody.tools = tools;
    }

    // Call Bedrock InvokeModel API
    const command = new InvokeModelCommand({
      modelId: this.config.bedrockModelId || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody),
    });

    const response = await this.bedrockClient.send(command);

    // Parse response
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return responseBody;
  }

  // ============================================================================
  // Conversation Management
  // ============================================================================

  resetConversation(): void {
    this.conversationHistory = [];
  }

  getConversationHistory() {
    return this.conversationHistory;
  }

  isLLMEnabled(): boolean {
    return this.anthropic !== null || this.bedrockClient !== null;
  }
}
