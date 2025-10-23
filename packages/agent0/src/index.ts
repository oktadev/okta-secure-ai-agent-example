// index.ts - Main Entry Point for Agent0
import * as dotenv from 'dotenv';
import { Agent, AgentConfig } from './agent.js';
import { ResourceServer, ResourceServerConfig } from './resource-server.js';
import { OktaConfig } from './auth/okta-auth.js';

// Load environment variables
dotenv.config();

// ============================================================================
// Main Bootstrap Function
// ============================================================================

async function bootstrap(): Promise<void> {
  console.log('🚀 Starting Agent0...\n');

  // ============================================================================
  // 1. Configure and Initialize Agent (MCP Client + LLM)
  // ============================================================================

  const agentConfig: AgentConfig = {
    mcpServerUrl: process.env.MCP_SERVER_URL || 'http://localhost:3001',
    name: 'agent0',
    version: '1.0.0',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
    enableLLM: true,
  };

  const agent = new Agent(agentConfig);

  // Connect to MCP server
  try {
    await agent.connect();
  } catch (error) {
    console.error('❌ Failed to connect to MCP server. Continuing without MCP...');
    console.error('   Make sure the MCP server is running on', agentConfig.mcpServerUrl);
  }

  // ============================================================================
  // 2. Configure and Start Resource Server
  // ============================================================================

  const port = parseInt(process.env.PORT || '3000', 10);
  const sessionSecret = process.env.SESSION_SECRET || 'default-secret-change-in-production';

  const resourceServerConfig: ResourceServerConfig = {
    port,
    sessionSecret,
  };

  // Add Okta configuration if environment variables are set
  if (process.env.OKTA_DOMAIN && process.env.OKTA_CLIENT_ID && process.env.OKTA_CLIENT_SECRET) {
    resourceServerConfig.okta = {
      domain: process.env.OKTA_DOMAIN,
      clientId: process.env.OKTA_CLIENT_ID,
      clientSecret: process.env.OKTA_CLIENT_SECRET,
      redirectUri: process.env.OKTA_REDIRECT_URI || `http://localhost:${port}/callback`,
    } as OktaConfig;
  }

  const resourceServer = new ResourceServer(resourceServerConfig, agent);

  // Start the resource server
  await resourceServer.start();

  // Open browser to the UI
  try {
    const open = (await (0, eval)("import('open')")).default;
    console.log(`✅ Opening browser at http://localhost:${port}`);
    await open(`http://localhost:${port}`);
  } catch (error) {
    console.log(`💡 Open your browser to http://localhost:${port}`);
  }

  // ============================================================================
  // 3. Handle Graceful Shutdown
  // ============================================================================

  process.on('SIGINT', async () => {
    console.log('\n\n👋 Shutting down gracefully...');
    await agent.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n👋 Shutting down gracefully...');
    await agent.disconnect();
    process.exit(0);
  });
}

// ============================================================================
// Start the Application
// ============================================================================

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('❌ Failed to start Agent0:', error);
    process.exit(1);
  });
}

// Export for programmatic use
export { Agent, ResourceServer, AgentConfig, ResourceServerConfig };
