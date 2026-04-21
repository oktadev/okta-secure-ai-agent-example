# MCP Server Registration Scripts

Provisions the MCP Server managed-connection type at Okta by calling
`/resource-servers/api/v1/mcp-servers`. Once registered and ACTIVE, Okta
can enforce policy on the MCP and a later step can attach the MCP as a
managed connection on any AI agent.

## Scripts

| Command              | Script                       | Purpose                                                       |
| -------------------- | ---------------------------- | ------------------------------------------------------------- |
| `pnpm register:mcp`  | `register.ts`                | POST register → poll PENDING → activate → save state          |
| `pnpm validate:mcp`  | `validate.ts`                | GET + list authorization servers, print health report         |
| `pnpm rollback:mcp`  | `rollback.ts`                | Deactivate → delete at Okta → clear `.mcp-register-state.json` |

State file: `.mcp-register-state.json` (gitignored).

## Prerequisite: an OAuth bearer token

Okta's MCP Servers API requires an OAuth 2.0 access token with
`okta.resourceServers.mcpServers.manage` scope (or SUPER_ADMIN role).
Easiest path for dev: open the Okta admin console, grab the Authorization
header from any admin-API call in DevTools → Network, strip the `Bearer `
prefix, and paste when the script prompts.

## Prerequisite: a tunnel for localhost MCPs

Okta fetches `<resourceUrl>/.well-known/oauth-protected-resource` server-side.
`http://localhost:5002/mcp` is not reachable from Okta. For local development:

```
ngrok http 5002     # or cloudflared tunnel, tailscale funnel, etc.
# then use the https tunnel URL (suffix /mcp) when register:mcp prompts.
```

## Auto-discovered authorization servers

After registration, Okta walks the MCP's metadata chain:

```
GET <resourceUrl>/.well-known/oauth-protected-resource
  → authorization_servers: [ <issuer1>, <issuer2>, ... ]
GET <issuer>/.well-known/oauth-authorization-server
  → token_endpoint, grant_types_supported,
    identity_chaining_requested_token_types_supported, ...
```

`pnpm validate:mcp` prints the discovered ASes and labels each as either:

- **`aus…` prefix** — Okta custom AS, supports XAA / ID-JAG
- **`eas…` prefix** — external AS, supports STS token exchange

Todo0 already serves `.well-known/oauth-protected-resource` via the MCP SDK's
`mcpAuthMetadataRouter` (see `packages/todo0/src/mcp-server.ts`), so no
changes are needed on the resource-server side.
