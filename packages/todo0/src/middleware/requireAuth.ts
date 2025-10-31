import { Request, Response, NextFunction } from 'express';
import OktaJwtVerifier from '@okta/jwt-verifier';

export interface AuthMiddlewareConfig {
  oktaIssuer: string;
  oktaClientId: string;
  expectedAudience: string;
}

export function createRequireAuth(config: AuthMiddlewareConfig) {
  const { oktaIssuer, oktaClientId, expectedAudience } = config;

  console.log('🔐 Auth Middleware Configuration:');
  console.log(`   Issuer: ${oktaIssuer}`);
  console.log(`   Client ID: ${oktaClientId}`);
  console.log(`   Expected Audience: ${expectedAudience}`);

  const oktaJwtVerifier = new OktaJwtVerifier({
    issuer: oktaIssuer,
    clientId: oktaClientId,
    assertClaims: {
      aud: expectedAudience,
    },
  });

  return async function requireAuth(req: Request, res: Response, next: NextFunction) {
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
    const jwt = await oktaJwtVerifier.verifyAccessToken(accessToken, expectedAudience);

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
  };
}

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}
