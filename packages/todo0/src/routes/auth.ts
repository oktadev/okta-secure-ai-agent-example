import { Router } from 'express';
import { Issuer, generators, Client } from 'openid-client';

export interface AuthConfig {
  oktaIssuer: string;
  oktaClientId: string;
  oktaClientSecret: string;
  oktaRedirectUri: string;
}

export function createAuthRouter(config: AuthConfig): Router {
  const { oktaIssuer, oktaClientId, oktaClientSecret, oktaRedirectUri } = config;

  console.log('🔐 Okta Auth Configuration:');
  console.log(`   Issuer: ${oktaIssuer}`);
  console.log(`   Client ID: ${oktaClientId}`);
  console.log(`   Redirect URI: ${oktaRedirectUri}`);

  // Initialize OpenID Client - this will be set after discovery
  let client: Client | null = null;

  // Discover OpenID configuration and create client
  (async () => {
    try {
      const issuer = await Issuer.discover(oktaIssuer);
      
      client = new issuer.Client({
        client_id: oktaClientId,
        client_secret: oktaClientSecret,
        redirect_uris: [oktaRedirectUri],
        response_types: ['code'],
      });
      
      console.log('✅ OpenID Client initialized successfully');
      console.log(`   Issuer: ${issuer.metadata.issuer}`);
    } catch (err: any) {
      console.error('❌ Failed to initialize OpenID Client:', err.message);
      process.exit(1);
    }
  })();

  const router = Router();

router.get('/login', async (req, res) => {
  console.log('[AUTH] Login endpoint hit');
  console.log('[AUTH] Request URL:', req.url);
  console.log('[AUTH] Request path:', req.path);
  
  try {
    if (!client) {
      throw new Error('OpenID client not ready yet. Please wait a moment and try again.');
    }

    // Generate PKCE parameters using openid-client generators
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    
    // Store code verifier in session for later use
    req.session.codeVerifier = codeVerifier;
    
    // Generate state parameter
    const state = generators.state();
    req.session.state = state;

    // Build authorization URL with PKCE using openid-client
    const authorizationUrl = client.authorizationUrl({
      scope: 'openid profile email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: state,
    });
    
    console.log('[AUTH] Generated PKCE parameters');
    console.log('[AUTH] Redirecting to:', authorizationUrl);
    res.redirect(authorizationUrl);
  } catch (err: any) {
    console.error(err.stack);
    console.error('[AUTH] Login error:', err.message);
    res.status(500).send('Login failed: ' + err.message);
  }
});

router.get('/callback', async (req, res) => {
  console.log('[AUTH] /callback route hit');
  console.log('[AUTH] Query params:', req.query);
  
  const { code, error, error_description, state } = req.query;
  
  if (error) {
    console.error('[AUTH] Callback error:', error, error_description);
    return res.status(400).send(`Authentication failed: ${error} - ${error_description}`);
  }
  
  if (!code) {
    console.error('[AUTH] Missing authorization code');
    return res.status(400).send('Missing authorization code');
  }
  
  try {
    if (!client) {
      throw new Error('OpenID client not ready yet. Please wait a moment and try again.');
    }

    console.log('[AUTH] Exchanging code for tokens...');
    
    // Get code verifier and state from session
    const codeVerifier = (req.session as any).codeVerifier;
    const sessionState = (req.session as any).state;
    
    if (!codeVerifier) {
      console.error('[AUTH] Missing code verifier in session');
      return res.status(400).send('Missing code verifier. Please try logging in again.');
    }
    
    // Verify state parameter
    if (state !== sessionState) {
      console.error('[AUTH] State parameter mismatch');
      return res.status(400).send('Invalid state parameter');
    }
    
    console.log('[AUTH] Retrieved code verifier from session');
    
    // Build callback parameters
    const params = client.callbackParams(req);
    
    // Exchange authorization code for tokens using openid-client
    const tokenSet = await client.callback(oktaRedirectUri, params, {
      code_verifier: codeVerifier,
      state: sessionState,
    });
    
    console.log('[AUTH] Token exchange successful');
    console.log('[AUTH] Token response:', {
      hasAccessToken: !!tokenSet.access_token,
      hasIdToken: !!tokenSet.id_token,
    });
    
    // Store tokens in session
    (req.session as any).access_token = tokenSet.access_token;
    (req.session as any).id_token = tokenSet.id_token;
    
    // Clear code verifier and state from session
    delete (req.session as any).codeVerifier;
    delete (req.session as any).state;
    
    console.log('[AUTH] Tokens stored in session, redirecting to /');
    res.redirect('/');
  } catch (err: any) {
    console.error('[AUTH] Token exchange failed:', err.message);
    console.error('[AUTH] Error details:', err);
    res.status(500).send('Token exchange failed: ' + err.message);
  }
});

router.post('/logout', async (req, res) => {
  console.log('[AUTH] Logout endpoint hit');
  
  const idToken = (req.session as any).id_token;
  
  req.session.destroy((err) => {
    if (err) {
      console.error('[AUTH] Session destroy error:', err);
    }
    
    console.log('[AUTH] Session destroyed');
    
    // Use Okta's proper logout endpoint with id_token_hint
    const oktaLogoutUrl = `${oktaIssuer}/v1/logout?` +
      `id_token_hint=${idToken || ''}` +
      `&post_logout_redirect_uri=${encodeURIComponent('http://localhost:5001/')}`;

    console.log('[AUTH] Redirecting to Okta logout:', oktaLogoutUrl);
    res.redirect(oktaLogoutUrl);
  });
});

  return router;
}
