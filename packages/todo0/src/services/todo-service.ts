import { PrismaClient, Todo } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Shared business logic for todo operations.
 * Used by both todo0 app routes and MCP server tools to avoid token passthrough anti-pattern.
 */
export class TodoService {
  /**
   * Get all todos, ordered by ID descending
   */
  async getAllTodos(): Promise<Todo[]> {
    return prisma.todo.findMany({ orderBy: { id: 'desc' } });
  }

  /**
   * Create a new todo
   */
  async createTodo(title: string): Promise<Todo> {
    return prisma.todo.create({ data: { title } });
  }

  /**
   * Toggle the completed status of a todo
   */
  async toggleTodo(id: number): Promise<Todo | null> {
    const todo = await prisma.todo.findUnique({ where: { id } });
    if (!todo) {
      return null;
    }
    return prisma.todo.update({
      where: { id },
      data: { completed: !todo.completed }
    });
  }

  /**
   * Delete a todo by ID
   */
  async deleteTodo(id: number): Promise<boolean> {
    try {
      await prisma.todo.delete({ where: { id } });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get a single todo by ID
   */
  async getTodoById(id: number): Promise<Todo | null> {
    return prisma.todo.findUnique({ where: { id } });
  }
}

export const todoService = new TodoService();
