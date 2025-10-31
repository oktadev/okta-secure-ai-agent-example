// index.ts - Main Entry Point for Agent0
import path from 'path';
import * as dotenv from 'dotenv';
import { disconnectAll } from './agent.js';
import { AppServer } from './app.js';

// Load environment variables for app server
dotenv.config({ path: path.resolve(__dirname, '../.env.app') });

// ============================================================================
// Main Bootstrap Function
// ============================================================================

async function bootstrap(): Promise<void> {
  console.log('🚀 Starting Agent0...\n');

  // App server validates its own environment internally
  const appServer = new AppServer();

  // Start the app server
  await appServer.start();

  // Open browser to the UI
  const port = appServer.getPort();
  try {
    const open = (await (0, eval)("import('open')")).default;
    console.log(`✅ Opening browser at http://localhost:${port}`);
    await open(`http://localhost:${port}`);
  } catch (error) {
    console.log(`💡 Open your browser to http://localhost:${port}`);
  }

  // ============================================================================
  // Handle Graceful Shutdown
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
export { AppServer };
