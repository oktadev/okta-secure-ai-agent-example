#!/usr/bin/env node
/**
 * Standalone A2A Identity Chaining setup — ADDITIVE.
 *
 * Adds the agent0 → Agent B → todo0 second hop to an EXISTING osage install
 * WITHOUT re-running `bootstrap:okta` (which would recreate the MCP AS, apps,
 * and agent0 identity and overwrite your .env files).
 *
 * It reads your existing config from the generated .env files, then provisions
 * only the new A2A resources via the shared `provisionA2A()` (no duplicated
 * provisioning logic). New resources are tracked in `.a2a-setup-state.json`
 * (following the .opa-setup-state.json / .mcp-register-state.json pattern) so
 * `cleanup:a2a` can remove just the A2A pieces and leave the base demo intact.
 *
 * Usage: pnpm run setup:a2a   (prompts for the Okta API token)
 */

import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { OktaAPIClient } from './lib/okta-api.js';
import { AgentIdentityAPIClient } from './lib/agent-identity-api.js';
import { provisionA2A } from './lib/a2a-provisioning.js';
import {
  generateAgentbEnv,
  generateAgent0A2ASection,
  writeEnvFile,
  BootstrapConfig,
  LLMConfig,
} from './lib/env-writer.js';

const A2A_STATE_FILE = '.a2a-setup-state.json';
const AGENT0_ENV = 'packages/agent0/.env.agent';
const TODO0_MCP_ENV = 'packages/todo0/.env.mcp';
const AGENTB_ENV = 'packages/agentb/.env.agentb';
const TODO0_MCP_POLICY_NAME = 'Default MCP Policy';

interface A2ASetupState {
  oktaDomain?: string;
  orgId?: string;
  agentIdentityIds: string[];      // Agent B
  a2aAuthServerIds: string[];
  delegationLinkIds: string[];
  agentConnections: { agentId: string; connectionId: string }[];
}

function loadEnvFile(filePath: string): Record<string, string> {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Not found: ${filePath} — run \`pnpm run bootstrap:okta\` first.`);
  }
  const env: Record<string, string> = {};
  for (let line of fs.readFileSync(abs, 'utf8').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

/** Parse the AS id from an issuer URL: https://<domain>/oauth2/<ausId>. */
function authServerIdFromIssuer(issuer: string): string {
  return issuer.replace(/\/$/, '').split('/').pop() || '';
}

function emptyState(): A2ASetupState {
  return { agentIdentityIds: [], a2aAuthServerIds: [], delegationLinkIds: [], agentConnections: [] };
}

function writeState(state: A2ASetupState): void {
  fs.writeFileSync(A2A_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function main() {
  console.log(chalk.bold.blue('\n🔗 A2A Identity Chaining — additive setup\n'));
  console.log('Adds agent0 → Agent B → todo0 to your existing install.');
  console.log(chalk.gray('Does NOT recreate base resources or overwrite existing .env values.\n'));

  // Refuse if A2A already looks set up (avoid duplicate Okta resources).
  if (fs.existsSync(A2A_STATE_FILE) || fs.existsSync(AGENTB_ENV)) {
    console.error(chalk.red('❌ A2A appears to be set up already'));
    console.log(chalk.yellow(`   Found ${fs.existsSync(A2A_STATE_FILE) ? A2A_STATE_FILE : AGENTB_ENV}.`));
    console.log(chalk.yellow('   Run `pnpm run cleanup:a2a` first if you want to recreate it.\n'));
    process.exit(1);
  }

  // Read existing config.
  let agent0Env: Record<string, string>;
  let todo0McpEnv: Record<string, string>;
  try {
    agent0Env = loadEnvFile(AGENT0_ENV);
    todo0McpEnv = loadEnvFile(TODO0_MCP_ENV);
  } catch (err: any) {
    console.error(chalk.red(`❌ ${err.message}`));
    process.exit(1);
  }

  const oktaDomain = agent0Env.OKTA_DOMAIN;
  const agent0AgentId = agent0Env.AI_AGENT_ID;
  const mcpAuthServerId = authServerIdFromIssuer(agent0Env.MCP_AUTHORIZATION_SERVER || '');
  const mcpAudience = todo0McpEnv.MCP_EXPECTED_AUDIENCE;
  const mcpScopes = (agent0Env.AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST ||
    'mcp:connect mcp:tools:read mcp:tools:manage').split(/\s+/).filter(Boolean);

  if (!oktaDomain || !agent0AgentId || !mcpAuthServerId || !mcpAudience) {
    console.error(chalk.red('❌ Could not read existing config'));
    console.log(chalk.yellow('   Need OKTA_DOMAIN, AI_AGENT_ID, MCP_AUTHORIZATION_SERVER (agent0/.env.agent) and MCP_EXPECTED_AUDIENCE (todo0/.env.mcp).'));
    process.exit(1);
  }

  console.log('Detected existing config:');
  console.log(chalk.gray(`  Okta domain:   ${oktaDomain}`));
  console.log(chalk.gray(`  agent0 agent:  ${agent0AgentId}`));
  console.log(chalk.gray(`  todo0 MCP AS:  ${mcpAuthServerId}`));
  console.log(chalk.gray(`  todo0 audience:${mcpAudience}\n`));

  const answers = await prompts([
    {
      type: 'password',
      name: 'oktaApiToken',
      message: 'Enter your Okta API token:',
      validate: (v) => (v ? true : 'API token is required'),
    },
    {
      type: 'select',
      name: 'ownerSetupMethod',
      message: 'Method for setting Agent B owner?',
      choices: [
        { title: 'Standard API (Governance)', value: 'standard' },
        { title: 'Developer API (Local Dev)', value: 'developer' },
      ],
      initial: 0,
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Create A2A resources (Agent B, A2A AS, delegation link, connections)?',
      initial: false,
    },
  ]);

  if (!answers.confirm) {
    console.log(chalk.yellow('\n⚠️  Cancelled\n'));
    process.exit(0);
  }

  const oktaClient = new OktaAPIClient({ orgUrl: `https://${oktaDomain}`, token: answers.oktaApiToken });
  const agentClient = new AgentIdentityAPIClient({ oktaDomain, apiToken: answers.oktaApiToken });

  const state = emptyState();
  state.oktaDomain = oktaDomain;

  const spinner = ora('Resolving org + todo0 MCP policy...').start();
  try {
    const [orgMetadata, currentUser] = await Promise.all([
      agentClient.getOrgMetadata(),
      agentClient.getCurrentUser(),
    ]);
    state.orgId = orgMetadata.id;

    const todo0McpPolicyId = await oktaClient.getPolicyIdByName(mcpAuthServerId, TODO0_MCP_POLICY_NAME);
    if (!todo0McpPolicyId) {
      throw new Error(`Could not find policy "${TODO0_MCP_POLICY_NAME}" on MCP AS ${mcpAuthServerId}`);
    }

    spinner.text = 'Provisioning A2A resources...';
    const a2aConfig = await provisionA2A({
      oktaClient,
      agentClient,
      oktaDomain,
      ownerSetupMethod: answers.ownerSetupMethod,
      orgId: orgMetadata.id,
      currentUserId: currentUser.id,
      agent0AgentId,
      todo0McpAuthServerId: mcpAuthServerId,
      todo0McpPolicyId,
      mcpAudience,
      mcpScopes,
      // Persist created resources incrementally into the A2A-only state file so
      // a partial failure can still be cleaned up by `cleanup:a2a`.
      record: (updates) => {
        if (updates.agentIdentityIds) state.agentIdentityIds.push(...updates.agentIdentityIds);
        if (updates.a2aAuthServerIds) state.a2aAuthServerIds.push(...updates.a2aAuthServerIds);
        if (updates.delegationLinkIds) state.delegationLinkIds.push(...updates.delegationLinkIds);
        if (updates.agentConnections) state.agentConnections.push(...updates.agentConnections);
        writeState(state);
      },
      log: (msg) => { spinner.text = msg; },
    });

    spinner.succeed(`A2A resources created — Agent B: ${chalk.cyan(a2aConfig.agentbAgentId)}`);

    // ── Write env: append A2A section to agent0/.env.agent, write agentb env ──
    // Copy agent0's LLM creds so Agent B is itself an LLM-powered agent.
    let llmConfig: LLMConfig = { provider: 'skip' };
    if (agent0Env.ANTHROPIC_API_KEY) {
      llmConfig = {
        provider: 'anthropic',
        apiKey: agent0Env.ANTHROPIC_API_KEY,
        model: agent0Env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      };
    } else if (agent0Env.AWS_ACCESS_KEY_ID && agent0Env.AWS_SECRET_ACCESS_KEY) {
      llmConfig = {
        provider: 'bedrock',
        region: agent0Env.AWS_REGION || 'us-east-1',
        accessKeyId: agent0Env.AWS_ACCESS_KEY_ID,
        secretAccessKey: agent0Env.AWS_SECRET_ACCESS_KEY,
        sessionToken: agent0Env.AWS_SESSION_TOKEN || undefined,
        modelId: agent0Env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      };
    }

    const envConfig = { oktaDomain, mcpAuthServerId, mcpAudience, a2a: a2aConfig, llmConfig } as BootstrapConfig;

    const agent0EnvPath = path.resolve(AGENT0_ENV);
    const existing = fs.readFileSync(agent0EnvPath, 'utf8');
    if (!existing.includes('A2A_SERVER_URL=')) {
      fs.appendFileSync(agent0EnvPath, generateAgent0A2ASection(envConfig));
      console.log(chalk.green(`✓ Appended A2A section to ${AGENT0_ENV}`));
    } else {
      console.log(chalk.yellow(`⚠ ${AGENT0_ENV} already has A2A_SERVER_URL — left untouched`));
    }

    writeEnvFile(AGENTB_ENV, generateAgentbEnv(envConfig));

    console.log(chalk.bold.green('\n✅ A2A setup complete!\n'));
    console.log(`  Agent B:    ${a2aConfig.agentbAgentId}`);
    console.log(`  A2A AS:     ${a2aConfig.a2aAuthServerId}`);
    console.log(`  State file: ${A2A_STATE_FILE} (used by \`pnpm run cleanup:a2a\`)\n`);
    console.log('Next:');
    console.log(`  ${chalk.cyan('pnpm build && pnpm run dev')}  → Agent B starts on port ${a2aConfig.agentbPort}`);
    console.log(`  Then: "ask the task agent to add a todo" in the agent0 chat.\n`);
    console.log(chalk.gray('To remove ONLY the A2A resources later: `pnpm run cleanup:a2a`\n'));
  } catch (error: any) {
    spinner.fail(`A2A setup failed: ${error.message}`);
    console.log(chalk.yellow(`\n⚠️  Partial resources may exist. Run \`pnpm run cleanup:a2a\` to remove them.\n`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
