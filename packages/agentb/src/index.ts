// ============================================================================
// AGENT B — ENTRY POINT
// ============================================================================

import * as fs from 'fs';
import { loadConfig } from './config';
import { createServer } from './server';

function main() {
  // A2A is optional. When the demo hasn't been provisioned with A2A, there is
  // no .env.agentb — exit cleanly so `pnpm run dev` isn't disrupted.
  if (!fs.existsSync('.env.agentb')) {
    console.log('ℹ️  Agent B: no .env.agentb found — A2A not provisioned, skipping. ' +
      'Run `pnpm run bootstrap:okta` and enable A2A to use the second hop.');
    process.exit(0);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err: any) {
    console.error(`❌ Agent B configuration error: ${err.message}`);
    process.exit(1);
  }

  const app = createServer(config);

  app.listen(config.port, () => {
    console.log('\n🤖 Agent B (Task Agent) — A2A downstream agent');
    console.log(`   Listening:    http://localhost:${config.port}`);
    console.log(`   Agent card:   http://localhost:${config.port}/.well-known/agent-card.json`);
    console.log(`   A2A endpoint: http://localhost:${config.port}/a2a`);
    console.log(`   resourceUrl:  ${config.resourceUrl}`);
    console.log(`   Downstream:   ${config.mcpServerUrl} (todo0 MCP)\n`);
  });
}

main();
