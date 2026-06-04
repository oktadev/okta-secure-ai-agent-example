// ============================================================================
// AGENT B — LLM AGENT (intelligent task interpretation)
// ============================================================================
// Makes Agent B a real Claude-powered agent: given a delegated task and the
// todo0 MCP tools, it runs its own tool-use loop, deciding which tools to call
// with what arguments. This replaces brittle deterministic parsing — Claude
// interprets "add 'X'", "list my todos", "mark the Q3 one done", etc.
//
// Supports Anthropic (direct) and AWS Bedrock, mirroring agent0's setup so the
// same LLM credentials work for both agents.

import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export interface LLMConfig {
  provider: 'anthropic' | 'bedrock';
  anthropicApiKey?: string;
  anthropicModel?: string;
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  bedrockModelId?: string;
}

/** Read Agent B's LLM config from env, or null if none is configured. */
export function loadLLMConfig(): LLMConfig | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
    };
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      provider: 'bedrock',
      awsRegion: process.env.AWS_REGION || 'us-east-1',
      awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      awsSessionToken: process.env.AWS_SESSION_TOKEN,
      bedrockModelId: process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    };
  }
  return null;
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const MAX_ITERATIONS = 6;

export class LlmAgent {
  private anthropic?: Anthropic;
  private bedrock?: BedrockRuntimeClient;

  constructor(private readonly config: LLMConfig) {
    if (config.provider === 'anthropic') {
      this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey! });
    } else {
      this.bedrock = new BedrockRuntimeClient({
        region: config.awsRegion!,
        credentials: {
          accessKeyId: config.awsAccessKeyId!,
          secretAccessKey: config.awsSecretAccessKey!,
          sessionToken: config.awsSessionToken,
        },
      });
    }
  }

  private async call(system: string, messages: any[], tools: LlmTool[]): Promise<any> {
    if (this.anthropic) {
      return this.anthropic.messages.create({
        model: this.config.anthropicModel || 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        system,
        messages,
        tools: tools.length ? (tools as any) : undefined,
      });
    }
    const body: any = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 2048, system, messages };
    if (tools.length) body.tools = tools;
    const command = new InvokeModelCommand({
      modelId: this.config.bedrockModelId || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    });
    const response = await this.bedrock!.send(command);
    return JSON.parse(new TextDecoder().decode(response.body));
  }

  /**
   * Run the agentic loop: let Claude fulfil `task` using `tools`, executing
   * each tool via `executeTool`. `onNote` streams progress. Returns the final
   * assistant text.
   */
  async run(
    system: string,
    tools: LlmTool[],
    task: string,
    executeTool: (name: string, args: any) => Promise<any>,
    onNote?: (text: string) => void,
  ): Promise<string> {
    const note = onNote ?? (() => {});
    const messages: any[] = [{ role: 'user', content: task }];
    let finalText = '';

    note('Agent B is thinking…');
    let response = await this.call(system, messages, tools);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const toolUses = (response.content || []).filter((b: any) => b.type === 'tool_use');

      if (toolUses.length === 0) {
        finalText = (response.content || [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        break;
      }

      messages.push({ role: 'assistant', content: response.content });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        note(`todo0 · ${tu.name}…`);
        let result: any;
        try {
          result = await executeTool(tu.name, tu.input || {});
        } catch (err: any) {
          result = { isError: true, content: [{ type: 'text', text: `Tool failed: ${err?.message || String(err)}` }] };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });

      note('Agent B is thinking…');
      response = await this.call(system, messages, tools);
    }

    return finalText || 'Done.';
  }
}
