# MCP Server Connection

Third of the three managed-connection types this sample covers, alongside
Authorization Server (ID-JAG → MCP access token) and Application (OAuth STS
brokered consent). Unlike the other two slots, this one represents the MCP
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
- **Out-of-band registration** — done manually in the Okta Admin Console
  (Directory → AI Agents → *your agent* → Managed connections → **+ Add
  connection** → MCP Server). Okta's server-side discovery then fetches the
  MCP's `.well-known/oauth-protected-resource` and walks the chain to each
  AS's `.well-known/oauth-authorization-server`.

## Status lifecycle (at Okta)

```
register → PENDING   ← Okta is fetching metadata
         → INACTIVE  ← metadata OK, waiting for activation
         → ACTIVE    ← activated in Admin Console
         → INVALID   ← metadata fetch/validate failed
```

## Env vars

- `MCP_SERVER_URL` (required) — e.g. `http://localhost:5002/mcp`. Used by the
  MCP SDK client.
- `MCP_RESOURCE_INDICATOR` (optional) — resource indicator the MCP advertises;
  defaults to `MCP_SERVER_URL`. Must match the value Okta stored on the
  managed connection (Okta strips trailing slashes).
- `OKTA_MCP_SERVER_ID` (optional) — copy from the managed connection in the
  Okta Admin Console so the handler can surface "registered at Okta" in
  status.

## Prereq for local dev

`resourceUrl` must be reachable from Okta. For a localhost MCP use a tunnel
(ngrok, cloudflared, tailscale funnel, etc.) and register the tunnel URL as
the `resourceUrl` in the Admin Console.
