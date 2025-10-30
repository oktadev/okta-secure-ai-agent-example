// agent.ts - Agent Identity: MCP Client + LLM Integration
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { TokenExchangeHandler, TokenExchangeConfig } from './auth/token-exchange.js';
import { Request } from 'express';
import * as dotenv from 'dotenv';

// Load environment variables for agent
dotenv.config({ path: path.resolve(__dirname, '../.env.agent') });

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
      mcpAuthorizationServer: mcpAuthServer,
      mcpAuthorizationServerTokenEndpoint: mcpAuthServerTokenEndpoint,
      oktaDomain,
      clientId: agentId,
      privateKeyFile,
      privateKeyKid,
      agentScopes,
    };
  }
  return undefined;
};

const agentConfig: Omit<AgentConfig, 'idToken' | 'userContext'> = {
  mcpServerUrl: process.env.MCP_SERVER_URL || 'http://localhost:5002/mcp',
  name: 'agent0',
  version: '1.0.0',
  // Token Exchange
  tokenExchange: buildTokenExchangeConfig(),
  // Anthropic Direct
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
  // AWS Bedrock
  awsRegion: process.env.AWS_REGION,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsSessionToken: process.env.AWS_SESSION_TOKEN,
  bedrockModelId: process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  enableLLM: true,
};

export function getAgentForUserContext(idToken: string, userContext: UserContext): Agent {
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

  const agent = getAgentForUserContext(
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

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new Client(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {
          tools: {},
        },
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

  async connect(): Promise<boolean> {
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
      const tokenResult = await this.tokenExchangeHandler.exchangeToken(this.config.idToken);

      if (!tokenResult.success || !tokenResult.access_token) {
        throw new Error('Token exchange failed or did not return access token');
      }

      console.log('✅ Token exchange successful');
      console.log(`⏰ Token expires in: ${tokenResult.expires_in}s`);

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

  async callTool(toolName: string, args: any = {}): Promise<any> {
    try {
      console.log(`\n🔄 Executing tool: ${toolName}`);
      console.log(`   Arguments: ${JSON.stringify(args, null, 2)}`);

      const callOptions: any = {
        name: toolName,
        arguments: args,
      };

      const response = await this.client.callTool(callOptions);

      return response;
    } catch (error) {
      console.error('❌ Tool execution failed:', error);
      throw error;
    }
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
