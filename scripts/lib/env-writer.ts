import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Generate a cryptographically secure random session secret
 */
function generateSessionSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

// LLM Configuration Types
export interface AnthropicLLMConfig {
  provider: 'anthropic';
  apiKey: string;
  model: string;
}

export interface BedrockLLMConfig {
  provider: 'bedrock';
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  modelId: string;
}

export interface SkipLLMConfig {
  provider: 'skip';
}

export type LLMConfig = AnthropicLLMConfig | BedrockLLMConfig | SkipLLMConfig;

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

  // LLM Configuration (optional)
  llmConfig?: LLMConfig;

  // A2A identity chaining (optional — present only when A2A provisioning ran)
  a2a?: A2AConfig;
}

/**
 * Configuration for the A2A (agent-to-agent) second hop: agent0 → Agent B → todo0.
 */
export interface A2AConfig {
  // Agent B (the dual-natured downstream agent)
  agentbAgentId: string;
  agentbPrivateKeyFile: string;
  agentbKeyId: string;
  agentbResourceUrl: string;   // a2a-server audience / resource indicator
  agentbPort: number;          // local A2A transport port
  agentbServerUrl: string;     // local A2A transport URL (e.g. http://localhost:5005)
  agentbMcpScopes: string[];   // scopes Agent B requests for the todo0 hop

  // A2A authorization server (protects Agent B; used for the agent0 → Agent B hop)
  a2aAuthServerId: string;
  a2aScopes: string[];         // e.g. ['agent.invoke']
}

/**
 * Generate .env.app file for agent0 package (Resource Server)
 */
export function generateAgent0AppEnv(config: BootstrapConfig): string {
  return `# ============================================================================
# RESOURCE SERVER CONFIGURATION
# ============================================================================
PORT=3000
SESSION_SECRET=${generateSessionSecret()}

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
 * Generate LLM configuration section based on mode
 */
function generateLLMConfigSection(llmConfig?: LLMConfig): string {
  if (!llmConfig || llmConfig.provider === 'skip') {
    // Skip mode: provide template for manual configuration
    return `# ============================================================================
# AGENT - LLM INTEGRATION CONFIGURATION
# ============================================================================
# Configure EITHER Anthropic OR AWS Bedrock (uncomment one section)

# Option 1: Anthropic
# ANTHROPIC_API_KEY=sk-ant-your-key-here
# ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Option 2: AWS Bedrock
# AWS_REGION=us-east-1
# AWS_ACCESS_KEY_ID=your_aws_access_key
# AWS_SECRET_ACCESS_KEY=your_aws_secret_key
# BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0
`;
  }

  if (llmConfig.provider === 'anthropic') {
    return `# ============================================================================
# AGENT - LLM INTEGRATION CONFIGURATION
# ============================================================================
ANTHROPIC_API_KEY=${llmConfig.apiKey}
ANTHROPIC_MODEL=${llmConfig.model}
`;
  }

  if (llmConfig.provider === 'bedrock') {
    let bedrockConfig = `# ============================================================================
# AGENT - LLM INTEGRATION CONFIGURATION
# ============================================================================
AWS_REGION=${llmConfig.region}
AWS_ACCESS_KEY_ID=${llmConfig.accessKeyId}
AWS_SECRET_ACCESS_KEY=${llmConfig.secretAccessKey}
BEDROCK_MODEL_ID=${llmConfig.modelId}
`;
    if (llmConfig.sessionToken) {
      bedrockConfig += `AWS_SESSION_TOKEN=${llmConfig.sessionToken}\n`;
    }
    return bedrockConfig;
  }

  return '';
}

/**
 * Generate .env.agent file for agent0 package (AI Agent / MCP Client)
 */
export function generateAgent0AgentEnv(config: BootstrapConfig): string {
  const llmSection = generateLLMConfigSection(config.llmConfig);

  return `# ============================================================================
# AGENT - MCP CLIENT CONFIGURATION
# ============================================================================
MCP_SERVER_URL=http://localhost:5002/mcp

${llmSection}
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
${config.a2a ? generateAgent0A2ASection(config) : ''}
`;
}

/**
 * Generate the A2A (agent-to-agent) section appended to agent0's .env.agent.
 * Enables agent0 to obtain an access token for Agent B and call it over A2A.
 * Exported so the standalone `setup:a2a` script can append it to an existing
 * .env.agent without rewriting the rest of the file.
 */
export function generateAgent0A2ASection(config: BootstrapConfig): string {
  const a2a = config.a2a!;
  return `
# ============================================================================
# AGENT - A2A IDENTITY CHAINING (agent0 → Agent B)
# ============================================================================
# A2A transport endpoint (Agent B's local A2A protocol server)
A2A_SERVER_URL=${a2a.agentbServerUrl}
# Resource indicator (Agent B's a2a-server resourceUrl / audience)
A2A_RESOURCE_INDICATOR=${a2a.agentbResourceUrl}
# A2A authorization server that protects Agent B
A2A_AUTHORIZATION_SERVER=https://${config.oktaDomain}/oauth2/${a2a.a2aAuthServerId}
A2A_AUTHORIZATION_SERVER_TOKEN_ENDPOINT=https://${config.oktaDomain}/oauth2/${a2a.a2aAuthServerId}/v1/token
A2A_SCOPES_TO_REQUEST=${a2a.a2aScopes.join(' ')}
# Agent B's Okta agent id (for the Connections panel)
OKTA_A2A_SERVER_ID=${a2a.agentbAgentId}
`;
}

/**
 * Generate .env.agentb for the agentb package (the dual-natured downstream agent).
 * Agent B validates inbound A2A calls (against the A2A AS) and performs its own
 * second-hop token exchange to reach todo0's MCP server.
 */
export function generateAgentbEnv(config: BootstrapConfig): string {
  const a2a = config.a2a;
  if (!a2a) {
    throw new Error('generateAgentbEnv called without A2A config');
  }

  const llmSection = generateLLMConfigSection(config.llmConfig);

  return `# ============================================================================
# AGENT B — SERVER CONFIGURATION
# ============================================================================
AGENTB_PORT=${a2a.agentbPort}
# This agent's a2a-server resourceUrl (the audience inbound tokens must carry)
AGENTB_RESOURCE_URL=${a2a.agentbResourceUrl}

${llmSection}

# ============================================================================
# AGENT B — IDENTITY (its own workload-principal credentials)
# ============================================================================
OKTA_DOMAIN=${config.oktaDomain}
AGENTB_AI_AGENT_ID=${a2a.agentbAgentId}
AGENTB_AI_AGENT_PRIVATE_KEY_FILE=${a2a.agentbPrivateKeyFile}
AGENTB_AI_AGENT_PRIVATE_KEY_KID=${a2a.agentbKeyId}

# ============================================================================
# AGENT B — INBOUND VALIDATION (agent0 → Agent B)
# ============================================================================
# The A2A authorization server that issued the inbound access token. Agent B
# verifies issuer + aud (= AGENTB_RESOURCE_URL) + scope (agent.invoke).
A2A_AUTHORIZATION_SERVER=https://${config.oktaDomain}/oauth2/${a2a.a2aAuthServerId}

# ============================================================================
# AGENT B — OUTBOUND SECOND HOP (Agent B → todo0 MCP)
# ============================================================================
MCP_SERVER_URL=http://localhost:5002/mcp
MCP_AUTHORIZATION_SERVER=https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}
MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT=https://${config.oktaDomain}/oauth2/${config.mcpAuthServerId}/v1/token
MCP_RESOURCE_INDICATOR=${config.mcpAudience}
AGENTB_MCP_SCOPES_TO_REQUEST=${a2a.agentbMcpScopes.join(' ')}
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
SESSION_SECRET=${generateSessionSecret()}

# ============================================================================
# APP SERVER - OKTA OAUTH (HUMAN SSO)
# ============================================================================
OKTA_ISSUER=https://${config.oktaDomain}/
OKTA_CLIENT_ID=${config.todo0AppClientId}
OKTA_CLIENT_SECRET=${config.todo0AppClientSecret}
OKTA_REDIRECT_URI=http://localhost:5001/callback
EXPECTED_AUDIENCE=api://todo0

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
