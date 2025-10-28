// todo-manager.ts
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import * as dotenv from 'dotenv';
import axios from 'axios';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

// ============================================================================
// Todo Service - Makes real API calls to Todo backend
// ============================================================================
class TodoService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.TODO_API_BASE_URL || 'http://localhost:5001';
  }

  private getHeaders(accessToken?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    } else {
      console.warn('⚠️  No access token provided - API calls may fail');
    }

    return headers;
  }

  async getAllTodos(accessToken?: string): Promise<Todo[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/todos`, {
        headers: this.getHeaders(accessToken),
      });
      return response.data.todos;
    } catch (error: any) {
      throw new Error(`Failed to fetch todos: ${error.message}`);
    }
  }

  async createTodo(title: string, accessToken?: string): Promise<Todo> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/todos`,
        { title },
        { headers: this.getHeaders(accessToken) }
      );
      return response.data.todo;
    } catch (error: any) {
      throw new Error(`Failed to create todo: ${error.message}`);
    }
  }

  async toggleTodo(id: number, accessToken?: string): Promise<Todo> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/todos/${id}/complete`,
        {},
        { headers: this.getHeaders(accessToken) }
      );
      return response.data.todo;
    } catch (error: any) {
      throw new Error(`Failed to toggle todo: ${error.message}`);
    }
  }

  async deleteTodo(id: number, accessToken?: string): Promise<{ message: string }> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/todos/${id}/delete`,
        {},
        { headers: this.getHeaders(accessToken) }
      );
      return response.data;
    } catch (error: any) {
      throw new Error(`Failed to delete todo: ${error.message}`);
    }
  }
}

const todoService = new TodoService();

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

server.tool(
  'create-todo',
  'Create a new todo item.',
  createTodoParams,
  async ({ title }, _extra) => {
    try {
      // Extract access token from metadata if provided
      const accessToken = _extra.requestInfo?.headers['authorization']?.toString().replace('Bearer ', '');
      const todo = await todoService.createTodo(title, accessToken);

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
  async (_args, _extra) => {
    try {
      // Extract access token from metadata if provided
      const accessToken = _extra.requestInfo?.headers['authorization']?.toString().replace('Bearer ', '');
      const todos = await todoService.getAllTodos(accessToken);

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
  async ({ id }, _extra) => {
    try {
      const accessToken = _extra.requestInfo?.headers['authorization']?.toString().replace('Bearer ', '');
      const todo = await todoService.toggleTodo(id, accessToken);

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
  async ({ id }, _extra) => {
    try {
      const accessToken = _extra.requestInfo?.headers['authorization']?.toString().replace('Bearer ', '');
      const result = await todoService.deleteTodo(id, accessToken);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: result.message
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
  const MCP_PORT = process.env.MCP_PORT || 5002;
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  app.use(express.json());

  app.get('/sse', async (_req, res) => {
    console.log('New SSE connection established');

    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);

    res.on('close', () => {
      console.log('SSE connection closed:', transport.sessionId);
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = String(req.query.sessionId);
    const transport = transports.get(sessionId);

    if (transport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      console.error('No transport found for sessionId:', sessionId);
      res.status(400).json({
        error: 'Invalid session',
        message: 'No transport found for sessionId',
      });
    }
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
    console.log(`✓ SSE endpoint: http://localhost:${MCP_PORT}/sse`);
    console.log(`✓ Messages endpoint: http://localhost:${MCP_PORT}/messages`);
    console.log('='.repeat(60));
    console.log('Configuration:');
    console.log(`  - MCP Server Port: ${MCP_PORT}`);
    console.log(`  - Todo API: ${process.env.TODO_API_BASE_URL || 'http://localhost:5001'}`);
    console.log(`  - Auth: Tokens passed per-request via MCP protocol`);
    console.log('='.repeat(60));
    console.log('Available Tools:');
    console.log('  1. create-todo  - Create a new todo');
    console.log('  2. get-todos    - List all todos');
    console.log('  3. toggle-todo  - Toggle completion state');
    console.log('  4. delete-todo  - Delete a todo');
    console.log('='.repeat(60));
    console.log('Ready to accept connections! 🎉');
    console.log('');
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});