import { Router, RequestHandler } from 'express';
import { todoService } from '../services/todo-service';

export function createTodosRouter(requireAuth: RequestHandler): Router {
  const router = Router();

router.get('/', async (req, res) => {
  const authenticated = req.session && req.session.access_token && req.session.userId;
  const accessToken = req.session?.access_token || '';
  const userId = req.session?.userId || '';
  let todos: any[] = [];
  if (authenticated && userId) {
    todos = await todoService.getAllTodos(userId);
  }
  res.render('index', { todos, authenticated, accessToken });
});

// API endpoint to get all todos as JSON (Bearer token required)
router.get('/todos', requireAuth, async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ error: 'User ID not found in session' });
  }
  try {
    const todos = await todoService.getAllTodos(userId);
    res.json({ todos });
  } catch (error: any) {
    console.error('Failed to fetch todos:', error);
    res.status(500).json({ error: 'Failed to fetch todos', message: error.message });
  }
});



// Create a new todo
router.post('/todos', requireAuth, async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'User ID not found in session' });
  }
  const { title } = req.body;
  if (!title) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(400).json({ error: 'Title is required' });
  }
  try {
    const todo = await todoService.createTodo(title, userId);
    if (req.accepts('html')) return res.redirect('/');
    res.status(201).json({ todo });
  } catch (error: any) {
    console.error('Failed to create todos:', error);
    if (req.accepts('html')) return res.redirect('/');
    res.status(500).json({ error: 'Failed to create todo', message: error.message });
  }
});

// Toggle complete/undo
router.post('/todos/:id/complete', requireAuth, async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'User ID not found in session' });
  }
  const id = parseInt(req.params.id, 10);
  try {
    const updated = await todoService.toggleTodo(id, userId);
    if (!updated) {
      if (req.accepts('html')) return res.redirect('/');
      return res.status(404).json({ error: 'Todo not found or not owned by user' });
    }
    if (req.accepts('html')) return res.redirect('/');
    res.json({ todo: updated });
  } catch (error: any) {
    console.error('Failed to complete todo:', error);
    if (req.accepts('html')) return res.redirect('/');
    res.status(500).json({ error: 'Failed to update todo', message: error.message });
  }
});

// Delete a todo
router.post('/todos/:id/delete', requireAuth, async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'User ID not found in session' });
  }
  const id = parseInt(req.params.id, 10);
  try {
    const deleted = await todoService.deleteTodo(id, userId);
    if (!deleted) {
      if (req.accepts('html')) return res.redirect('/');
      return res.status(404).json({ error: 'Todo not found or not owned by user' });
    }
    if (req.accepts('html')) return res.redirect('/');
    res.json({ message: 'Todo deleted successfully' });
  } catch (error: any) {
    console.error('Failed to delete todo:', error);
    if (req.accepts('html')) return res.redirect('/');
    res.status(500).json({ error: 'Failed to delete todo', message: error.message });
  }
});

  return router;
}
