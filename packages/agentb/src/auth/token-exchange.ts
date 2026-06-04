// ============================================================================
// AGENT B — OUTBOUND SECOND HOP (Agent B → todo0 MCP)
// ============================================================================
// The dual nature in action: having received an inbound access token (sub =
// original user), Agent B now acts as a PRINCIPAL. It exchanges that token —
// authenticating as ITSELF (its own client_assertion) — for an access token
// scoped to todo0's MCP server, preserving the original user as `sub`.
//
//   Hop 2:  access_token(inbound) --(Org AS, token-exchange)--> id-jag
//   Hop 2b: id-jag                --(todo0 MCP AS, jwt-bearer)--> access_token(aud=todo0)
//
// Mirrors agent0's ID-JAG flow, with two differences: the subject is an
// access_token (not an id_token), and the request carries a `resource`.

import axios from 'axios';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import type { AgentBConfig } from '../config';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface SecondHopResult {
  accessToken: string;
  idJag: string;
  expiresIn?: number;
  scope?: string;
}

export class SecondHopExchange {
  constructor(private readonly config: AgentBConfig) {}

  /**
   * Sign a client_assertion JWT proving Agent B's identity to a token endpoint.
   */
  private createClientAssertion(audience: string): string {
    return jwt.sign({ jti: randomUUID() }, this.config.privateKey, {
      algorithm: 'RS256',
      expiresIn: '5m',
      audience,
      issuer: this.config.agentId,
      subject: this.config.agentId,
      keyid: this.config.privateKeyKid,
    });
  }

  /** Hop 2: exchange the inbound access token for an ID-JAG at the Org AS. */
  private async exchangeForIdJag(inboundAccessToken: string): Promise<string> {
    const orgTokenEndpoint = `https://${this.config.oktaDomain}/oauth2/v1/token`;
    const form = new URLSearchParams();
    form.append('grant_type', TOKEN_EXCHANGE_GRANT);
    form.append('requested_token_type', ID_JAG_TOKEN_TYPE);
    form.append('subject_token', inboundAccessToken);
    form.append('subject_token_type', ACCESS_TOKEN_TYPE);
    form.append('audience', this.config.mcpAuthorizationServer);
    // No RFC 8707 `resource` param: the todo0 MCP authorization server has a
    // static audience (mcp://todo0), so `audience` alone yields the correct
    // token `aud`. Sending `resource` requires Custom-AS resource-indicator
    // support that isn't enabled on all orgs (Org AS would reject it as
    // "'resource' is invalid or not supported"). Mirrors agent0's todo0 flow.
    form.append('scope', this.config.mcpScopes);
    form.append('client_assertion_type', CLIENT_ASSERTION_TYPE);
    form.append('client_assertion', this.createClientAssertion(orgTokenEndpoint));

    const response = await axios.post(orgTokenEndpoint, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return response.data.access_token; // the ID-JAG
  }

  /** Hop 2b: redeem the ID-JAG for a todo0-scoped access token at the MCP AS. */
  private async exchangeIdJagForMcpToken(idJag: string): Promise<SecondHopResult> {
    const form = new URLSearchParams();
    form.append('grant_type', JWT_BEARER_GRANT);
    form.append('assertion', idJag);
    form.append('client_assertion_type', CLIENT_ASSERTION_TYPE);
    form.append('client_assertion', this.createClientAssertion(this.config.mcpAuthorizationServerTokenEndpoint));

    const response = await axios.post(this.config.mcpAuthorizationServerTokenEndpoint, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    return {
      accessToken: response.data.access_token,
      idJag,
      expiresIn: response.data.expires_in,
      scope: response.data.scope,
    };
  }

  /**
   * Full second hop: inbound access token → todo0 MCP access token.
   * `onNote` receives human-readable progress for live A2A streaming.
   */
  async exchange(inboundAccessToken: string, onNote?: (text: string) => void): Promise<SecondHopResult> {
    const note = onNote ?? (() => {});
    note('Exchanging inbound token → ID-JAG (Org AS)…');
    const idJag = await this.exchangeForIdJag(inboundAccessToken);
    note('Redeeming ID-JAG → todo0 access token (Custom AS)…');
    return this.exchangeIdJagForMcpToken(idJag);
  }
}
