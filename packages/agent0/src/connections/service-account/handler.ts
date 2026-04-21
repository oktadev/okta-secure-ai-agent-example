// handler.ts — Service Account managed connection (stub / scaffold)
//
// STATUS: SCAFFOLD. The runtime token-exchange URN for Service Account
// connections is not published in the public Okta docs at the time of writing.
// This module implements the `ConnectionHandler` contract so the connection
// slot is visible alongside Authorization Server, Application, Secret, and
// MCP Server, but `isConfigured()` returns false and `executeTool()` throws.
//
// When implementing:
//   1. Confirm the `requested_token_type` URN for service-account credentials
//      against a real Okta tenant (likely pattern:
//      `urn:okta:params:oauth:token-type:service-account-credential`
//      — verify before shipping).
//   2. Model the credential shape (username/password, or username+password+TOTP
//      for MFA-wrapped accounts). Reference docs:
//      - https://help.okta.com/oie/en-us/content/topics/ai-agents/ai-agent-auth-service-acnt.htm
//      - https://developer.okta.com/docs/guides/ai-agent-token-exchange/
//   3. Follow the pattern in `../secret/handler.ts` — per-user session cache
//      with TTL, `TokenExchangeHandler` from `../authorization-server/handler.ts`
//      for the exchange call.
//   4. Add env vars (see `.env.service-account.example`) and wire
//      `isServiceAccountConfigured()` into `agent.ts`'s `getAgentForUserContext`
//      or into the specific tool handler that needs the credential.
//   5. Add provisioning scripts under `scripts/connections/service-account/`.

import {
  ConnectionHandler,
  ConnectionStatus,
  ToolDescriptor,
  ToolExecutionResult,
} from '../types.js';

// ============================================================================
// Env / Configuration (currently unused — reserved for the eventual impl)
// ============================================================================

/**
 * Returns true when Service Account connection env vars are fully set.
 * Currently always false until the runtime flow is implemented.
 */
export function isServiceAccountConfigured(): boolean {
  // Placeholder. Once implemented, check vars like:
  //   process.env.SERVICE_ACCOUNT_RESOURCE_ORN
  //   process.env.SERVICE_ACCOUNT_APP_ID
  // and return true only when all required are present.
  return false;
}

// ============================================================================
// Handler
// ============================================================================

export class ServiceAccountHandler implements ConnectionHandler {
  readonly kind = 'service_account' as const;

  isConfigured(): boolean {
    return isServiceAccountConfigured();
  }

  getTools(): ToolDescriptor[] {
    return [];
  }

  async executeTool(): Promise<ToolExecutionResult> {
    return {
      status: 'error',
      error:
        'Service Account connection is a scaffold — implementation pending. ' +
        'See packages/agent0/src/connections/service-account/handler.ts',
    };
  }

  getStatus(): ConnectionStatus {
    return {
      kind: this.kind,
      configured: this.isConfigured(),
      connected: false,
      details: { state: 'scaffold', note: 'Implementation pending' },
    };
  }
}
