#!/usr/bin/env node
import prompts from 'prompts';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import { OktaAPIClient } from './lib/okta-api.js';
import { generateRSAKeyPair, savePrivateKey } from './lib/key-generator.js';
import {
  generateAgent0AppEnv,
  generateAgent0AgentEnv,
  generateTodo0AppEnv,
  generateTodo0McpEnv,
  writeEnvFile,
  writeConfigReport,
  BootstrapConfig,
} from './lib/env-writer.js';
import {
  loadRollbackState,
  updateRollbackState,
} from './lib/state-manager.js';
import {
  AgentIdentityAPIClient,
  convertPublicKeyToJWK,
  constructAuthServerORN,
} from './lib/agent-identity-api.js';
import type { OpenIdConnectApplication } from '@okta/okta-sdk-nodejs';

interface PromptAnswers {
  oktaDomain: string;
  oktaApiToken: string;
  mcpAudience: string;
  ownerSetupMethod: 'standard' | 'developer';
  confirm: boolean;
}

/**
 * Main bootstrap function
 */
async function bootstrap() {
  console.log(chalk.bold.blue('\n🚀 Okta Tenant Bootstrap for Secure AI Agent Example\n'));
  console.log('This script will configure your Okta tenant with:');
  console.log('  • Two OIDC applications (Agent0 + Todo0)');
  console.log('  • One custom authorization server (Todo0 MCP Server)');
  console.log('     • Custom scopes and access policies');
  console.log('  • Agent0 agent identity');
  console.log('     • RSA key pair for agent authentication');
  console.log('  • .env files for both packages\n');

  // Prompt for configuration
  const answers = await prompts([
    {
      type: 'text',
      name: 'oktaDomain',
      message: 'Enter your Okta domain (e.g., dev-12345.okta.com):',
      validate: (value) => {
        if (!value) return 'Okta domain is required';
        return true;
      },
    },
    {
      type: 'password',
      name: 'oktaApiToken',
      message: 'Enter your Okta API token:',
      validate: (value) => (value ? true : 'API token is required'),
    },
    {
      type: 'text',
      name: 'mcpAudience',
      message: 'MCP Server audience identifier:',
      initial: 'mcp://todo0',
    },
    {
      type: 'select',
      name: 'ownerSetupMethod',
      message: 'Which method to use for setting agent owners?',
      choices: [
        { title: 'Standard API (Governance)', value: 'standard', description: 'Use /governance/api/v1/resource-owners' },
        { title: 'Developer API (Local Dev)', value: 'developer', description: 'Use /devtools/api for Okta developers' },
      ],
      initial: 0,
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Ready to create resources in your Okta tenant?',
      initial: false,
    },
  ]);

  if (!answers.confirm) {
    console.log(chalk.yellow('\n⚠️  Bootstrap cancelled by user'));
    process.exit(0);
  }

  const config = answers as PromptAnswers;
  const oktaClient = new OktaAPIClient({
    orgUrl: `https://${config.oktaDomain}`,
    token: config.oktaApiToken,
  });

  // Initialize Agent Identity API client
  const agentClient = new AgentIdentityAPIClient({
    oktaDomain: config.oktaDomain,
    apiToken: config.oktaApiToken,
  });

  // Initialize rollback state (loads existing or creates new)
  let rollbackState = loadRollbackState(config.oktaDomain);

  const bootstrapConfig: Partial<BootstrapConfig> = {
    oktaDomain: config.oktaDomain,
    mcpAudience: config.mcpAudience,
    privateKeyFile: 'agent0-private-key.pem',
  };

  try {
    // Step 1: Create MCP Authorization Server
    console.log(chalk.bold('\n📋 Step 1: Creating MCP Authorization Server'));
    let spinner = ora('Creating authorization server...').start();

    const mcpAS = await oktaClient.createAuthorizationServer({
      name: 'todo0-mcp-server',
      description: 'Authorization server for todo0 MCP server',
      audiences: [config.mcpAudience],
    });

    bootstrapConfig.mcpAuthServerId = mcpAS.id!;
    rollbackState = updateRollbackState(rollbackState, {
      mcpAuthServerIds: [mcpAS.id!],
    });
    spinner.succeed(`MCP AS created: ${chalk.cyan(mcpAS.id)}`);

    // Add MCP scopes
    spinner = ora('Adding MCP scopes...').start();
    await oktaClient.addScopes(mcpAS.id!, [
      { name: 'mcp:connect', description: 'Establish MCP SSE connection' },
      { name: 'mcp:tools:read', description: 'Use tools that read todo data' },
      { name: 'mcp:tools:manage', description: 'Use tools that manage todo data' },
    ]);
    spinner.succeed('MCP scopes added');

    // Step 2: Create agent0 OIDC Application
    console.log(chalk.bold('\n📋 Step 2: Creating agent0 OIDC Application'));
    spinner = ora('Creating agent0 OIDC client...').start();

    const agent0App = await oktaClient.createApplication({
      name: 'oidc_client',
      label: 'agent0',
      signOnMode: 'OPENID_CONNECT',
      credentials: {
        oauthClient: {
          token_endpoint_auth_method: 'client_secret_basic',
        },
      },
      settings: {
        oauthClient: {
          client_uri: 'http://localhost:3000',
          redirect_uris: ['http://localhost:3000/callback'],
          post_logout_redirect_uris: ['http://localhost:3000'],
          response_types: ['code'],
          grant_types: ['authorization_code'],
          application_type: 'web',
          consent_method: 'REQUIRED',
        },
        implicitAssignment: false,
      },
    }) as OpenIdConnectApplication;

    bootstrapConfig.agentAppClientId = agent0App.credentials.oauthClient!.client_id!;
    bootstrapConfig.agentAppClientSecret = agent0App.credentials.oauthClient!.client_secret!;
    const agent0AppId = agent0App.id!;
    rollbackState = updateRollbackState(rollbackState, {
      agent0AppIds: [agent0AppId],
    });
    spinner.succeed(`agent0 OIDC app created: ${chalk.cyan(agent0AppId)}`);

    // Step 3: Create todo0 OIDC Application
    console.log(chalk.bold('\n📋 Step 3: Creating todo0 OIDC Application'));
    spinner = ora('Creating todo0 OIDC client...').start();

    const todo0App = await oktaClient.createApplication({
      name: 'oidc_client',
      label: 'todo0',
      signOnMode: 'OPENID_CONNECT',
      credentials: {
        oauthClient: {
          token_endpoint_auth_method: 'client_secret_basic',
        },
      },
      settings: {
        oauthClient: {
          client_uri: 'http://localhost:5001',
          redirect_uris: ['http://localhost:5001/callback'],
          post_logout_redirect_uris: ['http://localhost:5001'],
          response_types: ['code'],
          grant_types: ['authorization_code'],
          application_type: 'web',
          consent_method: 'REQUIRED',
        },
        implicitAssignment: false,
      },
    }) as OpenIdConnectApplication;

    const todo0AppId = todo0App.id!;
    bootstrapConfig.todo0AppClientId = todo0App.credentials.oauthClient!.client_id!;
    bootstrapConfig.todo0AppClientSecret = todo0App.credentials.oauthClient!.client_secret!;
    rollbackState = updateRollbackState(rollbackState, {
      todo0AppIds: [todo0AppId],
    });
    spinner.succeed(`todo0 OIDC app created: ${chalk.cyan(todo0AppId)}`);

    // Step 4: Assign Current User to Applications
    console.log(chalk.bold('\n📋 Step 4: Assigning User to Applications'));
    spinner = ora('Getting current user...').start();

    const currentUser = await agentClient.getCurrentUser();
    spinner.succeed(`Current user: ${chalk.cyan(currentUser.login)}`);

    spinner = ora('Assigning user to agent0 application...').start();
    await oktaClient.assignUserToApplication(agent0AppId, currentUser.id);
    rollbackState = updateRollbackState(rollbackState, {
      agent0AppUserIds: [currentUser.id],
    });
    spinner.succeed('User assigned to agent0 application');

    spinner = ora('Assigning user to todo0 application...').start();
    await oktaClient.assignUserToApplication(todo0AppId, currentUser.id);
    rollbackState = updateRollbackState(rollbackState, {
      todo0AppUserIds: [currentUser.id],
    });
    spinner.succeed('User assigned to todo0 application');

    // Step 5: Generate RSA Key Pair
    console.log(chalk.bold('\n📋 Step 5: Generating RSA Key Pair for Agent'));
    spinner = ora('Generating 2048-bit RSA key pair...').start();

    const keyPair = await generateRSAKeyPair();
    const privateKeyPath = path.resolve('packages/agent0', bootstrapConfig.privateKeyFile!);
    await savePrivateKey(keyPair.privateKeyPem, privateKeyPath);
    spinner.succeed('RSA key pair generated');

    // Step 6: Create Agent Identity
    console.log(chalk.bold('\n📋 Step 6: Creating Agent Identity'));
    spinner = ora('Registering agent identity...').start();

    let agentIdentityId: string;
    let agentClientId: string;

    try {
      // Register agent (async operation)
      const operationUrl = await agentClient.registerAgent({
        profile: {
          name: 'Agent0 Agent',
          description: 'Agent0 Agent',
        },
        appId: agent0AppId,
      });

      // Poll until registration completes
      spinner.text = 'Waiting for agent registration to complete...';
      const operation = await agentClient.pollOperation(operationUrl);

      // Get agent details
      agentIdentityId = operation.resource.id;
      agentClientId = agentIdentityId;  // Agent ID is the client ID

      // Save to rollback state
      rollbackState = updateRollbackState(rollbackState, {
        agentIdentityIds: [agentIdentityId],
      });

      spinner.succeed(`Agent identity created: ${chalk.cyan(agentIdentityId)}`);
    } catch (error: any) {
      spinner.fail(`Agent identity creation failed: ${error.message}`);
      console.log(chalk.gray('  → Check Okta tenant for partially created resources'));
      throw error;
    }

    bootstrapConfig.agentIdentityClientId = agentClientId;

    // Step 7: Set Agent Owners
    console.log(chalk.bold('\n📋 Step 7: Setting Agent Owners'));
    spinner = ora('Setting agent owners...').start();

    try {
      // Get current user and org metadata
      spinner.text = 'Getting current user and org metadata...';
      const [currentUser, orgMetadata] = await Promise.all([
        agentClient.getCurrentUser(),
        agentClient.getOrgMetadata(),
      ]);

      spinner.text = `Setting agent owner to: ${currentUser.login}`;

      if (config.ownerSetupMethod === 'developer') {
        // Use developer API
        await agentClient.setAgentOwnersDeveloper(agentIdentityId, orgMetadata.id);
        spinner.succeed(`Agent owners set using Developer API`);
      } else {
        // Use standard governance API
        await agentClient.setAgentOwnersStandard(agentIdentityId, orgMetadata.id, currentUser.id);
        spinner.succeed(`Agent owners set using Standard API (owner: ${currentUser.login})`);
      }

      // Save owner setup method to rollback state
      rollbackState = updateRollbackState(rollbackState, {
        agentOwnerSetupMethod: config.ownerSetupMethod,
      });
    } catch (error: any) {
      spinner.fail(`Agent owner setup failed: ${error.message}`);
      console.log(chalk.gray('  → Agent activation may fail without owners'));
      throw error;
    }

    // Step 8: Upload Public Key to Agent Identity
    console.log(chalk.bold('\n📋 Step 8: Uploading Public Key to Agent'));
    spinner = ora('Uploading public key...').start();

    try {
      // Convert public key to JWK format and upload
      const jwk = await convertPublicKeyToJWK(keyPair.publicKeyPem);
      const { kid } = await agentClient.uploadPublicKey(agentIdentityId, jwk);

      bootstrapConfig.keyId = kid;
      spinner.succeed(`Public key uploaded: ${chalk.cyan(kid)}`);
    } catch (error: any) {
      spinner.fail(`Public key upload failed: ${error.message}`);
      console.log(chalk.gray('  → Check agent identity in Okta tenant'));
      throw error;
    }

    // Step 9: Activate Agent Identity
    console.log(chalk.bold('\n📋 Step 9: Activating Agent Identity'));
    spinner = ora('Activating agent...').start();

    try {
      // Activate agent (async operation)
      const activationUrl = await agentClient.activateAgent(agentIdentityId);
      spinner.text = 'Waiting for agent activation to complete...';
      await agentClient.pollOperation(activationUrl);

      spinner.succeed('Agent identity activated');
    } catch (error: any) {
      spinner.fail(`Agent activation failed: ${error.message}`);
      console.log(chalk.gray('  → Check agent status in Okta Admin Console'));
      throw error;
    }

    // Note: Linking agent to agent0 app was done during agent registration (Step 7)
    // when we provided appId in the POST request body

    // Step 10: Create Agent Connection to MCP Authorization Server
    console.log(chalk.bold('\n📋 Step 10: Creating Agent Connection to MCP AS'));
    spinner = ora('Connecting agent to MCP authorization server...').start();

    try {
      // Get org metadata for ORN construction
      const orgMetadata = await agentClient.getOrgMetadata();
      const authServerOrn = constructAuthServerORN(orgMetadata.id, mcpAS.id!);

      // Define MCP scopes granted to the agent
      const mcpScopes = ['mcp:connect', 'mcp:tools:read', 'mcp:tools:manage'];

      // Create connection
      const connection = await agentClient.createConnection(agentIdentityId, {
        connectionType: 'IDENTITY_ASSERTION_CUSTOM_AS',
        authorizationServer: {
          orn: authServerOrn,
          resourceIndicator: config.mcpAudience,
        },
        scopeCondition: 'INCLUDE_ONLY',
        scopes: mcpScopes,
      });

      // Save MCP scopes to config for .env generation
      bootstrapConfig.mcpScopes = mcpScopes;

      rollbackState = updateRollbackState(rollbackState, {
        agentConnections: [{ agentId: agentIdentityId, connectionId: connection.id }],
      });

      spinner.succeed(`Agent connection created: ${chalk.cyan(connection.id)}`);
    } catch (error: any) {
      spinner.fail(`Agent connection creation failed: ${error.message}`);
      console.log(chalk.gray(`  → Check agent and authorization server in Okta Admin Console`));
      throw error;
    }

    // Step 11: Create Access Policies
    console.log(chalk.bold('\n📋 Step 11: Creating Access Policies'));

    // MCP AS Policy (for agent identity)
    spinner = ora('Creating MCP policy...').start();
    const mcpPolicy = await oktaClient.createPolicy(mcpAS.id!, {
      name: 'Default MCP Policy',
      description: 'Default access policy for MCP server',
      priority: 1,
      clientIds: [agentClientId],
    });
    rollbackState = updateRollbackState(rollbackState, {
      mcpPolicyIds: [mcpPolicy.id!],
    });
    spinner.succeed('MCP policy created');

    spinner = ora('Creating MCP policy rule...').start();
    const mcpPolicyRule = await oktaClient.createPolicyRule(mcpAS.id!, mcpPolicy.id!, {
      name: 'Allow MCP Connection',
      priority: 1,
      grantTypes: [
        'client_credentials',
        'authorization_code',
        'urn:ietf:params:oauth:grant-type:device_code',
        'urn:ietf:params:oauth:grant-type:token-exchange',
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
      ],
      scopes: ['mcp:connect', 'mcp:tools:read', 'mcp:tools:manage'],
      accessTokenLifetimeMinutes: 60,
      refreshTokenLifetimeMinutes: 129600,
      refreshTokenWindowMinutes: 10080,
    });
    rollbackState = updateRollbackState(rollbackState, {
      mcpPolicyRuleIds: [mcpPolicyRule.id!],
    });
    spinner.succeed('MCP policy rule created');

    // Step 12: Create Trusted Origins
    console.log(chalk.bold('\n📋 Step 12: Creating Trusted Origins'));
    spinner = ora('Adding trusted origins...').start();

    const origins = [
      { name: 'agent0-ui', url: 'http://localhost:3000' },
      { name: 'todo0-mcp-server', url: 'http://localhost:5002' },
    ];

    const createdOrigins: string[] = [];
    for (const { name, url } of origins) {
      const result = await oktaClient.createTrustedOriginIfNotExists(name, url);
      if (result.created) {
        createdOrigins.push(name);
      }
    }

    // Only add to rollback state the origins we actually created
    if (createdOrigins.length > 0) {
      rollbackState = updateRollbackState(rollbackState, {
        trustedOriginNames: createdOrigins,
      });
    }

    if (origins.length === createdOrigins.length) {
      spinner.succeed('Trusted origins added');
    } else {
      spinner.succeed(`Trusted origins configured (${createdOrigins.length} created, ${origins.length - createdOrigins.length} already existed)`);
    }

    // Step 13: Generate Configuration Files
    console.log(chalk.bold('\n📋 Step 13: Generating Configuration Files'));
    spinner = ora('Writing .env files...').start();

    const agent0AppEnv = generateAgent0AppEnv(bootstrapConfig as BootstrapConfig);
    writeEnvFile('packages/agent0/.env.app', agent0AppEnv);

    const agent0AgentEnv = generateAgent0AgentEnv(bootstrapConfig as BootstrapConfig);
    writeEnvFile('packages/agent0/.env.agent', agent0AgentEnv);

    const todo0AppEnv = generateTodo0AppEnv(bootstrapConfig as BootstrapConfig);
    writeEnvFile('packages/todo0/.env.app', todo0AppEnv);

    const todo0McpEnv = generateTodo0McpEnv(bootstrapConfig as BootstrapConfig);
    writeEnvFile('packages/todo0/.env.mcp', todo0McpEnv);

    writeConfigReport(bootstrapConfig as BootstrapConfig);

    spinner.succeed('Configuration files generated');

    // Success!
    console.log(chalk.bold.green('\n✅ Bootstrap Complete!\n'));

    console.log('Next steps:');
    console.log(`  1. ${chalk.cyan('pnpm install')} - Install dependencies`);
    console.log(`  2. ${chalk.cyan('pnpm run bootstrap')} - Bootstrap database`);
    console.log(`  3. ${chalk.cyan('pnpm run start:todo0')} - Start REST API`);
    console.log(`  4. ${chalk.cyan('pnpm run start:mcp')} - Start MCP Server`);
    console.log(`  5. ${chalk.cyan('pnpm run start:agent0')} - Start Agent`);
    console.log(`\n  Optional: ${chalk.cyan('pnpm run validate:okta')} - Validate configuration`);
    console.log(`\n📄 See ${chalk.cyan('okta-config-report.md')} for detailed configuration\n`);
  } catch (error: any) {
    console.error(chalk.red('\n❌ Bootstrap failed:'), error.message);
    console.error(chalk.yellow('\n⚠️  Some resources may have been created.'));
    console.error(chalk.yellow('Run `pnpm run rollback:okta` to clean up.\n'));
    process.exit(1);
  }
}

// Run bootstrap
bootstrap().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
