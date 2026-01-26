import { Request, Response, NextFunction } from 'express';
import OktaJwtVerifier from '@okta/jwt-verifier';

export interface McpAuthConfig {
  mcpOktaIssuer: string;
  mcpExpectedAudience: string;
}

// ============================================================================
// Scope Challenge Helper (MCP Authorization Best Practices)
// ============================================================================

/**
 * Build WWW-Authenticate header for scope challenge per MCP spec
 * @param requiredScopes - Scopes required for the operation
 * @param resourceMetadataUrl - URL to the OAuth protected resource metadata
 * @param errorDescription - Human-readable error description
 */
export function buildScopeChallengeHeader(
  requiredScopes: string[],
  resourceMetadataUrl?: string,
  errorDescription?: string
): string {
  let header = `Bearer error="insufficient_scope", scope="${requiredScopes.join(' ')}"`;

  if (resourceMetadataUrl) {
    header += `, resource_metadata="${resourceMetadataUrl}"`;
  }

  if (errorDescription) {
    header += `, error_description="${errorDescription}"`;
  }

  return header;
}

/**
 * Send 403 response with WWW-Authenticate header for scope challenge
 */
export function sendScopeChallengeResponse(
  res: Response,
  requiredScopes: string[],
  resourceMetadataUrl?: string,
  errorDescription?: string
): Response {
  const wwwAuthHeader = buildScopeChallengeHeader(
    requiredScopes,
    resourceMetadataUrl,
    errorDescription
  );

  console.log(`🔐 Sending scope challenge: ${wwwAuthHeader}`);

  return res
    .status(403)
    .set('WWW-Authenticate', wwwAuthHeader)
    .json({
      error: 'insufficient_scope',
      error_description: errorDescription || 'Additional scopes required',
      required_scopes: requiredScopes,
    });
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
    console.log('   User ID:', jwt.claims.uid);
    console.log('   Scopes:', jwt.claims.scp);
    console.log('   Client ID:', jwt.claims.cid);

    if (!verifyScopesClaim(jwt.claims, ['mcp:connect'])) {
      console.log('✗ Missing required scope: mcp:connect');
      return sendScopeChallengeResponse(
        res,
        ['mcp:connect'],
        undefined,
        'mcp:connect scope required for MCP connection'
      );
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

  /**
   * Verify access token and check for required scopes
   * Returns object with success status, user ID (sub claim), and missing scopes if any
   */
  async function verifyAccessTokenWithScopes(
    authorizationHeader: string,
    expectedScopes: string[]
  ): Promise<{ valid: boolean; userId?: string; missingScopes?: string[] }> {
    console.log('🔍 Verifying MCP access token with scopes:', expectedScopes);

    const match = authorizationHeader.match(/^Bearer (.+)$/);

    if (!match) {
      console.log('✗ No Bearer token found in Authorization header for MCP connection');
      return { valid: false };
    }

    const accessToken = match[1];
    console.log('🔍 Verifying MCP access token...');

    try {
      const jwt = await oktaJwtVerifier.verifyAccessToken(
        accessToken,
        mcpExpectedAudience
      );

      const missingScopes = findMissingScopes(jwt.claims, expectedScopes);
      if (missingScopes.length > 0) {
        return { valid: false, missingScopes };
      }

      // Return the user's uid claim (Okta user ID) for user-scoped operations
      // Note: Using uid instead of sub because sub contains email in MCP tokens
      return { valid: true, userId: jwt.claims.uid as string };
    } catch (error) {
      console.log('✗ Token verification failed');
      console.error('Token verification error details:', error);
      return { valid: false };
    }
  }

  return { requireMcpAuth, verifyAccessTokenWithScopes };
}

/**
 * Find missing scopes from claims
 */
function findMissingScopes(claims: OktaJwtVerifier.JwtClaims, expectedScopes: string[]): string[] {
  const missing: string[] = [];
  if (claims.scp) {
    for (const expectedScope of expectedScopes) {
      if (!claims.scp.includes(expectedScope)) {
        missing.push(expectedScope);
      }
    }
  } else {
    return expectedScopes; // All scopes are missing
  }
  return missing;
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
