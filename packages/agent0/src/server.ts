// todo-manager.ts
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import * as dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

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
    this.baseUrl = process.env.TODO_API_BASE_URL || 'http://localhost:3001';
    
    const initialToken = process.env.TODO_ACCESS_TOKEN || '';
    if (!initialToken) {
      console.warn('WARNING: TODO_ACCESS_TOKEN not set in environment variables');
      console.warn('You can obtain a token by using the Cross-App Access button in the UI');
    }
  }

  // Get access token dynamically to allow runtime updates
  private getAccessToken(): string {
    return process.env.TODO_ACCESS_TOKEN || '';
  }

  private getHeaders() {
    const token = this.getAccessToken();
    if (!token) {
      console.warn('⚠️  No access token available - API calls may fail');
    }
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async getAllTodos(): Promise<Todo[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/todos`, {
        headers: this.getHeaders(),
      });
      return response.data.todos;
    } catch (error: any) {
      throw new Error(`Failed to fetch todos: ${error.message}`);
    }
  }

  async createTodo(title: string): Promise<Todo> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/todos`,
        { title },
        { headers: this.getHeaders() }
      );
      return response.data.todo;
    } catch (error: any) {
      throw new Error(`Failed to create todo: ${error.message}`);
    }
  }

  async toggleTodo(id: number): Promise<Todo> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/todos/${id}/complete`,
        {},
        { headers: this.getHeaders() }
      );
      return response.data.todo;
    } catch (error: any) {
      throw new Error(`Failed to toggle todo: ${error.message}`);
    }
  }

  async deleteTodo(id: number): Promise<{ message: string }> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/todos/${id}/delete`,
        {},
        { headers: this.getHeaders() }
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
  async (_args, _extra) => {
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
  async ({ id }, _extra) => {
    try {
      const todo = await todoService.toggleTodo(id);
      
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
      const result = await todoService.deleteTodo(id);
      
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
  const PORT = process.env.PORT || 3001; // Changed to 3001 to avoid conflict with client
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

  app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('🚀 MCP Todo Server');
    console.log('='.repeat(60));
    console.log(`✓ Server running on http://localhost:${PORT}`);
    console.log(`✓ SSE endpoint: http://localhost:${PORT}/sse`);
    console.log(`✓ Messages endpoint: http://localhost:${PORT}/messages`);
    console.log('='.repeat(60));
    console.log('Configuration:');
    console.log(`  - Port: ${PORT}`);
    console.log(`  - Todo API: ${process.env.TODO_API_BASE_URL || 'http://localhost:3001'}`);
    console.log(`  - Access Token: ${process.env.TODO_ACCESS_TOKEN ? '✓ Set' : '✗ Not Set'}`);
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

// Helper function to execute tools directly
async function executeTool(toolName: string, args: any) {
  switch (toolName) {
    case 'create-todo':
      const todo = await todoService.createTodo(args.title);
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
      
    case 'get-todos':
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
      
    case 'toggle-todo':
      const toggleTodo = await todoService.toggleTodo(args.id);
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true, 
            todo: toggleTodo, 
            message: 'Todo completion status toggled' 
          }) 
        }],
      };
      
    case 'delete-todo':
      const deleteResult = await todoService.deleteTodo(args.id);
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            message: deleteResult.message
          }) 
        }],
      };
      
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

bootstrap().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});