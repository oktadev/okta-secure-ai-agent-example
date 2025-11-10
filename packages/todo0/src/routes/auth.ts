import { Router } from 'express';
import { Issuer, generators, Client } from 'openid-client';

export interface AuthConfig {
  oktaIssuer: string;
  oktaClientId: string;
  oktaClientSecret: string;
  oktaRedirectUri: string;
}

// Helper function to get the OpenID Client configuration
async function getClientConfig(config: AuthConfig): Promise<Client> {
  const { oktaIssuer, oktaClientId, oktaClientSecret, oktaRedirectUri } = config;
  
  const issuer = await Issuer.discover(oktaIssuer);
  
  const client = new issuer.Client({
    client_id: oktaClientId,
    client_secret: oktaClientSecret,
    redirect_uris: [oktaRedirectUri],
    response_types: ['code'],
  });
  
  return client;
}

export function createAuthRouter(config: AuthConfig): Router {
  const { oktaIssuer, oktaClientId, oktaClientSecret, oktaRedirectUri } = config;

  console.log('🔐 Okta Auth Configuration:');
  console.log(`   Issuer: ${oktaIssuer}`);
  console.log(`   Client ID: ${oktaClientId}`);
  console.log(`   Redirect URI: ${oktaRedirectUri}`);

  const router = Router();

router.get('/login', async (req, res) => {
  console.log('[AUTH] Login endpoint hit');
  console.log('[AUTH] Request URL:', req.url);
  console.log('[AUTH] Request path:', req.path);
  
  try {
    // Get OpenID Client configuration
    const client = await getClientConfig(config);

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
      redirect_uri: oktaRedirectUri,
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
  
  const { code, error, error_description } = req.query;
  
  if (error) {
    console.error('[AUTH] Callback error:', error, error_description);
    return res.status(400).send(`Authentication failed: ${error} - ${error_description}`);
  }
  
  if (!code) {
    console.error('[AUTH] Missing authorization code');
    return res.status(400).send('Missing authorization code');
  }
  
  try {
    // Get OpenID Client configuration
    const client = await getClientConfig(config);

    console.log('[AUTH] Exchanging code for tokens...');
    
    // Get PKCE parameters from session
    const { pkce } = req.session as any;
    
    if (!pkce || !pkce.code_verifier || !pkce.state) {
      console.error('[AUTH] Missing PKCE parameters in session');
      return res.status(400).send('Login session expired or invalid. Please try logging in again.');
    }
    
    console.log('[AUTH] Retrieved PKCE parameters from session');
    
    // Build callback parameters from the request
    const params = client.callbackParams(req);
    
    // Exchange authorization code for tokens using openid-client
    const tokenSet = await client.callback(
      oktaRedirectUri,
      params,
      {
        code_verifier: pkce.code_verifier,
        state: pkce.state,
      }
    );
    
    console.log('[AUTH] Token exchange successful');
    console.log('[AUTH] Token response:', {
      hasAccessToken: !!tokenSet.access_token,
      hasIdToken: !!tokenSet.id_token,
    });
    
    // Store tokens in session
    (req.session as any).access_token = tokenSet.access_token;
    (req.session as any).id_token = tokenSet.id_token;
    
    // Clear PKCE parameters from session
    delete (req.session as any).pkce;
    
    console.log('[AUTH] Tokens stored in session, redirecting to /');
    res.redirect('/');
  } catch (err: any) {
    console.error('[AUTH] Token exchange failed:', err.message);
    console.error('[AUTH] Error details:', err);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

router.post('/logout', async (req, res) => {
  console.log('[AUTH] Logout endpoint hit');
  
  try {
    // Get OpenID Client configuration
    const client = await getClientConfig(config);
    
    const idToken = (req.session as any).id_token;
    
    // Build end session URL using openid-client
    const logoutUrl = client.endSessionUrl({
      id_token_hint: idToken,
      post_logout_redirect_uri: 'http://localhost:5001/',
    });
    
    req.session.destroy((err) => {
      if (err) {
        console.error('[AUTH] Session destroy error:', err);
      }
      
      console.log('[AUTH] Session destroyed');
      console.log('[AUTH] Redirecting to Okta logout:', logoutUrl);
      res.redirect(logoutUrl);
    });
  } catch (err: any) {
    console.error('[AUTH] Logout error:', err.message);
    res.status(500).send('Something went wrong during logout.');
  }
});

  return router;
}
