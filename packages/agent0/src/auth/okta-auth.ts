// okta-auth.ts - Okta Authentication and Session Management
import { Request, Response, NextFunction } from 'express';
import { Issuer, generators, Client } from 'openid-client';
import session from 'express-session';

// Extend Express session type
declare module 'express-session' {
  interface SessionData {
    idToken?: string;
    accessToken?: string;
    userInfo?: any;
    pkce?: {
      code_verifier: string;
      state: string;
    };
  }
}

// ============================================================================
// Okta Configuration
// ============================================================================

export interface OktaConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// ============================================================================
// Session Configuration
// ============================================================================

export function createSessionMiddleware(sessionSecret: string) {
  return session({
    name: 'agent0.sid', // Unique session name for agent0 app
    secret: sessionSecret || 'default-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    rolling: true, // Reset maxAge on every response
    cookie: {
      secure: false, // Set to true in production with HTTPS
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax', // Prevent CSRF while allowing normal navigation
    },
  });
}

// ============================================================================
// Okta Auth Helper Class
// ============================================================================

export class OktaAuthHelper {
  private client: Client | null = null;
  private config: OktaConfig;
  private issuerUrl: string;

  constructor(config: OktaConfig) {
    this.config = config;
    this.issuerUrl = `https://${config.domain}`;
    this.initializeClient();
    console.log('🔐 Okta authentication configured');
  }

  private async initializeClient(): Promise<void> {
    try {
      const issuer = await Issuer.discover(this.issuerUrl);
      
      this.client = new issuer.Client({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uris: [this.config.redirectUri],
        response_types: ['code'],
      });
      
      console.log('✅ OpenID Client initialized successfully');
    } catch (error: any) {
      console.error('❌ Failed to initialize OpenID Client:', error.message);
    }
  }

  private async getClient(): Promise<Client> {
    if (!this.client) {
      await this.initializeClient();
      if (!this.client) {
        throw new Error('OpenID client not initialized');
      }
    }
    return this.client;
  }

  // ============================================================================
  // Token Helpers
  // ============================================================================

  getIdToken(req: Request): string | null {
    const session = req.session as any;
    return session.idToken || null;
  }

  getAccessToken(req: Request): string | null {
    const session = req.session as any;
    return session.accessToken || null;
  }

  getUserInfo(req: Request): any | null {
    const session = req.session as any;
    return session.userInfo || null;
  }

  // ============================================================================
  // Authentication Middleware
  // ============================================================================

  requireAuth() {
    return (req: Request, res: Response, next: NextFunction) => {
      const session = req.session as any;

      if (session.idToken) {
        next();
      } else {
        res.status(401).json({ error: 'Unauthorized', message: 'Please login first' });
      }
    };
  }

  // ============================================================================
  // Login Handler
  // ============================================================================

  async handleLogin(req: Request, res: Response): Promise<void> {
    try {
      const client = await this.getClient();

      // Generate PKCE parameters using openid-client generators
      const code_verifier = generators.codeVerifier();
      const code_challenge = generators.codeChallenge(code_verifier);
      const state = generators.state();

      // Store PKCE parameters in session
      req.session.pkce = { code_verifier, state };

      // Build authorization URL with PKCE using openid-client
      const authorizationUrl = client.authorizationUrl({
        scope: 'openid profile email',
        code_challenge,
        code_challenge_method: 'S256',
        state,
        redirect_uri: this.config.redirectUri,
      });

      console.log('🔐 Redirecting to:', authorizationUrl);
      res.redirect(authorizationUrl);
    } catch (error: any) {
      console.error('Login redirect error:', error);
      res.status(500).json({ error: 'Failed to initiate login' });
    }
  }

  // ============================================================================
  // Callback Handler
  // ============================================================================

  async handleCallback(req: Request, res: Response): Promise<void> {
    const { code, error, error_description } = req.query;

    if (error) {
      console.error('Okta authentication error:', error, error_description);
      res.redirect('/?error=' + encodeURIComponent(error as string));
      return;
    }

    if (!code) {
      res.redirect('/?error=no_code');
      return;
    }

    try {
      const client = await this.getClient();

      // Get PKCE parameters from session
      const { pkce } = req.session as any;

      if (!pkce || !pkce.code_verifier || !pkce.state) {
        console.error('Missing PKCE parameters in session');
        res.redirect('/?error=missing_verifier');
        return;
      }

      // Build callback parameters from the request
      const params = client.callbackParams(req);

      // Exchange authorization code for tokens using openid-client
      const tokenSet = await client.callback(
        this.config.redirectUri,
        params,
        {
          code_verifier: pkce.code_verifier,
          state: pkce.state,
        }
      );

      if (tokenSet.access_token && tokenSet.id_token) {
        // Store tokens in session
        (req.session as any).idToken = tokenSet.id_token;
        (req.session as any).accessToken = tokenSet.access_token;
        (req.session as any).userInfo = tokenSet.claims();

        // Clear PKCE parameters
        delete (req.session as any).pkce;

        console.log('✅ User authenticated:', tokenSet.claims().email || tokenSet.claims().sub);

        // Redirect to main page
        res.redirect('/');
      } else {
        throw new Error('No tokens received from Okta');
      }
    } catch (error: any) {
      console.error('Token exchange error:', error);
      res.redirect('/?error=token_exchange_failed');
    }
  }

  // ============================================================================
  // Logout Handler
  // ============================================================================

  handleLogout(port: number) {
    return async (req: Request, res: Response) => {
      try {
        const client = await this.getClient();
        const idToken = (req.session as any)?.idToken;

        // Build end session URL using openid-client with client_id parameter
        const logoutUrl = client.endSessionUrl({
          client_id: this.config.clientId,
          id_token_hint: idToken,
          post_logout_redirect_uri: `http://localhost:${port}`,
        });

        req.session.destroy((err) => {
          if (err) {
            console.error('Session destruction error:', err);
          }
          res.redirect(logoutUrl);
        });
      } catch (error: any) {
        console.error('Logout error:', error);
        req.session.destroy((err) => {
          res.redirect('/');
        });
      }
    };
  }

  // ============================================================================
  // Status Endpoints
  // ============================================================================

  async handleAuthStatus(req: Request, res: Response): Promise<void> {
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
  }

  async handleUserInfo(req: Request, res: Response): Promise<void> {
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
  }
}
