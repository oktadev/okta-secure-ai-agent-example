#!/usr/bin/env node
/**
 * setup-opa-secrets.ts - One-time setup for OPA secrets management
 *
 * This script implements the simplified 2-user architecture:
 * 1. Setup Admin (your human token) - Creates all infrastructure, then discarded
 * 2. Runtime User - Minimal permissions, used by your app to read secrets
 *
 * Flow:
 * 1. Human provides bearer token (from browser DevTools)
 * 2. Script creates resource group, project, folder
 * 3. Script creates runtime service user with minimal permissions
 * 4. Script stores secrets
 * 5. Script outputs runtime credentials for your app
 */

import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { OPAClient, createOPAClientFromCredentials } from './lib/opa-api.js';

// ============================================================================
// Configuration
// ============================================================================

interface SetupConfig {
  baseUrl: string;
  teamName: string;
  adminToken: string;
  resourceGroupName: string;
  projectName: string;
  folderName: string;
  runtimeUserName: string;
  secrets: Array<{ name: string; value: string; description?: string }>;
}

interface SetupResult {
  resourceGroupId: string;
  projectId: string;
  folderId: string;
  runtimeCredentials: {
    userName: string;
    keyId: string;
    keySecret: string | undefined;
  };
  secretIds: Record<string, string>;
}

// ============================================================================
// Setup Functions
// ============================================================================

async function runSetup(config: SetupConfig): Promise<SetupResult> {
  const client = new OPAClient({
    baseUrl: config.baseUrl,
    teamName: config.teamName,
    token: config.adminToken,
  });

  let spinner = ora();

  // Step 1: Create Runtime Service User FIRST
  spinner = ora('Creating runtime service user...').start();
  let runtimeUser;
  try {
    runtimeUser = await client.getServiceUser(config.runtimeUserName);
    spinner.warn(`Runtime user already exists: ${chalk.cyan(runtimeUser.name)}`);
  } catch {
    runtimeUser = await client.createServiceUser(config.runtimeUserName);
    spinner.succeed(`Runtime user created: ${chalk.cyan(runtimeUser.name)}`);
  }

  // Step 2: Create group for runtime user
  const groupName = `${config.runtimeUserName}-group`;
  spinner = ora('Creating group for runtime user...').start();
  const group = await client.getOrCreateGroup(groupName, ['end_user']);
  spinner.succeed(`Group: ${chalk.cyan(group.name)} (${group.id})`);

  // Step 3: Add runtime user to group
  spinner = ora('Adding runtime user to group...').start();
  try {
    await client.addUserToGroup(groupName, config.runtimeUserName);
    spinner.succeed('Runtime user added to group');
  } catch {
    spinner.warn('Runtime user may already be in group');
  }

  // Step 4: Create Resource Group
  spinner = ora('Creating resource group...').start();
  const resourceGroup = await client.getOrCreateResourceGroup(
    config.resourceGroupName,
    'Resource group for application secrets',
    [{ id: group.id }]
  );
  spinner.succeed(`Resource group: ${chalk.cyan(resourceGroup.name)} (${resourceGroup.id})`);

  // Step 5: Create Project
  spinner = ora('Creating project...').start();
  const project = await client.getOrCreateProject(resourceGroup.id, config.projectName);
  spinner.succeed(`Project: ${chalk.cyan(project.name)} (${project.id})`);

  // Step 6: Create Secret Folder
  spinner = ora('Creating secret folder...').start();
  const folder = await client.getOrCreateSecretFolder(
    resourceGroup.id,
    project.id,
    config.folderName,
    'Folder for application secrets'
  );
  spinner.succeed(`Folder: ${chalk.cyan(folder.name)} (${folder.id})`);

  // Step 7: Create API key for runtime user
  spinner = ora('Checking for existing API keys...').start();
  const existingKeys = await client.listServiceUserKeys(config.runtimeUserName);

  let keyId: string;
  let keySecret: string | undefined;

  if (existingKeys.length > 0) {
    spinner.warn(`API key already exists (${existingKeys.length} key(s)).`);
    const keyAction = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do with API keys?',
      choices: [
        { title: 'Keep existing (use saved credentials)', value: 'keep' },
        { title: 'Create new key (keep old keys)', value: 'add' },
        { title: 'Rotate (delete all old keys, create new)', value: 'rotate' },
      ],
      initial: 0,
    });

    if (keyAction.action === 'rotate') {
      spinner = ora(`Deleting ${existingKeys.length} old key(s)...`).start();
      for (const oldKey of existingKeys) {
        await client.deleteServiceUserKey(config.runtimeUserName, oldKey.id);
      }
      spinner.succeed(`Deleted ${existingKeys.length} old key(s)`);

      spinner = ora('Creating new API key...').start();
      const newKey = await client.rotateServiceUserKeys(config.runtimeUserName);
      keyId = newKey.id;
      keySecret = newKey.secret;
      spinner.succeed(`New API key created: ${chalk.cyan(keyId)}`);
    } else if (keyAction.action === 'add') {
      spinner = ora('Creating additional API key...').start();
      const newKey = await client.rotateServiceUserKeys(config.runtimeUserName);
      keyId = newKey.id;
      keySecret = newKey.secret;
      spinner.succeed(`New API key created: ${chalk.cyan(keyId)} (old keys still valid)`);
    } else {
      spinner.info('Keeping existing keys.');
      keyId = existingKeys[0]!.id;
      keySecret = undefined;
    }
  } else {
    spinner = ora('Creating API key for runtime user...').start();
    const newKey = await client.rotateServiceUserKeys(config.runtimeUserName);
    if (!newKey.secret) {
      throw new Error('Failed to get API key secret');
    }
    keyId = newKey.id;
    keySecret = newKey.secret;
    spinner.succeed(`API key created: ${chalk.cyan(keyId)}`);
  }

  // Step 8: Create security policy
  spinner = ora('Creating security policy...').start();
  const policyName = `${config.runtimeUserName}-secrets-policy`;
  const rules = [
    {
      name: 'Allow secret access',
      resource_type: 'secret_based_resource' as const,
      resource_selector: {
        selectors: [
          {
            selector_type: 'secret_folder',
            selector: {
              secret_folder: { id: folder.id },
            },
          },
        ],
      },
      privileges: [
        {
          privilege_type: 'secret' as const,
          privilege_value: {
            list: true,
            secret_reveal: true,
            secret_create: true,
            secret_update: true,
            secret_delete: false,
            folder_create: true,
            folder_update: true,
            folder_delete: false,
          },
        },
      ],
    },
  ];

  try {
    await client.createSecurityPolicy(
      policyName,
      { user_groups: [{ id: group.id }] },
      rules,
      true,
      `Security policy for ${config.runtimeUserName} to access secrets`
    );
    spinner.succeed(`Security policy created: ${chalk.cyan(policyName)}`);
  } catch (error: unknown) {
    const err = error as { response?: { status?: number } };
    if (err.response?.status === 409) {
      spinner.warn('Security policy already exists');
    } else {
      throw error;
    }
  }

  // Step 9: Store secrets using runtime user credentials
  const secretIds: Record<string, string> = {};

  if (!keySecret) {
    console.log(chalk.yellow('\nCannot store secrets without the runtime user API key secret.'));
    console.log(chalk.yellow('Re-run setup and create a new API key to store secrets.\n'));
  } else {
    spinner = ora('Authenticating as runtime user...').start();
    const runtimeClient = await createOPAClientFromCredentials(
      config.baseUrl,
      config.teamName,
      keyId,
      keySecret
    );
    spinner.succeed('Authenticated as runtime user');

    for (const secretConfig of config.secrets) {
      spinner = ora(`Storing secret: ${secretConfig.name}...`).start();
      try {
        const secret = await runtimeClient.createSecretWithEncryption(
          resourceGroup.id,
          project.id,
          secretConfig.name,
          secretConfig.value,
          folder.id,
          secretConfig.description
        );
        secretIds[secretConfig.name] = secret.id;
        spinner.succeed(`Secret stored: ${chalk.cyan(secretConfig.name)}`);
      } catch (error: unknown) {
        const err = error as { response?: { status?: number; data?: { message?: string } } };
        if (err.response?.status === 409) {
          spinner.warn(`Secret already exists: ${chalk.cyan(secretConfig.name)}`);

          const existing = await runtimeClient.getSecretByName(
            resourceGroup.id,
            project.id,
            secretConfig.name,
            folder.id
          );

          if (existing) {
            // Debug: show the secret structure we got
            const existingAny = existing as unknown as Record<string, unknown>;
            console.log(chalk.gray(`\n  Debug: Found secret with id=${existing.id}`));
            if (existingAny.secret_id) {
              console.log(chalk.gray(`  Debug: Also has secret_id=${existingAny.secret_id}`));
            }

            const updateChoice = await prompts({
              type: 'confirm',
              name: 'update',
              message: `Update existing secret "${secretConfig.name}"?`,
              initial: true,
            });

            if (updateChoice.update) {
              spinner = ora(`Updating secret: ${secretConfig.name}...`).start();

              // Use secret_id if available, otherwise fall back to id
              const secretIdToUse = (existingAny.secret_id as string) || existing.id;

              try {
                await runtimeClient.updateSecretWithEncryption(
                  resourceGroup.id,
                  project.id,
                  secretIdToUse,
                  secretConfig.name,       // name (required for PUT)
                  secretConfig.value,
                  folder.id,               // parent_folder_id (required for PUT)
                  secretConfig.description,
                  'secret'                 // keyName
                );
                secretIds[secretConfig.name] = existing.id;
                spinner.succeed(`Secret updated: ${chalk.cyan(secretConfig.name)}`);
              } catch (updateError: unknown) {
                spinner.fail(`Failed to update secret: ${secretConfig.name}`);
                const ue = updateError as { message?: string };
                console.log(chalk.yellow(`\n  Update failed: ${ue.message}`));
                console.log(chalk.yellow('  The secret exists but cannot be updated via API.'));
                console.log(chalk.yellow('  Options:'));
                console.log(chalk.yellow('    1. Delete the secret manually in the OPA dashboard and re-run setup'));
                console.log(chalk.yellow('    2. Keep the existing secret value'));

                const keepExisting = await prompts({
                  type: 'confirm',
                  name: 'keep',
                  message: 'Keep existing secret and continue?',
                  initial: true,
                });

                if (keepExisting.keep) {
                  secretIds[secretConfig.name] = existing.id;
                  console.log(chalk.green(`  Keeping existing secret: ${secretConfig.name}`));
                } else {
                  throw updateError;
                }
              }
            } else {
              secretIds[secretConfig.name] = existing.id;
            }
          }
        } else {
          spinner.fail(`Failed to store secret: ${secretConfig.name}`);
          throw error;
        }
      }
    }
  }

  return {
    resourceGroupId: resourceGroup.id,
    projectId: project.id,
    folderId: folder.id,
    runtimeCredentials: {
      userName: config.runtimeUserName,
      keyId,
      keySecret,
    },
    secretIds,
  };
}

// ============================================================================
// Interactive Setup
// ============================================================================

async function interactiveSetup(): Promise<void> {
  console.log(chalk.bold.blue('\n=== OPA Secrets Setup ===\n'));
  console.log('This script will:');
  console.log('  1. Create resource group, project, and folder');
  console.log('  2. Create a runtime service user with minimal permissions');
  console.log('  3. Store your secrets');
  console.log('  4. Output credentials for agent0\n');

  console.log(chalk.yellow('PREREQUISITE: You need a bearer token from the OPA dashboard.'));
  console.log(chalk.gray('  1. Log into your OPA dashboard'));
  console.log(chalk.gray('  2. Open DevTools (F12) -> Network tab'));
  console.log(chalk.gray('  3. Look for any API call and copy the Authorization header value'));
  console.log(chalk.gray('  4. Remove "Bearer " prefix if present\n'));

  const opaConfig = await prompts([
    {
      type: 'text',
      name: 'baseUrl',
      message: 'OPA Base URL:',
      initial: process.env.OPA_BASE_URL || 'https://your-team.pam.okta.com',
      validate: (v) => v.startsWith('https://') || 'Must start with https://',
    },
    {
      type: 'text',
      name: 'teamName',
      message: 'Team Name:',
      initial: process.env.OPA_TEAM_NAME || '',
      validate: (v) => !!v || 'Required',
    },
    {
      type: 'password',
      name: 'adminToken',
      message: 'Admin Bearer Token (from browser):',
      validate: (v) => !!v || 'Required',
    },
  ]);

  if (!opaConfig.baseUrl || !opaConfig.teamName || !opaConfig.adminToken) {
    console.log(chalk.yellow('\nSetup cancelled.'));
    return;
  }

  // Test connection
  const testSpinner = ora('Testing connection...').start();
  try {
    const client = new OPAClient({
      baseUrl: opaConfig.baseUrl,
      teamName: opaConfig.teamName,
      token: opaConfig.adminToken,
    });
    await client.listResourceGroups();
    testSpinner.succeed('Connection successful');
  } catch (error: unknown) {
    testSpinner.fail('Connection failed');
    const err = error as { response?: { data?: { message?: string } }; message?: string };
    console.error(chalk.red(`Error: ${err.response?.data?.message || err.message}`));
    return;
  }

  const resourceConfig = await prompts([
    {
      type: 'text',
      name: 'resourceGroupName',
      message: 'Resource Group Name:',
      initial: 'app-secrets',
    },
    {
      type: 'text',
      name: 'projectName',
      message: 'Project Name:',
      initial: 'credentials',
    },
    {
      type: 'text',
      name: 'folderName',
      message: 'Folder Name:',
      initial: 'llm-keys',
    },
    {
      type: 'text',
      name: 'runtimeUserName',
      message: 'Runtime Service User Name:',
      initial: 'svc-app-runtime',
    },
  ]);

  // Collect secrets
  console.log(chalk.bold('\nSecrets to store:'));
  const secrets: Array<{ name: string; value: string; description?: string }> = [];
  let addMore = true;

  while (addMore) {
    const secretInput = await prompts([
      {
        type: 'text',
        name: 'name',
        message: 'Secret name (e.g., ANTHROPIC_API_KEY):',
        validate: (v) => !!v || 'Required',
      },
      {
        type: 'password',
        name: 'value',
        message: 'Secret value:',
        validate: (v) => !!v || 'Required',
      },
      {
        type: 'text',
        name: 'description',
        message: 'Description (optional):',
      },
      {
        type: 'confirm',
        name: 'addMore',
        message: 'Add another secret?',
        initial: false,
      },
    ]);

    if (secretInput.name && secretInput.value) {
      secrets.push({
        name: secretInput.name,
        value: secretInput.value,
        description: secretInput.description || undefined,
      });
    }
    addMore = secretInput.addMore;
  }

  if (secrets.length === 0) {
    console.log(chalk.yellow('\nNo secrets to store. Setup cancelled.'));
    return;
  }

  console.log(chalk.bold('\nRunning setup...\n'));

  try {
    const result = await runSetup({
      baseUrl: opaConfig.baseUrl,
      teamName: opaConfig.teamName,
      adminToken: opaConfig.adminToken,
      resourceGroupName: resourceConfig.resourceGroupName,
      projectName: resourceConfig.projectName,
      folderName: resourceConfig.folderName,
      runtimeUserName: resourceConfig.runtimeUserName,
      secrets,
    });

    console.log(chalk.bold.green('\n=== Setup Complete ===\n'));

    console.log(chalk.bold('Resource IDs:'));
    console.log(`  Resource Group: ${result.resourceGroupId}`);
    console.log(`  Project:        ${result.projectId}`);
    console.log(`  Folder:         ${result.folderId}`);

    console.log(chalk.bold('\nSecret IDs:'));
    for (const [name, id] of Object.entries(result.secretIds)) {
      console.log(`  ${name}: ${id}`);
    }

    if (result.runtimeCredentials.keySecret) {
      console.log(chalk.bold.yellow('\n=== RUNTIME CREDENTIALS (SAVE THESE!) ===\n'));
      console.log(chalk.red('These credentials will NOT be shown again!\n'));

      const saveOption = await prompts({
        type: 'confirm',
        name: 'save',
        message: 'Save credentials to packages/agent0/.env.opa?',
        initial: true,
      });

      if (saveOption.save) {
        const envContent = `# OPA Runtime Credentials
# Generated: ${new Date().toISOString()}
# WARNING: Keep this file secure!

OPA_BASE_URL=${opaConfig.baseUrl}
OPA_TEAM_NAME=${opaConfig.teamName}
OPA_RESOURCE_GROUP_ID=${result.resourceGroupId}
OPA_PROJECT_ID=${result.projectId}
OPA_FOLDER_ID=${result.folderId}
OPA_RUNTIME_USER=${result.runtimeCredentials.userName}
OPA_KEY_ID=${result.runtimeCredentials.keyId}
OPA_KEY_SECRET=${result.runtimeCredentials.keySecret}

# Secret IDs
${Object.entries(result.secretIds).map(([name, id]) => `OPA_SECRET_${name}=${id}`).join('\n')}

# LLM Provider Configuration
OPA_LLM_PROVIDER=anthropic
OPA_ANTHROPIC_SECRET_NAME=ANTHROPIC_API_KEY
`;

        const envPath = path.join(process.cwd(), 'packages/agent0/.env.opa');
        fs.writeFileSync(envPath, envContent, { mode: 0o600 });
        console.log(chalk.green(`\nCredentials saved to: ${envPath}`));
      } else {
        console.log(`OPA_BASE_URL=${opaConfig.baseUrl}`);
        console.log(`OPA_TEAM_NAME=${opaConfig.teamName}`);
        console.log(`OPA_RESOURCE_GROUP_ID=${result.resourceGroupId}`);
        console.log(`OPA_PROJECT_ID=${result.projectId}`);
        console.log(`OPA_FOLDER_ID=${result.folderId}`);
        console.log(`OPA_KEY_ID=${result.runtimeCredentials.keyId}`);
        console.log(`OPA_KEY_SECRET=${result.runtimeCredentials.keySecret}`);
      }
    } else {
      // No new key secret - user chose to keep existing keys
      console.log(chalk.yellow('\n=== EXISTING CREDENTIALS ===\n'));
      console.log(chalk.yellow('You chose to keep existing API keys.'));
      console.log(chalk.yellow('The key secret cannot be retrieved - only shown when first created.\n'));

      const updateEnvOption = await prompts({
        type: 'confirm',
        name: 'update',
        message: 'Update packages/agent0/.env.opa with resource IDs (without key secret)?',
        initial: false,
      });

      if (updateEnvOption.update) {
        // Check if existing .env.opa has the key secret
        const envPath = path.join(process.cwd(), 'packages/agent0/.env.opa');
        let existingKeySecret = '';

        if (fs.existsSync(envPath)) {
          const existingContent = fs.readFileSync(envPath, 'utf-8');
          const match = existingContent.match(/OPA_KEY_SECRET=(.+)/);
          if (match) {
            existingKeySecret = match[1]!;
            console.log(chalk.green('Found existing OPA_KEY_SECRET in .env.opa, preserving it.'));
          }
        }

        if (!existingKeySecret) {
          console.log(chalk.red('Warning: No existing OPA_KEY_SECRET found. You will need to add it manually.'));
          console.log(chalk.yellow('Tip: Re-run setup and choose "Rotate" to create a new API key.\n'));
        }

        const envContent = `# OPA Runtime Credentials
# Generated: ${new Date().toISOString()}
# WARNING: Keep this file secure!

OPA_BASE_URL=${opaConfig.baseUrl}
OPA_TEAM_NAME=${opaConfig.teamName}
OPA_RESOURCE_GROUP_ID=${result.resourceGroupId}
OPA_PROJECT_ID=${result.projectId}
OPA_FOLDER_ID=${result.folderId}
OPA_RUNTIME_USER=${result.runtimeCredentials.userName}
OPA_KEY_ID=${result.runtimeCredentials.keyId}
OPA_KEY_SECRET=${existingKeySecret || 'YOUR_KEY_SECRET_HERE'}

# Secret IDs
${Object.entries(result.secretIds).map(([name, id]) => `OPA_SECRET_${name}=${id}`).join('\n')}

# LLM Provider Configuration
OPA_LLM_PROVIDER=anthropic
OPA_ANTHROPIC_SECRET_NAME=ANTHROPIC_API_KEY
`;

        fs.writeFileSync(envPath, envContent, { mode: 0o600 });
        console.log(chalk.green(`\nCredentials saved to: ${envPath}`));
      } else {
        console.log(chalk.gray('\nResource IDs (for manual configuration):'));
        console.log(`  OPA_RESOURCE_GROUP_ID=${result.resourceGroupId}`);
        console.log(`  OPA_PROJECT_ID=${result.projectId}`);
        console.log(`  OPA_FOLDER_ID=${result.folderId}`);
        console.log(`  OPA_KEY_ID=${result.runtimeCredentials.keyId}`);
      }
    }

  } catch (error: unknown) {
    const err = error as { response?: { data?: { message?: string } }; message?: string };
    console.error(chalk.red(`\nSetup failed: ${err.response?.data?.message || err.message}`));
    process.exit(1);
  }
}

// ============================================================================
// Main
// ============================================================================

interactiveSetup().catch((error) => {
  console.error(chalk.red('Unexpected error:'), error);
  process.exit(1);
});
