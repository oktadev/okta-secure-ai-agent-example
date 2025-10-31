import * as fs from 'fs';
import * as path from 'path';

export interface BootstrapConfig {
  oktaDomain: string;

  // Applications
  agentAppClientId: string;
  agentAppClientSecret: string;
  agentIdentityClientId: string;

  todo0AppClientId: string;
  todo0AppClientSecret: string;

  // Keys
  privateKeyFile: string;
  keyId: string;

  // Authorization Servers
  mcpAuthServerId: string;
  mcpAudience: string;
  mcpScopes: string[];
}

/**
 * Generate .env.app file for agent0 package (Resource Server)
 */
export function generateAgent0AppEnv(config: BootstrapConfig): string {
  return `# ============================================================================
# RESOURCE SERVER CONFIGURATION
# ============================================================================
PORT=3000
SESSION_SECRET=default-secret-change-in-production

# ============================================================================
# RESOURCE SERVER - OKTA OAUTH (HUMAN SSO)
# ============================================================================
OKTA_DOMAIN=${config.oktaDomain}
OKTA_CLIENT_ID=${config.agentAppClientId}
OKTA_CLIENT_SECRET=${config.agentAppClientSecret}
OKTA_REDIRECT_URI=http://localhost:3000/callback

`;
}

/**
 * Generate .env.agent file for agent0 package (AI Agent / MCP Client)
 */
export function generateAgent0AgentEnv(config: BootstrapConfig): string {
  return `# ============================================================================
# AGENT - MCP CLIENT CONFIGURATION
# ============================================================================
MCP_SERVER_URL=http://localhost:5002/mcp

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
# AGENT - CROSS-APP ACCESS (ID-JAG TOKEN EXCHANGE)
# ============================================================================
# Agent Identity Configuration
OKTA_DOMAIN=${config.oktaDomain}
AI_AGENT_ID=${config.agentIdentityClientId}
AI_AGENT_PRIVATE_KEY_FILE=${config.privateKeyFile}
AI_AGENT_PRIVATE_KEY_KID=${config.keyId}
AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST=${config.mcpScopes.join(' ')}

# MCP Authorization Server (for todo0 MCP server)
MCP_AUTHORIZATION_SERVER=https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}
MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT=https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}/v1/token

`;
}

/**
 * Generate .env.app file for todo0 package (App server)
 */
export function generateTodo0AppEnv(config: BootstrapConfig): string {
  return `# ============================================================================
# APP SERVER CONFIGURATION
# ============================================================================
PORT=5001

# ============================================================================
# APP SERVER - OKTA OAUTH (HUMAN SSO)
# ============================================================================
OKTA_ISSUER=https://${config.oktaDomain}/oauth2/default
OKTA_CLIENT_ID=${config.todo0AppClientId}
OKTA_CLIENT_SECRET=${config.todo0AppClientSecret}
OKTA_REDIRECT_URI=http://localhost:5001/callback

# ============================================================================
# DATABASE CONFIGURATION
# ============================================================================
# Database connection configured in prisma/schema.prisma
# Default: SQLite with file ./dev.db
`;
}

/**
 * Generate .env.mcp file for todo0 package (MCP server)
 */
export function generateTodo0McpEnv(config: BootstrapConfig): string {
  return `# ============================================================================
# MCP SERVER CONFIGURATION
# ============================================================================
MCP_PORT=5002

# ============================================================================
# MCP SERVER - OKTA JWT AUTHENTICATION
# ============================================================================
MCP_OKTA_ISSUER=https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}
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

### Todo0 MCP Server Authorization Server
- **ID**: \`${config.mcpAuthServerId}\`
- **Issuer**: https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}
- **Audience**: \`${config.mcpAudience}\`
- **Purpose**: Protect todo0 MCP server endpoints (port 5002)
- **Scopes**:
  - \`mcp:connect\` - Establish MCP connection
  - \`mcp:tools:read\` - Execute tools to read todo data
  - \`mcp:tools:manage\` - Execute tools to manage todo data

## Applications

### Resource Server (OIDC Client)
- **Client ID**: \`${config.agentAppClientId}\`
- **Type**: Web Application
- **Grant Types**: Authorization Code with PKCE
- **Redirect URI**: http://localhost:3000/callback
- **Purpose**: Human user authentication for web UI

### Agent Identity (MCP Client)
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

### Step 3: Exchange for MCP Token
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
| **Todo0 MCP Server** | 5002 | Todo0 MCP AS | \`${config.mcpAudience}\` | JWT (requireMcpAuth) |

## Files Generated

- \`packages/agent0/.env.app\` - Agent0 web UI configuration
- \`packages/agent0/.env.agent\` - Agent0 agent identity configuration
- \`packages/todo0/.env.app\` - Todo0 REST API server configuration
- \`packages/todo0/.env.mcp\` - Todo0 MCP server configuration
- \`packages/agent0/${config.privateKeyFile}\` - RSA private key (600 permissions)
- \`okta-config-report.md\` - This report

## Next Steps

1. **Install dependencies**: \`pnpm install\`
2. **Bootstrap database**: \`pnpm run bootstrap\`
3. **Start Todo0 REST API**: \`pnpm run start:todo0\`
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
