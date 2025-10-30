# Okta Tenant Bootstrap Scripts

Automated scripts to configure an Okta tenant for the Secure AI Agent Example with dual custom authorization servers.

## Overview

These scripts automate the creation and configuration of Okta resources required to run this example, including:

- **Two Custom Authorization Servers**:
  - `todo0-rest-api` - For REST API endpoints (port 5001)
  - `todo0-mcp-server` - For MCP server endpoints (port 5002)
- **Two OIDC Applications**:
  - `agent0` - OIDC client for agent0 resource server (human SSO)
  - `todo0` - OIDC client for todo0 application (human SSO)
- **Agent0 - Agent identity** (NEW Okta entity type):
  - Separate from OIDC applications
  - Used for cross-app authentication
  - Linked to agent0 OIDC application
  - Has connections to authorization servers
- **Custom Scopes**: REST API scopes (`create:todos`, etc.) and MCP scopes (`mcp:connect`, etc.)
- **Access Policies**: Default policies and rules for both authorization servers
- **RSA Key Pair**: For agent authentication via private key JWT
- **Configuration Files**: Generated `.env` files for both packages

## Prerequisites

1. **Okta Account**: You need an Okta developer account
   - Sign up at: https://developer.okta.com/signup/

2. **Okta API Token**: Create an API token with admin permissions
   - Okta Admin Console → Security → API → Tokens → Create Token
   - Required scopes: `okta.apps.manage`, `okta.authorizationServers.manage`, `okta.clients.manage`

3. **Dependencies Installed**:
   ```bash
   pnpm install
   ```

## Usage

### 1. Bootstrap Okta Tenant

Run the bootstrap script to create all required resources:

```bash
pnpm run bootstrap:okta
```

The script will prompt you for:
- Okta domain (e.g., `dev-12345.okta.com`)
- Okta API token
- REST API audience (default: `api://todo0`)
- MCP audience (default: `mcp://todo0`)

**What it does:**
1. Creates two custom authorization servers (REST API + MCP)
2. Adds custom scopes to each (5 REST + 3 MCP scopes)
3. Creates two OIDC applications (agent0 + todo0)
4. Generates RSA key pair for agent authentication
5. **[PLACEHOLDER]** Creates Agent Identity entity
6. **[PLACEHOLDER]** Uploads public key to agent
7. **[PLACEHOLDER]** Activates the agent
8. **[PLACEHOLDER]** Links agent to agent0 OIDC app
9. **[PLACEHOLDER]** Creates agent connection to MCP AS
10. Creates access policies and rules
11. Adds trusted origins
12. Generates `.env` files for both packages
13. Creates configuration report (`okta-config-report.md`)
14. Saves rollback state (`.okta-bootstrap-state.json`)

**Note**: Steps 5-9 use placeholders for the new Okta Agent Identity API (not yet in public SDK). See `scripts/lib/agent-identity-api.ts` for implementation details.

**Output:**
- `packages/agent0/.env` - Agent configuration
- `packages/todo0/.env` - Todo0 configuration
- `packages/agent0/agent0-private-key.pem` - Private key (600 permissions)
- `okta-config-report.md` - Detailed configuration report
- `.okta-bootstrap-state.json` - Rollback information

### 2. Validate Configuration

Test the configuration to ensure everything is working:

```bash
pnpm run validate:okta
```

**Validation checks:**
- ✓ Environment files exist and contain required variables
- ✓ Audiences are distinct (REST API vs MCP)
- ✓ Private key exists and is valid
- ✓ REST API authorization server is reachable
- ✓ MCP authorization server is reachable
- ✓ ID-JAG token flow works (client credentials + private key JWT)

### 3. Rollback (Clean Up)

Remove all created resources from Okta:

```bash
pnpm run rollback:okta
```

**What it deletes:**
- Custom authorization servers
- OAuth applications
- Trusted origins
- Optionally: local `.env` files, private key, and configuration report

## Architecture

### Authorization Server Separation

| Server | Audience | Purpose | Scopes |
|--------|----------|---------|--------|
| **Org AS** | - | Human SSO, ID-JAG issuance | Default |
| **REST API AS** | `api://todo0` | Protect REST API (port 5001) | `create:todos`, `read:todos`, etc. |
| **MCP AS** | `mcp://todo0` | Protect MCP server (port 5002) | `mcp:connect`, `mcp:tools:read`, `mcp:tools:manage` |

### Token Flow

```
1. User Login
   User → Resource Server → Org AS
   Result: ID Token

2. Agent Gets ID-JAG
   Agent Identity → Org AS (client_credentials + private key JWT)
   Result: ID-JAG Token

3. Exchange for REST API Token
   Agent Identity → REST API AS (jwt-bearer grant with ID-JAG)
   Result: Access Token (aud: api://todo0)

4. Exchange for MCP Token
   Agent Identity → MCP AS (jwt-bearer grant with ID-JAG)
   Result: Access Token (aud: mcp://todo0)
```

### Security Benefits

✅ **Separate Audiences** - Tokens for one service can't be used on another
✅ **Granular Policies** - Different access rules for REST API vs MCP
✅ **No Token Passthrough** - Direct database access, no HTTP forwarding
✅ **JWT Verification** - Both services validate tokens independently
✅ **Private Key JWT** - Strong authentication for agent identity

## Agent Identity API Implementation

The bootstrap script includes placeholders for the new Okta Agent Identity API, which is not yet available in the public SDK. To complete the bootstrap process, you'll need to provide implementations for:

### Required API Functions

Located in `scripts/lib/agent-identity-api.ts`:

1. **`createAgentIdentity()`** - Create a new agent entity in Okta
2. **`uploadAgentPublicKey()`** - Upload RSA public key for private key JWT auth
3. **`activateAgent()`** - Activate the agent for use
4. **`linkAgentToApplication()`** - Link agent to the agent0 OIDC application
5. **`createAgentConnection()`** - Create connection to MCP authorization server

### Implementation Steps

1. Replace the placeholder functions in `agent-identity-api.ts` with actual API calls
2. Update `bootstrap-okta-tenant.ts` to uncomment and use the real implementations
3. Test the bootstrap script end-to-end

### Manual Alternative

If the API is not yet available, you can:
1. Run the bootstrap script (it will create everything except the agent identity)
2. Manually create the agent identity in Okta Admin Console
3. Link it to the agent0 application
4. Create the connection to the MCP authorization server
5. Update the `.env` files with the actual agent client ID

## Files

### Library Modules

- **`lib/okta-api.ts`** - Okta Management API wrapper
  - Create/delete authorization servers
  - Manage scopes, policies, and applications
  - Standard OIDC application operations

- **`lib/agent-identity-api.ts`** - Agent Identity API placeholders
  - Placeholder functions for new Okta entity type
  - Ready for actual API implementation
  - Includes TypeScript interfaces and documentation

- **`lib/key-generator.ts`** - RSA key generation
  - Generate 2048-bit RSA key pairs
  - Create self-signed certificates
  - Secure file permissions (600)

- **`lib/env-writer.ts`** - Configuration file generation
  - Generate `.env` files for both packages
  - Create markdown configuration report
  - Backup existing files

### Main Scripts

- **`bootstrap-okta-tenant.ts`** - Main orchestration script
- **`validate-okta-config.ts`** - Health checks and validation
- **`rollback-okta-config.ts`** - Clean up and resource deletion

## Troubleshooting

### Bootstrap Fails

**Issue**: API token doesn't have sufficient permissions

**Solution**:
- Go to Okta Admin Console → Security → API → Tokens
- Delete old token and create new one with admin permissions
- Re-run bootstrap

**Issue**: Resource already exists

**Solution**:
- Run `pnpm run rollback:okta` to clean up
- Then re-run bootstrap

### Validation Fails

**Issue**: "Failed to reach authorization server"

**Solution**:
- Check Okta domain is correct in `.env` files
- Verify authorization servers were created in Okta Admin Console
- Check network connectivity

**Issue**: "Failed to get ID-JAG token"

**Solution**:
- Verify private key file exists and has correct permissions (600)
- Check Key ID (KID) matches what's in Okta
- Verify agent identity application has correct grant types enabled

### Private Key Issues

**Issue**: "Private key file is invalid"

**Solution**:
- Delete the invalid key file
- Re-run bootstrap to generate a new one

**Issue**: Permission denied when reading private key

**Solution**:
```bash
chmod 600 packages/agent0/agent0-private-key.pem
```

## Manual Configuration

If you prefer to configure Okta manually, see the generated `okta-config-report.md` for a complete checklist of resources and settings.

## Security Notes

⚠️ **Important**:
- Never commit `.env` files or private keys to git
- Keep your Okta API token secure
- Rotate keys periodically
- Use separate Okta tenants for dev/staging/prod
- Review access policies before production use

## Support

For issues or questions:
- Check `okta-config-report.md` for your specific configuration
- Review validation output for specific error messages
- See main README.md for architecture details
- Okta documentation: https://developer.okta.com/docs/
