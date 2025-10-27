// todo-manager.ts
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { todoService } from './services/todo-service';
import { requireMcpAuth, McpAuthClaims } from './middleware/requireMcpAuth';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ============================================================================
// Create MCP Server
// ============================================================================

const server = new McpServer({
  name: 'Todo Manager',
  version: '1.0.0',
});

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
// Tool 1: Create Todo
// ============================================================================
// Note: JWT authentication is enforced at the transport layer (SSE/messages endpoints).
// All connections to this server are authenticated before tool execution.
// Future enhancement: Pass user claims to tools for user-specific operations.

server.tool(
  'create-todo',
  'Create a new todo item.',
  createTodoParams,
  async ({ title }) => {
    try {
      const todo = await todoService.createTodo(title);

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
);

// ============================================================================
// Tool 2: Get Todos
// ============================================================================

server.tool(
  'get-todos',
  'List all todos.',
  emptyParams,
  async () => {
    try {
      const todos = await todoService.getAllTodos();

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
);

// ============================================================================
// Tool 3: Toggle Todo Completed Status
// ============================================================================

server.tool(
  'toggle-todo',
  'Toggle the completed status of a todo.',
  toggleTodoParams,
  async ({ id }) => {
    try {
      const todo = await todoService.toggleTodo(id);

      if (!todo) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Not Found',
              message: 'Todo not found'
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
);

// ============================================================================
// Tool 4: Delete Todo
// ============================================================================

server.tool(
  'delete-todo',
  'Delete a todo by ID.',
  deleteTodoParams,
  async ({ id }) => {
    try {
      const deleted = await todoService.deleteTodo(id);

      if (!deleted) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Not Found',
              message: 'Todo not found or already deleted'
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
);

// ============================================================================
// Express Server Setup
// ============================================================================

async function bootstrap(): Promise<void> {
  const MCP_PORT = process.env.MCP_PORT || 3001;
  const app = express();
  const transports = new Map<string, SSEServerTransport>();
  const sessionAuth = new Map<string, McpAuthClaims>();

  app.use(express.json());

  // Secure SSE endpoint with JWT verification
  app.get('/sse', requireMcpAuth, async (req, res) => {
    const mcpUser = (req as any).mcpUser as McpAuthClaims;
    console.log('New SSE connection established');
    console.log('  Authenticated user:', mcpUser.sub);
    console.log('  Client ID:', mcpUser.cid);

    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    sessionAuth.set(transport.sessionId, mcpUser);

    res.on('close', () => {
      console.log('SSE connection closed:', transport.sessionId);
      transports.delete(transport.sessionId);
      sessionAuth.delete(transport.sessionId);
    });

    await server.connect(transport);
  });

  // Secure messages endpoint with JWT verification
  app.post('/messages', requireMcpAuth, async (req, res) => {
    const sessionId = String(req.query.sessionId);
    const transport = transports.get(sessionId);
    const mcpUser = (req as any).mcpUser as McpAuthClaims;

    if (!transport) {
      console.error('No transport found for sessionId:', sessionId);
      return res.status(400).json({
        error: 'Invalid session',
        message: 'No transport found for sessionId',
      });
    }

    // Verify the session belongs to this authenticated user
    const sessionUser = sessionAuth.get(sessionId);
    if (!sessionUser || sessionUser.sub !== mcpUser.sub) {
      console.error('Session authentication mismatch');
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Session does not belong to authenticated user',
      });
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({
      error: 'Internal Server Error',
      message: err.message,
    });
  });

  app.listen(MCP_PORT, () => {
    console.log('='.repeat(60));
    console.log('🚀 MCP Todo Server');
    console.log('='.repeat(60));
    console.log(`✓ Server running on http://localhost:${MCP_PORT}`);
    console.log(`✓ SSE endpoint: http://localhost:${MCP_PORT}/sse [SECURED]`);
    console.log(`✓ Messages endpoint: http://localhost:${MCP_PORT}/messages [SECURED]`);
    console.log('='.repeat(60));
    console.log('Configuration:');
    console.log(`  - MCP Server Port: ${MCP_PORT}`);
    console.log(`  - Data Access: Direct Prisma operations (shared service)`);
    console.log(`  - Auth: JWT verification on all endpoints`);
    console.log(`  - Security: No token passthrough anti-pattern`);
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
}

bootstrap().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});