// resource-server.ts - Agent0 Resource Server (Express)
import express, { Request, Response } from 'express';
import * as path from 'path';
import cookieParser from 'cookie-parser';
import { getAgentForSession, UserContext } from './agent.js';
import { OktaAuthHelper, OktaConfig, createSessionMiddleware } from './auth/okta-auth.js';
import { TokenExchangeHandler, TokenExchangeConfig, createTokenExchangeConfig } from './auth/token-exchange.js';

// ============================================================================
// Resource Server Configuration
// ============================================================================

export interface ResourceServerConfig {
  port: number;
  sessionSecret: string;
  okta?: OktaConfig;
}

// ============================================================================
// Resource Server Class
// ============================================================================

export class ResourceServer {
  private app: express.Application;
  private config: ResourceServerConfig;
  private oktaAuthHelper: OktaAuthHelper | null = null;
  private tokenExchangeHandler: TokenExchangeHandler | null = null;

  constructor(config: ResourceServerConfig) {
    this.config = config;
    this.app = express();

    // Initialize Okta Auth if configured
    if (this.config.okta) {
      this.oktaAuthHelper = new OktaAuthHelper(this.config.okta);
    }

    // Initialize Token Exchange if configured
    const tokenExchangeConfig = createTokenExchangeConfig();
    if (tokenExchangeConfig) {
      this.tokenExchangeHandler = new TokenExchangeHandler(tokenExchangeConfig);
    }

    this.setupMiddleware();
    this.setupRoutes();
  }

  // ============================================================================
  // Middleware Setup
  // ============================================================================

  private setupMiddleware(): void {
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
    const nodeModulesPath = path.join(__dirname, '..', '..', 'node_modules');

    this.app.use(express.static(publicPath));
    this.app.use('/node_modules', express.static(nodeModulesPath));
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

    // Cross-app access: Exchange ID token for ID-JAG token
    if (this.tokenExchangeHandler) {
      this.app.post('/cross-app-access', this.oktaAuthHelper.requireAuth(), async (req, res) => {
        // Wrap the original response to intercept the access token
        const originalJson = res.json.bind(res);
        res.json = (body: any) => {
          return originalJson(body);
        };

        await this.tokenExchangeHandler!.handleCrossAppAccess(req, res);
      });
    }
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

        // Process message with agent
        const result = await agent.processUserInput(message);
        res.json(result);
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
  // Health Check
  // ============================================================================

  private handleHealth(_req: Request, res: Response): void {
    res.json({
      status: 'ok',
      service: 'agent0 Resource Server',
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
        console.log('🚀 Agent0 Resource Server');
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
        console.log(`  - Token Exchange: ${this.tokenExchangeHandler ? '✅ Configured' : '❌ Not Configured'}`);
        console.log('='.repeat(60));
        console.log('Ready! 🎉');
        console.log('');
        resolve();
      });
    });
  }
}
