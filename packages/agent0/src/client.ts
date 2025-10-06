import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { OktaAuth } from '@okta/okta-auth-js';
import * as fs from 'fs';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
// import { AccessTokenResult, exchangeIdJwtAuthzGrant, ExchangeTokenResult, requestIdJwtAuthzGrant } from 'id-assert-authz-grant-client';

// Extend Express session type  
declare module 'express-session' {
  interface SessionData {
    idToken?: string;
    accessToken?: string;
    userInfo?: any;
    oktaMeta?: {
      state: string;
      codeVerifier: string;
      codeChallenge: string;
    };
  }
}

// Load environment variables
dotenv.config();

// ============================================================================
// MCP Client Configuration
// ============================================================================

interface MCPClientConfig {
  serverUrl: string;
  name: string;
  version: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  enableLLM?: boolean;
  okta?: {
    domain: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  sessionSecret?: string;
}

// ============================================================================
// Chat Interface Class (No CLI - API only)
// ============================================================================

class MCPChatClient {

  // Start MCP server, connect, and serve UI
  async startServerAndConnect(serverScriptPath: string, mcpServerPort: number = 3001, clientPort: number = 3000): Promise<void> {
    const { spawn } = await import('child_process');
    // Use eval to prevent TypeScript from transforming dynamic import to require()
    const open = (await (0, eval)("import('open')")).default;

    console.log('🚀 Starting MCP Server...');
    
    // Start the MCP server as a child process
    const serverProcess = spawn('node', [serverScriptPath], {
      cwd: path.dirname(serverScriptPath),
      stdio: 'inherit',
      env: { ...process.env, PORT: String(mcpServerPort) },
    });

    // Wait for the server to start
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log('🔌 Connecting MCP Client to server...');
    
    // Update config to point to the MCP server port
    this.config.serverUrl = `http://localhost:${mcpServerPort}`;
    
    // Connect the client to the MCP server
    await this.connect();

    console.log('🌐 Starting Web UI Server...');
    
    // Start Express server for UI
    await this.startUIServer(clientPort);
    
    // Open the browser to the web UI
    console.log(`✅ Opening browser at http://localhost:${clientPort}`);
    await open(`http://localhost:${clientPort}`);

    // Handle server process exit
    serverProcess.on('exit', (code) => {
      console.log(`MCP server exited with code ${code}`);
      process.exit(code || 0);
    });
  }

  // Start Express server to serve the UI
  private async startUIServer(port: number): Promise<void> {
    const app = express();
    
    app.use(express.json());
    app.use(cookieParser());
    
    // Session configuration
    app.use(session({
      name: 'agent0.sid', // Unique session name for agent0 app
      secret: this.config.sessionSecret || 'default-secret-change-in-production',
      resave: false,
      saveUninitialized: false,
      rolling: true, // Reset maxAge on every response
      cookie: {
        secure: false, // Set to true in production with HTTPS
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        sameSite: 'lax', // Prevent CSRF while allowing normal navigation
      },
    }) as any);
    
    // CORS middleware
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // Initialize Okta Auth if configured
    let oktaAuth: OktaAuth | null = null;
    if (this.config.okta) {
      oktaAuth = new OktaAuth({
        issuer: `https://${this.config.okta.domain}`,
        clientId: this.config.okta.clientId,
        clientSecret: this.config.okta.clientSecret,
        redirectUri: this.config.okta.redirectUri,
        scopes: ['openid', 'profile', 'email'],
        pkce: true, // Enable PKCE for proper flow
        tokenManager: {
          storage: 'memory',
        },
      });
      console.log('🔐 Okta authentication configured');
    }

    // Serve static files (web UI)
    const publicPath = path.join(__dirname, '..', 'public');
    const nodeModulesPath = path.join(__dirname, '..', '..', 'node_modules');
    
    app.use(express.static(publicPath));
    app.use('/node_modules', express.static(nodeModulesPath));

    // Login endpoint - redirects to Okta
    app.get('/login', async (req, res) => {
      if (!oktaAuth || !this.config.okta) {
        return res.status(500).json({ error: 'Okta not configured' });
      }
      
      // oktaAuth.signInWithRedirect();
      try {
        // Generate code verifier and challenge for PKCE
        const tokenParams = await oktaAuth.token.prepareTokenParams();
        const meta = {
          state: Math.random().toString(36).substring(7),
          codeVerifier: tokenParams.codeVerifier || '',
          codeChallenge: tokenParams.codeChallenge || '',
        };
        
        // Store meta in session for callback
        (req.session as any).oktaMeta = meta;
        
        const authorizeUrl = `https://${this.config.okta.domain}/oauth2/v1/authorize?` +
          `client_id=${this.config.okta.clientId}&` +
          `response_type=code&` +
          `scope=openid%20profile%20email&` +
          `redirect_uri=${encodeURIComponent(this.config.okta.redirectUri)}&` +
          `state=${meta.state}&` +
          `code_challenge_method=S256&` +
          `code_challenge=${meta.codeChallenge}`;
        
        res.redirect(authorizeUrl);
      } catch (error: any) {
        console.error('Login redirect error:', error);
        res.status(500).json({ error: 'Failed to initiate login' });
      }
    });

    // Callback endpoint - handles Okta redirect
    app.get('/callback', async (req, res) => {
      if (!oktaAuth || !this.config.okta) {
        return res.status(500).json({ error: 'Okta not configured' });
      }

      // await oktaAuth.handleLoginRedirect();
      const { code, error, error_description, state } = req.query;

      if (error) {
        console.error('Okta authentication error:', error, error_description);
        return res.redirect('/?error=' + encodeURIComponent(error as string));
      }

      if (!code) {
        return res.redirect('/?error=no_code');
      }

      try {
        // Get stored meta from session
        const oktaMeta = (req.session as any).oktaMeta;
        if (!oktaMeta || !oktaMeta.codeVerifier) {
          console.error('No code verifier found in session');
          return res.redirect('/?error=missing_verifier');
        }

        // Verify state matches
        if (oktaMeta.state !== state) {
          console.error('State mismatch');
          return res.redirect('/?error=state_mismatch');
        }

        // Exchange authorization code for tokens
        const tokenResponse = await oktaAuth.token.exchangeCodeForTokens({
          authorizationCode: code as string,
          codeVerifier: oktaMeta.codeVerifier,
        });

        const { idToken, accessToken } = tokenResponse.tokens;

        if (idToken && accessToken) {
          // Store tokens in session
          (req.session as any).idToken = idToken.idToken;
          (req.session as any).accessToken = accessToken.accessToken;
          (req.session as any).userInfo = idToken.claims;

          // Clear the meta data
          delete (req.session as any).oktaMeta;

          console.log('✅ User authenticated:', idToken.claims.email || idToken.claims.sub);
          
          // Redirect to main page
          res.redirect('/');
        } else {
          throw new Error('No tokens received from Okta');
        }
      } catch (error: any) {
        console.error('Token exchange error:', error);
        res.redirect('/?error=token_exchange_failed');
      }
    });

    // Logout endpoint
    app.get('/logout', (req, res) => {
      req.session.destroy((err) => {
        if (err) {
          console.error('Session destruction error:', err);
        }
        if (oktaAuth && this.config.okta) {
          const logoutUrl = `https://${this.config.okta.domain}/oauth2/v1/logout?` +
            `id_token_hint=${(req.session as any)?.idToken || ''}&` +
            `post_logout_redirect_uri=${encodeURIComponent('http://localhost:' + port)}`;
          res.redirect(logoutUrl);
        } else {
          res.redirect('/');
        }
      });
    });

    // Auth status endpoint
    app.get('/auth/status', async (req, res) => {
      console.log(await oktaAuth?.isAuthenticated());

      const session = req.session as any;

      if (session.idToken && session.userInfo) {
        res.json({
          authenticated: true,
          user: {
            email: session.userInfo.email,
            name: session.userInfo.name,
            sub: session.userInfo.sub,
            given_name: session.userInfo.given_name,
            family_name: session.userInfo.family_name,
          },
          // Don't send the actual token to client, just metadata
          tokenInfo: {
            hasIdToken: !!session.idToken,
            hasAccessToken: !!session.accessToken,
            issuer: session.userInfo.iss,
            issuedAt: session.userInfo.iat,
            expiresAt: session.userInfo.exp,
          },
        });
      } else {
        res.json({ authenticated: false });
      }
    });

    // Get ID token (only for server-side use, don't expose raw token to browser)
    // This endpoint can be used by the chat API internally
    const getIdToken = (req: Request): string | null => {
      const session = req.session as any;
      return session.idToken || null;
      // return oktaAuth?.getIdToken() ?? null;
    };

    // Get access token (for making authenticated API calls)
    const getAccessToken = (req: Request): string | null => {
      const session = req.session as any;
      return session.accessToken || null;
      // return oktaAuth?.getAccessToken() ?? null;
    };

    // Middleware to check authentication
    const requireAuth = (req: Request, res: Response, next: NextFunction) => {
      const session = req.session as any;
      if (!oktaAuth) {
        // If Okta is not configured, allow access
        return next();
      }
      
      if (session.idToken) {
        next();
      } else {
        res.status(401).json({ error: 'Unauthorized', message: 'Please login first' });
      }
    };

    // Get current user's ID token claims (for debugging/display purposes)
    app.get('/auth/user', requireAuth, (req, res) => {
      const session = req.session as any;
      if (session.userInfo) {
        res.json({
          success: true,
          user: session.userInfo,
        });
      } else {
        res.status(404).json({
          success: false,
          message: 'User information not found',
        });
      }
    });

    // Cross-app access: Exchange ID token for ID-JAG token
    app.post('/cross-app-access', requireAuth, async (req, res) => {
      try {
        const session = req.session as any;
        const idToken = session.idToken;
        console.log(idToken.toString());

        if (!idToken) {
          return res.status(401).json({
            success: false,
            error: 'No ID token found in session',
          });
        }

        // Get configuration from environment
        const targetAudience = process.env.TARGET_SERVICE_AUDIENCE;
        const tokenEndpoint = process.env.OKTA_TOKEN_ENDPOINT;
        const clientId = process.env.AI_AGENT_ID;
        const oktaDomain = process.env.OKTA_DOMAIN || (this.config.okta ? this.config.okta.domain : null) || null;
        const privateKeyFile = process.env.OKTA_CC_PRIVATE_KEY_FILE;

        if (!targetAudience || !tokenEndpoint || !clientId || !oktaDomain || !privateKeyFile) {
          return res.status(500).json({
            success: false,
            error: 'Cross-app access not configured properly. Missing required environment variables.',
          });
        }

        // Read the private key
        const privateKeyPath = path.resolve(__dirname, '..', privateKeyFile);
        let privateKey: string;
        try {
          privateKey = fs.readFileSync(privateKeyPath, 'utf8');
        } catch (error: any) {
          console.error('Failed to read private key:', error);
          return res.status(500).json({
            success: false,
            error: 'Failed to read private key file',
            details: error.message,
          });
        }

        // Create client assertion JWT for authentication
        // const now = Math.floor(Date.now() / 1000);
        const jwtPayload = {
          jti: Math.random().toString(36).substring(7),
        };

        const signingOptions: jwt.SignOptions = {
          algorithm: 'RS256',
          expiresIn: '5m', // 5 minutes
          audience: `https://${oktaDomain}/oauth2/v1/token`,
          issuer: clientId,
          subject: clientId,
          keyid: '{yourKID}',
        };

        let clientAssertion: string;
        try {
          clientAssertion = jwt.sign(jwtPayload, privateKey, signingOptions);
        } catch (error: any) {
          console.error('Failed to create client assertion:', error);
          return res.status(500).json({
            success: false,
            error: 'Failed to create client assertion JWT',
            details: error.message,
          });
        }
        console.log(`👻 Subject token: ${idToken}`);

        // Construct the Okta base URL
        const oktaBaseUrl = `https://${oktaDomain}`;

        // Make the token exchange request with client assertion
        try {
          const axios = (await import('axios')).default;
          const formData = new URLSearchParams();
          formData.append('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
          formData.append('requested_token_type', 'urn:ietf:params:oauth:token-type:id-jag');
          formData.append('subject_token', idToken ?? '');
          formData.append('subject_token_type', 'urn:ietf:params:oauth:token-type:id_token');
          formData.append('audience', targetAudience);
          formData.append('client_id', clientId);
          formData.append('scope', 'read:todo0');
          formData.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
          formData.append('client_assertion', clientAssertion);

          console.log(`🔄 Exchanging ID token for ID-JAG token with private key auth...`);
          console.log(`📍 Audience: ${targetAudience}`);
          console.log(`📍 Client Assertion: ${clientAssertion}`);
          console.log(`🆔 Client ID: ${clientId}`);
          
          const response = await axios.post(`${oktaBaseUrl}/oauth2/v1/token`, formData, {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          });

          console.log(`✅ Token exchange successful`);
          console.log(`🎯 Issued token type: ${response.data.issued_token_type}`);
          
          // Step 2: Exchange ID-JAG for Access Token at the Resource Authorization Server
          // According to section 4.4 of the spec, we now need to present the ID-JAG
          // to the target service's token endpoint using jwt-bearer grant type
          const idJag = response.data.access_token; // This is actually the ID-JAG token
          
          console.log(`🔄 Step 2: Exchanging ID-JAG for Access Token at Resource Server...`);
          console.log(`📍 ID-JAG: ${idJag.substring(0, 50)}...`);
          
          try {
            // The Resource Authorization Server token endpoint
            // Extract the authorization server path from TARGET_SERVICE_AUDIENCE if it contains it
            // or construct it from the token endpoint environment variable
            const resourceTokenEndpoint = process.env.RESOURCE_TOKEN_ENDPOINT || `${oktaBaseUrl}/oauth2/default/v1/token`;
            
            console.log(`📍 Resource Token Endpoint: ${resourceTokenEndpoint}`);
            
            // Create a new client assertion for the second request
            // The client needs to authenticate the same way for the Resource Authorization Server
            const jwtPayload2 = {
              jti: Math.random().toString(36).substring(7),
            };

            const signingOptions2: jwt.SignOptions = {
              algorithm: 'RS256',
              expiresIn: '5m',
              audience: resourceTokenEndpoint,
              issuer: clientId,
              subject: clientId,
              keyid: '{yourKID}',
            };

            const clientAssertion2 = jwt.sign(jwtPayload2, privateKey, signingOptions2);
            
            // Make the jwt-bearer grant request to the Resource Authorization Server
            const resourceTokenForm = new URLSearchParams();
            resourceTokenForm.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
            resourceTokenForm.append('assertion', idJag);
            resourceTokenForm.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
            resourceTokenForm.append('client_assertion', clientAssertion2);
            
            const resourceTokenResponse = await axios.post(
              resourceTokenEndpoint,
              resourceTokenForm,
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
              }
            );
            
            console.log(`✅ Access Token obtained from Resource Server`);
            console.log(`🎯 Token type: ${resourceTokenResponse.data.token_type}`);
            console.log(`⏰ Expires in: ${resourceTokenResponse.data.expires_in}s`);
            
            // Store the access token in environment for MCP server to use
            const accessToken = resourceTokenResponse.data.access_token;
            process.env.TODO_ACCESS_TOKEN = accessToken;
            console.log('💾 Access token saved to process.env.TODO_ACCESS_TOKEN');
            console.log('✅ MCP server can now use this token to call the TODO API');
            
            res.json({
              success: true,
              id_jag: idJag,
              access_token: accessToken,
              token_type: resourceTokenResponse.data.token_type,
              expires_in: resourceTokenResponse.data.expires_in,
              scope: resourceTokenResponse.data.scope,
              issued_token_type: response.data.issued_token_type,
            });
          } catch (resourceError: any) {
            console.error('❌ Failed to exchange ID-JAG for Access Token:', resourceError.response?.data || resourceError.message);
            
            // If the second step fails, return the ID-JAG anyway
            res.json({
              success: true,
              id_jag: idJag,
              issued_token_type: response.data.issued_token_type,
              token_type: response.data.token_type,
              expires_in: response.data.expires_in,
              scope: response.data.scope,
              note: 'ID-JAG obtained successfully, but Access Token exchange failed',
              error: resourceError.response?.data || resourceError.message,
            });
          }
        } catch (error: any) {
          console.error('Token exchange request failed:', error.response?.data || error.message);
          return res.status(500).json({
            success: false,
            error: 'Token exchange request failed',
            details: error.response?.data || error.message,
          });
        }
      } catch (error: any) {
        console.error('Error in cross-app access:', error);
        res.status(500).json({
          success: false,
          error: 'Token exchange failed',
          details: error.message || 'Unknown error',
        });
      }
    });

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        client: 'MCP Chat Client',
        llmEnabled: this.anthropic ? true : false,
        oktaEnabled: oktaAuth ? true : false,
        timestamp: new Date().toISOString(),
      });
    });
    
    // Chat endpoint with LLM support (protected by auth if Okta is enabled)
    app.post('/api/chat', requireAuth, async (req, res) => {
      try {
        const { message } = req.body;
        
        if (!message) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'message is required',
          });
        }

        if (!this.anthropic) {
          return res.status(503).json({
            success: false,
            error: 'Service Unavailable',
            message: 'LLM is not configured. Please set ANTHROPIC_API_KEY environment variable.',
          });
        }

        // Get user info from session if authenticated
        const session = req.session as any;
        const userContext = session.userInfo ? {
          email: session.userInfo.email,
          name: session.userInfo.name || session.userInfo.email,
          sub: session.userInfo.sub,
        } : null;

        // Process message with LLM, passing user context
        const result = await this.processUserInput(message, userContext);
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

    // Start the server
    await new Promise<void>((resolve) => {
      app.listen(port, () => {
        console.log('='.repeat(60));
        console.log('🚀 MCP Client UI Server');
        console.log('='.repeat(60));
        console.log(`✓ UI Server running on http://localhost:${port}`);
        console.log(`✓ Health check: http://localhost:${port}/health`);
        console.log(`✓ Web UI: http://localhost:${port}`);
        console.log(`✓ Chat endpoint: http://localhost:${port}/api/chat`);
        console.log('='.repeat(60));
        console.log('Configuration:');
        console.log(`  - UI Port: ${port}`);
        console.log(`  - MCP Server: ${this.config.serverUrl}`);
        console.log(`  - LLM Enabled: ${this.anthropic ? '✅ Yes (Claude)' : '❌ No'}`);
        if (this.anthropic) {
          console.log(`  - LLM Model: ${this.config.anthropicModel || 'claude-3-5-sonnet-20241022'}`);
        }
        console.log(`  - Okta Auth: ${oktaAuth ? '✅ Enabled' : '❌ Disabled'}`);
        if (oktaAuth && this.config.okta) {
          console.log(`  - Okta Domain: ${this.config.okta.domain}`);
          console.log(`  - Login URL: http://localhost:${port}/login`);
        }
        console.log('='.repeat(60));
        console.log('Ready! 🎉');
        console.log('');
        resolve();
      });
    });
  }
  private client: Client;
  private transport: SSEClientTransport | null = null;
  private config: MCPClientConfig;
  private isConnected = false;
  private availableTools: any[] = [];
  private anthropic: Anthropic | null = null;
  private conversationHistory: Array<{
    role: 'user' | 'assistant';
    content: string | Array<any>;
  }> = [];

  constructor(config: MCPClientConfig) {
    this.config = config;
    this.client = new Client(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize Anthropic if API key is provided
    if (config.anthropicApiKey && config.enableLLM !== false) {
      this.anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
      });
      console.log('🤖 LLM integration enabled (Claude)');
    }
  }

  // ============================================================================
  // Connection Methods
  // ============================================================================

  async connect(): Promise<void> {
    try {
      console.log('🔌 Connecting to MCP server...');
      console.log(`   Server: ${this.config.serverUrl}`);

      this.transport = new SSEClientTransport(
        new URL(`${this.config.serverUrl}/sse`)
      );

      await this.client.connect(this.transport);
      this.isConnected = true;

      console.log('✅ Connected to MCP server successfully!\n');

      // Fetch available tools
      await this.fetchAvailableTools();
    } catch (error) {
      console.error('❌ Failed to connect to MCP server:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.client.close();
      this.isConnected = false;
      console.log('\n👋 Disconnected from MCP server');
    }
  }

  // ============================================================================
  // Tool Discovery
  // ============================================================================

  async fetchAvailableTools(): Promise<void> {
    try {
      const response = await this.client.listTools();
      this.availableTools = response.tools || [];
      
      console.log('🔧 Available Tools:');
      console.log('='.repeat(60));
      this.availableTools.forEach((tool, index) => {
        console.log(`${index + 1}. ${tool.name}`);
        console.log(`   📝 ${tool.description}`);
        if (tool.inputSchema?.properties) {
          const params = Object.keys(tool.inputSchema.properties);
          if (params.length > 0) {
            console.log(`   📋 Parameters: ${params.join(', ')}`);
          }
        }
        console.log('');
      });
      console.log('='.repeat(60));
    } catch (error) {
      console.error('❌ Failed to fetch tools:', error);
    }
  }

  // ============================================================================
  // Tool Execution
  // ============================================================================

  async callTool(toolName: string, args: any = {}): Promise<any> {
    try {
      console.log(`\n🔄 Executing tool: ${toolName}`);
      console.log(`   Arguments: ${JSON.stringify(args, null, 2)}`);

      const response = await this.client.callTool({
        name: toolName,
        arguments: args,
      });

      return response;
    } catch (error) {
      console.error('❌ Tool execution failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // Natural Language Processing (API Method - No CLI)
  // ============================================================================

  async processUserInput(
    input: string, 
    userContext?: { email: string; name: string; sub: string } | null
  ): Promise<{ success: boolean; message: string; data?: any }> {
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }
    try {
      return await this.processWithLLM(input, userContext);
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Error processing input',
      };
    }
  }

  // ============================================================================
  // LLM Integration (Returns data instead of console output)
  // ============================================================================

  async processWithLLM(
    userMessage: string,
    userContext?: { email: string; name: string; sub: string } | null
  ): Promise<{ success: boolean; message: string; data?: any; toolResults?: any[] }> {
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    try {
      // Add user message to conversation history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Convert MCP tools to Anthropic tool format
      const tools = this.availableTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
      }));

      // Create system message with context
      let systemMessage = `You are a helpful AI assistant that can manage todos using the available MCP tools. 
You have access to the following tools: ${this.availableTools.map(t => t.name).join(', ')}.

When the user asks to do something, analyze their request and call the appropriate tool with the correct parameters.
- For creating todos: extract the todo content from the user's message
- For listing todos: call get-todos without parameters
- For updating todos: extract the todo ID and new title
- For toggling todos: extract the todo ID
- For deleting todos: extract the todo ID

Always be helpful and conversational. If you successfully complete an action, let the user know in a friendly way.
If you need more information, ask the user for clarification.`;

      // Add user context if available
      if (userContext) {
        systemMessage += `\n\nCurrent user context:
- User: ${userContext.name} (${userContext.email})
- User ID: ${userContext.sub}

When the user asks "who am I" or "who is the owner", you can refer to this information.
The todos you manage belong to this user.`;
      }

      // Call Anthropic with tool use
      const response = await this.anthropic.messages.create({
        model: this.config.anthropicModel || 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemMessage,
        messages: this.conversationHistory,
        tools: tools.length > 0 ? tools : undefined,
      });

      // Handle tool calls
      let assistantContent: Array<any> = [];
      let toolResults: any[] = [];
      let responseMessage = '';
      
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          // Execute the MCP tool
          const result = await this.callTool(block.name, block.input);
          
          // Parse the result
          let parsedResult: any = {};
          if (result.content && result.content[0]) {
            try {
              parsedResult = JSON.parse(result.content[0].text);
            } catch {
              parsedResult = result;
            }
          }
          
          toolResults.push({
            tool: block.name,
            arguments: block.input,
            result: parsedResult,
          });

          // Add to assistant content for history
          assistantContent.push(block);
          
          // Add tool result to content for next request
          assistantContent.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } else if (block.type === 'text') {
          assistantContent.push(block);
          if (block.text) {
            responseMessage += block.text;
          }
        }
      }

      // Add assistant's response to history (only the tool_use and text blocks)
      const historyContent = response.content.filter(
        (block: any) => block.type === 'tool_use' || block.type === 'text'
      );
      this.conversationHistory.push({
        role: 'assistant',
        content: historyContent.length > 0 ? historyContent : response.content,
      });

      // If there were tool calls, get final response
      const hasToolUse = response.content.some((block: any) => block.type === 'tool_use');
      if (hasToolUse) {
        // Add tool results to history as user message
        const toolResultBlocks = assistantContent.filter(
          (block: any) => block.type === 'tool_result'
        );
        
        if (toolResultBlocks.length > 0) {
          this.conversationHistory.push({
            role: 'user',
            content: toolResultBlocks,
          });

          // Get final response from Claude
          const finalResponse = await this.anthropic.messages.create({
            model: this.config.anthropicModel || 'claude-3-5-sonnet-20241022',
            max_tokens: 4096,
            system: systemMessage,
            messages: this.conversationHistory,
          });

          const textBlocks = finalResponse.content.filter((block: any) => block.type === 'text');
          if (textBlocks.length > 0) {
            responseMessage = textBlocks.map((block: any) => block.text).join('\n');
            
            this.conversationHistory.push({
              role: 'assistant',
              content: finalResponse.content,
            });
          }
        }
      }

      // Keep conversation history manageable (last 10 messages)
      if (this.conversationHistory.length > 10) {
        this.conversationHistory = this.conversationHistory.slice(-10);
      }

      return {
        success: true,
        message: responseMessage || 'Task completed',
        toolResults,
      };
    } catch (error: any) {
      console.error('❌ LLM processing failed:', error.message);
      return {
        success: false,
        message: error.message || 'LLM processing failed',
      };
    }
  }

  // ============================================================================
  // Intent Recognition (Returns data instead of console output)
  // ============================================================================



  // ============================================================================
  // Utility Methods
  // ============================================================================



  parseToolResult(result: any): any {
    if (result.content && result.content.length > 0) {
      try {
        return JSON.parse(result.content[0].text);
      } catch {
        return result;
      }
    }
    return result;
  }



  // Method to reset conversation history
  resetConversation(): void {
    this.conversationHistory = [];
  }

  // Method to get current conversation history
  getConversationHistory() {
    return this.conversationHistory;
  }
}

// Export for use by server
export { MCPChatClient, MCPClientConfig };

// Entrypoint: Start MCP server, connect, and serve UI if run directly
if (require.main === module) {
  (async () => {
    const path = await import('path');
    const serverScriptPath = path.resolve(__dirname, 'server.js');
    
    const config: MCPClientConfig = {
      serverUrl: 'http://localhost:3001', // Will be updated by startServerAndConnect
      name: 'todo-chat-client-llm',
      version: '1.0.0',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      enableLLM: true,
      sessionSecret: process.env.SESSION_SECRET,
    };

    // Add Okta configuration if environment variables are set
    if (process.env.OKTA_DOMAIN && process.env.OKTA_CLIENT_ID && process.env.OKTA_CLIENT_SECRET) {
      config.okta = {
        domain: process.env.OKTA_DOMAIN,
        clientId: process.env.OKTA_CLIENT_ID,
        clientSecret: process.env.OKTA_CLIENT_SECRET,
        redirectUri: process.env.OKTA_REDIRECT_URI || 'http://localhost:3000/callback',
      };
    }

    const client = new MCPChatClient(config);

    client.startServerAndConnect(serverScriptPath, 3001, 3000)
      .catch((err) => {
        console.error('Failed to start server and connect:', err);
        process.exit(1);
      });
  })();
}
