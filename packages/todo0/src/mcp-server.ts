// todo-manager.ts
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol';
import { isInitializeRequest, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

import { todoService } from './services/todo-service';
import { createRequireMcpAuth, McpAuthClaims } from './middleware/requireMcpAuth';

// Load environment variables from .env.mcp
dotenv.config({ path: path.resolve(__dirname, '../.env.mcp') });

// ============================================================================
// Create MCP Server
// ============================================================================

// NOTE: A fresh McpServer is created PER SESSION (see createTodoMcpServer below),
// not shared globally. The MCP SDK binds a server to a single transport, so a
// shared server instance breaks when multiple clients connect concurrently —
// e.g. agent0 and Agent B both using todo0 during A2A identity chaining. The
// later connect() rebinds the server and the earlier session's requests hang
// (MCP error -32001 "Request timed out"). Per-session servers avoid that.

const createTodoParams: z.ZodRawShape = {
  title: z.string().describe('The title/content of the todo item'),
};

const emptyParams: z.ZodRawShape = {};

const toggleTodoParams: z.ZodRawShape = {
  id: z.number().describe('The ID of the todo to toggle'),
};

const deleteTodoParams: z.ZodRawShape = {
  id: z.number().describe('The ID of the todo to delete'),
};

// ============================================================================
// Tool Registration Function
// ============================================================================

/**
 * Register MCP tools with scope-based authorization
 */
function registerTools(server: McpServer, verifyAccessTokenWithScopes: (authHeader: string, scopes: string[]) => Promise<{ valid: boolean; userId?: string; missingScopes?: string[] }>): void {
  /**
   * Create a protected tool that verifies scopes and passes userId to the callback
   * @param scopes - Required scopes for this tool
   * @param cb - Tool callback that receives params and userId
   */
  const makeProtectedTool = (scopes: string[], cb: (params: any, userId: string, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<any>): ((args: any, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<any>) => {
      return async (params: any, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        if (!extra.requestInfo?.headers.authorization) {
          throw new Error('Missing Authorization header in tool callback');
        }
        if (Array.isArray(extra.requestInfo?.headers.authorization)) {
          throw new Error('Unexpected Authorization header in tool callback');
        }
        const authorizationHeader = extra.requestInfo?.headers.authorization;

        console.log('🔍 Verifying access token for tool execution...');
        const authResult = await verifyAccessTokenWithScopes(authorizationHeader, scopes);

        if (!authResult.valid || !authResult.userId) {
          // Check if this is a scope challenge (missing scopes) vs invalid token
          if (authResult.missingScopes && authResult.missingScopes.length > 0) {
            console.log(`🔐 Scope challenge: missing scopes ${authResult.missingScopes.join(', ')}`);
            // Return scope challenge per MCP spec (as structured error in MCP response)
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: 'insufficient_scope',
                  error_description: `Missing required scopes: ${authResult.missingScopes.join(', ')}`,
                  required_scopes: authResult.missingScopes,
                  // Include WWW-Authenticate header value for clients that can parse it
                  www_authenticate: `Bearer error="insufficient_scope", scope="${authResult.missingScopes.join(' ')}"`,
                })
              }],
              isError: true,
            };
          }

          // Invalid or expired token
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Unauthorized',
                message: 'Invalid or expired token'
              })
            }],
            isError: true,
          };
        }

        try {
          // Pass userId to the tool callback for user-scoped operations
          return await cb(params, authResult.userId, extra);
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Internal Server Error',
                message: error instanceof Error ? error.message : 'Unknown error'
              })
            }],
            isError: true,
          };
        }

      }
  }

  // ============================================================================
  // Tool 1: Create Todo
  // ============================================================================
  // Note: JWT authentication is enforced at the transport layer (/mcp endpoint).
  // All connections to this server are authenticated before tool execution.
  // Tools are further authorized via scope checks in makeProtectedTool.
  server.tool(
    'create-todo',
    'Create a new todo item.',
    createTodoParams,
    makeProtectedTool(
      [
        'mcp:tools:manage'
      ],
      async ({ title }, userId) => {
        const todo = await todoService.createTodo(title, userId);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              todo,
              message: 'Todo created successfully'
            })
          }],
        };
      }
    )
  );

  // ============================================================================
  // Tool 2: Get Todos
  // ============================================================================

  server.tool(
    'get-todos',
    'List all todos for the authenticated user.',
    emptyParams,
    makeProtectedTool(
      [
        'mcp:tools:read'
      ],
      async (_params, userId) => {
        const todos = await todoService.getAllTodos(userId);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              todos,
              count: todos.length,
              message: 'Retrieved all todos'
            })
          }],
        };
      }
    )
  );

  // ============================================================================
  // Tool 3: Toggle Todo Completed Status
  // ============================================================================

  server.tool(
    'toggle-todo',
    'Toggle the completed status of a todo.',
    toggleTodoParams,
    makeProtectedTool(
      [
        'mcp:tools:manage'
      ],
      async ({ id }, userId) => {
        const todo = await todoService.toggleTodo(id, userId);

        if (!todo) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Not Found',
                message: 'Todo not found or not owned by user'
              })
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              todo,
              message: 'Todo completion status toggled'
            })
          }],
        };
      }
    )
  );

  // ============================================================================
  // Tool 4: Delete Todo
  // ============================================================================

  server.tool(
    'delete-todo',
    'Delete a todo by ID.',
    deleteTodoParams,
    makeProtectedTool(
      [
        'mcp:tools:manage'
      ],
      async ({ id }, userId) => {
        const deleted = await todoService.deleteTodo(id, userId);

        if (!deleted) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Not Found',
                message: 'Todo not found, already deleted, or not owned by user'
              })
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Todo deleted successfully'
            })
          }],
        };
      }
    )
  );
}

/**
 * Build a fresh MCP server instance for a single session, with tools registered.
 * One server per transport keeps concurrent sessions (e.g. agent0 + Agent B
 * during A2A identity chaining) fully isolated.
 */
function createTodoMcpServer(
  verifyAccessTokenWithScopes: (authHeader: string, scopes: string[]) => Promise<{ valid: boolean; userId?: string; missingScopes?: string[] }>
): McpServer {
  const server = new McpServer({ name: 'Todo Manager', version: '1.0.0' });
  registerTools(server, verifyAccessTokenWithScopes);
  return server;
}

// ============================================================================
// Express Server Setup with StreamableHTTP
// ============================================================================

/**
 * Configuration interface for MCP server
 */
interface McpServerConfig {
  mcpPort: number;
  mcpOktaIssuer: string;
  mcpExpectedAudience: string;
}

/**
 * Validate required environment variables and return typed configuration
 */
function validateMcpEnv(): McpServerConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  // Check required variables
  const requiredVars = [
    'MCP_OKTA_ISSUER',
    'MCP_EXPECTED_AUDIENCE',
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName] || process.env[varName]!.trim() === '') {
      missing.push(varName);
    }
  }

  // Validate URL format for issuer
  if (process.env.MCP_OKTA_ISSUER) {
    try {
      new URL(process.env.MCP_OKTA_ISSUER);
    } catch {
      invalid.push('MCP_OKTA_ISSUER (invalid URL format)');
    }
  }

  // Report errors and exit if validation fails
  if (missing.length > 0 || invalid.length > 0) {
    console.error('❌ Environment configuration error in .env.mcp');
    if (missing.length > 0) {
      console.error('   Missing required variables:', missing.join(', '));
    }
    if (invalid.length > 0) {
      console.error('   Invalid variables:', invalid.join(', '));
    }
    console.error('   Check packages/todo0/.env.mcp file');
    process.exit(1);
  }

  console.log('✅ MCP server environment variables validated');

  // Return typed configuration object
  return {
    mcpPort: parseInt(process.env.MCP_PORT || '5002', 10),
    mcpOktaIssuer: process.env.MCP_OKTA_ISSUER!,
    mcpExpectedAudience: process.env.MCP_EXPECTED_AUDIENCE!,
  };
}

async function bootstrap(): Promise<void> {
  // Validate environment and get typed configuration
  const config = validateMcpEnv();

  // Create configured MCP auth middleware with validated config
  const { requireMcpAuth, verifyAccessTokenWithScopes } = createRequireMcpAuth({
    mcpOktaIssuer: config.mcpOktaIssuer,
    mcpExpectedAudience: config.mcpExpectedAudience,
  });

  // Tools are registered per-session in createTodoMcpServer() (one MCP server
  // per transport) so concurrent clients don't rebind a shared server.

  const app = express();

  // Security headers via helmet (API server - restrictive CSP since no HTML served)
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
  }));

  // Map to store transports by session ID
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  // Map to store auth claims by session ID
  const sessionAuth: Record<string, McpAuthClaims> = {};

  app.use(express.json());

  // DNS Rebinding Protection: Validate Origin header (MCP spec requirement)
  const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5001',
    'http://127.0.0.1:5001',
    `http://localhost:${config.mcpPort}`,
    `http://127.0.0.1:${config.mcpPort}`,
  ];

  app.use('/mcp', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Origin not allowed' });
    }
    next();
  });

  const mcpAuthMetadata = await fetch(`${config.mcpOktaIssuer}/.well-known/oauth-authorization-server`).then(res => res.json());

  console.log('MCP Auth Metadata:', mcpAuthMetadata);

  /**
   * MCP Protected Resource Metadata Endpoint
   */
  const resourceServerUrl = new URL(
    process.env.MCP_RESOURCE_INDICATOR || `http://localhost:${config.mcpPort}/mcp`
  );

  app.use(mcpAuthMetadataRouter({
    oauthMetadata: mcpAuthMetadata,
    resourceServerUrl
  }));

  // MCP POST endpoint - handles initialization and subsequent requests
  app.post('/mcp', requireMcpAuth, async (req, res) => {
    const mcpUser = (req as any).mcpUser as McpAuthClaims;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      console.log(`Received MCP request for session: ${sessionId}`);
    }

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport for this session
        transport = transports[sessionId];

        // Verify the session belongs to this authenticated user
        const sessionUser = sessionAuth[sessionId];
        if (!sessionUser || sessionUser.sub !== mcpUser.sub) {
          console.error('Session authentication mismatch');
          return res.status(403).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Forbidden: Session does not belong to authenticated user'
            },
            id: null
          });
        }
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request - create new transport
        console.log('New MCP session initializing');
        console.log('  Authenticated user:', mcpUser.sub);
        console.log('  Client ID:', mcpUser.cid);

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            console.log(`Session initialized with ID: ${newSessionId}`);
            transports[newSessionId] = transport;
            sessionAuth[newSessionId] = mcpUser;
          }
        });

        // Set up onclose handler to clean up transport
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            console.log(`Transport closed for session ${sid}`);
            delete transports[sid];
            delete sessionAuth[sid];
          }
        };

        // Connect a FRESH per-session MCP server to this transport (see
        // createTodoMcpServer). A shared server would rebind on each connect
        // and break concurrent sessions.
        const sessionServer = createTodoMcpServer(verifyAccessTokenWithScopes);
        await sessionServer.connect(transport);
      } else {
        // Invalid request - no session ID or not an initialization request
        return res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided or missing initialization'
          },
          id: null
        });
      }

      // Handle the request with the transport
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  // MCP GET endpoint - handles SSE streams (for server-to-client messages)
  app.get('/mcp', requireMcpAuth, async (req, res) => {
    const mcpUser = (req as any).mcpUser as McpAuthClaims;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send('Invalid or missing session ID');
    }

    // Verify the session belongs to this authenticated user
    const sessionUser = sessionAuth[sessionId];
    if (!sessionUser || sessionUser.sub !== mcpUser.sub) {
      console.error('Session authentication mismatch for SSE stream');
      return res.status(403).send('Forbidden: Session does not belong to authenticated user');
    }

    // Check for Last-Event-ID header for resumability
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
      console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
      console.log(`Establishing SSE stream for session ${sessionId}`);
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // MCP DELETE endpoint - handles session termination
  app.delete('/mcp', requireMcpAuth, async (req, res) => {
    const mcpUser = (req as any).mcpUser as McpAuthClaims;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send('Invalid or missing session ID');
    }

    // Verify the session belongs to this authenticated user
    const sessionUser = sessionAuth[sessionId];
    if (!sessionUser || sessionUser.sub !== mcpUser.sub) {
      console.error('Session authentication mismatch for termination');
      return res.status(403).send('Forbidden: Session does not belong to authenticated user');
    }

    console.log(`Received session termination request for session ${sessionId}`);

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling session termination:', error);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // Error handling middleware
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
      });
    }
  });

  // Bind to localhost only (MCP spec: prevents DNS rebinding attacks)
  app.listen(config.mcpPort, '127.0.0.1', () => {
    console.log('='.repeat(60));
    console.log('🚀 MCP Todo Server (StreamableHTTP)');
    console.log('='.repeat(60));
    console.log(`✓ Server running on http://127.0.0.1:${config.mcpPort}`);
    console.log(`✓ MCP endpoint: http://localhost:${config.mcpPort}/mcp [SECURED]`);
    console.log(`  - POST: Initialize/Send messages`);
    console.log(`  - GET:  SSE stream (server→client)`);
    console.log(`  - DELETE: Terminate session`);
    console.log(`✓ MCP protected resource metadata: ${getOAuthProtectedResourceMetadataUrl(resourceServerUrl)}`);
    console.log('='.repeat(60));
    console.log('Configuration:');
    console.log(`  - Transport: StreamableHTTP (no SSE-only mode)`);
    console.log(`  - MCP Server Port: ${config.mcpPort}`);
    console.log(`  - Data Access: Direct Prisma operations (shared service)`);
    console.log(`  - Auth: JWT verification with MCP-specific audience`);
    console.log(`  - Expected Audience: ${config.mcpExpectedAudience}`);
    console.log('='.repeat(60));
    console.log('Available Tools:');
    console.log('  1. create-todo  - Create a new todo');
    console.log('  2. get-todos    - List all todos');
    console.log('  3. toggle-todo  - Toggle completion state');
    console.log('  4. delete-todo  - Delete a todo');
    console.log('='.repeat(60));
    console.log('Ready to accept authenticated connections! 🎉');
    console.log('');
  });

  // Handle server shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
      try {
        console.log(`Closing transport for session ${sessionId}`);
        await transports[sessionId].close();
        delete transports[sessionId];
        delete sessionAuth[sessionId];
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    console.log('Server shutdown complete');
    process.exit(0);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});

