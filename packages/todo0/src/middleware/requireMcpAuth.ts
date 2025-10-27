import { Request, Response, NextFunction } from 'express';
import OktaJwtVerifier from '@okta/jwt-verifier';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Use environment variables for configuration
const OKTA_ISSUER = process.env.OKTA_ISSUER ?? '{yourIssuerUrl}';
const OKTA_CLIENT_ID = process.env.OKTA_CLIENT_ID ?? '{yourClientId}';
const EXPECTED_AUDIENCE = process.env.EXPECTED_AUDIENCE ?? '{yourExpectedAudience}';

console.log('🔐 MCP Auth Middleware Configuration:');
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

export interface McpAuthClaims {
  sub: string;
  scp?: string[];
  cid?: string;
  [key: string]: any;
}

/**
 * Middleware to verify JWT tokens for MCP server connections.
 * Extracts Bearer token from Authorization header and validates it.
 */
export async function requireMcpAuth(req: Request, res: Response, next: NextFunction) {
  // Check for Bearer token authentication
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);

  if (!match) {
    console.log('✗ No Bearer token found in Authorization header for MCP connection');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. MCP connections require a valid Bearer token.'
    });
  }

  const accessToken = match[1];
  console.log('🔍 Verifying MCP access token...');

  try {
    // Verify the access token
    const jwt = await oktaJwtVerifier.verifyAccessToken(accessToken, EXPECTED_AUDIENCE);

    console.log('✅ MCP token verified successfully');
    console.log('   Subject:', jwt.claims.sub);
    console.log('   Scopes:', jwt.claims.scp);
    console.log('   Client ID:', jwt.claims.cid);

    // Attach verified claims to request
    (req as any).mcpUser = jwt.claims as McpAuthClaims;
    return next();
  } catch (err: any) {
    console.error('❌ MCP token verification failed:', err.message);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
      details: err.message
    });
  }
}

declare global {
  namespace Express {
    interface Request {
      mcpUser?: McpAuthClaims;
    }
  }
}
