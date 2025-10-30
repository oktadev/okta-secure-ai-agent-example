import { Request, Response, NextFunction } from 'express';
import OktaJwtVerifier from '@okta/jwt-verifier';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Use MCP-specific environment variables for configuration
// These should be distinct from the REST API configuration
const MCP_OKTA_ISSUER = process.env.MCP_OKTA_ISSUER ?? '{yourIssuerUrl}';
const MCP_EXPECTED_AUDIENCE = process.env.MCP_EXPECTED_AUDIENCE ?? 'mcp://default';

console.log('🔐 MCP Auth Middleware Configuration:');
console.log(`   Issuer: ${MCP_OKTA_ISSUER}`);
console.log(`   Expected Audience: ${MCP_EXPECTED_AUDIENCE}`);

const oktaJwtVerifier = new OktaJwtVerifier({
  issuer: MCP_OKTA_ISSUER,
  assertClaims: {
    aud: MCP_EXPECTED_AUDIENCE,
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
    const jwt = await oktaJwtVerifier.verifyAccessToken(accessToken, MCP_EXPECTED_AUDIENCE);

    console.log('✅ MCP token verified successfully');
    console.log('   Subject:', jwt.claims.sub);
    console.log('   Scopes:', jwt.claims.scp);
    console.log('   Client ID:', jwt.claims.cid);

    if (!verifyScopesClaim(jwt.claims, ['mcp:connect'])) {
      console.log('✗ Missing required scopes');
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient scope'
      });
    }

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

function verifyScopesClaim(claims: OktaJwtVerifier.JwtClaims, expectedScopes: string[]): boolean {
  if (claims.scp) {
    for (const expectedScope of expectedScopes) {
      if (!claims.scp.includes(expectedScope)) {
        console.log(`✗ Missing required scope: ${expectedScope}`);
        return false;
      }
    }
    return true;
  } else {
    return false;
  }
}

export async function verifyAccessTokenWithScopes(authorizationHeader: string, expectedScopes: string[]): Promise<boolean> {
  console.log('🔍 Verifying MCP access token with scopes:', expectedScopes);

  const match = authorizationHeader.match(/^Bearer (.+)$/);

  if (!match) {
    console.log('✗ No Bearer token found in Authorization header for MCP connection');
    return false;
  }

  const accessToken = match[1];
  console.log('🔍 Verifying MCP access token...');

  const jwt = await oktaJwtVerifier.verifyAccessToken(
    accessToken, 
    MCP_EXPECTED_AUDIENCE
  );

  return verifyScopesClaim(jwt.claims, expectedScopes);
}

declare global {
  namespace Express {
    interface Request {
      mcpUser?: McpAuthClaims;
    }
  }
}
