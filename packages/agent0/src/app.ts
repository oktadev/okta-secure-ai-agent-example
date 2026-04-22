// app.ts - Agent0 App Server (Express)
import express, { Request, Response } from 'express';
import * as path from 'path';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { getAgentForSession } from './agent.js';
import { OktaAuthHelper, OktaConfig, createSessionMiddleware } from './auth/okta-auth.js';
import { buildConnectionStatuses } from './connections/registry.js';

// ============================================================================
// App Server Configuration Types
// ============================================================================

/**
 * App server configuration (discriminated union for optional Okta)
 */
type AppServerConfig = {
  port: number;
  sessionSecret: string;
} & (
  | {
      hasOkta: true;
      oktaDomain: string;
      oktaClientId: string;
      oktaClientSecret: string;
      oktaRedirectUri: string;
    }
  | {
      hasOkta: false;
    }
);

/**
 * Internal configuration after processing
 */
interface AppServerInternalConfig {
  port: number;
  sessionSecret: string;
  okta?: OktaConfig;
}

// ============================================================================
// Environment Validation Function
// ============================================================================

/**
 * Validate app server environment variables and return typed configuration
 */
function validateAppServerEnv(): AppServerConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  // Check required variables
  if (!process.env.PORT || process.env.PORT.trim() === '') {
    missing.push('PORT');
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.trim() === '') {
    missing.push('SESSION_SECRET');
  }

  // Check optional Okta configuration (all or none)
  const oktaDomain = process.env.OKTA_DOMAIN;
  const oktaClientId = process.env.OKTA_CLIENT_ID;
  const oktaClientSecret = process.env.OKTA_CLIENT_SECRET;
  const oktaRedirectUri = process.env.OKTA_REDIRECT_URI;

  const oktaVarsSet = [oktaDomain, oktaClientId, oktaClientSecret, oktaRedirectUri].filter(v => v && v.trim() !== '');
  const hasPartialOkta = oktaVarsSet.length > 0 && oktaVarsSet.length < 4;

  if (hasPartialOkta) {
    if (!oktaDomain || oktaDomain.trim() === '') missing.push('OKTA_DOMAIN');
    if (!oktaClientId || oktaClientId.trim() === '') missing.push('OKTA_CLIENT_ID');
    if (!oktaClientSecret || oktaClientSecret.trim() === '') missing.push('OKTA_CLIENT_SECRET');
    if (!oktaRedirectUri || oktaRedirectUri.trim() === '') missing.push('OKTA_REDIRECT_URI');
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
    console.error('   Check packages/agent0/.env.app file');
    console.error('   Note: Okta variables must be all present or all absent');
    process.exit(1);
  }

  console.log('✅ App server environment variables validated');

  const baseConfig = {
    port: parseInt(process.env.PORT!, 10),
    sessionSecret: process.env.SESSION_SECRET!,
  };

  // Return discriminated union based on Okta configuration
  if (oktaVarsSet.length === 4) {
    return {
      ...baseConfig,
      hasOkta: true,
      oktaDomain: oktaDomain!,
      oktaClientId: oktaClientId!,
      oktaClientSecret: oktaClientSecret!,
      oktaRedirectUri: oktaRedirectUri!,
    };
  } else {
    return {
      ...baseConfig,
      hasOkta: false,
    };
  }
}

// ============================================================================
// App Server Class
// ============================================================================

export class AppServer {
  private app: express.Application;
  private config: AppServerInternalConfig;
  private oktaAuthHelper: OktaAuthHelper | null = null;

  constructor() {
    // Validate environment and get typed config
    const envConfig = validateAppServerEnv();

    this.config = {
      port: envConfig.port,
      sessionSecret: envConfig.sessionSecret,
    };

    this.app = express();

    // Initialize Okta Auth if configured
    if (envConfig.hasOkta) {
      this.config.okta = {
        domain: envConfig.oktaDomain,
        clientId: envConfig.oktaClientId,
        clientSecret: envConfig.oktaClientSecret,
        redirectUri: envConfig.oktaRedirectUri,
      };
      this.oktaAuthHelper = new OktaAuthHelper(this.config.okta);
    }

    this.setupMiddleware();
    this.setupRoutes();
  }

  public getPort(): number {
    return this.config.port;
  }

  // ============================================================================
  // Middleware Setup
  // ============================================================================

  private setupMiddleware(): void {
    // Security headers via helmet (uses secure defaults, we only override CSP)
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'", "http://localhost:3000", "http://127.0.0.1:3000"],
        },
      },
    }));

    this.app.use(express.json());
    this.app.use(cookieParser());
    this.app.use(createSessionMiddleware(this.config.sessionSecret));

    // CORS middleware
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // Serve static files (web UI)
    const publicPath = path.join(__dirname, '..', 'public');
    this.app.use(express.static(publicPath));
  }

  // ============================================================================
  // Routes Setup
  // ============================================================================

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', this.handleHealth.bind(this));

    // Setup authentication routes
    this.setupAuthRoutes();

    // Setup chat routes
    this.setupChatRoutes();

    // Setup OAuth STS routes
    this.setupOAuthStsRoutes();
  }

  // ============================================================================
  // Authentication Routes
  // ============================================================================

  private setupAuthRoutes(): void {
    if (!this.oktaAuthHelper) {
      console.log('⚠️  Okta authentication not configured - auth endpoints disabled');
      return;
    }

    // Login endpoint - redirects to Okta
    this.app.get('/login', (req, res) => {
      this.oktaAuthHelper!.handleLogin(req, res);
    });

    // Callback endpoint - handles Okta redirect
    this.app.get('/callback', (req, res) => {
      this.oktaAuthHelper!.handleCallback(req, res);
    });

    // Logout endpoint
    this.app.get('/logout', this.oktaAuthHelper.handleLogout(this.config.port));

    // Auth status endpoint
    this.app.get('/auth/status', (req, res) => {
      this.oktaAuthHelper!.handleAuthStatus(req, res);
    });

    // Get current user's ID token claims
    this.app.get('/auth/user', this.oktaAuthHelper.requireAuth(), (req, res) => {
      this.oktaAuthHelper!.handleUserInfo(req, res);
    });
  }

  // ============================================================================
  // Chat Routes
  // ============================================================================

  private setupChatRoutes(): void {
    const authMiddleware = this.oktaAuthHelper
      ? this.oktaAuthHelper.requireAuth()
      : (_req: Request, _res: Response, next: any) => next();

    // Chat endpoint with LLM support
    this.app.post('/api/chat', authMiddleware, async (req, res) => {
      try {
        const { message } = req.body;

        if (!message) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'message is required',
          });
        }

        const agent = await getAgentForSession(req);

        if (!agent || !agent.isLLMEnabled()) {
          return res.status(503).json({
            success: false,
            error: 'Service Unavailable',
            message: 'LLM is not configured. Please set ANTHROPIC_API_KEY environment variable.',
          });
        }

        // Process message with agent. If connect() produced pending OAuth-STS
        // consents (e.g. GitHub MCP first-use), surface them so the frontend
        // can open consent popups; the LLM still runs with whichever MCP
        // tools did connect successfully.
        const result = await agent.processUserInput(message);
        const pendingConsents = agent.consumePendingConsents();
        if (pendingConsents.length > 0) {
          const data = { ...(result.data || {}), pending_consents: pendingConsents };
          res.json({ ...result, data });
        } else {
          res.json(result);
        }
      } catch (error: any) {
        console.error('Chat API error:', error);
        res.status(500).json({
          success: false,
          error: 'Internal Server Error',
          message: error.message,
        });
      }
    });
  }

  // ============================================================================
  // OAuth STS Brokered Consent Routes
  // ============================================================================

  private setupOAuthStsRoutes(): void {
    const authMiddleware = this.oktaAuthHelper
      ? this.oktaAuthHelper.requireAuth()
      : (_req: Request, _res: Response, next: any) => next();

    // Trigger OAuth STS exchange (called after user completes consent).
    // Optional body field `resource` lets callers target a specific
    // OAuth-STS handler (OIN GitHub, GitHub MCP, ...). Absent `resource`
    // falls back to the legacy OIN handler for backward compatibility.
    this.app.post('/api/oauth-sts/exchange', authMiddleware, async (req, res) => {
      try {
        const agent = await getAgentForSession(req);
        if (!agent) {
          return res.status(503).json({ status: 'error', error: 'Agent not available' });
        }

        const resource: string | undefined = req.body?.resource;
        const stsHandler = resource
          ? agent.getOAuthStsHandlerByResource(resource)
          : agent.getOAuthStsHandler();

        if (!stsHandler) {
          return res.status(404).json({
            status: 'error',
            error: resource
              ? `No OAuth STS handler registered for resource="${resource}"`
              : 'OAuth STS not configured',
          });
        }

        const idToken = agent.getIdToken();
        const result = await stsHandler.exchangeForISVToken(idToken);

        // If this exchange just unblocked an MCP, reconnect it so its tools
        // join the union. We can't rely on getPendingConsents() here — /api/chat
        // already drained it via consumePendingConsents(). Instead match by
        // resource against the live MCP list.
        if (resource && result.status === 'success') {
          const owner = agent
            .listOAuthStsResources()
            .find(r => r.scope === 'mcp' && r.resource === resource);
          if (owner?.mcpId) {
            const outcome = await agent.retryPendingMcp(owner.mcpId);
            console.log(`   retryPendingMcp[${owner.mcpId}] -> ${outcome}`);
          }
        }

        res.json(result);
      } catch (error: any) {
        console.error('OAuth STS exchange error:', error);
        res.status(500).json({ status: 'error', error: error.message });
      }
    });

    // Check OAuth STS connection status. Optional `?resource=` query
    // targets a specific handler; default = legacy OIN handler.
    this.app.get('/api/oauth-sts/status', authMiddleware, async (req, res) => {
      try {
        const agent = await getAgentForSession(req);
        if (!agent) {
          return res.json({ configured: false, connected: false });
        }

        const resource = typeof req.query.resource === 'string' ? req.query.resource : undefined;
        const stsHandler = resource
          ? agent.getOAuthStsHandlerByResource(resource)
          : agent.getOAuthStsHandler();

        if (!stsHandler) {
          return res.json({ configured: false, connected: false });
        }

        const hasToken = stsHandler.getCachedToken() !== null;
        res.json({ configured: true, connected: hasToken, resource });
      } catch (error: any) {
        console.error('OAuth STS status error:', error);
        res.status(500).json({ configured: false, connected: false, error: error.message });
      }
    });

    // Unified connections status: reports all five Okta managed-connection
    // slots (authorization_server, application, secret, service_account,
    // mcp_server) so the UI "Connections" panel can render them uniformly.
    //
    // Returns env-derived state for the anonymous/logged-out case, and
    // enriches "connected" flags with per-user runtime state when the
    // caller has an active session.
    this.app.get('/api/connections/status', async (req, res) => {
      try {
        const agent = await getAgentForSession(req).catch(() => null);
        const connections = buildConnectionStatuses(agent);
        res.json({ connections });
      } catch (error: any) {
        console.error('Connections status error:', error);
        res.status(500).json({ error: error.message });
      }
    });
  }

  // ============================================================================
  // Health Check
  // ============================================================================

  private handleHealth(_req: Request, res: Response): void {
    res.json({
      status: 'ok',
      service: 'agent0 App Server',
      oktaEnabled: this.oktaAuthHelper ? true : false,
      llmEnabled: true,
      timestamp: new Date().toISOString(),
    });
  }

  // ============================================================================
  // Start Server
  // ============================================================================

  async start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.app.listen(this.config.port, () => {
        console.log('='.repeat(60));
        console.log('🚀 Agent0 App Server');
        console.log('='.repeat(60));
        console.log(`✓ Server running on http://localhost:${this.config.port}`);
        console.log(`✓ Health check: http://localhost:${this.config.port}/health`);
        console.log(`✓ Web UI: http://localhost:${this.config.port}`);
        console.log(`✓ Chat endpoint: http://localhost:${this.config.port}/api/chat`);
        console.log('='.repeat(60));
        console.log('Configuration:');
        console.log(`  - Port: ${this.config.port}`);
        console.log(`  - Okta Auth: ${this.oktaAuthHelper ? '✅ Enabled' : '❌ Disabled'}`);
        if (this.oktaAuthHelper && this.config.okta) {
          console.log(`  - Okta Domain: ${this.config.okta.domain}`);
          console.log(`  - Login URL: http://localhost:${this.config.port}/login`);
        }
        console.log('='.repeat(60));
        console.log('Ready! 🎉');
        console.log('');
        resolve();
      });
    });
  }
}
