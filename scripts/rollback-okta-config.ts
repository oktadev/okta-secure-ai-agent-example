#!/usr/bin/env node
import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { OktaAPIClient } from './lib/okta-api.js';
import { AgentIdentityAPIClient } from './lib/agent-identity-api.js';

interface AgentConnectionInfo {
  agentId: string;
  connectionId: string;
}

interface RollbackState {
  oktaDomain: string;
  agent0ApiAuthServerIds: string[];
  restApiAuthServerIds: string[];
  mcpAuthServerIds: string[];
  agent0AppIds: string[];
  todo0AppIds: string[];
  agent0AppUserIds: string[];
  todo0AppUserIds: string[];
  agentIdentityIds: string[];
  agentConnections: AgentConnectionInfo[];
  agentOwnerSetupMethod?: 'standard' | 'developer';
  agent0ApiPolicyIds: string[];
  agent0ApiPolicyRuleIds: string[];
  restApiPolicyIds: string[];
  restApiPolicyRuleIds: string[];
  mcpPolicyIds: string[];
  mcpPolicyRuleIds: string[];
  trustedOriginNames: string[];
}

/**
 * Load rollback state from file
 */
function loadRollbackState(): RollbackState | null {
  const statePath = '.okta-bootstrap-state.json';
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(chalk.red('Failed to parse rollback state file'));
    return null;
  }
}

/**
 * Delete rollback state file
 */
function deleteRollbackState(): void {
  const statePath = '.okta-bootstrap-state.json';
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
    console.log(chalk.gray('  Rollback state file deleted'));
  }
}

/**
 * Main rollback function
 */
async function rollback() {
  console.log(chalk.bold.red('\n🗑️  Okta Configuration Rollback\n'));
  console.log(chalk.yellow('⚠️  WARNING: This will delete resources from your Okta tenant!\n'));

  // Load rollback state
  const state = loadRollbackState();
  if (!state) {
    console.error(chalk.red('❌ No rollback state found'));
    console.log(chalk.yellow('\n💡 Rollback state is created during bootstrap'));
    console.log(chalk.yellow('   File: .okta-bootstrap-state.json\n'));
    process.exit(1);
  }

  console.log('Resources to be deleted:');
  if (state.agent0ApiAuthServerIds?.length > 0) {
    console.log(chalk.gray(`  • Agent0 API Authorization Servers (${state.agent0ApiAuthServerIds.length})`));
  }
  if (state.restApiAuthServerIds?.length > 0) {
    console.log(chalk.gray(`  • REST API Authorization Servers (${state.restApiAuthServerIds.length})`));
  }
  if (state.mcpAuthServerIds?.length > 0) {
    console.log(chalk.gray(`  • MCP Authorization Servers (${state.mcpAuthServerIds.length})`));
  }
  if (state.agent0AppIds?.length > 0) {
    console.log(chalk.gray(`  • agent0 Applications (${state.agent0AppIds.length})`));
  }
  if (state.agent0AppUserIds?.length > 0) {
    console.log(chalk.gray(`  • agent0 Application User Assignments (${state.agent0AppUserIds.length})`));
  }
  if (state.todo0AppIds?.length > 0) {
    console.log(chalk.gray(`  • todo0 Applications (${state.todo0AppIds.length})`));
  }
  if (state.todo0AppUserIds?.length > 0) {
    console.log(chalk.gray(`  • todo0 Application User Assignments (${state.todo0AppUserIds.length})`));
  }
  if (state.agent0ApiPolicyIds?.length > 0) {
    console.log(chalk.gray(`  • Agent0 API Policies (${state.agent0ApiPolicyIds.length})`));
  }
  if (state.restApiPolicyIds?.length > 0) {
    console.log(chalk.gray(`  • REST API Policies (${state.restApiPolicyIds.length})`));
  }
  if (state.mcpPolicyIds?.length > 0) {
    console.log(chalk.gray(`  • MCP Policies (${state.mcpPolicyIds.length})`));
  }
  if (state.agentConnections?.length > 0) {
    console.log(chalk.gray(`  • Agent Connections (${state.agentConnections.length})`));
  }
  if (state.trustedOriginNames?.length > 0) {
    console.log(chalk.gray(`  • Trusted Origins: ${state.trustedOriginNames.join(', ')}`));
  }
  console.log('');

  // Prompt for API token
  const answers = await prompts([
    {
      type: 'password',
      name: 'oktaApiToken',
      message: 'Enter your Okta API token to proceed:',
      validate: (value) => (value ? true : 'API token is required'),
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

  const oktaClient = new OktaAPIClient({
    orgUrl: `https://${state.oktaDomain}`,
    token: answers.oktaApiToken,
  });

  const agentClient = new AgentIdentityAPIClient({
    oktaDomain: state.oktaDomain,
    apiToken: answers.oktaApiToken,
  });

  let deletedCount = 0;
  let errorCount = 0;

  try {
    // Delete in reverse dependency order: policies/rules → apps → auth servers → origins

    // Step 1: Delete Policy Rules (must be deleted before policies)
    if (state.agent0ApiPolicyRuleIds && state.agent0ApiPolicyRuleIds.length > 0) {
      for (const ruleId of state.agent0ApiPolicyRuleIds) {
        const spinner = ora(`Deleting Agent0 API policy rule ${ruleId}...`).start();
        try {
          const authServerId = state.agent0ApiAuthServerIds?.[0];
          const policyId = state.agent0ApiPolicyIds?.[0];
          if (authServerId && policyId) {
            await oktaClient.deletePolicyRule(authServerId, policyId, ruleId);
            spinner.succeed(`Agent0 API policy rule deleted`);
            deletedCount++;
          } else {
            spinner.warn('Skipped (missing auth server or policy ID)');
          }
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    if (state.restApiPolicyRuleIds && state.restApiPolicyRuleIds.length > 0) {
      for (const ruleId of state.restApiPolicyRuleIds) {
        const spinner = ora(`Deleting REST API policy rule ${ruleId}...`).start();
        try {
          // We need both authServerId and policyId - extract from state
          const authServerId = state.restApiAuthServerIds?.[0];
          const policyId = state.restApiPolicyIds?.[0];
          if (authServerId && policyId) {
            await oktaClient.deletePolicyRule(authServerId, policyId, ruleId);
            spinner.succeed(`REST API policy rule deleted`);
            deletedCount++;
          } else {
            spinner.warn('Skipped (missing auth server or policy ID)');
          }
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    if (state.mcpPolicyRuleIds && state.mcpPolicyRuleIds.length > 0) {
      for (const ruleId of state.mcpPolicyRuleIds) {
        const spinner = ora(`Deleting MCP policy rule ${ruleId}...`).start();
        try {
          const authServerId = state.mcpAuthServerIds?.[0];
          const policyId = state.mcpPolicyIds?.[0];
          if (authServerId && policyId) {
            await oktaClient.deletePolicyRule(authServerId, policyId, ruleId);
            spinner.succeed(`MCP policy rule deleted`);
            deletedCount++;
          } else {
            spinner.warn('Skipped (missing auth server or policy ID)');
          }
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    // Step 2: Delete Policies (must be deleted before auth servers)
    if (state.agent0ApiPolicyIds && state.agent0ApiPolicyIds.length > 0) {
      for (const policyId of state.agent0ApiPolicyIds) {
        const spinner = ora(`Deleting Agent0 API policy ${policyId}...`).start();
        try {
          const authServerId = state.agent0ApiAuthServerIds?.[0];
          if (authServerId) {
            await oktaClient.deletePolicy(authServerId, policyId);
            spinner.succeed(`Agent0 API policy deleted`);
            deletedCount++;
          } else {
            spinner.warn('Skipped (missing auth server ID)');
          }
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    if (state.restApiPolicyIds && state.restApiPolicyIds.length > 0) {
      for (const policyId of state.restApiPolicyIds) {
        const spinner = ora(`Deleting REST API policy ${policyId}...`).start();
        try {
          const authServerId = state.restApiAuthServerIds?.[0];
          if (authServerId) {
            await oktaClient.deletePolicy(authServerId, policyId);
            spinner.succeed(`REST API policy deleted`);
            deletedCount++;
          } else {
            spinner.warn('Skipped (missing auth server ID)');
          }
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    if (state.mcpPolicyIds && state.mcpPolicyIds.length > 0) {
      for (const policyId of state.mcpPolicyIds) {
        const spinner = ora(`Deleting MCP policy ${policyId}...`).start();
        try {
          const authServerId = state.mcpAuthServerIds?.[0];
          if (authServerId) {
            await oktaClient.deletePolicy(authServerId, policyId);
            spinner.succeed(`MCP policy deleted`);
            deletedCount++;
          } else {
            spinner.warn('Skipped (missing auth server ID)');
          }
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    // Step 2.5: Remove Agent Owners (must be before connections/agents)
    if (state.agentOwnerSetupMethod && state.agentIdentityIds && state.agentIdentityIds.length > 0) {
      const spinner = ora('Removing agent owners...').start();
      try {
        // Get org metadata for ORN construction
        const orgMetadata = await agentClient.getOrgMetadata();

        if (state.agentOwnerSetupMethod === 'developer') {
          // Use developer API to remove owners
          await agentClient.removeAgentOwnersDeveloper(orgMetadata.id);
          spinner.succeed('Agent owners removed using Developer API');
        } else {
          // Use standard API - remove owners for each agent
          for (const agentId of state.agentIdentityIds) {
            spinner.text = `Removing owners for agent ${agentId}...`;
            await agentClient.removeAgentOwnersStandard(agentId, orgMetadata.id);
          }
          spinner.succeed('Agent owners removed using Standard API');
        }
        deletedCount++;
      } catch (error: any) {
        spinner.warn(`Failed to remove owners: ${error.message}`);
        // Don't increment errorCount - this is not critical for cleanup
      }
    }

    // Step 3: Delete Agent Connections (must be before agents)
    if (state.agentConnections && state.agentConnections.length > 0) {
      for (const connection of state.agentConnections) {
        const spinner = ora(`Deleting agent connection ${connection.connectionId}...`).start();
        try {
          await agentClient.deleteConnection(connection.agentId, connection.connectionId);
          spinner.succeed(`Agent connection deleted`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    // Step 4: Delete Agent Identities (must be before applications)
    if (state.agentIdentityIds && state.agentIdentityIds.length > 0) {
      for (const agentId of state.agentIdentityIds) {
        const spinner = ora(`Deleting agent identity ${agentId}...`).start();
        try {
          // Deactivate agent first
          spinner.text = `Deactivating agent ${agentId}...`;
          const deactivationUrl = await agentClient.deactivateAgent(agentId);
          await agentClient.pollOperation(deactivationUrl);

          // Then delete agent
          spinner.text = `Deleting agent ${agentId}...`;
          const deletionUrl = await agentClient.deleteAgent(agentId);
          await agentClient.pollOperation(deletionUrl);

          spinner.succeed(`Agent identity deleted`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    // Step 4.5: Unassign Users from Applications (must be before deleting applications)
    if (state.agent0AppUserIds && state.agent0AppUserIds.length > 0 && state.agent0AppIds && state.agent0AppIds.length > 0) {
      for (const userId of state.agent0AppUserIds) {
        const spinner = ora(`Unassigning user ${userId} from agent0 application...`).start();
        try {
          await oktaClient.unassignUserFromApplication(state.agent0AppIds[0], userId);
          spinner.succeed(`User unassigned from agent0 application`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    if (state.todo0AppUserIds && state.todo0AppUserIds.length > 0 && state.todo0AppIds && state.todo0AppIds.length > 0) {
      for (const userId of state.todo0AppUserIds) {
        const spinner = ora(`Unassigning user ${userId} from todo0 application...`).start();
        try {
          await oktaClient.unassignUserFromApplication(state.todo0AppIds[0], userId);
          spinner.succeed(`User unassigned from todo0 application`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    // Step 5: Delete Applications
    if (state.agent0AppIds && state.agent0AppIds.length > 0) {
      for (const appId of state.agent0AppIds) {
        const spinner = ora(`Deleting agent0 application ${appId}...`).start();
        try {
          await oktaClient.deleteApplication(appId);
          spinner.succeed(`agent0 application deleted`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    if (state.todo0AppIds && state.todo0AppIds.length > 0) {
      for (const appId of state.todo0AppIds) {
        const spinner = ora(`Deleting todo0 application ${appId}...`).start();
        try {
          await oktaClient.deleteApplication(appId);
          spinner.succeed(`todo0 application deleted`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    // Step 6: Delete Authorization Servers (scopes are auto-deleted with auth server)
    if (state.agent0ApiAuthServerIds && state.agent0ApiAuthServerIds.length > 0) {
      for (const authServerId of state.agent0ApiAuthServerIds) {
        const spinner = ora(`Deleting Agent0 API Authorization Server ${authServerId}...`).start();
        try {
          await oktaClient.deleteAuthorizationServer(authServerId);
          spinner.succeed(`Agent0 API Authorization Server deleted`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    if (state.restApiAuthServerIds && state.restApiAuthServerIds.length > 0) {
      for (const authServerId of state.restApiAuthServerIds) {
        const spinner = ora(`Deleting REST API Authorization Server ${authServerId}...`).start();
        try {
          await oktaClient.deleteAuthorizationServer(authServerId);
          spinner.succeed(`REST API Authorization Server deleted`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    if (state.mcpAuthServerIds && state.mcpAuthServerIds.length > 0) {
      for (const authServerId of state.mcpAuthServerIds) {
        const spinner = ora(`Deleting MCP Authorization Server ${authServerId}...`).start();
        try {
          await oktaClient.deleteAuthorizationServer(authServerId);
          spinner.succeed(`MCP Authorization Server deleted`);
          deletedCount++;
        } catch (error: any) {
          spinner.fail(`Failed: ${error.message}`);
          errorCount++;
        }
      }
    }

    // Step 7: Delete Trusted Origins
    if (state.trustedOriginNames && state.trustedOriginNames.length > 0) {
      const spinner = ora('Deleting Trusted Origins...').start();
      let originsDeleted = 0;

      for (const originName of state.trustedOriginNames) {
        try {
          await oktaClient.deleteTrustedOriginByName(originName);
          originsDeleted++;
        } catch (error: any) {
          console.log(chalk.yellow(`  Warning: Could not delete origin "${originName}": ${error.message}`));
        }
      }

      if (originsDeleted > 0) {
        spinner.succeed(`Deleted ${originsDeleted} trusted origin(s)`);
        deletedCount += originsDeleted;
      } else {
        spinner.warn('No trusted origins deleted');
      }
    }

    // Optional: Clean up local files
    const cleanupAnswers = await prompts([
      {
        type: 'confirm',
        name: 'deleteEnvFiles',
        message: 'Delete generated .env files?',
        initial: false,
      },
      {
        type: 'confirm',
        name: 'deletePrivateKey',
        message: 'Delete generated private key file?',
        initial: false,
      },
      {
        type: 'confirm',
        name: 'deleteReport',
        message: 'Delete configuration report?',
        initial: false,
      },
    ]);

    console.log('');

    if (cleanupAnswers.deleteEnvFiles) {
      const agent0Env = 'packages/agent0/.env';
      const todo0Env = 'packages/todo0/.env';

      if (fs.existsSync(agent0Env)) {
        fs.unlinkSync(agent0Env);
        console.log(chalk.gray(`  Deleted: ${agent0Env}`));
      }
      if (fs.existsSync(todo0Env)) {
        fs.unlinkSync(todo0Env);
        console.log(chalk.gray(`  Deleted: ${todo0Env}`));
      }
    }

    if (cleanupAnswers.deletePrivateKey) {
      const keyPath = 'packages/agent0/agent0-private-key.pem';
      if (fs.existsSync(keyPath)) {
        fs.unlinkSync(keyPath);
        console.log(chalk.gray(`  Deleted: ${keyPath}`));
      }
    }

    if (cleanupAnswers.deleteReport) {
      const reportPath = 'okta-config-report.md';
      if (fs.existsSync(reportPath)) {
        fs.unlinkSync(reportPath);
        console.log(chalk.gray(`  Deleted: ${reportPath}`));
      }
    }

    // Delete rollback state
    deleteRollbackState();

    // Summary
    console.log(chalk.bold('\n📊 Rollback Summary\n'));
    console.log(`  ${chalk.green('Resources deleted:')} ${deletedCount}`);
    if (errorCount > 0) {
      console.log(`  ${chalk.red('Errors encountered:')} ${errorCount}`);
    }
    console.log('');

    if (errorCount === 0) {
      console.log(chalk.bold.green('✅ Rollback completed successfully!\n'));
    } else {
      console.log(chalk.bold.yellow('⚠️  Rollback completed with some errors\n'));
      console.log(chalk.yellow('💡 Check Okta Admin Console to verify all resources were removed\n'));
    }
  } catch (error: any) {
    console.error(chalk.red('\n❌ Rollback failed:'), error.message);
    console.error(chalk.yellow('\n⚠️  Some resources may remain in your Okta tenant.'));
    console.error(chalk.yellow('Please check Okta Admin Console and delete manually if needed.\n'));
    process.exit(1);
  }
}

// Run rollback
rollback().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
