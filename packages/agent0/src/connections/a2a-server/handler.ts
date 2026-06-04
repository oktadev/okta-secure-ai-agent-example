// ============================================================================
// A2A Server Connection (agent0 → Agent B)
// ============================================================================
// The outbound half of the A2A second hop, from agent0's perspective.
//
// agent0 obtains an access token scoped to Agent B's a2a-server (via ID-JAG
// token exchange against the A2A authorization server, RFC 8707 resource =
// Agent B's resourceUrl), then calls Agent B over the real A2A protocol
// (JSON-RPC `message/send`). Agent B performs its own downstream hop to todo0.
//
// This is NOT an MCP connection — it contributes a single LLM tool
// (`delegate_to_task_agent`) and is invoked like the GitHub OIN tool.

import { randomUUID } from 'crypto';
import {
  TokenExchangeHandler,
  type TokenExchangeConfig,
} from '../authorization-server/handler.js';
import { isConnectionDisabled } from '../config.js';
import type { ConnectionStatus, ToolDescriptor } from '../types.js';

// ── Config ────────────────────────────────────────────────────────────────

export interface A2AServerConfig {
  serverUrl: string;          // Agent B A2A transport base URL (e.g. http://localhost:5005)
  resourceIndicator: string;  // Agent B a2a-server resourceUrl (token audience)
  oktaAgentServerId?: string; // Agent B's Okta agent id (for the panel)
  tokenExchange: TokenExchangeConfig; // configured for the A2A AS + resource
}

export const A2A_TOOL_NAME = 'delegate_to_task_agent';

/**
 * Build the A2A server connection config from env, or null if not configured
 * (or disabled). Requires the shared agent identity plus the A2A_* vars.
 */
export function loadA2AServerConfig(): A2AServerConfig | null {
  if (isConnectionDisabled('a2a_server')) return null;

  const oktaDomain = process.env.OKTA_DOMAIN;
  const clientId = process.env.AI_AGENT_ID;
  const privateKeyFile = process.env.AI_AGENT_PRIVATE_KEY_FILE;
  const privateKeyKid = process.env.AI_AGENT_PRIVATE_KEY_KID;

  const serverUrl = process.env.A2A_SERVER_URL;
  const resourceIndicator = process.env.A2A_RESOURCE_INDICATOR;
  const authorizationServer = process.env.A2A_AUTHORIZATION_SERVER;
  const tokenEndpoint = process.env.A2A_AUTHORIZATION_SERVER_TOKEN_ENDPOINT;
  const scopes = process.env.A2A_SCOPES_TO_REQUEST || 'agent.invoke';

  if (
    !oktaDomain || !clientId || !privateKeyFile || !privateKeyKid ||
    !serverUrl || !resourceIndicator || !authorizationServer || !tokenEndpoint
  ) {
    return null;
  }

  return {
    serverUrl,
    resourceIndicator,
    oktaAgentServerId: process.env.OKTA_A2A_SERVER_ID,
    tokenExchange: {
      oktaDomain,
      clientId,
      privateKeyFile,
      privateKeyKid,
      authorizationServer,
      authorizationServerTokenEndpoint: tokenEndpoint,
      agentScopes: scopes,
      // NOTE: we intentionally do NOT set `resource` here. The A2A authorization
      // server is configured with a static audience = Agent B's resourceUrl, so
      // the issued token's `aud` is correct from `audience` alone. Sending an
      // RFC 8707 `resource` param requires Custom-AS resource-indicator support,
      // which isn't enabled on all orgs (the Org AS rejects it as
      // "'resource' is invalid or not supported"). This mirrors the proven
      // agent0 → todo0 ID-JAG flow.
    },
  };
}

// ── Handler ───────────────────────────────────────────────────────────────

export interface A2ACallResult {
  text: string;
  tokenChain?: unknown;
}

export class A2AServerHandler {
  private readonly tokenExchange: TokenExchangeHandler;
  private cachedAccessToken: string | null = null;
  private cachedTokenExpiry = 0;
  private hasEverSucceeded = false;

  constructor(private readonly config: A2AServerConfig) {
    this.tokenExchange = new TokenExchangeHandler(config.tokenExchange);
  }

  isConfigured(): boolean {
    return true; // only constructed when loadA2AServerConfig() returns config
  }

  isAuthorized(): boolean {
    return this.hasEverSucceeded;
  }

  clearCache(): void {
    this.cachedAccessToken = null;
    this.cachedTokenExpiry = 0;
  }

  /** The single LLM tool this connection contributes. */
  getTool(): ToolDescriptor {
    return {
      name: A2A_TOOL_NAME,
      description:
        'Delegate a task to the downstream Task Agent (Agent B) over the A2A protocol. ' +
        'Agent B manages the user\'s todos in todo0 on their behalf, preserving the user\'s identity. ' +
        'Use this when the user asks the "task agent" to add or list todos.',
      input_schema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The natural-language task to hand to the Task Agent (e.g. \'add "prep the Q3 review" to my todos\').',
          },
        },
        required: ['task'],
      },
    };
  }

  private getCachedToken(): string | null {
    if (this.cachedAccessToken && Date.now() < this.cachedTokenExpiry) {
      return this.cachedAccessToken;
    }
    return null;
  }

  /** Obtain an access token for Agent B (cached until ~60s before expiry). */
  private async getAccessToken(idToken: string): Promise<string> {
    const cached = this.getCachedToken();
    if (cached) return cached;

    const result = await this.tokenExchange.exchangeToken(idToken);
    if (!result.success || !result.access_token) {
      throw new Error(result.note || 'A2A token exchange did not return an access token');
    }
    this.cachedAccessToken = result.access_token;
    this.cachedTokenExpiry = Date.now() + ((result.expires_in ?? 3600) - 60) * 1000;
    return result.access_token;
  }

  private a2aEndpoint(): string {
    const base = this.config.serverUrl.replace(/\/$/, '');
    return base.endsWith('/a2a') ? base : `${base}/a2a`;
  }

  /**
   * Call Agent B over A2A with the given task. Re-exchanges the token once on
   * a 401 (expired/rejected token) before failing.
   * `onNote` receives human-readable progress lines for live UI streaming.
   */
  async callAgent(
    idToken: string,
    task: string,
    onNote?: (text: string) => void,
    _retry = 0,
  ): Promise<A2ACallResult> {
    const note = onNote ?? (() => {});
    note('Minting access token for Agent B (ID-JAG → access token)…');
    const accessToken = await this.getAccessToken(idToken);
    note('Calling Agent B over the A2A protocol (streaming)…');

    // Native A2A `message/stream`: Agent B returns an SSE stream of
    // status-update events (its own second-hop steps) ending in a final event.
    const body = {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'message/stream',
      params: {
        message: {
          role: 'user',
          messageId: randomUUID(),
          parts: [{ kind: 'text', text: task }],
        },
      },
    };

    const response = await fetch(this.a2aEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401 && _retry === 0) {
      // Token may be expired/rejected — clear cache and retry once.
      this.clearCache();
      note('Access token rejected — re-minting and retrying…');
      return this.callAgent(idToken, task, onNote, _retry + 1);
    }
    if (!response.ok || !response.body) {
      throw new Error(`A2A call to Agent B failed: HTTP ${response.status}`);
    }

    // Consume the SSE stream: relay each of Agent B's status messages as a
    // progress note, and capture the final text + token chain.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalText = '';
    let tokenChain: unknown;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let msg: any;
        try { msg = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        if (msg.error) {
          throw new Error(`Agent B error: ${msg.error.message || JSON.stringify(msg.error)}`);
        }
        const result = msg.result;
        if (!result) continue;
        const text = result.status?.message?.parts?.find(
          (p: any) => p.kind === 'text' || p.type === 'text',
        )?.text;
        if (result.final) {
          if (text) finalText = text;
          if (result.metadata?.tokenChain) tokenChain = result.metadata.tokenChain;
        } else if (text) {
          note(text); // stream Agent B's internal step into agent0's progress
        }
      }
    }

    this.hasEverSucceeded = true;
    return { text: finalText || 'Agent B completed.', tokenChain };
  }

  getStatus(): ConnectionStatus {
    return {
      kind: 'a2a_server',
      configured: true,
      connected: this.hasEverSucceeded,
      details: {
        agentServerUrl: this.config.serverUrl,
        resourceIndicator: this.config.resourceIndicator,
        authorizationServer: this.config.tokenExchange.authorizationServer,
        registeredAtOkta: !!this.config.oktaAgentServerId,
        oktaAgentServerId: this.config.oktaAgentServerId,
      },
    };
  }
}
