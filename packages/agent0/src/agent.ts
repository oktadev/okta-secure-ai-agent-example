// agent.ts - Agent Identity: MCP Client + LLM Integration
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import Anthropic from '@anthropic-ai/sdk';

// ============================================================================
// Agent Configuration
// ============================================================================

export interface AgentConfig {
  mcpServerUrl: string;
  name: string;
  version: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  enableLLM?: boolean;
}

export interface UserContext {
  email: string;
  name: string;
  sub: string;
}

// ============================================================================
// Agent Class - MCP Client + LLM Integration
// ============================================================================

export class Agent {
  private client: Client;
  private transport: SSEClientTransport | null = null;
  private config: AgentConfig;
  private isConnected = false;
  private availableTools: any[] = [];
  private anthropic: Anthropic | null = null;
  private conversationHistory: Array<{
    role: 'user' | 'assistant';
    content: string | Array<any>;
  }> = [];
  private accessToken: string | null = null;

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

    // Initialize Anthropic if API key is provided
    if (config.anthropicApiKey && config.enableLLM !== false) {
      this.anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
      });
      console.log('🤖 LLM integration enabled (Claude)');
    }
  }

  // ============================================================================
  // MCP Connection Methods
  // ============================================================================

  async connect(): Promise<void> {
    try {
      console.log('🔌 Connecting to MCP server...');
      console.log(`   Server: ${this.config.mcpServerUrl}`);

      this.transport = new SSEClientTransport(
        new URL(`${this.config.mcpServerUrl}/sse`)
      );

      await this.client.connect(this.transport);
      this.isConnected = true;

      console.log('✅ Connected to MCP server successfully!\n');

      // Fetch available tools
      await this.fetchAvailableTools();
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

      // Only include meta if we have an access token
      if (this.accessToken) {
        callOptions._meta = {
          progressToken: this.accessToken,
        };
      }

      const response = await this.client.callTool(callOptions);

      return response;
    } catch (error) {
      console.error('❌ Tool execution failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // Access Token Management
  // ============================================================================

  setAccessToken(token: string): void {
    this.accessToken = token;
    console.log('🔑 Access token set for MCP tool calls');
  }

  clearAccessToken(): void {
    this.accessToken = null;
    console.log('🔓 Access token cleared');
  }

  hasAccessToken(): boolean {
    return this.accessToken !== null;
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
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
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
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

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

      // Call Anthropic with tool use
      const response = await this.anthropic.messages.create({
        model: this.config.anthropicModel || 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemMessage,
        messages: this.conversationHistory,
        tools: tools.length > 0 ? tools : undefined,
      });

      // Handle tool calls
      let assistantContent: Array<any> = [];
      let toolResults: any[] = [];
      let responseMessage = '';

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

          // Add to assistant content for history
          assistantContent.push(block);

          // Add tool result to content for next request
          assistantContent.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } else if (block.type === 'text') {
          assistantContent.push(block);
          if (block.text) {
            responseMessage += block.text;
          }
        }
      }

      // Add assistant's response to history (only the tool_use and text blocks)
      const historyContent = response.content.filter(
        (block: any) => block.type === 'tool_use' || block.type === 'text'
      );
      this.conversationHistory.push({
        role: 'assistant',
        content: historyContent.length > 0 ? historyContent : response.content,
      });

      // If there were tool calls, get final response
      const hasToolUse = response.content.some((block: any) => block.type === 'tool_use');
      if (hasToolUse) {
        // Add tool results to history as user message
        const toolResultBlocks = assistantContent.filter(
          (block: any) => block.type === 'tool_result'
        );

        if (toolResultBlocks.length > 0) {
          this.conversationHistory.push({
            role: 'user',
            content: toolResultBlocks,
          });

          // Get final response from Claude
          const finalResponse = await this.anthropic.messages.create({
            model: this.config.anthropicModel || 'claude-3-5-sonnet-20241022',
            max_tokens: 4096,
            system: systemMessage,
            messages: this.conversationHistory,
          });

          const textBlocks = finalResponse.content.filter((block: any) => block.type === 'text');
          if (textBlocks.length > 0) {
            responseMessage = textBlocks.map((block: any) => block.text).join('\n');

            this.conversationHistory.push({
              role: 'assistant',
              content: finalResponse.content,
            });
          }
        }
      }

      // Keep conversation history manageable (last 10 messages)
      if (this.conversationHistory.length > 10) {
        this.conversationHistory = this.conversationHistory.slice(-10);
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
  // Conversation Management
  // ============================================================================

  resetConversation(): void {
    this.conversationHistory = [];
  }

  getConversationHistory() {
    return this.conversationHistory;
  }

  isLLMEnabled(): boolean {
    return this.anthropic !== null;
  }
}
