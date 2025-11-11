import { Router, RequestHandler } from 'express';
import { todoService } from '../services/todo-service';

export function createTodosRouter(requireAuth: RequestHandler): Router {
  const router = Router();

router.get('/', async (req, res) => {
  const authenticated = req.session && req.session.access_token;
  const accessToken = req.session?.access_token || '';
  let todos: any[] = [];
  if (authenticated) {
    todos = await todoService.getAllTodos();
  }
  res.render('index', { todos, authenticated, accessToken });
});

// API endpoint to get all todos as JSON (Bearer token required)
router.get('/todos', requireAuth, async (req, res) => {
  try {
    const todos = await todoService.getAllTodos();
    res.json({ todos });
  } catch (error: any) {
    console.error('Failed to fetch todos:', error);
    res.status(500).json({ error: 'Failed to fetch todos', message: error.message });
  }
});



// Create a new todo
router.post('/todos', requireAuth, async (req, res) => {
  const { title } = req.body;
  if (!title) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(400).json({ error: 'Title is required' });
  }
  try {
    const todo = await todoService.createTodo(title);
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
  const id = parseInt(req.params.id, 10);
  try {
    const updated = await todoService.toggleTodo(id);
    if (!updated) {
      if (req.accepts('html')) return res.redirect('/');
      return res.status(404).json({ error: 'Todo not found' });
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
  const id = parseInt(req.params.id, 10);
  try {
    const deleted = await todoService.deleteTodo(id);
    if (!deleted) {
      if (req.accepts('html')) return res.redirect('/');
      return res.status(404).json({ error: 'Todo not found' });
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
