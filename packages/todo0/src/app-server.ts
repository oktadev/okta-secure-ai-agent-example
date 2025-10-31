import express from 'express';
import path from 'path';
import bodyParser from 'body-parser';
import session from 'express-session';
import * as dotenv from 'dotenv';
import { createRequireAuth } from './middleware/requireAuth';
import { createAuthRouter } from './routes/auth';
import { createTodosRouter } from './routes/todos';

// Load environment variables from .env.app
dotenv.config({ path: path.resolve(__dirname, '../.env.app') });

/**
 * Configuration interface for app server
 */
interface AppServerConfig {
  port: number;
  oktaIssuer: string;
  oktaClientId: string;
  oktaClientSecret: string;
  oktaRedirectUri: string;
}

/**
 * Validate required environment variables and return typed configuration
 */
function validateAppEnv(): AppServerConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  // Check required variables
  const requiredVars = [
    'OKTA_ISSUER',
    'OKTA_CLIENT_ID',
    'OKTA_CLIENT_SECRET',
    'OKTA_REDIRECT_URI'
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName] || process.env[varName]!.trim() === '') {
      missing.push(varName);
    }
  }

  // Validate URL formats
  if (process.env.OKTA_ISSUER) {
    try {
      new URL(process.env.OKTA_ISSUER);
    } catch {
      invalid.push('OKTA_ISSUER (invalid URL format)');
    }
  }

  if (process.env.OKTA_REDIRECT_URI) {
    try {
      new URL(process.env.OKTA_REDIRECT_URI);
    } catch {
      invalid.push('OKTA_REDIRECT_URI (invalid URL format)');
    }
  }

  // Report errors and exit if validation fails
  if (missing.length > 0 || invalid.length > 0) {
    console.error('❌ Environment configuration error in .env.app');
    if (missing.length > 0) {
      console.error('   Missing required variables:', missing.join(', '));
    }
    if (invalid.length > 0) {
      console.error('   Invalid variables:', invalid.join(', '));
    }
    console.error('   Check packages/todo0/.env.app file');
    process.exit(1);
  }

  console.log('✅ App server environment variables validated');

  // Return typed configuration object
  return {
    port: parseInt(process.env.PORT || '', 10),
    oktaIssuer: process.env.OKTA_ISSUER!,
    oktaClientId: process.env.OKTA_CLIENT_ID!,
    oktaClientSecret: process.env.OKTA_CLIENT_SECRET!,
    oktaRedirectUri: process.env.OKTA_REDIRECT_URI!,
  };
}

// Validate environment and get typed configuration
const config = validateAppEnv();

// Create configured modules
const requireAuth = createRequireAuth();

const authRouter = createAuthRouter({
  oktaIssuer: config.oktaIssuer,
  oktaClientId: config.oktaClientId,
  oktaClientSecret: config.oktaClientSecret,
  oktaRedirectUri: config.oktaRedirectUri,
});

const todosRouter = createTodosRouter(requireAuth);

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

app.listen(config.port, () => {
  console.log(`[SERVER] Express server running on http://localhost:${config.port}`);
  console.log(`[SERVER] Auth routes: /login, /callback, /logout`);
});
