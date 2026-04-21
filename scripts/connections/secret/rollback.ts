#!/usr/bin/env node
/**
 * rollback-opa-config.ts - Rollback OPA/PAM configuration
 *
 * This script undoes everything created by setup-opa-secrets.ts:
 * 1. Deletes secrets
 * 2. Deletes secret folder
 * 3. Deletes security policy
 * 4. Removes user from group
 * 5. Deletes group
 * 6. Deletes service user keys
 * 7. Deletes service user
 * 8. Deletes project
 * 9. Deletes resource group
 * 10. Deletes .env.opa file
 * 11. Deletes state file
 */

import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { OPAClient } from './lib/opa-api.js';
import {
  loadOPARollbackStateOnly,
  deleteOPARollbackState,
  type OPARollbackState,
} from './lib/opa-state-manager.js';


/**
 * Main rollback function
 */
async function rollback() {
  console.log(chalk.bold.red('\n🗑️  OPA/PAM Configuration Rollback\n'));
  console.log(chalk.yellow('⚠️  WARNING: This will delete OPA resources!\n'));

  // Load rollback state
  const state = loadOPARollbackStateOnly();
  if (!state) {
    console.error(chalk.red('❌ No OPA rollback state found'));
    console.log(chalk.yellow('\n💡 Rollback state is created during setup-opa-secrets'));
    console.log(chalk.yellow('   File: .opa-setup-state.json\n'));
    process.exit(1);
  }

  // Display resources to be deleted
  console.log('Resources to be deleted:');
  if (state.secretIds?.length > 0) {
    console.log(chalk.gray(`  • Secrets (${state.secretIds.length}): ${state.secretIds.map(s => s.name).join(', ')}`));
  }
  if (state.folderId) {
    console.log(chalk.gray(`  • Secret Folder: ${state.folderName || state.folderId}`));
  }
  if (state.securityPolicyName) {
    console.log(chalk.gray(`  • Security Policy: ${state.securityPolicyName}`));
  }
  if (state.groupName) {
    console.log(chalk.gray(`  • Group: ${state.groupName}`));
  }
  if (state.serviceUserName) {
    console.log(chalk.gray(`  • Service User: ${state.serviceUserName}`));
  }
  if (state.serviceUserKeyIds?.length > 0) {
    console.log(chalk.gray(`  • Service User Keys (${state.serviceUserKeyIds.length})`));
  }
  if (state.projectId) {
    console.log(chalk.gray(`  • Project: ${state.projectName || state.projectId}`));
  }
  if (state.resourceGroupId) {
    console.log(chalk.gray(`  • Resource Group: ${state.resourceGroupName || state.resourceGroupId}`));
  }
  console.log('');

  // Prompt for bearer token
  console.log(chalk.yellow('PREREQUISITE: You need a bearer token from the OPA dashboard.'));
  console.log(chalk.gray('  1. Log into your OPA dashboard'));
  console.log(chalk.gray('  2. Open DevTools (F12) -> Network tab'));
  console.log(chalk.gray('  3. Look for any API call and copy the Authorization header value'));
  console.log(chalk.gray('  4. Remove "Bearer " prefix if present\n'));

  const answers = await prompts([
    {
      type: 'password',
      name: 'adminToken',
      message: 'Enter your OPA Bearer Token:',
      validate: (value) => (value ? true : 'Bearer token is required'),
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: chalk.red('Are you sure you want to delete these resources?'),
      initial: false,
    },
    {
      type: (prev) => (prev ? 'confirm' : null),
      name: 'doubleConfirm',
      message: chalk.red('This action cannot be undone. Continue?'),
      initial: false,
    },
  ]);

  if (!answers.confirm || !answers.doubleConfirm) {
    console.log(chalk.yellow('\n⚠️  Rollback cancelled\n'));
    process.exit(0);
  }

  // Test connection
  const testSpinner = ora('Testing connection...').start();
  let client: OPAClient;
  try {
    client = new OPAClient({
      baseUrl: state.baseUrl,
      teamName: state.teamName,
      token: answers.adminToken,
    });
    await client.listResourceGroups();
    testSpinner.succeed('Connection successful');
  } catch (error: unknown) {
    testSpinner.fail('Connection failed');
    const err = error as { response?: { data?: { message?: string } }; message?: string };
    console.error(chalk.red(`Error: ${err.response?.data?.message || err.message}`));
    process.exit(1);
  }

  let deletedCount = 0;
  let errorCount = 0;

  try {
    // Delete in reverse dependency order

    // Step 1: Delete Secrets (must be deleted before folder)
    if (state.secretIds && state.secretIds.length > 0 && state.resourceGroupId && state.projectId) {
      for (const secret of state.secretIds) {
        const spinner = ora(`Deleting secret: ${secret.name}...`).start();
        try {
          await client.deleteSecret(state.resourceGroupId, state.projectId, secret.id);
          spinner.succeed(`Secret deleted: ${secret.name}`);
          deletedCount++;
        } catch (error: unknown) {
          const err = error as { message?: string };
          spinner.fail(`Failed to delete secret ${secret.name}: ${err.message}`);
          errorCount++;
        }
      }
    }

    // Step 2: Delete Secret Folder
    if (state.folderId && state.resourceGroupId && state.projectId) {
      const spinner = ora(`Deleting secret folder: ${state.folderName || state.folderId}...`).start();
      try {
        await client.deleteSecretFolder(state.resourceGroupId, state.projectId, state.folderId);
        spinner.succeed(`Secret folder deleted: ${state.folderName || state.folderId}`);
        deletedCount++;
      } catch (error: unknown) {
        const err = error as { message?: string };
        spinner.fail(`Failed to delete secret folder: ${err.message}`);
        errorCount++;
      }
    }

    // Step 3: Delete Security Policy
    if (state.securityPolicyName) {
      const spinner = ora(`Deleting security policy: ${state.securityPolicyName}...`).start();
      try {
        // Find policy by name if we don't have the ID
        let policyId = state.securityPolicyId;
        if (!policyId) {
          const policy = await client.getSecurityPolicyByName(state.securityPolicyName);
          policyId = policy?.id;
        }
        if (policyId) {
          await client.deleteSecurityPolicy(policyId);
          spinner.succeed(`Security policy deleted: ${state.securityPolicyName}`);
          deletedCount++;
        } else {
          spinner.warn(`Security policy not found: ${state.securityPolicyName}`);
        }
      } catch (error: unknown) {
        const err = error as { message?: string };
        spinner.fail(`Failed to delete security policy: ${err.message}`);
        errorCount++;
      }
    }

    // Step 4: Remove Service User from Group
    if (state.groupName && state.serviceUserName) {
      const spinner = ora(`Removing ${state.serviceUserName} from group ${state.groupName}...`).start();
      try {
        await client.removeUserFromGroup(state.groupName, state.serviceUserName);
        spinner.succeed(`User removed from group`);
        deletedCount++;
      } catch (error: unknown) {
        const err = error as { message?: string };
        spinner.warn(`Failed to remove user from group (may already be removed): ${err.message}`);
      }
    }

    // Step 5: Delete Group
    if (state.groupName) {
      const spinner = ora(`Deleting group: ${state.groupName}...`).start();
      try {
        await client.deleteGroup(state.groupName);
        spinner.succeed(`Group deleted: ${state.groupName}`);
        deletedCount++;
      } catch (error: unknown) {
        const err = error as { message?: string };
        spinner.fail(`Failed to delete group: ${err.message}`);
        errorCount++;
      }
    }

    // Step 6: Delete Service User Keys
    if (state.serviceUserKeyIds && state.serviceUserKeyIds.length > 0 && state.serviceUserName) {
      for (const keyId of state.serviceUserKeyIds) {
        const spinner = ora(`Deleting service user key: ${keyId}...`).start();
        try {
          await client.deleteServiceUserKey(state.serviceUserName, keyId);
          spinner.succeed(`Service user key deleted: ${keyId}`);
          deletedCount++;
        } catch (error: unknown) {
          const err = error as { message?: string };
          spinner.fail(`Failed to delete key ${keyId}: ${err.message}`);
          errorCount++;
        }
      }
    }

    // Step 7: Delete Service User
    if (state.serviceUserName) {
      const spinner = ora(`Deleting service user: ${state.serviceUserName}...`).start();
      try {
        await client.deleteServiceUser(state.serviceUserName);
        spinner.succeed(`Service user deleted: ${state.serviceUserName}`);
        deletedCount++;
      } catch (error: unknown) {
        const err = error as { message?: string };
        spinner.fail(`Failed to delete service user: ${err.message}`);
        errorCount++;
      }
    }

    // Step 8: Delete Project
    if (state.projectId && state.resourceGroupId) {
      const spinner = ora(`Deleting project: ${state.projectName || state.projectId}...`).start();
      try {
        await client.deleteProject(state.resourceGroupId, state.projectId);
        spinner.succeed(`Project deleted: ${state.projectName || state.projectId}`);
        deletedCount++;
      } catch (error: unknown) {
        const err = error as { message?: string };
        spinner.fail(`Failed to delete project: ${err.message}`);
        errorCount++;
      }
    }

    // Step 9: Delete Resource Group
    if (state.resourceGroupId) {
      const spinner = ora(`Deleting resource group: ${state.resourceGroupName || state.resourceGroupId}...`).start();
      try {
        await client.deleteResourceGroup(state.resourceGroupId);
        spinner.succeed(`Resource group deleted: ${state.resourceGroupName || state.resourceGroupId}`);
        deletedCount++;
      } catch (error: unknown) {
        const err = error as { message?: string };
        spinner.fail(`Failed to delete resource group: ${err.message}`);
        errorCount++;
      }
    }

    // Step 10: Clean up local files
    const cleanupAnswers = await prompts([
      {
        type: 'confirm',
        name: 'deleteEnvOpa',
        message: 'Delete packages/agent0/.env.opa file?',
        initial: true,
      },
    ]);

    console.log('');

    if (cleanupAnswers.deleteEnvOpa) {
      const envOpaPath = path.join(process.cwd(), 'packages/agent0/.env.opa');
      if (fs.existsSync(envOpaPath)) {
        fs.unlinkSync(envOpaPath);
        console.log(chalk.gray(`  Deleted: ${envOpaPath}`));
      } else {
        console.log(chalk.gray(`  File not found: ${envOpaPath}`));
      }
    }

    // Step 11: Delete OPA rollback state
    deleteOPARollbackState();
    console.log(chalk.gray('  Deleted: .opa-setup-state.json'));

    // Summary
    console.log(chalk.bold('\n📊 Rollback Summary\n'));
    console.log(`  ${chalk.green('Resources deleted:')} ${deletedCount}`);
    if (errorCount > 0) {
      console.log(`  ${chalk.red('Errors encountered:')} ${errorCount}`);
    }
    console.log('');

    if (errorCount === 0) {
      console.log(chalk.bold.green('✅ OPA rollback completed successfully!\n'));
    } else {
      console.log(chalk.bold.yellow('⚠️  Rollback completed with some errors\n'));
      console.log(chalk.yellow('💡 Check OPA dashboard to verify all resources were removed\n'));
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error(chalk.red('\n❌ Rollback failed:'), err.message);
    console.error(chalk.yellow('\n⚠️  Some resources may remain in your OPA tenant.'));
    console.error(chalk.yellow('Please check OPA dashboard and delete manually if needed.\n'));
    process.exit(1);
  }
}

// Run rollback
rollback().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
