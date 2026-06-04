/**
 * A2A (Agent-to-Agent) Identity Chaining — Okta provisioning
 *
 * Provisions the second-hop topology: agent0 (Agent A) → Agent B → todo0.
 *
 * Creates:
 *  - Agent B: a new AI agent registered WITH a resourceUrl (auto-creates its
 *    read-only a2a-server projection), its own RSA key, resource owner, activated.
 *  - A2A authorization server: protects Agent B (scope `agent.invoke`); used for
 *    the agent0 → Agent B hop.
 *  - The A2A AS ↔ Agent B a2a-server association.
 *  - A delegation link agent0 → Agent B (inbound policy for Agent B's exchange).
 *  - Managed connections: agent0 → Agent B (IDENTITY_ASSERTION_A2A_SERVER) and
 *    Agent B → todo0 (IDENTITY_ASSERTION_CUSTOM_AS, reusing the todo0 MCP AS).
 *  - Adds Agent B's client id to the todo0 MCP AS policy so todo0 accepts its tokens.
 *
 * Token sequence the result enables (sub preserved at every hop):
 *   agent0  id_token →(Org AS, resource=AgentB)→ id-jag →(A2A AS, jwt-bearer)→ AT(aud=AgentB)
 *   --A2A--> Agent B  AT →(Org AS, resource=todo0)→ id-jag →(todo0 MCP AS, jwt-bearer)→ AT(aud=todo0) --MCP--> todo0
 */

import * as path from 'path';
import { OktaAPIClient } from './okta-api.js';
import {
  AgentIdentityAPIClient,
  convertPublicKeyToJWK,
  constructAuthServerORN,
  constructA2aServerORN,
  constructAgentORN,
} from './agent-identity-api.js';
import { generateRSAKeyPair, savePrivateKey } from './key-generator.js';
import type { A2AConfig } from './env-writer.js';

/**
 * Incremental record of A2A resources as they are created, so a caller can
 * persist them for cleanup (decoupled from any particular state-file shape).
 */
export interface A2AProvisionRecord {
  agentIdentityIds?: string[];     // Agent B
  a2aAuthServerIds?: string[];
  delegationLinkIds?: string[];
  agentConnections?: { agentId: string; connectionId: string }[];
}

// ── A2A provisioning constants ───────────────────────────────────────────────

const AGENTB_PORT = 5005;
const AGENTB_SERVER_URL = `http://localhost:${AGENTB_PORT}`;
const AGENTB_PRIVATE_KEY_FILE = 'agentb-private-key.pem';
const A2A_SCOPE = 'agent.invoke';
const A2A_AUTH_SERVER_NAME = 'agent0-a2a-server';

export interface A2AProvisionDeps {
  oktaClient: OktaAPIClient;
  agentClient: AgentIdentityAPIClient;
  oktaDomain: string;
  ownerSetupMethod: 'standard' | 'developer';
  orgId: string;
  currentUserId: string;
  /** agent0's agent-identity client id (the caller in the first A2A hop). */
  agent0AgentId: string;
  /** todo0's MCP authorization server id + audience + scopes (reused for hop 2). */
  todo0McpAuthServerId: string;
  todo0McpPolicyId: string;
  mcpAudience: string;
  mcpScopes: string[];
  /** Persist incremental state as resources are created (for cleanup). */
  record: (updates: A2AProvisionRecord) => void;
  log?: (msg: string) => void;
}

/**
 * Run the full A2A provisioning sequence. Returns the A2AConfig used to render
 * env files for agent0 (A2A section) and the new agentb package.
 */
export async function provisionA2A(deps: A2AProvisionDeps): Promise<A2AConfig> {
  const {
    oktaClient,
    agentClient,
    oktaDomain,
    ownerSetupMethod,
    orgId,
    currentUserId,
    agent0AgentId,
    todo0McpAuthServerId,
    todo0McpPolicyId,
    mcpAudience,
    mcpScopes,
    record,
  } = deps;
  const log = deps.log ?? (() => {});

  const agentbResourceUrl = `https://agentb.${oktaDomain}`;

  // ── 1. Agent B key pair ────────────────────────────────────────────────────
  const keyPair = await generateRSAKeyPair();
  const privateKeyPath = path.resolve('packages/agentb', AGENTB_PRIVATE_KEY_FILE);
  await savePrivateKey(keyPair.privateKeyPem, privateKeyPath);
  log('Generated Agent B RSA key pair');

  // ── 2. Register Agent B WITH resourceUrl (auto-creates its a2a-server) ──────
  const registerOp = await agentClient.registerAgent({
    profile: { name: 'Agent B (Task Agent)', description: 'A2A downstream task agent' },
    resourceUrl: agentbResourceUrl,
  });
  const registered = await agentClient.pollOperation(registerOp);
  const agentbAgentId = registered.resource.id;
  record({ agentIdentityIds: [agentbAgentId] });
  log(`Registered Agent B: ${agentbAgentId}`);

  // ── 3. Resource owner (required before activation) ──────────────────────────
  if (ownerSetupMethod === 'developer') {
    await agentClient.setAgentOwnersDeveloper(agentbAgentId, orgId);
  } else {
    await agentClient.setAgentOwnersStandard(agentbAgentId, orgId, currentUserId);
  }
  log('Set Agent B resource owner');

  // ── 4. Upload Agent B public key ────────────────────────────────────────────
  const jwk = await convertPublicKeyToJWK(keyPair.publicKeyPem);
  const { kid: agentbKeyId } = await agentClient.uploadPublicKey(agentbAgentId, jwk);
  log(`Uploaded Agent B public key (kid: ${agentbKeyId})`);

  // ── 5. Activate Agent B ─────────────────────────────────────────────────────
  const activateOp = await agentClient.activateAgent(agentbAgentId);
  await agentClient.pollOperation(activateOp);
  log('Activated Agent B');

  // ── 6. A2A authorization server (protects Agent B) ──────────────────────────
  const a2aAs = await oktaClient.createAuthorizationServer({
    name: A2A_AUTH_SERVER_NAME,
    description: 'A2A authorization server protecting Agent B (agent-to-agent identity chaining)',
    audiences: [agentbResourceUrl],
  });
  const a2aAuthServerId = a2aAs.id!;
  record({ a2aAuthServerIds: [a2aAuthServerId] });
  log(`Created A2A authorization server: ${a2aAuthServerId}`);

  await oktaClient.addScopes(a2aAuthServerId, [
    { name: A2A_SCOPE, description: 'Invoke the agent', consent: 'IMPLICIT' },
  ]);

  // Policy + rule: allow agent0 to obtain tokens via token-exchange / jwt-bearer.
  const a2aPolicy = await oktaClient.createPolicy(a2aAuthServerId, {
    name: 'A2A Policy',
    description: 'Allow agent0 to obtain access tokens for Agent B',
    priority: 1,
    clientIds: [agent0AgentId],
  });
  await oktaClient.createPolicyRule(a2aAuthServerId, a2aPolicy.id!, {
    name: 'Allow A2A token exchange',
    priority: 1,
    grantTypes: [
      'client_credentials',
      'authorization_code',
      'urn:ietf:params:oauth:grant-type:token-exchange',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
    scopes: [A2A_SCOPE],
    accessTokenLifetimeMinutes: 60,
  });
  log('Created A2A policy + rule');

  // ── 7. Associate A2A AS with Agent B's a2a-server ───────────────────────────
  const a2aAsOrn = constructAuthServerORN(orgId, a2aAuthServerId);
  await agentClient.addAuthorizationServerToA2aServer(agentbAgentId, a2aAsOrn);
  log('Linked A2A AS to Agent B a2a-server');

  // Read the a2a-server's canonical ORN + resourceUrl back from Okta rather than
  // constructing them — avoids ORN-format drift on the connection create.
  const a2aServer = await agentClient.getA2aServer(agentbAgentId);
  const a2aServerOrn = a2aServer.orn || constructA2aServerORN(orgId, agentbAgentId);
  const resolvedResourceUrl = a2aServer.resourceUrl || agentbResourceUrl;
  log(`Resolved Agent B a2a-server ORN: ${a2aServerOrn}`);

  // ── 8. Delegation link: agent0 → Agent B (inbound policy for hop 2) ─────────
  const delegationLink = await agentClient.createDelegationLink({
    from: {
      type: 'OKTA_AUTHORIZATION_SERVER',
      clientOrn: constructAgentORN(orgId, agent0AgentId),
      tokenType: 'ACCESS_TOKEN',
    },
    to: { resourceOrn: constructAgentORN(orgId, agentbAgentId) },
  });
  if (delegationLink?.id) {
    record({ delegationLinkIds: [delegationLink.id] });
  }
  log('Created delegation link agent0 → Agent B');

  // ── 9. Managed connection: agent0 → Agent B ────────────────────────────────
  // Prefer the dedicated IDENTITY_ASSERTION_A2A_SERVER type. Some org builds do
  // not yet accept it (the connection-create rejects the type as not
  // well-formed); fall back to IDENTITY_ASSERTION_CUSTOM_AS targeting Agent B's
  // resourceUrl via the A2A AS. The issued token is identical either way
  // (aud = Agent B's resourceUrl), so the identity chain is unaffected.
  let a2aConnection;
  try {
    a2aConnection = await agentClient.createA2aConnection(agent0AgentId, {
      connectionType: 'IDENTITY_ASSERTION_A2A_SERVER',
      a2aServer: { orn: a2aServerOrn },
      authorizationServer: { orn: a2aAsOrn },
      scopeCondition: 'INCLUDE_ONLY',
      scopes: [A2A_SCOPE],
    });
    log('Created managed connection agent0 → Agent B (IDENTITY_ASSERTION_A2A_SERVER)');
  } catch (err: any) {
    log('A2A_SERVER connection type not accepted — falling back to CUSTOM_AS (resource indicator)');
    a2aConnection = await agentClient.createConnection(agent0AgentId, {
      connectionType: 'IDENTITY_ASSERTION_CUSTOM_AS',
      authorizationServer: { orn: a2aAsOrn },
      resourceIndicator: resolvedResourceUrl,
      scopeCondition: 'INCLUDE_ONLY',
      scopes: [A2A_SCOPE],
    });
    log('Created managed connection agent0 → Agent B (IDENTITY_ASSERTION_CUSTOM_AS fallback)');
  }
  record({ agentConnections: [{ agentId: agent0AgentId, connectionId: a2aConnection.id }] });

  // ── 10. Managed connection: Agent B → todo0 (IDENTITY_ASSERTION_CUSTOM_AS) ───
  const todoConnection = await agentClient.createConnection(agentbAgentId, {
    connectionType: 'IDENTITY_ASSERTION_CUSTOM_AS',
    authorizationServer: { orn: constructAuthServerORN(orgId, todo0McpAuthServerId) },
    resourceIndicator: mcpAudience,
    scopeCondition: 'INCLUDE_ONLY',
    scopes: mcpScopes,
  });
  record({ agentConnections: [{ agentId: agentbAgentId, connectionId: todoConnection.id }] });
  log('Created managed connection Agent B → todo0');

  // ── 11. Allow Agent B's client on the todo0 MCP AS policy ───────────────────
  await oktaClient.addClientToPolicy(todo0McpAuthServerId, todo0McpPolicyId, agentbAgentId);
  log('Added Agent B to todo0 MCP AS policy');

  return {
    agentbAgentId,
    agentbPrivateKeyFile: AGENTB_PRIVATE_KEY_FILE,
    agentbKeyId,
    agentbResourceUrl: resolvedResourceUrl,
    agentbPort: AGENTB_PORT,
    agentbServerUrl: AGENTB_SERVER_URL,
    agentbMcpScopes: mcpScopes,
    a2aAuthServerId,
    a2aScopes: [A2A_SCOPE],
  };
}
