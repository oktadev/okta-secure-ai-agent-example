import { Request, Response, NextFunction } from 'express';
import OktaJwtVerifier from '@okta/jwt-verifier';
import * as dotenv from 'dotenv'; 

// Load environment variables
dotenv.config();

// Use environment variables for configuration
const OKTA_ISSUER = process.env.OKTA_ISSUER ?? '{yourIssuerUrl}';
const OKTA_CLIENT_ID = process.env.OKTA_CLIENT_ID ?? '{yourClientId}';
const EXPECTED_AUDIENCE = process.env.EXPECTED_AUDIENCE ?? '{yourExpectedAudience}';

console.log('🔐 Auth Middleware Configuration:');
console.log(`   Issuer: ${OKTA_ISSUER}`);
console.log(`   Client ID: ${OKTA_CLIENT_ID}`);
console.log(`   Expected Audience: ${EXPECTED_AUDIENCE}`);

const oktaJwtVerifier = new OktaJwtVerifier({
  issuer: OKTA_ISSUER,
  clientId: OKTA_CLIENT_ID,
  assertClaims: {
    aud: EXPECTED_AUDIENCE,
  },
});

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // 1. Check for session-based authentication
  if (req.session && (req.session as any).access_token) {
    console.log('✓ Session-based authentication found');
    return next();
  }

  // 2. Check for Bearer token authentication
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    console.log('✗ No Bearer token found in Authorization header');
    return res.status(401).json({ error: 'Missing or invalid Authorization header or session' });
  }
  
  const accessToken = match[1];
  console.log('🔍 Verifying access token...');
  
  try {
    // Verify the access token
    const jwt = await oktaJwtVerifier.verifyAccessToken(accessToken, EXPECTED_AUDIENCE);
    
    console.log('✅ Token verified successfully');
    console.log('   Subject:', jwt.claims.sub);
    console.log('   Scopes:', jwt.claims.scp);
    console.log('   Client ID:', jwt.claims.cid);
    
    (req as any).user = jwt.claims;
    return next();
  } catch (err: any) {
    console.error('❌ Token verification failed:', err.message);
    return res.status(401).json({ 
      error: 'Invalid or expired token', 
      details: err.message 
    });
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}
