import express from 'express';
import path from 'path';
import bodyParser from 'body-parser';
import session from 'express-session';
import * as dotenv from 'dotenv';
import todosRouter from './routes/todos';
import authRouter from './routes/auth';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

declare module 'express-session' {
  interface SessionData {
    access_token?: string;
    id_token?: string;
    codeVerifier?: string;
    state?: string;
  }
}
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Logging middleware - must come first
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  console.log(`[REQUEST] Path: ${req.path}`);
  console.log(`[REQUEST] Headers:`, req.headers);
  next();
});

app.use(session({
  name: 'todo0.sid', // Unique session name for todo0 app
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  rolling: true, // Keep session alive with activity
  cookie: { 
    secure: false,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  }
}));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json()); // Enable JSON body parsing for API routes
app.use(express.static(path.join(__dirname, '../public')));

console.log('[SERVER] Registering routes...');
app.use('/', todosRouter);
app.use('/', authRouter);
console.log('[SERVER] Routes registered');

// 404 handler - must come after all routes
app.use((req, res) => {
  console.error(`[404] Route not found: ${req.method} ${req.url}`);
  console.error(`[404] Available routes should include: /login, /callback, /logout`);
  res.status(404).send(`404 Not Found: ${req.method} ${req.url}`);
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`[SERVER] Express server running on http://localhost:${PORT}`);
  console.log(`[SERVER] Auth routes: /login, /callback, /logout`);
});
