#!/usr/bin/env node
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import * as jose from 'jose';

interface ValidationResult {
  passed: boolean;
  message: string;
  details?: any;
}

/**
 * Load environment variables from .env file
 */
function loadEnvFile(filePath: string): Record<string, string> {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Environment file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf8');
  const env: Record<string, string> = {};

  content.split('\n').forEach((line) => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join('=').trim();
      }
    }
  });

  return env;
}

/**
 * Create a signed JWT for private key JWT authentication
 */
function createClientAssertion(
  clientId: string,
  audience: string,
  privateKeyPem: string,
  kid: string
): string {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    jti: Math.random().toString(36).substring(2),
    exp: now + 300, // 5 minutes
    iat: now,
  };

  return jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    keyid: kid,
  });
}


/**
 * Test: Validate MCP Authorization Server is reachable
 */
async function validateMcpAS(env: Record<string, string>): Promise<ValidationResult> {
  try {
    const issuer = env.MCP_OKTA_ISSUER;
    if (!issuer) {
      return { passed: false, message: 'MCP issuer not configured' };
    }

    const response = await axios.get(`${issuer}/.well-known/openid-configuration`);
    const config = response.data;

    return {
      passed: true,
      message: 'MCP AS is reachable',
      details: {
        issuer: config.issuer,
        tokenEndpoint: config.token_endpoint,
      },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to reach MCP AS: ${error.message}`,
    };
  }
}

/**
 * Test: Validate private key file exists and is readable
 */
async function validatePrivateKey(env: Record<string, string>): Promise<ValidationResult> {
  try {
    const keyFile = env.AI_AGENT_PRIVATE_KEY_FILE;
    if (!keyFile) {
      return { passed: false, message: 'Private key file not configured (AI_AGENT_PRIVATE_KEY_FILE)' };
    }

    const keyPath = path.resolve('packages/agent0', keyFile);
    if (!fs.existsSync(keyPath)) {
      return { passed: false, message: `Private key file not found: ${keyPath}` };
    }

    const keyContent = fs.readFileSync(keyPath, 'utf8');

    // Try to parse the key to ensure it's valid
    try {
      await jose.importPKCS8(keyContent, 'RS256');
    } catch {
      return { passed: false, message: 'Private key file is invalid or corrupted' };
    }

    // Check file permissions (should be 600)
    const stats = fs.statSync(keyPath);
    const mode = (stats.mode & parseInt('777', 8)).toString(8);

    return {
      passed: true,
      message: 'Private key is valid',
      details: {
        path: keyPath,
        permissions: mode,
        warning: mode !== '600' ? 'Recommended permissions: 600' : null,
      },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to validate private key: ${error.message}`,
    };
  }
}

/**
 * Test: Validate .env files exist and contain required variables
 */
async function validateEnvFiles(): Promise<ValidationResult> {
  try {
    const agent0AppEnvPath = 'packages/agent0/.env.app';
    const agent0AgentEnvPath = 'packages/agent0/.env.agent';
    const todo0EnvPath = 'packages/todo0/.env';

    const missing: string[] = [];
    if (!fs.existsSync(agent0AppEnvPath)) missing.push(agent0AppEnvPath);
    if (!fs.existsSync(agent0AgentEnvPath)) missing.push(agent0AgentEnvPath);
    if (!fs.existsSync(todo0EnvPath)) missing.push(todo0EnvPath);

    if (missing.length > 0) {
      return {
        passed: false,
        message: 'Missing .env files',
        details: { missing },
      };
    }

    const agent0AppEnv = loadEnvFile(agent0AppEnvPath);
    const agent0AgentEnv = loadEnvFile(agent0AgentEnvPath);
    const todo0Env = loadEnvFile(todo0EnvPath);

    // Combine agent0 .env files for validation
    const agent0Env = { ...agent0AppEnv, ...agent0AgentEnv };

    const requiredAgent0App = [
      'PORT',
      'SESSION_SECRET',
      'OKTA_DOMAIN',
      'OKTA_CLIENT_ID',
      'OKTA_CLIENT_SECRET',
      'OKTA_REDIRECT_URI',
    ];

    const requiredAgent0Agent = [
      'MCP_SERVER_URL',
      'OKTA_DOMAIN',
      'AI_AGENT_ID',
      'AI_AGENT_PRIVATE_KEY_FILE',
      'AI_AGENT_PRIVATE_KEY_KID',
      'AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST',
      'MCP_AUTHORIZATION_SERVER',
      'MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT',
    ];

    const requiredTodo0 = [
      'MCP_PORT',
      'MCP_OKTA_ISSUER',
      'MCP_EXPECTED_AUDIENCE',
    ];

    const missingVars: string[] = [];
    requiredAgent0App.forEach((key) => {
      if (!agent0AppEnv[key]) missingVars.push(`agent0 (.env.app): ${key}`);
    });
    requiredAgent0Agent.forEach((key) => {
      if (!agent0AgentEnv[key]) missingVars.push(`agent0 (.env.agent): ${key}`);
    });
    requiredTodo0.forEach((key) => {
      if (!todo0Env[key]) missingVars.push(`todo0: ${key}`);
    });

    if (missingVars.length > 0) {
      return {
        passed: false,
        message: 'Missing required environment variables',
        details: { missingVars },
      };
    }

    return {
      passed: true,
      message: 'All environment files are properly configured',
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to validate env files: ${error.message}`,
    };
  }
}


/**
 * Main validation function
 */
async function validate() {
  console.log(chalk.bold.blue('\n🔍 Validating Okta Configuration\n'));

  // Load environment variables
  let agent0AgentEnv: Record<string, string> = {};
  let todo0Env: Record<string, string> = {};

  try {
    agent0AgentEnv = loadEnvFile('packages/agent0/.env.agent');
    todo0Env = loadEnvFile('packages/todo0/.env');
  } catch (error: any) {
    console.error(chalk.red('❌ Failed to load environment files:'), error.message);
    console.log(chalk.yellow('\n💡 Run `pnpm run bootstrap:okta` first\n'));
    process.exit(1);
  }

  const tests: Array<{ name: string; fn: () => Promise<ValidationResult> }> = [
    { name: 'Environment Files', fn: () => validateEnvFiles() },
    { name: 'Private Key', fn: () => validatePrivateKey(agent0AgentEnv) },
    { name: 'MCP Auth Server', fn: () => validateMcpAS(todo0Env) },
  ];

  let passedCount = 0;
  let failedCount = 0;

  for (const test of tests) {
    const spinner = ora(`Testing: ${test.name}`).start();

    try {
      const result = await test.fn();

      if (result.passed) {
        spinner.succeed(chalk.green(`${test.name}: ${result.message}`));
        if (result.details) {
          console.log(chalk.gray('  Details:'), result.details);
        }
        passedCount++;
      } else {
        spinner.fail(chalk.red(`${test.name}: ${result.message}`));
        if (result.details) {
          console.log(chalk.gray('  Details:'), result.details);
        }
        failedCount++;
      }
    } catch (error: any) {
      spinner.fail(chalk.red(`${test.name}: Unexpected error - ${error.message}`));
      failedCount++;
    }
  }

  // Summary
  console.log(chalk.bold('\n📊 Validation Summary\n'));
  console.log(`  ${chalk.green('Passed:')} ${passedCount}/${tests.length}`);
  console.log(`  ${chalk.red('Failed:')} ${failedCount}/${tests.length}\n`);

  if (failedCount === 0) {
    console.log(chalk.bold.green('✅ All validations passed!\n'));
    console.log('Your Okta configuration is ready to use.\n');
    process.exit(0);
  } else {
    console.log(chalk.bold.red('❌ Some validations failed\n'));
    console.log(chalk.yellow('💡 Tips:'));
    console.log('  • Check that all resources were created in Okta Admin Console');
    console.log('  • Verify .env files have correct values');
    console.log('  • Ensure private key file has correct permissions (600)');
    console.log('  • Try re-running: pnpm run bootstrap:okta\n');
    process.exit(1);
  }
}

// Run validation
validate().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
