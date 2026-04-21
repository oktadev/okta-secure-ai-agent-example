#!/usr/bin/env node
/**
 * register.ts - Register todo0 (or any MCP) with Okta as a managed MCP Server
 *
 * Flow:
 *   1. Prompt operator for Okta org URL + OAuth bearer token + MCP resourceUrl.
 *   2. POST /resource-servers/api/v1/mcp-servers → creates MCP in PENDING state.
 *   3. Poll GET /mcp-servers/{id} until status leaves PENDING.
 *      Okta fetches `<resourceUrl>/.well-known/oauth-protected-resource` and
 *      each discovered AS's `.well-known/oauth-authorization-server`.
 *   4. If the MCP lands in INACTIVE → POST /lifecycle/activate to reach ACTIVE.
 *   5. Persist mcpServerId to .mcp-register-state.json for rollback.
 *
 * Prerequisite for local dev: resourceUrl must be reachable from Okta. For a
 * local MCP (http://localhost:5002/mcp) use a tunnel (e.g. ngrok, cloudflared)
 * and register the tunnel URL instead.
 */

import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import { OktaMcpClient } from './lib/mcp-api.js';
import { loadMcpRegisterState, saveMcpRegisterState } from './lib/mcp-state-manager.js';

async function main() {
  console.log(chalk.bold.cyan('\n🔗 Register MCP Server with Okta\n'));

  const existing = loadMcpRegisterState();
  if (existing) {
    console.log(chalk.yellow(`⚠️  An MCP registration already exists in .mcp-register-state.json:`));
    console.log(chalk.gray(`   mcpServerId: ${existing.mcpServerId}`));
    console.log(chalk.gray(`   resourceUrl: ${existing.resourceUrl}`));
    console.log(chalk.yellow(`   Run \`pnpm rollback:mcp\` first if you want to re-register.\n`));
    process.exit(1);
  }

  console.log(chalk.gray('Prerequisite: operator needs an Okta OAuth 2.0 bearer token'));
  console.log(chalk.gray('with `okta.resourceServers.mcpServers.manage` scope or SUPER_ADMIN role.'));
  console.log(chalk.gray('Easiest path: copy an Authorization header from the Okta admin console\n'));

  const answers = await prompts([
    {
      type: 'text',
      name: 'orgUrl',
      message: 'Okta org URL (e.g. https://dev-123.okta.com):',
      validate: (v: string) => /^https:\/\/.+/.test(v) || 'Must start with https://',
    },
    {
      type: 'password',
      name: 'token',
      message: 'OAuth 2.0 bearer token:',
      validate: (v: string) => (v ? true : 'Required'),
    },
    {
      type: 'text',
      name: 'resourceUrl',
      message: 'MCP resourceUrl (must be reachable from Okta, e.g. https://xyz.ngrok.app/mcp):',
      validate: (v: string) => /^https?:\/\/.+/.test(v) || 'Must be a valid URL',
    },
    {
      type: 'text',
      name: 'displayName',
      message: 'Display name (optional):',
      initial: 'Todo0 MCP',
    },
    {
      type: 'text',
      name: 'description',
      message: 'Description (optional):',
      initial: 'Todo management MCP server',
    },
  ], { onCancel: () => process.exit(0) });

  if (!answers.orgUrl || !answers.token || !answers.resourceUrl) {
    console.log(chalk.yellow('\n⚠️  Missing required input. Exiting.\n'));
    process.exit(1);
  }

  const client = new OktaMcpClient({ orgUrl: answers.orgUrl, token: answers.token });

  // --- Register -------------------------------------------------------------

  const registerSpinner = ora('Registering MCP server with Okta…').start();
  let mcp;
  try {
    mcp = await client.register({
      resourceUrl: answers.resourceUrl,
      displayName: answers.displayName || undefined,
      description: answers.description || undefined,
    });
    registerSpinner.succeed(`Registered: id=${mcp.id} status=${mcp.status}`);
  } catch (err) {
    registerSpinner.fail(`Registration failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // --- Persist state early so it can be rolled back even if later steps fail

  saveMcpRegisterState({
    oktaOrgUrl: answers.orgUrl,
    mcpServerId: mcp.id,
    resourceUrl: mcp.resourceUrl,
    displayName: mcp.metadata?.displayName,
    registeredAt: new Date().toISOString(),
  });
  console.log(chalk.gray(`  Saved rollback state → .mcp-register-state.json`));

  // --- Wait for PENDING to resolve ------------------------------------------

  const pollSpinner = ora('Waiting for Okta to discover MCP metadata (PENDING → INACTIVE)…').start();
  let settled;
  try {
    settled = await client.waitForOutOfPending(mcp.id);
    pollSpinner.succeed(`Status: ${settled.status}`);
  } catch (err) {
    pollSpinner.fail(`Discovery timed out / failed: ${(err as Error).message}`);
    console.log(chalk.yellow('\n⚠️  MCP server is registered but stuck in PENDING.'));
    console.log(chalk.yellow('   Verify that resourceUrl exposes /.well-known/oauth-protected-resource'));
    console.log(chalk.yellow('   and is reachable from Okta, then run `pnpm validate:mcp`.\n'));
    process.exit(1);
  }

  if (settled.status === 'INVALID') {
    console.log(chalk.red('\n❌ MCP landed in INVALID status — Okta could not discover metadata.'));
    console.log(chalk.yellow('   Common causes:'));
    console.log(chalk.yellow('     • resourceUrl not publicly reachable from Okta'));
    console.log(chalk.yellow('     • /.well-known/oauth-protected-resource not served'));
    console.log(chalk.yellow('     • The discovered AS issuer rejects /.well-known/oauth-authorization-server'));
    console.log(chalk.yellow('   Use `pnpm validate:mcp` to inspect, then `pnpm rollback:mcp` to clean up.\n'));
    process.exit(1);
  }

  // --- Activate --------------------------------------------------------------

  if (settled.status === 'INACTIVE') {
    const actSpinner = ora('Activating…').start();
    try {
      const activated = await client.activate(mcp.id);
      const finalStatus = (activated as any)?.status || 'ACTIVE';
      actSpinner.succeed(`Activated: status=${finalStatus}`);
    } catch (err) {
      actSpinner.fail(`Activation failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (settled.status === 'ACTIVE') {
    console.log(chalk.gray('  Already ACTIVE — no activation needed.'));
  }

  // --- Summary ---------------------------------------------------------------

  const authServers = await client.listAuthorizationServers(mcp.id).catch(() => null);

  console.log(chalk.bold.green('\n✅ MCP Server registered and ACTIVE\n'));
  console.log(`  ${chalk.bold('mcpServerId:')} ${mcp.id}`);
  console.log(`  ${chalk.bold('resourceUrl:')} ${mcp.resourceUrl}`);
  if (authServers?.data?.length) {
    console.log(`  ${chalk.bold('Authorization Servers discovered:')} ${authServers.data.length}`);
    for (const as of authServers.data) {
      console.log(chalk.gray(`    • ${as.id}  issuer=${as.issuer}  status=${as.status}`));
    }
  } else {
    console.log(chalk.yellow('  No authorization servers were discovered. Check .well-known metadata.'));
  }
  console.log(chalk.gray('\n  Rollback with: pnpm rollback:mcp\n'));
}

main().catch((err) => {
  console.error(chalk.red(`\nFatal: ${(err as Error).message}\n`));
  process.exit(1);
});
