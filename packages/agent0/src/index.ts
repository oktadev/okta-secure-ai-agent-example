// index.ts - Main Entry Point for Agent0
import path from 'path';
import * as dotenv from 'dotenv';
import { disconnectAll } from './agent.js';
import { ResourceServer, ResourceServerConfig } from './resource-server.js';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

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
