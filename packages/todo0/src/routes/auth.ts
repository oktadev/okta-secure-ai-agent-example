import { Router } from 'express';
import { OktaAuth } from '@okta/okta-auth-js';

const OKTA_DOMAIN = '{yourOktaDomain}';
const OKTA_CLIENT_ID = '{yourClientID}';
const OKTA_CLIENT_SECRET = '{yourClientSecret}';
const OKTA_ISSUER = '{yourOktaIssuer}';
const REDIRECT_URI = '{yourRedirectUri}';

// Initialize OktaAuth for server-side use
const oktaAuth = new OktaAuth({
  issuer: OKTA_ISSUER,
  clientId: OKTA_CLIENT_ID,
  clientSecret: OKTA_CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
});

const router = Router();

router.get('/login', async (req, res) => {
  console.log('[AUTH] Login endpoint hit');
  console.log('[AUTH] Request URL:', req.url);
  console.log('[AUTH] Request path:', req.path);
  
  try {
    // Generate PKCE parameters
    const { codeVerifier, codeChallenge } = await oktaAuth.token.prepareTokenParams();
    
    // Store code verifier in session for later use
    req.session.codeVerifier = codeVerifier;
    
    // Build authorization URL with PKCE
    const state = Math.random().toString(36).substring(7);
    req.session.state = state;
    
    const authUrl = `${OKTA_ISSUER}/v1/authorize?` +
      `client_id=${OKTA_CLIENT_ID}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent('openid profile email')}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${state}` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256`;
    
    console.log('[AUTH] Generated PKCE parameters');
    console.log('[AUTH] Redirecting to:', authUrl);
    res.redirect(authUrl);
  } catch (err: any) {
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
    console.log('[AUTH] Exchanging code for tokens...');
    
    // Get code verifier from session
    const codeVerifier = (req.session as any).codeVerifier;
    if (!codeVerifier) {
      console.error('[AUTH] Missing code verifier in session');
      return res.status(400).send('Missing code verifier. Please try logging in again.');
    }
    
    console.log('[AUTH] Retrieved code verifier from session');
    
    // Exchange authorization code for tokens using Okta Auth JS
    const tokenResponse = await oktaAuth.token.exchangeCodeForTokens({
      authorizationCode: code as string,
      codeVerifier: codeVerifier,
    });
    
    console.log('[AUTH] Token exchange successful');
    console.log('[AUTH] Token response:', {
      hasAccessToken: !!tokenResponse.tokens.accessToken,
      hasIdToken: !!tokenResponse.tokens.idToken,
    });
    
    // Store tokens in session
    (req.session as any).access_token = tokenResponse.tokens.accessToken?.accessToken;
    (req.session as any).id_token = tokenResponse.tokens.idToken?.idToken;
    
    // Clear code verifier from session
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
    const oktaLogoutUrl = `${OKTA_ISSUER}/v1/logout?` +
      `id_token_hint=${idToken || ''}` +
      `&post_logout_redirect_uri=${encodeURIComponent('http://localhost:5001/')}`;
    
    console.log('[AUTH] Redirecting to Okta logout:', oktaLogoutUrl);
    res.redirect(oktaLogoutUrl);
  });
});

export default router;
