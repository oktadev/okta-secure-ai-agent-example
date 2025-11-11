import { Request, Response, NextFunction } from 'express';
import OktaJwtVerifier from '@okta/jwt-verifier';

export interface McpAuthConfig {
  mcpOktaIssuer: string;
  mcpExpectedAudience: string;
}

export function createRequireMcpAuth(config: McpAuthConfig) {
  const { mcpOktaIssuer, mcpExpectedAudience } = config;

  console.log('🔐 MCP Auth Middleware Configuration:');
  console.log(`   Issuer: ${mcpOktaIssuer}`);
  console.log(`   Expected Audience: ${mcpExpectedAudience}`);

  const oktaJwtVerifier = new OktaJwtVerifier({
    issuer: mcpOktaIssuer,
    assertClaims: {
      aud: mcpExpectedAudience,
    },
  });

  /**
   * Middleware to verify JWT tokens for MCP server connections.
   * Extracts Bearer token from Authorization header and validates it.
   */
  async function requireMcpAuth(req: Request, res: Response, next: NextFunction) {
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
    const jwt = await oktaJwtVerifier.verifyAccessToken(accessToken, mcpExpectedAudience);

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

  async function verifyAccessTokenWithScopes(authorizationHeader: string, expectedScopes: string[]): Promise<boolean> {
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
      mcpExpectedAudience
    );

    return verifyScopesClaim(jwt.claims, expectedScopes);
  }

  return { requireMcpAuth, verifyAccessTokenWithScopes };
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

export interface McpAuthClaims {
  sub: string;
  scp?: string[];
  cid?: string;
  [key: string]: any;
}

declare global {
  namespace Express {
    interface Request {
      mcpUser?: McpAuthClaims;
    }
  }
}
