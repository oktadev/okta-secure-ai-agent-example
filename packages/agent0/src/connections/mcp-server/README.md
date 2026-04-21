# MCP Server Connection

Fifth of five managed-connection types in Okta's "Add connection" admin UI
for AI agents. Unlike the other four slots, this one represents the MCP
resource server itself (todo0 in this sample) registered with Okta — not an
outbound credential the agent needs at runtime.

## Split of responsibilities

- **Runtime (agent0)** — `agent.ts` already opens an MCP client connection to
  `MCP_SERVER_URL` and calls `client.listTools()` / `client.callTool()`. The
  ID-JAG flow handled by `connections/authorization-server/handler.ts`
  provides the access token.
- **This handler (`handler.ts`)** — pure metadata: reports whether the MCP is
  configured (URL present) and whether it's registered at Okta
  (`OKTA_MCP_SERVER_ID` env var set). No LLM tools; no outbound calls.
- **Out-of-band registration** — performed by
  `scripts/connections/mcp-server/register.ts` (`pnpm register:mcp`). Okta's
  server-side discovery then fetches the MCP's
  `.well-known/oauth-protected-resource` and walks the chain to each AS's
  `.well-known/oauth-authorization-server`.

## Status lifecycle (at Okta)

```
register → PENDING   ← Okta is fetching metadata
         → INACTIVE  ← metadata OK, waiting for manual activation
         → ACTIVE    ← POST /lifecycle/activate
         → INVALID   ← metadata fetch/validate failed
```

`register:mcp` polls PENDING → INACTIVE and then auto-activates.

## Env vars

- `MCP_SERVER_URL` (required) — e.g. `http://localhost:5002/mcp`. Used by the
  MCP SDK client.
- `MCP_RESOURCE_INDICATOR` (optional) — resource indicator the MCP advertises;
  defaults to `MCP_SERVER_URL`.
- `OKTA_MCP_SERVER_ID` (optional) — set after a successful `pnpm register:mcp`
  so the handler can surface "registered at Okta" in status.

## Prereq for local dev

`resourceUrl` must be reachable from Okta. For a localhost MCP use a tunnel
(ngrok, cloudflared, tailscale funnel, etc.) and pass the tunnel URL when
`pnpm register:mcp` prompts for it.
