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
 * Test: Validate REST API Authorization Server is reachable
 */
async function validateRestApiAS(env: Record<string, string>): Promise<ValidationResult> {
  try {
    const issuer = env.MCP_OKTA_ISSUER || env.OKTA_ISSUER;
    if (!issuer) {
      return { passed: false, message: 'REST API issuer not configured' };
    }

    const response = await axios.get(`${issuer}/.well-known/openid-configuration`);
    const config = response.data;

    return {
      passed: true,
      message: 'REST API AS is reachable',
      details: {
        issuer: config.issuer,
        tokenEndpoint: config.token_endpoint,
      },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to reach REST API AS: ${error.message}`,
    };
  }
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
    const agent0EnvPath = 'packages/agent0/.env';
    const todo0EnvPath = 'packages/todo0/.env';

    const missing: string[] = [];
    if (!fs.existsSync(agent0EnvPath)) missing.push(agent0EnvPath);
    if (!fs.existsSync(todo0EnvPath)) missing.push(todo0EnvPath);

    if (missing.length > 0) {
      return {
        passed: false,
        message: 'Missing .env files',
        details: { missing },
      };
    }

    const agent0Env = loadEnvFile(agent0EnvPath);
    const todo0Env = loadEnvFile(todo0EnvPath);

    const requiredAgent0 = [
      'PORT',
      'SESSION_SECRET',
      'MCP_SERVER_URL',
      'OKTA_DOMAIN',
      'OKTA_CLIENT_ID',
      'OKTA_CLIENT_SECRET',
      'OKTA_REDIRECT_URI',
      'AI_AGENT_ID',
      'AI_AGENT_PRIVATE_KEY_FILE',
      'AI_AGENT_PRIVATE_KEY_KID',
      'AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST',
      'ID_JAG_TOKEN_ENDPOINT',
      'AGENT0_API_TOKEN_ENDPOINT',
      'AGENT0_API_AUDIENCE',
      'REST_API_TOKEN_ENDPOINT',
      'REST_API_AUDIENCE',
      'MCP_AUTHORIZATION_SERVER',
      'MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT',
      'MCP_AUDIENCE',
    ];

    const requiredTodo0 = [
      'PORT',
      'OKTA_ISSUER',
      'OKTA_CLIENT_ID',
      'EXPECTED_AUDIENCE',
      'MCP_PORT',
      'MCP_OKTA_ISSUER',
      'MCP_EXPECTED_AUDIENCE',
    ];

    const missingVars: string[] = [];
    requiredAgent0.forEach((key) => {
      if (!agent0Env[key]) missingVars.push(`agent0: ${key}`);
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
 * Test: Validate audiences are distinct
 * Compares todo0's REST API and MCP audiences to ensure proper security boundaries
 */
async function validateDistinctAudiences(todo0Env: Record<string, string>): Promise<ValidationResult> {
  try {
    const restApiAudience = todo0Env.EXPECTED_AUDIENCE;
    const mcpAudience = todo0Env.MCP_EXPECTED_AUDIENCE;

    if (!restApiAudience || !mcpAudience) {
      return { passed: false, message: 'Audiences not configured in todo0 .env' };
    }

    if (restApiAudience === mcpAudience) {
      return {
        passed: false,
        message: 'REST API and MCP audiences must be distinct for proper security boundaries',
        details: {
          restApiAudience,
          mcpAudience,
        },
      };
    }

    return {
      passed: true,
      message: 'Audiences are properly separated',
      details: {
        restApiAudience,
        mcpAudience,
      },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to validate audiences: ${error.message}`,
    };
  }
}

/**
 * Main validation function
 */
async function validate() {
  console.log(chalk.bold.blue('\n🔍 Validating Okta Configuration\n'));

  // Load environment variables
  let agent0Env: Record<string, string> = {};
  let todo0Env: Record<string, string> = {};

  try {
    agent0Env = loadEnvFile('packages/agent0/.env');
    todo0Env = loadEnvFile('packages/todo0/.env');
  } catch (error: any) {
    console.error(chalk.red('❌ Failed to load environment files:'), error.message);
    console.log(chalk.yellow('\n💡 Run `pnpm run bootstrap:okta` first\n'));
    process.exit(1);
  }

  const tests: Array<{ name: string; fn: () => Promise<ValidationResult> }> = [
    { name: 'Environment Files', fn: () => validateEnvFiles() },
    { name: 'Distinct Audiences', fn: () => validateDistinctAudiences(todo0Env) },
    { name: 'Private Key', fn: () => validatePrivateKey(agent0Env) },
    { name: 'REST API Auth Server', fn: () => validateRestApiAS(todo0Env) },
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
