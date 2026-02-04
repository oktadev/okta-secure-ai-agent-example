#!/usr/bin/env node
/**
 * link-opa-secrets.ts - Link OPA secrets to Agent
 *
 * This script creates STS_VAULT_SECRET connections between the agent
 * and OPA vault secrets, enabling token exchange for secret retrieval.
 *
 * Prerequisites:
 * 1. Run bootstrap:okta first (creates agent)
 * 2. Run setup:opa first (creates secrets in OPA vault)
 *
 * Flow:
 * 1. Read agent from rollback state
 * 2. Read secret IDs from .env.opa
 * 3. Get Okta org ID
 * 4. Construct secret ORNs
 * 5. Create STS_VAULT_SECRET connections
 * 6. Update .env.opa with full ORNs
 */

import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  AgentIdentityAPIClient,
  constructPamSecretORN,
} from './lib/agent-identity-api.js';
import {
  loadRollbackState,
  updateRollbackState,
  RollbackState,
} from './lib/state-manager.js';

// ============================================================================
// Types
// ============================================================================

interface OpaConfig {
  llmProvider: 'anthropic' | 'bedrock';
  secrets: Array<{
    name: string;
    envVar: string;
    secretId: string;
    ornEnvVar: string;
  }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Load and parse .env.opa file
 */
function loadOpaEnv(): Record<string, string> {
  const envPath = path.resolve('packages/agent0/.env.opa');

  if (!fs.existsSync(envPath)) {
    throw new Error(
      `.env.opa not found at ${envPath}\n` +
      'Run bootstrap:okta with OPA mode first, then setup:opa to create secrets.'
    );
  }

  const envConfig = dotenv.parse(fs.readFileSync(envPath));
  return envConfig;
}

/**
 * Parse OPA configuration from environment
 */
function parseOpaConfig(env: Record<string, string>): OpaConfig {
  const llmProvider = env.OPA_LLM_PROVIDER as 'anthropic' | 'bedrock';

  if (!llmProvider || (llmProvider !== 'anthropic' && llmProvider !== 'bedrock')) {
    throw new Error(
      'OPA_LLM_PROVIDER not set or invalid in .env.opa\n' +
      'Expected: anthropic or bedrock'
    );
  }

  const secrets: OpaConfig['secrets'] = [];

  if (llmProvider === 'anthropic') {
    // Look for Anthropic secret IDs
    const apiKeySecretId = env.OPA_SECRET_ANTHROPIC_API_KEY;
    const modelSecretId = env.OPA_SECRET_ANTHROPIC_MODEL;

    if (!apiKeySecretId) {
      throw new Error(
        'OPA_SECRET_ANTHROPIC_API_KEY not found in .env.opa\n' +
        'Run setup:opa first to create secrets and get their IDs.'
      );
    }

    secrets.push({
      name: 'Anthropic API Key',
      envVar: 'OPA_SECRET_ANTHROPIC_API_KEY',
      secretId: apiKeySecretId,
      ornEnvVar: 'OPA_ANTHROPIC_API_KEY_ORN',
    });

    if (modelSecretId) {
      secrets.push({
        name: 'Anthropic Model',
        envVar: 'OPA_SECRET_ANTHROPIC_MODEL',
        secretId: modelSecretId,
        ornEnvVar: 'OPA_ANTHROPIC_MODEL_ORN',
      });
    }
  } else if (llmProvider === 'bedrock') {
    // Look for Bedrock secret IDs
    const accessKeySecretId = env.OPA_SECRET_AWS_ACCESS_KEY_ID;
    const secretKeySecretId = env.OPA_SECRET_AWS_SECRET_ACCESS_KEY;
    const sessionTokenSecretId = env.OPA_SECRET_AWS_SESSION_TOKEN;

    if (!accessKeySecretId || !secretKeySecretId) {
      throw new Error(
        'OPA_SECRET_AWS_ACCESS_KEY_ID and OPA_SECRET_AWS_SECRET_ACCESS_KEY not found in .env.opa\n' +
        'Run setup:opa first to create secrets and get their IDs.'
      );
    }

    secrets.push({
      name: 'AWS Access Key ID',
      envVar: 'OPA_SECRET_AWS_ACCESS_KEY_ID',
      secretId: accessKeySecretId,
      ornEnvVar: 'OPA_AWS_ACCESS_KEY_ORN',
    });

    secrets.push({
      name: 'AWS Secret Access Key',
      envVar: 'OPA_SECRET_AWS_SECRET_ACCESS_KEY',
      secretId: secretKeySecretId,
      ornEnvVar: 'OPA_AWS_SECRET_ACCESS_KEY_ORN',
    });

    if (sessionTokenSecretId) {
      secrets.push({
        name: 'AWS Session Token',
        envVar: 'OPA_SECRET_AWS_SESSION_TOKEN',
        secretId: sessionTokenSecretId,
        ornEnvVar: 'OPA_AWS_SESSION_TOKEN_ORN',
      });
    }
  }

  return { llmProvider, secrets };
}

/**
 * Update .env.opa file with ORN values
 */
function updateOpaEnvWithOrns(
  ornMappings: Array<{ envVar: string; orn: string }>
): void {
  const envPath = path.resolve('packages/agent0/.env.opa');
  let content = fs.readFileSync(envPath, 'utf-8');

  for (const { envVar, orn } of ornMappings) {
    // Check if the variable already exists (commented or not)
    const commentedRegex = new RegExp(`^#\\s*${envVar}=.*$`, 'm');
    const uncommentedRegex = new RegExp(`^${envVar}=.*$`, 'm');

    if (uncommentedRegex.test(content)) {
      // Update existing uncommented line
      content = content.replace(uncommentedRegex, `${envVar}=${orn}`);
    } else if (commentedRegex.test(content)) {
      // Uncomment and update
      content = content.replace(commentedRegex, `${envVar}=${orn}`);
    } else {
      // Add new line before the last empty line or at end
      const lines = content.split('\n');
      const insertIndex = lines.findIndex(line => line.startsWith('# Optional') || line.startsWith('# Non-secret'));
      if (insertIndex > 0) {
        lines.splice(insertIndex, 0, `${envVar}=${orn}`);
        content = lines.join('\n');
      } else {
        content = content.trimEnd() + `\n${envVar}=${orn}\n`;
      }
    }
  }

  fs.writeFileSync(envPath, content, { mode: 0o600 });
}

// ============================================================================
// Main
// ============================================================================

async function linkOpaSecrets(): Promise<void> {
  console.log(chalk.bold.blue('\n🔗 Link OPA Secrets to Agent\n'));
  console.log('This script connects your agent to OPA vault secrets.');
  console.log('Prerequisites:');
  console.log('  1. bootstrap:okta completed (agent exists)');
  console.log('  2. setup:opa completed (secrets created in OPA)\n');

  // Step 1: Load rollback state to get agent
  console.log(chalk.bold('Step 1: Loading configuration...'));

  let rollbackState: RollbackState;
  try {
    const tempState = loadRollbackState('');
    if (!tempState.agentIdentityIds || tempState.agentIdentityIds.length === 0) {
      throw new Error('No agent found');
    }
    rollbackState = tempState;
  } catch {
    console.error(chalk.red('\n❌ No agent found in rollback state.'));
    console.error(chalk.yellow('   Run bootstrap:okta first to create the agent.\n'));
    process.exit(1);
  }

  const agentId = rollbackState.agentIdentityIds[0];
  const oktaDomain = rollbackState.oktaDomain;

  console.log(chalk.gray(`   Agent ID: ${agentId}`));
  console.log(chalk.gray(`   Okta Domain: ${oktaDomain}`));

  // Step 2: Load OPA configuration
  let opaEnv: Record<string, string>;
  let opaConfig: OpaConfig;

  try {
    opaEnv = loadOpaEnv();
    opaConfig = parseOpaConfig(opaEnv);
  } catch (error: any) {
    console.error(chalk.red(`\n❌ ${error.message}\n`));
    process.exit(1);
  }

  console.log(chalk.gray(`   LLM Provider: ${opaConfig.llmProvider}`));
  console.log(chalk.gray(`   Secrets to link: ${opaConfig.secrets.length}`));

  // Step 3: Prompt for API token
  console.log(chalk.bold('\nStep 2: Authentication'));

  const authAnswers = await prompts([
    {
      type: 'password',
      name: 'apiToken',
      message: 'Enter your Okta API token:',
      validate: (v) => !!v || 'API token is required',
    },
  ]);

  if (!authAnswers.apiToken) {
    console.log(chalk.yellow('\nSetup cancelled.\n'));
    process.exit(0);
  }

  const agentClient = new AgentIdentityAPIClient({
    oktaDomain,
    apiToken: authAnswers.apiToken,
  });

  // Step 4: Get org ID (from rollback state or API)
  console.log(chalk.bold('\nStep 3: Getting organization ID...'));
  let spinner: ReturnType<typeof ora>;

  let orgId: string;
  if (rollbackState.orgId) {
    // Use cached org ID from bootstrap
    orgId = rollbackState.orgId;
    console.log(chalk.gray(`   Org ID: ${orgId} (from bootstrap state)`));
  } else {
    // Fallback: fetch from API (older bootstrap state)
    spinner = ora('Fetching org metadata...').start();
    try {
      const orgMetadata = await agentClient.getOrgMetadata();
      orgId = orgMetadata.id;
      spinner.succeed(`Org ID: ${chalk.cyan(orgId)}`);

      // Save for future use
      updateRollbackState(rollbackState, { orgId });
    } catch (error: any) {
      spinner.fail('Failed to get org metadata');
      console.error(chalk.red(`   ${error.message}\n`));
      process.exit(1);
    }
  }

  // Step 5: Check existing connections
  console.log(chalk.bold('\nStep 4: Checking existing connections...'));
  spinner = ora('Listing agent connections...').start();

  let existingConnections: Awaited<ReturnType<typeof agentClient.listConnections>>;
  try {
    existingConnections = await agentClient.listConnections(agentId);
    spinner.succeed(`Found ${existingConnections.length} existing connection(s)`);
  } catch (error: any) {
    spinner.fail('Failed to list connections');
    console.error(chalk.red(`   ${error.message}\n`));
    process.exit(1);
  }

  // Build set of existing secret ORNs
  const existingSecretOrns = new Set(
    existingConnections
      .filter(c => c.connectionType === 'STS_VAULT_SECRET' && c.resource?.orn)
      .map(c => c.resource!.orn)
  );

  // Step 6: Create connections
  console.log(chalk.bold('\nStep 5: Creating vault secret connections...'));

  const ornMappings: Array<{ envVar: string; orn: string }> = [];
  const newConnections: Array<{ agentId: string; connectionId: string }> = [];

  for (const secret of opaConfig.secrets) {
    const secretOrn = constructPamSecretORN(orgId, secret.secretId);
    ornMappings.push({ envVar: secret.ornEnvVar, orn: secretOrn });

    spinner = ora(`Linking ${secret.name}...`).start();

    // Check if connection already exists
    if (existingSecretOrns.has(secretOrn)) {
      spinner.warn(`${secret.name} already linked (skipped)`);
      continue;
    }

    try {
      const connection = await agentClient.createVaultSecretConnection(agentId, secretOrn);
      newConnections.push({ agentId, connectionId: connection.id });
      spinner.succeed(`${secret.name} linked: ${chalk.cyan(connection.id)}`);
    } catch (error: any) {
      spinner.fail(`Failed to link ${secret.name}`);
      console.error(chalk.red(`   ${error.message}`));

      // Continue with other secrets
      continue;
    }
  }

  // Step 7: Update rollback state
  if (newConnections.length > 0) {
    console.log(chalk.bold('\nStep 6: Updating rollback state...'));
    spinner = ora('Saving connection info...').start();

    try {
      updateRollbackState(rollbackState, {
        agentConnections: newConnections,
      });
      spinner.succeed('Rollback state updated');
    } catch (error: any) {
      spinner.warn(`Failed to update rollback state: ${error.message}`);
    }
  }

  // Step 8: Update .env.opa with ORNs
  console.log(chalk.bold('\nStep 7: Updating .env.opa with ORNs...'));
  spinner = ora('Writing ORNs to .env.opa...').start();

  try {
    updateOpaEnvWithOrns(ornMappings);
    spinner.succeed('.env.opa updated with secret ORNs');
  } catch (error: any) {
    spinner.fail(`Failed to update .env.opa: ${error.message}`);
  }

  // Summary
  console.log(chalk.bold.green('\n✅ OPA Secret Linking Complete!\n'));

  console.log('Secret ORNs configured:');
  for (const { envVar, orn } of ornMappings) {
    console.log(chalk.gray(`  ${envVar}=`));
    console.log(chalk.cyan(`    ${orn}`));
  }

  console.log(chalk.bold('\nNext steps:'));
  console.log(`  ${chalk.cyan('pnpm run dev')} - Start all services`);
  console.log(chalk.gray('\n  LLM credentials will be fetched from OPA per user session.\n'));
}

// Run
linkOpaSecrets().catch((error) => {
  console.error(chalk.red('\nFatal error:'), error);
  process.exit(1);
});
