import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/requireAuth';

const prisma = new PrismaClient();
const router = Router();

router.get('/', async (req, res) => {
  const authenticated = req.session && req.session.access_token;
  const accessToken = req.session?.access_token || '';
  let todos: any[] = [];
  if (authenticated) {
    todos = await prisma.todo.findMany({ orderBy: { id: 'desc' } });
  }
  res.render('index', { todos, authenticated, accessToken });
});

// API endpoint to get all todos as JSON (Bearer token required)
router.get('/todos', requireAuth, async (req, res) => {
  try {
    const todos = await prisma.todo.findMany({ orderBy: { id: 'desc' } });
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
    const todo = await prisma.todo.create({ data: { title } });
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
    const todo = await prisma.todo.findUnique({ where: { id } });
    if (!todo) {
      if (req.accepts('html')) return res.redirect('/');
      return res.status(404).json({ error: 'Todo not found' });
    }
    const updated = await prisma.todo.update({ where: { id }, data: { completed: !todo.completed } });
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
    await prisma.todo.delete({ where: { id } });
    if (req.accepts('html')) return res.redirect('/');
    res.json({ message: 'Todo deleted successfully' });
  } catch (error: any) {
    console.error('Failed to delete todo:', error);
    if (req.accepts('html')) return res.redirect('/');
    res.status(500).json({ error: 'Failed to delete todo', message: error.message });
  }
});

export default router;
