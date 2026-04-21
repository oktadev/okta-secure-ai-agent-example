#!/usr/bin/env node
/**
 * rollback.ts - Deactivate and delete the MCP server registration at Okta
 *
 * Okta's delete endpoint refuses ACTIVE servers, so we always deactivate
 * first (no-op if already INACTIVE/INVALID), then delete, then clear the
 * local state file.
 */

import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import { OktaMcpClient } from './lib/mcp-api.js';
import { deleteMcpRegisterState, loadMcpRegisterState } from './lib/mcp-state-manager.js';

async function main() {
  console.log(chalk.bold.red('\n🗑️  Rollback MCP Server Registration\n'));

  const state = loadMcpRegisterState();
  if (!state) {
    console.log(chalk.yellow('No .mcp-register-state.json — nothing to rollback.\n'));
    process.exit(0);
  }

  console.log('Will delete:');
  console.log(chalk.gray(`  mcpServerId: ${state.mcpServerId}`));
  console.log(chalk.gray(`  resourceUrl: ${state.resourceUrl}`));
  console.log(chalk.gray(`  orgUrl:      ${state.oktaOrgUrl}\n`));

  const envApiToken = process.env.OKTA_API_TOKEN;

  const answers = await prompts([
    {
      type: envApiToken ? null : 'password',
      name: 'apiToken',
      message: 'Okta API token (SSWS):',
      validate: (v: string) => (v ? true : 'Required'),
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: chalk.red('Delete this MCP server registration?'),
      initial: false,
    },
  ], { onCancel: () => process.exit(0) });

  if (!answers.confirm) {
    console.log(chalk.yellow('\nCancelled.\n'));
    process.exit(0);
  }

  const apiToken = envApiToken || answers.apiToken;
  if (!apiToken) {
    console.log(chalk.yellow('\n⚠️  Missing API token. Exiting.\n'));
    process.exit(1);
  }

  const client = new OktaMcpClient({ orgUrl: state.oktaOrgUrl, apiToken });

  // --- Deactivate (tolerate "already INACTIVE") -----------------------------

  const deactSpinner = ora('Deactivating…').start();
  try {
    const current = await client.get(state.mcpServerId);
    if (current.status === 'ACTIVE') {
      await client.deactivate(state.mcpServerId);
      deactSpinner.succeed('Deactivated');
    } else {
      deactSpinner.succeed(`Skip deactivate (already ${current.status})`);
    }
  } catch (err) {
    deactSpinner.warn(`Deactivate step: ${(err as Error).message}`);
    // Continue to delete — 404 means it's already gone.
  }

  // --- Delete ---------------------------------------------------------------

  const delSpinner = ora('Deleting…').start();
  try {
    await client.delete(state.mcpServerId);
    delSpinner.succeed('Deleted at Okta');
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('404')) {
      delSpinner.succeed('Already gone at Okta (404)');
    } else {
      delSpinner.fail(`Delete failed: ${msg}`);
      process.exit(1);
    }
  }

  // --- Clear state ----------------------------------------------------------

  deleteMcpRegisterState();
  console.log(chalk.gray('  Cleared .mcp-register-state.json'));
  console.log(chalk.bold.green('\n✅ Rollback complete\n'));
}

main().catch((err) => {
  console.error(chalk.red(`\nFatal: ${(err as Error).message}\n`));
  process.exit(1);
});
