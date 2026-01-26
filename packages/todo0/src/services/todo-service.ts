import { PrismaClient, Todo } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Shared business logic for todo operations.
 * Used by both todo0 app routes and MCP server tools to avoid token passthrough anti-pattern.
 * All operations are scoped to the authenticated user's ID.
 */
export class TodoService {
  /**
   * Get all todos for a specific user, ordered by ID descending
   * @param userId - The authenticated user's ID (Okta sub claim)
   */
  async getAllTodos(userId: string): Promise<Todo[]> {
    return prisma.todo.findMany({
      where: { userId },
      orderBy: { id: 'desc' }
    });
  }

  /**
   * Create a new todo for a specific user
   * @param title - The todo title
   * @param userId - The authenticated user's ID (Okta sub claim)
   */
  async createTodo(title: string, userId: string): Promise<Todo> {
    return prisma.todo.create({
      data: { title, userId }
    });
  }

  /**
   * Toggle the completed status of a todo (only if owned by user)
   * @param id - The todo ID
   * @param userId - The authenticated user's ID (Okta sub claim)
   */
  async toggleTodo(id: number, userId: string): Promise<Todo | null> {
    // First verify the todo belongs to this user
    const todo = await prisma.todo.findFirst({
      where: { id, userId }
    });
    if (!todo) {
      return null;
    }
    return prisma.todo.update({
      where: { id },
      data: { completed: !todo.completed }
    });
  }

  /**
   * Delete a todo by ID (only if owned by user)
   * @param id - The todo ID
   * @param userId - The authenticated user's ID (Okta sub claim)
   */
  async deleteTodo(id: number, userId: string): Promise<boolean> {
    try {
      // Only delete if the todo belongs to this user
      const result = await prisma.todo.deleteMany({
        where: { id, userId }
      });
      return result.count > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get a single todo by ID (only if owned by user)
   * @param id - The todo ID
   * @param userId - The authenticated user's ID (Okta sub claim)
   */
  async getTodoById(id: number, userId: string): Promise<Todo | null> {
    return prisma.todo.findFirst({
      where: { id, userId }
    });
  }
}

export const todoService = new TodoService();
