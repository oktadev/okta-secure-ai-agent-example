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
    const keyFile = env.OKTA_CC_PRIVATE_KEY_FILE;
    if (!keyFile) {
      return { passed: false, message: 'Private key file not configured' };
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
 * Test: Attempt to get ID-JAG token from Org AS
 */
async function validateIdJagFlow(env: Record<string, string>): Promise<ValidationResult> {
  try {
    const clientId = env.AI_AGENT_ID;
    const tokenEndpoint = env.OKTA_TOKEN_ENDPOINT;
    const keyFile = env.OKTA_CC_PRIVATE_KEY_FILE;
    const kid = env.OKTA_PRIVATE_KEY_KID;

    if (!clientId || !tokenEndpoint || !keyFile || !kid) {
      return { passed: false, message: 'ID-JAG configuration incomplete' };
    }

    const keyPath = path.resolve('packages/agent0', keyFile);
    const privateKeyPem = fs.readFileSync(keyPath, 'utf8');

    const clientAssertion = createClientAssertion(
      clientId,
      tokenEndpoint,
      privateKeyPem,
      kid
    );

    const response = await axios.post(
      tokenEndpoint,
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'okta.users.read',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: clientAssertion,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const decoded = jwt.decode(response.data.access_token) as any;

    return {
      passed: true,
      message: 'Successfully obtained ID-JAG token',
      details: {
        tokenType: response.data.token_type,
        expiresIn: response.data.expires_in,
        clientId: decoded?.cid,
        subject: decoded?.sub,
      },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to get ID-JAG token: ${error.response?.data?.error_description || error.message}`,
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
      'OKTA_DOMAIN',
      'AI_AGENT_ID',
      'OKTA_CC_PRIVATE_KEY_FILE',
      'OKTA_PRIVATE_KEY_KID',
      'REST_API_AUDIENCE',
      'MCP_AUDIENCE',
    ];

    const requiredTodo0 = [
      'OKTA_ISSUER',
      'EXPECTED_AUDIENCE',
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
 */
async function validateDistinctAudiences(env: Record<string, string>): Promise<ValidationResult> {
  try {
    const restApiAudience = env.REST_API_AUDIENCE || env.EXPECTED_AUDIENCE;
    const mcpAudience = env.MCP_AUDIENCE || env.MCP_EXPECTED_AUDIENCE;

    if (!restApiAudience || !mcpAudience) {
      return { passed: false, message: 'Audiences not configured' };
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
    { name: 'Distinct Audiences', fn: () => validateDistinctAudiences(agent0Env) },
    { name: 'Private Key', fn: () => validatePrivateKey(agent0Env) },
    { name: 'REST API Auth Server', fn: () => validateRestApiAS(todo0Env) },
    { name: 'MCP Auth Server', fn: () => validateMcpAS(todo0Env) },
    { name: 'ID-JAG Token Flow', fn: () => validateIdJagFlow(agent0Env) },
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
