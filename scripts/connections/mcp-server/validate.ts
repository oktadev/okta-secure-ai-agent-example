#!/usr/bin/env node
/**
 * validate.ts - Verify an Okta-registered MCP server is healthy
 *
 * Reads `.mcp-register-state.json` for the mcpServerId. Fetches current
 * status + the list of linked authorization servers. Prints a report.
 */

import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import { OktaMcpClient } from './lib/mcp-api.js';
import { loadMcpRegisterState } from './lib/mcp-state-manager.js';

async function main() {
  console.log(chalk.bold.cyan('\n🔎 Validate MCP Server Registration\n'));

  const state = loadMcpRegisterState();
  if (!state) {
    console.log(chalk.red('❌ No .mcp-register-state.json — run `pnpm register:mcp` first.\n'));
    process.exit(1);
  }

  console.log(chalk.gray(`  orgUrl:      ${state.oktaOrgUrl}`));
  console.log(chalk.gray(`  mcpServerId: ${state.mcpServerId}`));
  console.log(chalk.gray(`  resourceUrl: ${state.resourceUrl}\n`));

  const envApiToken = process.env.OKTA_API_TOKEN;

  const answers = await prompts([
    {
      type: envApiToken ? null : 'password',
      name: 'apiToken',
      message: 'Okta API token (SSWS):',
      validate: (v: string) => (v ? true : 'Required'),
    },
  ], { onCancel: () => process.exit(0) });

  const apiToken = envApiToken || answers.apiToken;
  if (!apiToken) process.exit(1);

  const client = new OktaMcpClient({ orgUrl: state.oktaOrgUrl, apiToken });

  const getSpinner = ora('Fetching MCP server…').start();
  let mcp;
  try {
    mcp = await client.get(state.mcpServerId);
    getSpinner.succeed(`Status: ${mcp.status}`);
  } catch (err) {
    getSpinner.fail(`Get failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const asSpinner = ora('Listing authorization servers…').start();
  let authServers;
  try {
    authServers = await client.listAuthorizationServers(state.mcpServerId);
    asSpinner.succeed(`Found ${authServers.data.length} AS(es)`);
  } catch (err) {
    asSpinner.fail(`List ASes failed: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(chalk.bold('\n📋 Report\n'));
  console.log(`  ${chalk.bold('status:')}        ${statusColor(mcp.status)}`);
  console.log(`  ${chalk.bold('resourceUrl:')}   ${mcp.resourceUrl}`);
  console.log(`  ${chalk.bold('displayName:')}   ${mcp.metadata?.displayName ?? '(none)'}`);
  console.log(`  ${chalk.bold('description:')}   ${mcp.metadata?.description ?? '(none)'}`);
  console.log(`  ${chalk.bold('lastUpdated:')}   ${mcp.lastUpdated ?? 'n/a'}`);
  if (mcp.detectedMetadata) {
    console.log(`  ${chalk.bold('detectedResourceName:')} ${mcp.detectedMetadata.resourceName ?? 'n/a'}`);
    console.log(`  ${chalk.bold('scopesSupported:')}      ${(mcp.detectedMetadata.scopesSupported || []).join(', ') || '(none)'}`);
    console.log(`  ${chalk.bold('lastRefreshedAt:')}      ${mcp.detectedMetadata.lastRefreshedAt ?? 'n/a'}`);
  }

  console.log(chalk.bold(`\n  Authorization Servers (${authServers.data.length}):`));
  if (!authServers.data.length) {
    console.log(chalk.yellow('    none — Okta did not discover any AS from the MCP metadata'));
  } else {
    for (const as of authServers.data) {
      const prefix = as.id.startsWith('aus') ? 'Okta custom AS (supports XAA/ID-JAG)'
                    : as.id.startsWith('eas') ? 'external AS (supports STS)'
                    : 'unknown prefix';
      console.log(`    • ${chalk.bold(as.id)}  ${statusColor(as.status)}`);
      console.log(chalk.gray(`      issuer: ${as.issuer}`));
      console.log(chalk.gray(`      shape:  ${prefix}`));
    }
  }

  if (mcp.status === 'ACTIVE') {
    console.log(chalk.bold.green('\n✅ Registration healthy\n'));
  } else {
    console.log(chalk.bold.yellow(`\n⚠️  Registration not ACTIVE (status=${mcp.status})\n`));
    if (mcp.status === 'INVALID') {
      console.log(chalk.yellow('   Re-check that resourceUrl exposes /.well-known/oauth-protected-resource'));
      console.log(chalk.yellow('   and the discovered AS issuer exposes /.well-known/oauth-authorization-server.\n'));
    }
    if (mcp.status === 'INACTIVE') {
      console.log(chalk.yellow('   Activate with: pnpm register:mcp (it auto-activates INACTIVE servers),'));
      console.log(chalk.yellow('   or call POST /mcp-servers/{id}/lifecycle/activate directly.\n'));
    }
  }
}

function statusColor(status: string): string {
  if (status === 'ACTIVE') return chalk.green(status);
  if (status === 'INVALID') return chalk.red(status);
  if (status === 'PENDING') return chalk.cyan(status);
  return chalk.yellow(status); // INACTIVE
}

main().catch((err) => {
  console.error(chalk.red(`\nFatal: ${(err as Error).message}\n`));
  process.exit(1);
});
