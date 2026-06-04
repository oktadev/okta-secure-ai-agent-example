// ============================================================================
// AGENT B — INBOUND VALIDATION (agent0 → Agent B)
// ============================================================================
// Verifies the access token agent0 presents over A2A. The token was minted by
// the A2A authorization server, scoped to Agent B's resourceUrl. We verify:
//   - signature + issuer (the A2A AS)
//   - audience == AGENTB_RESOURCE_URL
//   - scope includes the required A2A scope (agent.invoke)
//
// At runtime the inbound access token also becomes the subject_token for Agent
// B's own second-hop exchange, so the verifier returns the raw token too.

import OktaJwtVerifier from '@okta/jwt-verifier';
import type { AgentBConfig } from '../config';

export interface InboundVerification {
  valid: boolean;
  accessToken?: string;
  sub?: string; // the original user — preserved through the chain
  claims?: OktaJwtVerifier.JwtClaims;
  error?: string;
}

export function createInboundVerifier(config: AgentBConfig) {
  const verifier = new OktaJwtVerifier({
    issuer: config.a2aAuthorizationServer,
    assertClaims: {
      aud: config.resourceUrl,
    },
  });

  function extractBearer(authorizationHeader?: string): string | null {
    const match = (authorizationHeader || '').match(/^Bearer (.+)$/);
    return match ? match[1] : null;
  }

  async function verify(authorizationHeader?: string): Promise<InboundVerification> {
    const accessToken = extractBearer(authorizationHeader);
    if (!accessToken) {
      return { valid: false, error: 'Missing or invalid Authorization header (expected a Bearer token)' };
    }

    try {
      const jwt = await verifier.verifyAccessToken(accessToken, config.resourceUrl);

      const scopes = (jwt.claims.scp as string[] | undefined) || [];
      if (!scopes.includes(config.requiredScope)) {
        return {
          valid: false,
          error: `Inbound token missing required scope "${config.requiredScope}"`,
        };
      }

      return {
        valid: true,
        accessToken,
        sub: jwt.claims.sub,
        claims: jwt.claims,
      };
    } catch (err: any) {
      return { valid: false, error: `Token verification failed: ${err.message}` };
    }
  }

  return { verify };
}
