// okta-auth.ts - Okta Authentication and Session Management
import { Request, Response, NextFunction } from 'express';
import { OktaAuth } from '@okta/okta-auth-js';
import session from 'express-session';

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
  private oktaAuth: OktaAuth;
  private config: OktaConfig;

  constructor(config: OktaConfig) {
    this.config = config;
    this.oktaAuth = new OktaAuth({
      issuer: `https://${config.domain}`,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      scopes: ['openid', 'profile', 'email'],
      pkce: true, // Enable PKCE for proper flow
      tokenManager: {
        storage: 'memory',
      },
    });
    console.log('🔐 Okta authentication configured');
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
      // Generate code verifier and challenge for PKCE
      const tokenParams = await this.oktaAuth.token.prepareTokenParams();
      const meta = {
        state: Math.random().toString(36).substring(7),
        codeVerifier: tokenParams.codeVerifier || '',
        codeChallenge: tokenParams.codeChallenge || '',
      };

      // Store meta in session for callback
      (req.session as any).oktaMeta = meta;

      const authorizeUrl = `https://${this.config.domain}/oauth2/v1/authorize?` +
        `client_id=${this.config.clientId}&` +
        `response_type=code&` +
        `scope=openid%20profile%20email&` +
        `redirect_uri=${encodeURIComponent(this.config.redirectUri)}&` +
        `state=${meta.state}&` +
        `code_challenge_method=S256&` +
        `code_challenge=${meta.codeChallenge}`;

      res.redirect(authorizeUrl);
    } catch (error: any) {
      console.error('Login redirect error:', error);
      res.status(500).json({ error: 'Failed to initiate login' });
    }
  }

  // ============================================================================
  // Callback Handler
  // ============================================================================

  async handleCallback(req: Request, res: Response): Promise<void> {
    const { code, error, error_description, state } = req.query;

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
      // Get stored meta from session
      const oktaMeta = (req.session as any).oktaMeta;
      if (!oktaMeta || !oktaMeta.codeVerifier) {
        console.error('No code verifier found in session');
        res.redirect('/?error=missing_verifier');
        return;
      }

      // Verify state matches
      if (oktaMeta.state !== state) {
        console.error('State mismatch');
        res.redirect('/?error=state_mismatch');
        return;
      }

      // Exchange authorization code for tokens
      const tokenResponse = await this.oktaAuth.token.exchangeCodeForTokens({
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
  }

  // ============================================================================
  // Logout Handler
  // ============================================================================

  handleLogout(port: number) {
    return (req: Request, res: Response) => {
      const idToken = (req.session as any)?.idToken;
      req.session.destroy((err) => {
        if (err) {
          console.error('Session destruction error:', err);
        }
        const logoutUrl = `https://${this.config.domain}/oauth2/v1/logout?` +
          `id_token_hint=${idToken || ''}&` +
          `post_logout_redirect_uri=${encodeURIComponent('http://localhost:' + port)}`;
        res.redirect(logoutUrl);
      });
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
