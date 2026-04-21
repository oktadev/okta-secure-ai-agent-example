#!/usr/bin/env node
/**
 * list.ts - Dump raw MCP-server registrations at Okta.
 * Diagnostic helper — prints the full JSON payload so we can reconcile
 * the REST client's types against Okta's actual response shape.
 */
import prompts from 'prompts';
import { OktaMcpClient } from './lib/mcp-api.js';

async function main() {
  const envOrgUrl = process.env.OKTA_ORG_URL;
  const envApiToken = process.env.OKTA_API_TOKEN;

  const answers = await prompts([
    { type: envOrgUrl ? null : 'text', name: 'orgUrl', message: 'Okta org URL:' },
    { type: envApiToken ? null : 'password', name: 'apiToken', message: 'Okta API token (SSWS):' },
  ], { onCancel: () => process.exit(0) });

  const orgUrl = envOrgUrl || answers.orgUrl;
  const apiToken = envApiToken || answers.apiToken;
  if (!orgUrl || !apiToken) process.exit(1);

  const client = new OktaMcpClient({ orgUrl, apiToken });
  const raw = await client.listRaw();
  console.log(JSON.stringify(raw, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
