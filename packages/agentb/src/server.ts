// ============================================================================
// AGENT B — A2A PROTOCOL SERVER
// ============================================================================
// Exposes the real A2A protocol surface:
//   - GET  /.well-known/agent-card.json  → the A2A AgentCard (capabilities,
//     skills, security scheme). /.well-known/agent.json is served too for
//     compatibility with older clients.
//   - POST /a2a                          → JSON-RPC 2.0 endpoint implementing
//     the core `message/send` method.
//
// Every /a2a call is authenticated against the A2A authorization server before
// the task is handled (the dual nature: Agent B is a resource server here).

import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import type { AgentBConfig } from './config';
import { createInboundVerifier } from './auth/inbound';
import { handleTask } from './handler';

const SKILL_ID = 'manage-todos';

export function createServer(config: AgentBConfig) {
  const app = express();
  app.use(helmet());
  app.use(express.json());

  const inbound = createInboundVerifier(config);

  // ── A2A AgentCard ──────────────────────────────────────────────────────────
  const agentCard = buildAgentCard(config);
  const serveCard = (_req: Request, res: Response) => res.json(agentCard);
  app.get('/.well-known/agent-card.json', serveCard);
  app.get('/.well-known/agent.json', serveCard); // legacy well-known path

  // ── A2A JSON-RPC endpoint ────────────────────────────────────────────────
  app.post('/a2a', async (req: Request, res: Response) => {
    const rpcId = req.body?.id ?? null;

    // Authenticate the caller (agent0) against the A2A authorization server.
    const verification = await inbound.verify(req.headers.authorization);
    if (!verification.valid || !verification.accessToken) {
      // Signal the caller to obtain a token (or consent) and retry.
      res.set('WWW-Authenticate', `Bearer error="invalid_token", error_description="${verification.error || 'unauthorized'}"`);
      return res.status(401).json(rpcError(rpcId, -32001, verification.error || 'Unauthorized'));
    }

    const method = req.body?.method;
    if (method !== 'message/send' && method !== 'message/stream') {
      return res.status(200).json(rpcError(rpcId, -32601, `Method not found: ${method}`));
    }

    const taskText = extractText(req.body?.params?.message);
    if (!taskText) {
      return res.status(200).json(rpcError(rpcId, -32602, 'No text part found in message'));
    }

    console.log(`📥 A2A ${method} from sub=${verification.sub}: "${taskText}"`);
    const taskId = randomUUID();

    // ── message/stream: A2A streaming — emit status-update events as Agent B
    // performs its second hop (token exchange → todo0), then a final event. ──
    if (method === 'message/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const statusUpdate = (text: string) => sse({
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          kind: 'status-update',
          taskId,
          status: { state: 'working', message: { role: 'agent', parts: [{ kind: 'text', text }] } },
          final: false,
        },
      });

      try {
        const result = await handleTask(taskText, verification.accessToken, config, statusUpdate);
        sse({
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            kind: 'status-update',
            taskId,
            status: {
              state: 'completed',
              message: {
                role: 'agent',
                messageId: `agentb-${taskId}`,
                parts: [{ kind: 'text', text: result.text }],
              },
            },
            metadata: { tokenChain: result.tokenChain },
            final: true,
          },
        });
      } catch (err: any) {
        console.error('❌ A2A stream task failed:', err.message);
        sse(rpcError(rpcId, -32000, `Task failed: ${err.message}`));
      } finally {
        res.end();
      }
      return;
    }

    // ── message/send: single (non-streaming) response ──────────────────────
    try {
      const result = await handleTask(taskText, verification.accessToken, config);
      return res.status(200).json({
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          kind: 'message',
          role: 'agent',
          messageId: `agentb-${taskId}`,
          parts: [{ kind: 'text', text: result.text }],
          metadata: { tokenChain: result.tokenChain },
        },
      });
    } catch (err: any) {
      console.error('❌ A2A task failed:', err.message);
      return res.status(200).json(rpcError(rpcId, -32000, `Task failed: ${err.message}`));
    }
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', resourceUrl: config.resourceUrl }));

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Extract the first text part from an A2A message. */
function extractText(message: any): string | null {
  const parts = message?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if ((part?.kind === 'text' || part?.type === 'text') && typeof part.text === 'string') {
      return part.text;
    }
  }
  return null;
}

function buildAgentCard(config: AgentBConfig) {
  return {
    protocolVersion: '0.3.0',
    name: 'Agent B (Task Agent)',
    description:
      'A2A downstream agent. Manages todos in todo0 on behalf of the original user, ' +
      'demonstrating Okta A2A identity chaining (the second hop).',
    url: `http://localhost:${config.port}/a2a`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: SKILL_ID,
        name: 'Manage todos',
        description: 'Create and list todos in todo0 for the requesting user.',
        tags: ['todo', 'productivity'],
        examples: ['add "prep the Q3 review" to my todos', 'list my todos'],
      },
    ],
    securitySchemes: {
      oauth_a2a: {
        type: 'oauth2',
        description: 'OAuth 2.0 access token issued by the Okta A2A authorization server.',
        flows: {
          clientCredentials: {
            tokenUrl: `${config.a2aAuthorizationServer}/v1/token`,
            scopes: { [config.requiredScope]: 'Invoke this agent' },
          },
        },
      },
    },
    security: [{ oauth_a2a: [config.requiredScope] }],
  };
}
