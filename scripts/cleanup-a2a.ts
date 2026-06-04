#!/usr/bin/env node
/**
 * Standalone A2A cleanup — removes ONLY the resources created by `setup:a2a`,
 * leaving the base osage install (MCP AS, apps, agent0 identity, todo0) intact.
 *
 * Reads `.a2a-setup-state.json`, deletes the A2A Okta resources in dependency
 * order, strips the appended A2A section from agent0/.env.agent, and removes
 * the agentb env + key + state file.
 *
 * Usage: pnpm run cleanup:a2a   (prompts for the Okta API token)
 */

import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { OktaAPIClient } from './lib/okta-api.js';
import { AgentIdentityAPIClient } from './lib/agent-identity-api.js';

const A2A_STATE_FILE = '.a2a-setup-state.json';
const AGENT0_ENV = 'packages/agent0/.env.agent';
const AGENTB_ENV = 'packages/agentb/.env.agentb';
const AGENTB_KEY = 'packages/agentb/agentb-private-key.pem';
const A2A_SECTION_MARKER = '# AGENT - A2A IDENTITY CHAINING';

interface A2ASetupState {
  oktaDomain?: string;
  orgId?: string;
  agentIdentityIds: string[];
  a2aAuthServerIds: string[];
  delegationLinkIds: string[];
  agentConnections: { agentId: string; connectionId: string }[];
}

/** Remove the appended A2A block from agent0/.env.agent (everything from the
 *  A2A section's comment banner to EOF, since setup appends it last). */
function stripA2ASection(): void {
  const abs = path.resolve(AGENT0_ENV);
  if (!fs.existsSync(abs)) return;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const markerIdx = lines.findIndex((l) => l.includes(A2A_SECTION_MARKER));
  if (markerIdx === -1) return;
  // Walk back to the start of this comment banner (the preceding `# ====` line).
  let start = markerIdx;
  while (start > 0 && lines[start - 1].trim().startsWith('# ===')) start--;
  while (start > 0 && lines[start - 1].trim() === '') start--;
  const kept = lines.slice(0, start).join('\n').replace(/\s+$/, '') + '\n';
  fs.writeFileSync(abs, kept, { mode: 0o600 });
  console.log(chalk.gray(`  Stripped A2A section from ${AGENT0_ENV}`));
}

async function main() {
  console.log(chalk.bold.red('\n🧹 A2A Cleanup — removes only the A2A resources\n'));

  if (!fs.existsSync(A2A_STATE_FILE)) {
    console.error(chalk.red(`❌ No ${A2A_STATE_FILE} found — nothing to clean up.`));
    console.log(chalk.yellow('   (A2A may not have been set up via `pnpm run setup:a2a`.)\n'));
    process.exit(1);
  }

  const state: A2ASetupState = JSON.parse(fs.readFileSync(A2A_STATE_FILE, 'utf8'));

  console.log('Will delete:');
  if (state.agentConnections?.length) console.log(chalk.gray(`  • ${state.agentConnections.length} managed connection(s)`));
  if (state.delegationLinkIds?.length) console.log(chalk.gray(`  • ${state.delegationLinkIds.length} delegation link(s)`));
  if (state.agentIdentityIds?.length) console.log(chalk.gray(`  • Agent B (${state.agentIdentityIds.join(', ')})`));
  if (state.a2aAuthServerIds?.length) console.log(chalk.gray(`  • A2A authorization server(s) (${state.a2aAuthServerIds.join(', ')})`));
  console.log('');

  const answers = await prompts([
    { type: 'password', name: 'oktaApiToken', message: 'Enter your Okta API token:', validate: (v) => (v ? true : 'Required') },
    { type: 'confirm', name: 'confirm', message: chalk.red('Delete these A2A resources?'), initial: false },
  ]);
  if (!answers.confirm) {
    console.log(chalk.yellow('\n⚠️  Cancelled\n'));
    process.exit(0);
  }

  const oktaClient = new OktaAPIClient({ orgUrl: `https://${state.oktaDomain}`, token: answers.oktaApiToken });
  const agentClient = new AgentIdentityAPIClient({ oktaDomain: state.oktaDomain!, apiToken: answers.oktaApiToken });

  let errors = 0;

  // 1. Connections (deactivate + delete) — before agents.
  for (const conn of state.agentConnections || []) {
    const spinner = ora(`Deleting connection ${conn.connectionId}...`).start();
    try {
      await agentClient.deactivateConnection(conn.agentId, conn.connectionId).catch(() => {});
      await agentClient.deleteConnection(conn.agentId, conn.connectionId);
      spinner.succeed(`Connection ${conn.connectionId} deleted`);
    } catch (e: any) { spinner.fail(`Failed: ${e.message}`); errors++; }
  }

  // 2. Delegation links.
  for (const linkId of state.delegationLinkIds || []) {
    const spinner = ora(`Deleting delegation link ${linkId}...`).start();
    try {
      await agentClient.deleteDelegationLink(linkId);
      spinner.succeed(`Delegation link ${linkId} deleted`);
    } catch (e: any) { spinner.fail(`Failed: ${e.message}`); errors++; }
  }

  // 3. Agent B (deactivate + delete; deletes its a2a-server + AS association too).
  for (const agentId of state.agentIdentityIds || []) {
    const spinner = ora(`Deleting Agent B ${agentId}...`).start();
    try {
      const deact = await agentClient.deactivateAgent(agentId);
      await agentClient.pollOperation(deact);
      const del = await agentClient.deleteAgent(agentId);
      await agentClient.pollOperation(del);
      spinner.succeed(`Agent B ${agentId} deleted`);
    } catch (e: any) { spinner.fail(`Failed: ${e.message}`); errors++; }
  }

  // 4. A2A authorization server(s).
  for (const asId of state.a2aAuthServerIds || []) {
    const spinner = ora(`Deleting A2A authorization server ${asId}...`).start();
    try {
      await oktaClient.deleteAuthorizationServer(asId);
      spinner.succeed(`A2A AS ${asId} deleted`);
    } catch (e: any) { spinner.fail(`Failed: ${e.message}`); errors++; }
  }

  // 5. Local files: strip env section, remove agentb env + key + state file.
  console.log('');
  stripA2ASection();
  for (const f of [AGENTB_ENV, AGENTB_KEY, A2A_STATE_FILE]) {
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(chalk.gray(`  Deleted: ${f}`)); }
  }

  console.log(errors === 0
    ? chalk.bold.green('\n✅ A2A cleanup complete (base install untouched).\n')
    : chalk.bold.yellow(`\n⚠️  Completed with ${errors} error(s) — check the Okta Admin Console.\n`));
}

main().catch((err) => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
