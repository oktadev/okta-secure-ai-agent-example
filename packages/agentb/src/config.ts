// ============================================================================
// AGENT B — CONFIGURATION
// ============================================================================
// Agent B is the dual-natured downstream agent in the A2A identity chain:
//   - a2a-server (resource): validates inbound A2A calls from agent0
//   - principal: performs its own second-hop token exchange to reach todo0
//
// Config is validated at startup; missing required vars fail fast.

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.agentb' });

export interface AgentBConfig {
  // Server
  port: number;
  resourceUrl: string; // this agent's a2a-server audience (inbound aud)

  // Identity (Agent B's own workload-principal credentials)
  oktaDomain: string;
  agentId: string;
  privateKey: string; // PEM contents
  privateKeyKid: string;

  // Inbound validation (agent0 → Agent B)
  a2aAuthorizationServer: string; // issuer of the inbound access token
  requiredScope: string; // scope the inbound token must carry (agent.invoke)

  // Outbound second hop (Agent B → todo0 MCP)
  mcpServerUrl: string;
  mcpAuthorizationServer: string; // todo0 MCP AS issuer (id-jag audience)
  mcpAuthorizationServerTokenEndpoint: string;
  mcpResourceIndicator: string; // todo0 resource (audience of the final token)
  mcpScopes: string; // space-separated
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name} (check packages/agentb/.env.agentb)`);
  }
  return value.trim();
}

export function loadConfig(): AgentBConfig {
  const privateKeyFile = required('AGENTB_AI_AGENT_PRIVATE_KEY_FILE');
  // __dirname at runtime is dist/; the .pem lives at the package root (one level up).
  const privateKeyPath = path.resolve(__dirname, '..', privateKeyFile);
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch (err: any) {
    throw new Error(`Failed to read Agent B private key at ${privateKeyPath}: ${err.message}`);
  }

  return {
    port: parseInt(process.env.AGENTB_PORT || '5005', 10),
    resourceUrl: required('AGENTB_RESOURCE_URL'),

    oktaDomain: required('OKTA_DOMAIN'),
    agentId: required('AGENTB_AI_AGENT_ID'),
    privateKey,
    privateKeyKid: required('AGENTB_AI_AGENT_PRIVATE_KEY_KID'),

    a2aAuthorizationServer: required('A2A_AUTHORIZATION_SERVER'),
    requiredScope: process.env.AGENTB_REQUIRED_SCOPE || 'agent.invoke',

    mcpServerUrl: required('MCP_SERVER_URL'),
    mcpAuthorizationServer: required('MCP_AUTHORIZATION_SERVER'),
    mcpAuthorizationServerTokenEndpoint: required('MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT'),
    mcpResourceIndicator: required('MCP_RESOURCE_INDICATOR'),
    mcpScopes: process.env.AGENTB_MCP_SCOPES_TO_REQUEST || 'mcp:connect mcp:tools:read mcp:tools:manage',
  };
}
