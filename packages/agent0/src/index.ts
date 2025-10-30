// index.ts - Main Entry Point for Agent0
import path from 'path';
import * as dotenv from 'dotenv';
import { disconnectAll } from './agent.js';
import { ResourceServer, ResourceServerConfig } from './resource-server.js';
import { TokenExchangeConfig } from './auth/token-exchange.js';

// Load environment variables for resource server (app)
dotenv.config({ path: path.resolve(__dirname, '../.env.app') });

// Also load agent env for token exchange config (resource server uses TokenExchangeHandler)
dotenv.config({ path: path.resolve(__dirname, '../.env.agent') });

// ============================================================================
// Main Bootstrap Function
// ============================================================================

async function bootstrap(): Promise<void> {
  console.log('🚀 Starting Agent0...\n');

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
    };
  }

  // Add Token Exchange configuration if environment variables are set
  const mcpAuthServer = process.env.MCP_AUTHORIZATION_SERVER;
  const mcpAuthServerTokenEndpoint = process.env.MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT;
  const oktaDomain = process.env.OKTA_DOMAIN;
  const agentId = process.env.AI_AGENT_ID;
  const privateKeyFile = process.env.AI_AGENT_PRIVATE_KEY_FILE;
  const privateKeyKid = process.env.AI_AGENT_PRIVATE_KEY_KID;
  const agentScopes = process.env.AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST;

  if (mcpAuthServer && mcpAuthServerTokenEndpoint && oktaDomain && agentId && privateKeyFile && privateKeyKid && agentScopes) {
    resourceServerConfig.tokenExchange = {
      mcpAuthorizationServer: mcpAuthServer,
      mcpAuthorizationServerTokenEndpoint: mcpAuthServerTokenEndpoint,
      oktaDomain,
      clientId: agentId,
      privateKeyFile,
      privateKeyKid,
      agentScopes,
    };
  }

  const resourceServer = new ResourceServer(resourceServerConfig);

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
    await disconnectAll();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n👋 Shutting down gracefully...');
    await disconnectAll();
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
export { 
  ResourceServer, 
  ResourceServerConfig
};
