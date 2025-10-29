import * as fs from 'fs';
import * as path from 'path';

export interface BootstrapConfig {
  oktaDomain: string;

  // Applications
  resourceServerClientId: string;
  resourceServerClientSecret: string;
  agentIdentityClientId: string;

  // Keys
  privateKeyFile: string;
  keyId: string;

  // Authorization Servers
  agent0ApiAuthServerId: string;
  agent0ApiAudience: string;
  restApiAuthServerId: string;
  restApiAudience: string;
  mcpAuthServerId: string;
  mcpAudience: string;
}

/**
 * Generate .env file for agent0 package
 */
export function generateAgent0Env(config: BootstrapConfig): string {
  return `# ============================================================================
# RESOURCE SERVER CONFIGURATION
# ============================================================================
PORT=3000
SESSION_SECRET=default-secret-change-in-production

# ============================================================================
# AGENT - MCP CLIENT CONFIGURATION
# ============================================================================
MCP_SERVER_URL=http://localhost:3001

# ============================================================================
# AGENT - LLM INTEGRATION CONFIGURATION
# ============================================================================
# Configure EITHER Anthropic Direct OR AWS Bedrock

# Anthropic Direct
ANTHROPIC_API_KEY=your_anthropic_api_key_here
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

# AWS Bedrock (alternative)
# AWS_REGION=us-east-1
# AWS_ACCESS_KEY_ID=your_aws_access_key
# AWS_SECRET_ACCESS_KEY=your_aws_secret_key
# BEDROCK_MODEL_ID=us.anthropic.claude-3-5-sonnet-20241022-v2:0

# ============================================================================
# RESOURCE SERVER - OKTA OAUTH (HUMAN SSO)
# ============================================================================
OKTA_DOMAIN=${config.oktaDomain}
OKTA_CLIENT_ID=${config.resourceServerClientId}
OKTA_CLIENT_SECRET=${config.resourceServerClientSecret}
OKTA_REDIRECT_URI=http://localhost:3000/callback

# ============================================================================
# AGENT - CROSS-APP ACCESS (ID-JAG TOKEN EXCHANGE)
# ============================================================================
# Agent Identity Configuration
AI_AGENT_ID=${config.agentIdentityClientId}
OKTA_CC_PRIVATE_KEY_FILE=${config.privateKeyFile}
OKTA_PRIVATE_KEY_KID=${config.keyId}

# Token Endpoints
OKTA_TOKEN_ENDPOINT=https://${config.oktaDomain}/oauth2/v1/token

# Agent0 API Authorization Server (for agent0's own APIs)
AGENT0_API_TOKEN_ENDPOINT=https://${config.oktaDomain}/oauth2/${config.agent0ApiAuthServerId}/v1/token
AGENT0_API_AUDIENCE=${config.agent0ApiAudience}

# REST API Authorization Server (for todo0 REST API)
REST_API_TOKEN_ENDPOINT=https://${config.oktaDomain}/oauth2/${config.restApiAuthServerId}/v1/token
REST_API_AUDIENCE=${config.restApiAudience}

# MCP Authorization Server (for todo0 MCP server)
MCP_TOKEN_ENDPOINT=https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}/v1/token
MCP_AUDIENCE=${config.mcpAudience}

# Legacy/compatibility (points to REST API AS)
TARGET_SERVICE_AUDIENCE=${config.restApiAudience}
RESOURCE_TOKEN_ENDPOINT=https://${config.oktaDomain}/oauth2/${config.restApiAuthServerId}/v1/token
`;
}

/**
 * Generate .env file for todo0 package
 */
export function generateTodo0Env(config: BootstrapConfig): string {
  return `# ============================================================================
# REST API SERVER CONFIGURATION
# ============================================================================
PORT=5001

# ============================================================================
# REST API - OKTA JWT AUTHENTICATION
# ============================================================================
OKTA_ISSUER=https://${config.oktaDomain}/oauth2/${config.restApiAuthServerId}
OKTA_CLIENT_ID=${config.agentIdentityClientId}
EXPECTED_AUDIENCE=${config.restApiAudience}

# ============================================================================
# MCP SERVER CONFIGURATION
# ============================================================================
MCP_PORT=3001

# ============================================================================
# MCP SERVER - OKTA JWT AUTHENTICATION
# ============================================================================
MCP_OKTA_ISSUER=https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}
MCP_OKTA_CLIENT_ID=${config.agentIdentityClientId}
MCP_EXPECTED_AUDIENCE=${config.mcpAudience}

# ============================================================================
# DATABASE CONFIGURATION
# ============================================================================
# Database connection configured in prisma/schema.prisma
# Default: SQLite with file ./dev.db
`;
}

/**
 * Write .env file to disk
 */
export function writeEnvFile(filePath: string, content: string): void {
  const absolutePath = path.resolve(filePath);
  const dir = path.dirname(absolutePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Check if .env already exists
  if (fs.existsSync(absolutePath)) {
    const backup = `${absolutePath}.backup`;
    fs.copyFileSync(absolutePath, backup);
    console.log(`  Backed up existing .env to: ${backup}`);
  }

  // Write new .env file
  fs.writeFileSync(absolutePath, content, { mode: 0o600 });
  console.log(`✓ Created .env file: ${absolutePath}`);
}

/**
 * Generate configuration report markdown
 */
export function generateConfigReport(config: BootstrapConfig): string {
  return `# Okta Tenant Bootstrap Report

Generated: ${new Date().toISOString()}

## Authorization Servers

### Org AS (Pre-existing)
- **URL**: https://${config.oktaDomain}/oauth2/v1
- **Purpose**: Human SSO, ID-JAG token issuance
- **Used by**: Resource Server OIDC, Agent Identity client_credentials

### Agent0 API Authorization Server
- **ID**: \`${config.agent0ApiAuthServerId}\`
- **Issuer**: https://${config.oktaDomain}/oauth2/${config.agent0ApiAuthServerId}
- **Audience**: \`${config.agent0ApiAudience}\`
- **Purpose**: Protect agent0 resource server API endpoints (port 3000)
- **Scopes**:
  - \`read:profile\` - Read user profile
  - \`write:profile\` - Update user profile

### Todo0 REST API Authorization Server
- **ID**: \`${config.restApiAuthServerId}\`
- **Issuer**: https://${config.oktaDomain}/oauth2/${config.restApiAuthServerId}
- **Audience**: \`${config.restApiAudience}\`
- **Purpose**: Protect todo0 REST API endpoints (port 5001)
- **Scopes**:
  - \`create:todos\` - Create new todo items
  - \`read:todos\` - Read todo items
  - \`update:todos\` - Modify existing todos
  - \`delete:todos\` - Remove todos
  - \`admin:todos\` - Full administrative access

### Todo0 MCP Server Authorization Server
- **ID**: \`${config.mcpAuthServerId}\`
- **Issuer**: https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}
- **Audience**: \`${config.mcpAudience}\`
- **Purpose**: Protect todo0 MCP server endpoints (port 3001)
- **Scopes**:
  - \`mcp:connect\` - Establish MCP SSE connection
  - \`mcp:tools:todos\` - Execute todo management tools
  - \`mcp:tools:admin\` - Administrative tool operations

## Applications

### Resource Server (OIDC Client)
- **Client ID**: \`${config.resourceServerClientId}\`
- **Type**: Web Application
- **Grant Types**: Authorization Code with PKCE
- **Redirect URI**: http://localhost:3000/callback
- **Purpose**: Human user authentication for web UI

### Agent Identity (Service Account)
- **Client ID**: \`${config.agentIdentityClientId}\`
- **Type**: Service (Native with Private Key JWT)
- **Grant Types**:
  - \`client_credentials\` (for ID-JAG from Org AS)
  - \`urn:ietf:params:oauth:grant-type:jwt-bearer\` (for token exchange)
- **Authentication**: Private Key JWT
- **Key ID (KID)**: \`${config.keyId}\`
- **Private Key**: \`packages/agent0/${config.privateKeyFile}\`
- **Purpose**: Agent authentication for cross-app access

## Token Exchange Flow

### Step 1: User Login
\`\`\`
User → Resource Server → Org AS
  Grant: Authorization Code + PKCE
  Result: ID Token + Access Token
\`\`\`

### Step 2: Agent Gets ID-JAG
\`\`\`
Agent Identity → Org AS (/oauth2/v1/token)
  Grant: client_credentials
  Auth: Private Key JWT
  Result: ID-JAG Token
\`\`\`

### Step 3: Exchange for REST API Token
\`\`\`
Agent Identity → REST API AS (/oauth2/${config.restApiAuthServerId}/v1/token)
  Grant: urn:ietf:params:oauth:grant-type:jwt-bearer
  Assertion: ID-JAG Token
  Audience: ${config.restApiAudience}
  Result: REST API Access Token (aud: ${config.restApiAudience})
\`\`\`

### Step 4: Exchange for MCP Token
\`\`\`
Agent Identity → MCP AS (/oauth2/${config.mcpAuthServerId}/v1/token)
  Grant: urn:ietf:params:oauth:grant-type:jwt-bearer
  Assertion: ID-JAG Token
  Audience: ${config.mcpAudience}
  Result: MCP Access Token (aud: ${config.mcpAudience})
\`\`\`

## Security Boundaries

| Service | Port | Auth Server | Audience | Validates |
|---------|------|-------------|----------|-----------|
| **Agent0 Web UI** | 3000 | Org AS | - | Session-based |
| **Agent0 APIs** | 3000 | Agent0 API AS | \`${config.agent0ApiAudience}\` | JWT (requireAuth) |
| **Todo0 REST API** | 5001 | Todo0 REST API AS | \`${config.restApiAudience}\` | JWT (requireAuth) |
| **Todo0 MCP Server** | 3001 | Todo0 MCP AS | \`${config.mcpAudience}\` | JWT (requireMcpAuth) |

## Files Generated

- \`packages/agent0/.env\` - Agent configuration
- \`packages/todo0/.env\` - Todo0 configuration
- \`packages/agent0/${config.privateKeyFile}\` - RSA private key (600 permissions)
- \`okta-config-report.md\` - This report

## Next Steps

1. **Install dependencies**: \`pnpm install\`
2. **Bootstrap database**: \`pnpm run bootstrap\`
3. **Start REST API**: \`pnpm run start:todo0\`
4. **Start MCP Server**: \`pnpm run start:mcp\`
5. **Start Agent**: \`pnpm run start:agent0\`
6. **Validate config** (optional): \`pnpm run validate:okta\`

## Important Notes

⚠️ **Security Warnings**:
- Private key file contains sensitive credentials - never commit to git
- Ensure \`.env\` files are in \`.gitignore\`
- Keep your Okta API token secure
- Rotate keys periodically

🔄 **Rollback**:
- To remove all created resources: \`pnpm run rollback:okta\`
- Backup .env files are created before overwriting

📖 **Documentation**:
- See README.md for architecture details
- See MCP specification for token passthrough best practices
`;
}

/**
 * Write configuration report to file
 */
export function writeConfigReport(config: BootstrapConfig, filePath: string = 'okta-config-report.md'): void {
  const absolutePath = path.resolve(filePath);
  const content = generateConfigReport(config);
  fs.writeFileSync(absolutePath, content);
  console.log(`✓ Configuration report saved: ${absolutePath}`);
}
