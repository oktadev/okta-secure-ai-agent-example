# Service Account Connection (scaffold)

This folder is the 4th of five managed-connection slots under
`packages/agent0/src/connections/`. It maps 1-to-1 with the **Service account**
option in Okta's "Add connection" admin UI for AI agents.

## What it will do (when implemented)

Retrieves a service-account credential (typically username + password for a
SaaS app registered in Okta Universal Directory, managed via Okta Privileged
Access) via OAuth 2.0 token exchange against the user's `id_token`, then uses
it to authenticate an outbound call to the SaaS provider.

This is distinct from the **Secret** connection (`../secret/`), which fetches
an arbitrary vaulted string (e.g. an API key). Service-account connections
return a structured principal credential.

## Why this is a scaffold

The `requested_token_type` URN for the service-account flow is not published
in the public Okta docs as of the current writing. Rather than ship a guessed
URN that silently fails against a real tenant, `handler.ts` implements the
`ConnectionHandler` contract but `isConfigured()` returns `false` and
`executeTool()` returns a clear scaffold-pending error.

## How to implement

1. Confirm the token-type URN against a real Okta Secure AI Agents tenant
   (use dev tools on a working admin-UI test, or Okta support).
2. Copy the shape of `../secret/handler.ts` — it already handles the identical
   problem for vaulted generic secrets (id_token → OPA token exchange →
   credential cached per-user with TTL).
3. Add env vars (e.g. `SERVICE_ACCOUNT_RESOURCE_ORN`) and flip
   `isServiceAccountConfigured()` to check them.
4. Add a tool under `./tools/` (e.g. a sample SaaS API client) to demonstrate
   what a developer builds on top of the credential.
5. Add provisioning scripts under `scripts/connections/service-account/`.

## References

- Admin UI setup: https://help.okta.com/oie/en-us/content/topics/ai-agents/ai-agent-auth-service-acnt.htm
- OPA overview: https://help.okta.com/oie/en-us/content/topics/privileged-access/pam-overview.htm
- Token exchange guide: https://developer.okta.com/docs/guides/ai-agent-token-exchange/
- Reference impl: `../secret/handler.ts`
